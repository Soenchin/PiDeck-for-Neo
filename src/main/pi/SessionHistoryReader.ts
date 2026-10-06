import { open, stat } from "node:fs/promises";
import type { ChatMessage, ImageContent, SessionMessagePage } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { RpcResponse } from "./PiRpcClient";
import type { AppLogger } from "../logging/AppLogger";
import { SessionDisplayIndexStore, indexFromText, sessionFileVersion, type SessionDisplayEntry, type SessionDisplayIndex } from "./SessionDisplayIndex";
import { MAX_HISTORY_PAGE_BYTES, readJsonlRow } from "./JsonlScanner";

export type SessionArchiveData = {
  compactions: Array<{ id: string; summary: string; timestamp: string; firstKeptEntryId?: string; tokensBefore?: number }>;
};
export type SessionHistoryReaderDeps = {
  toHostPath: (sessionPath: string) => string;
  convertMessages: (agentId: string, rawMessages: unknown[], activeEntryIds?: string[]) => ChatMessage[];
  trimMessages: (rawMessages: unknown[], maxTurns?: number) => unknown[];
  translate: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
  logger?: Pick<AppLogger, "info" | "warn">;
};

/** Align pages to complete user turns. The soft budget drops oldest whole turns, never half a turn. */
export function findTurnPageStart(
  entries: ReadonlyArray<{ role?: string; byteLength: number }>,
  before: number, turnCount: number, byteBudget: number,
): number {
  if (before <= 0 || turnCount < 1) return 0;
  let turnsSeen = 0;
  let start = 0;
  for (let i = before - 1; i >= 0; i--) {
    if (entries[i].role === "user" && ++turnsSeen === turnCount) { start = i; break; }
  }
  if (turnsSeen < turnCount) start = 0;
  else if (!entries.slice(0, start).some(e => e.role === "user")) start = 0;
  let bytes = entries.slice(start, before).reduce((n, e) => n + e.byteLength, 0);
  while (bytes > byteBudget) {
    let next = start + 1;
    while (next < before && entries[next].role !== "user") next++;
    if (next >= before) break;
    for (let i = start; i < next; i++) bytes -= entries[i].byteLength;
    start = next;
  }
  return start;
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object"); }
/** Text/image extraction retains both Pi's native image blocks and older source/base64 blocks. */
function extractResendContent(content: unknown): { text: string; images?: ImageContent[] } {
  if (typeof content === "string") return { text: content };
  const texts: string[] = [];
  const images: ImageContent[] = [];
  if (Array.isArray(content)) for (const block of content) {
    if (!record(block)) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    if (block.type !== "image") continue;
    const source = record(block.source) ? block.source : undefined;
    const data = source?.type === "base64" ? source.data : block.data;
    const mime = source?.type === "base64" ? source.media_type : block.mimeType;
    if (typeof data === "string") images.push({ type: "image", mimeType: typeof mime === "string" ? mime : "image/png", data });
  }
  return { text: texts.join("\n"), ...(images.length ? { images } : {}) };
}
function syntheticHistoryEntryId(messageId: string): string | undefined {
  const marker = "-history-";
  const i = messageId.lastIndexOf(marker);
  return i < 0 ? undefined : messageId.slice(i + marker.length) || undefined;
}
function archive(index: SessionDisplayIndex): SessionArchiveData {
  return { compactions: index.activeBranch.filter(e => e.type === "compaction").map(e => ({ id: e.id, summary: e.summary ?? "", timestamp: e.timestamp ?? "", firstKeptEntryId: e.firstKeptEntryId, tokensBefore: e.tokensBefore })) };
}

/** Persisted display history, not model context. All disk operations share one bounded lightweight index. */
export class SessionHistoryReader {
  private readonly indexStore = new SessionDisplayIndexStore();
  private readonly fullTextCache = new Map<string, string>();
  private epoch = 0;
  private static readonly FULL_TEXT_CACHE_LIMIT = 200;
  private static readonly FULL_TEXT_CACHE_BYTES = 8 * 1024 * 1024;
  private static readonly MAX_SESSION_DISPLAY_PAGE_SIZE = 100;
  private static readonly MAX_SESSION_DISPLAY_PAGE_BYTES = 256 * 1024;
  static readonly DEFAULT_TURN_PAGE_SIZE = 3;
  private static readonly MAX_TURN_PAGE_SIZE = 10;
  constructor(private readonly deps: SessionHistoryReaderDeps) {}
  static maxTurnPageSize(): number { return SessionHistoryReader.MAX_TURN_PAGE_SIZE; }
  /** Clears builders and caches without ever altering the original file. */
  dispose() { this.epoch++; this.indexStore.clear(); this.fullTextCache.clear(); }
  getDiagnostics() { return this.indexStore.diagnostics(); }
  private getSessionDisplayIndex(path: string) { return this.indexStore.get(this.deps.toHostPath(path)); }
  async getActiveLeafId(path: string): Promise<string | undefined> { return (await this.getSessionDisplayIndex(path)).activeBranch.at(-1)?.id; }
  async getActiveEntryCount(path: string): Promise<number> { return (await this.getSessionDisplayIndex(path)).activeMessageEntries.length; }
  async getSessionIndexVersion(path: string): Promise<string> { return (await this.getSessionDisplayIndex(path)).version; }
  async resolveEntryPosition(path: string, entryId: string): Promise<number | undefined> {
    const i = (await this.getSessionDisplayIndex(path)).activeMessageEntries.findIndex(e => e.id === entryId);
    return i < 0 ? undefined : i;
  }
  async resolveEntryIdAtPosition(path: string, position: number): Promise<string | undefined> { return (await this.getSessionDisplayIndex(path)).activeMessageEntries[position]?.id; }

  /** Cache keys include the snapshot: edits cannot return old tool text under the same message id. */
  async readMessageFullText(path: string, messageId: string, entryId?: string): Promise<{ text: string }> {
    const epoch = this.epoch;
    const index = await this.getSessionDisplayIndex(path);
    const key = `${index.hostPath}#${index.version}#${entryId ?? messageId}`;
    const cached = this.fullTextCache.get(key);
    if (cached !== undefined) { this.fullTextCache.delete(key); this.fullTextCache.set(key, cached); return { text: cached }; }
    const entry = index.activeMessageEntries.find(e => entryId && e.id === entryId)
      ?? index.activeMessageEntries.find(e => e.messageId === messageId || e.id === syntheticHistoryEntryId(messageId));
    if (!entry) throw new Error(`Message ${messageId} not found in session file`);
    const [raw] = await this.readIndexedSessionMessages(index, [entry]);
    if (epoch !== this.epoch) throw new Error("SESSION_READ_CANCELLED");
    const content = record(raw) ? raw.content : undefined;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(record).map(b => typeof b.text === "string" ? b.text : "").filter(Boolean).join("\n") : "";
    if (!text) throw new Error(`Message ${messageId} has no extractable text content`);
    if (text.length * 2 <= SessionHistoryReader.FULL_TEXT_CACHE_BYTES) {
      this.fullTextCache.set(key, text);
      let bytes = [...this.fullTextCache.values()].reduce((n, s) => n + 2 * s.length, 0);
      while (bytes > SessionHistoryReader.FULL_TEXT_CACHE_BYTES || this.fullTextCache.size > SessionHistoryReader.FULL_TEXT_CACHE_LIMIT) {
        const oldest = this.fullTextCache.keys().next().value;
        if (oldest === undefined) break;
        bytes -= 2 * (this.fullTextCache.get(oldest)?.length ?? 0);
        this.fullTextCache.delete(oldest);
      }
    }
    return { text };
  }

  /** Legacy complete-view API remains available for small snapshots; large calls fail explicitly, not OOM. */
  async readSessionDisplayMessages(path: string, agentId = "_viewer", sessionContent?: string): Promise<ChatMessage[]> {
    if (sessionContent !== undefined && Buffer.byteLength(sessionContent) > MAX_HISTORY_PAGE_BYTES) throw new Error("SESSION_PAGE_LIMIT: use paged history");
    const index = sessionContent === undefined ? await this.getSessionDisplayIndex(path) : indexFromText(path, sessionContent);
    const entries = index.activeMessageEntries;
    let raw: unknown[];
    if (sessionContent === undefined) raw = await this.readIndexedSessionMessages(index, entries);
    else {
      const bytes = Buffer.from(sessionContent);
      raw = entries.map(e => {
        const value: unknown = JSON.parse(bytes.subarray(e.offset, e.offset + e.byteLength).toString("utf8"));
        return record(value) ? value.message : undefined;
      });
    }
    return this.convertCompactionPageMessages(index, agentId, raw, entries.map(e => e.id), 0, entries.length);
  }

  async readSessionDisplayMessagePage(path: string, agentId = "_viewer", before?: number, pageSize = SessionHistoryReader.MAX_SESSION_DISPLAY_PAGE_SIZE): Promise<SessionMessagePage> {
    const index = await this.getSessionDisplayIndex(path);
    const total = index.activeMessageEntries.length;
    const end = Number.isSafeInteger(before) ? Math.min(Math.max(0, before!), total) : total;
    const limit = Number.isFinite(pageSize) ? Math.min(Math.max(1, Math.floor(pageSize)), 100) : 100;
    let start = end;
    let bytes = 0;
    while (start > 0 && end - start < limit) {
      const candidate = index.activeMessageEntries[start - 1];
      if (start < end && bytes + candidate.byteLength > SessionHistoryReader.MAX_SESSION_DISPLAY_PAGE_BYTES) break;
      bytes += candidate.byteLength; start--;
    }
    return this.page(index, agentId, start, end);
  }

  async readSessionDisplayTurnPage(path: string, agentId = "_viewer", before?: number, turnCount = SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE, beforeEntryId?: string): Promise<SessionMessagePage> {
    const index = await this.getSessionDisplayIndex(path);
    const total = index.activeMessageEntries.length;
    const anchor = beforeEntryId ? index.activeMessageEntries.findIndex(e => e.id === beforeEntryId) : -1;
    const resolvedBefore = anchor >= 0 ? anchor : before;
    const end = Number.isSafeInteger(resolvedBefore) ? Math.min(Math.max(0, resolvedBefore!), total) : total;
    const turns = Number.isFinite(turnCount) ? Math.min(Math.max(1, Math.floor(turnCount)), SessionHistoryReader.MAX_TURN_PAGE_SIZE) : 3;
    const start = findTurnPageStart(index.activeMessageEntries, end, turns, SessionHistoryReader.MAX_SESSION_DISPLAY_PAGE_BYTES);
    return this.page(index, agentId, start, end);
  }

  private async page(index: SessionDisplayIndex, agentId: string, start: number, end: number): Promise<SessionMessagePage> {
    const entries = index.activeMessageEntries.slice(start, end);
    const raw = await this.readIndexedSessionMessages(index, entries);
    return { messages: this.convertCompactionPageMessages(index, agentId, raw, entries.map(e => e.id), start, end), total: index.activeMessageEntries.length, nextBefore: start > 0 ? start : null, nextBeforeEntryId: start > 0 ? index.activeMessageEntries[start]?.id : undefined, indexVersion: index.version };
  }

  /** Compaction anchor is measured in raw entry space, even when projection omits empty/thinking-only rows. */
  private convertCompactionPageMessages(index: SessionDisplayIndex, agentId: string, raw: unknown[], ids: string[], start: number, end: number): ChatMessage[] {
    const messages = this.deps.convertMessages(agentId, raw, ids);
    const compactions = archive(index).compactions;
    const last = compactions.at(-1);
    if (!last) return messages;
    let anchor = last.firstKeptEntryId ? index.activeMessageEntries.findIndex(e => e.id === last.firstKeptEntryId) : -1;
    if (anchor < 0) {
      const compIdx = index.activeBranch.findIndex(e => e.id === last.id);
      anchor = index.activeBranch.slice(0, compIdx + 1).filter(e => e.type === "message" && e.hasMessage).length;
    }
    if (anchor < start || anchor >= end && !(anchor === end && end === index.activeMessageEntries.length)) return messages;
    const rel = this.deps.convertMessages(agentId, raw.slice(0, anchor - start), ids.slice(0, anchor - start)).length;
    const card: ChatMessage = { id: `${agentId}-meta-1`, agentId, role: "system", text: last.summary || this.deps.translate("session.summaryPlaceholder"), timestamp: last.timestamp ? Date.parse(last.timestamp) : Date.now(), meta: { type: "compaction", tokensBefore: last.tokensBefore, compactionCount: compactions.length } };
    return [...messages.slice(0, rel), card, ...messages.slice(rel)];
  }

  /** Sequential rows and a hard aggregate budget bound both raw message retention and IPC payload. */
  private async readIndexedSessionMessages(index: SessionDisplayIndex, entries: SessionDisplayEntry[]): Promise<unknown[]> {
    const bytes = entries.reduce((n, e) => n + e.byteLength, 0);
    if (bytes > MAX_HISTORY_PAGE_BYTES) throw new Error(`SESSION_PAGE_LIMIT: ${bytes} bytes; request a smaller history page`);
    const handle = await open(index.hostPath, "r");
    try {
      if (sessionFileVersion(await handle.stat()) !== index.version) throw new Error("SESSION_FILE_CHANGED: before page read");
      const messages: unknown[] = [];
      for (const entry of entries) {
        const row = await readJsonlRow(handle, entry.offset, entry.byteLength);
        if (!record(row) || row.id !== entry.id) throw new Error("SESSION_FILE_CHANGED: entry mismatch");
        messages.push(row.message);
      }
      if (sessionFileVersion(await handle.stat()) !== index.version || sessionFileVersion(await stat(index.hostPath)) !== index.version) throw new Error("SESSION_FILE_CHANGED: during page read");
      return messages;
    } finally { await handle.close(); }
  }

  async readMessageByMessageId(path: string, messageId: string): Promise<{ entryId: string; role?: string; text: string; images?: ImageContent[] } | undefined> {
    if (!messageId) return undefined;
    const index = await this.getSessionDisplayIndex(path);
    const syntheticId = syntheticHistoryEntryId(messageId);
    const entry = index.activeMessageEntries.find(e => e.messageId === messageId || e.id === messageId || e.id === syntheticId);
    if (!entry) return undefined;
    const [raw] = await this.readIndexedSessionMessages(index, [entry]);
    return { entryId: entry.id, role: entry.role, ...extractResendContent(record(raw) ? raw.content : undefined) };
  }

  /** Active-branch display tail, with aligned identity and snapshot; never retains all image history. */
  async readRecentMessages(path: string, maxTurns: number): Promise<RpcResponse> {
    const startTime = Date.now();
    const index = await this.getSessionDisplayIndex(path);
    const end = index.activeMessageEntries.length;
    const turns = Number.isFinite(maxTurns) ? Math.min(40, Math.max(1, Math.floor(maxTurns))) : 12;
    const start = findTurnPageStart(index.activeMessageEntries, end, turns, MAX_HISTORY_PAGE_BYTES);
    const entries = index.activeMessageEntries.slice(start, end);
    const messages = await this.readIndexedSessionMessages(index, entries);
    const compactions = archive(index).compactions;
    void this.deps.logger?.info("agent", "Recent messages read from session index", { messageEntries: end, trimmedMessages: messages.length, readMs: Date.now() - startTime });
    return { type: "response", command: "get_messages", success: true, data: { messages, entryIds: entries.filter(e => e.role === "user" || e.role === "assistant" || e.role === "toolResult").map(e => e.id), headOffset: start, indexVersion: index.version, compactions } };
  }

  /** Uses the same index and excludes compactions on abandoned branches. */
  async scanCompactions(path: string, sessionContent?: string): Promise<SessionArchiveData> {
    if (sessionContent !== undefined && Buffer.byteLength(sessionContent) > MAX_HISTORY_PAGE_BYTES) throw new Error("SESSION_PAGE_LIMIT: supplied snapshot");
    const index = sessionContent === undefined ? await this.getSessionDisplayIndex(path) : indexFromText(path, sessionContent);
    return archive(index);
  }
}
