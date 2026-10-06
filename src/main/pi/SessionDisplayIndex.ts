import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { scanJsonl } from "./JsonlScanner";

export type SessionDisplayEntry = {
  id: string;
  parentId: string | null;
  type: string;
  offset: number;
  byteLength: number;
  hasMessage: boolean;
  role?: string;
  messageId?: string;
  summary?: string;
  firstKeptEntryId?: string;
  timestamp?: string;
  tokensBefore?: number;
};
export type SessionDisplayIndex = {
  hostPath: string;
  size: number;
  mtimeMs: number;
  version: string;
  identity: string;
  hasCompaction: boolean;
  entries: Map<string, SessionDisplayEntry>;
  activeBranch: SessionDisplayEntry[];
  activeMessageEntries: SessionDisplayEntry[];
  endsWithNewline: boolean;
  prefixDigest: string;
  metadataBytes: number;
};
const INDEX_BUDGET_BYTES = 16 * 1024 * 1024;
const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
const CACHE_LIMIT = 32;
const MAX_SUMMARY_CHARS = 65536;

/** File identity detects atomic replacement even when length and modification time match. */
function identity(s: Stats): string { return `${s.dev}:${s.ino}:${s.birthtimeMs}`; }
export function sessionFileVersion(s: Stats): string { return `${identity(s)}:${s.ctimeMs}:${s.mtimeMs}:${s.size}`; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object"); }
function optionalString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

/** Malformed/unfinished JSON rows are isolated; explicit resource limits are not swallowed. */
function parseEntry(text: string, offset: number, byteLength: number): SessionDisplayEntry | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!record(value) || typeof value.id !== "string") return undefined;
  const message = record(value.message) ? value.message : undefined;
  const summary = optionalString(value.summary);
  if (summary && summary.length > MAX_SUMMARY_CHARS) throw new Error("SESSION_METADATA_LIMIT: compaction summary");
  const entry: SessionDisplayEntry = {
    id: value.id, parentId: optionalString(value.parentId) ?? null,
    type: optionalString(value.type) ?? "", offset, byteLength,
    hasMessage: value.message !== undefined && value.message !== null,
    role: optionalString(message?.role), messageId: optionalString(message?.id), summary,
    firstKeptEntryId: optionalString(value.firstKeptEntryId), timestamp: optionalString(value.timestamp),
    tokensBefore: typeof value.tokensBefore === "number" ? value.tokensBefore : undefined,
  };
  // Entry identifiers are metadata too: corrupt/untrusted huge ids must not defeat the budget.
  if ([entry.id, entry.parentId, entry.type, entry.role, entry.messageId, entry.timestamp, entry.firstKeptEntryId].some(s => s && s.length > 1024)) {
    throw new Error("SESSION_METADATA_LIMIT: identifier");
  }
  return entry;
}
function entryBytes(entry: SessionDisplayEntry): number {
  return 512 + 2 * [entry.id, entry.parentId, entry.type, entry.role, entry.messageId, entry.summary, entry.timestamp, entry.firstKeptEntryId].reduce<number>((n, s) => n + (s?.length ?? 0), 0);
}
function activeBranch(entries: Map<string, SessionDisplayEntry>): SessionDisplayEntry[] {
  let leaf: SessionDisplayEntry | undefined;
  for (const entry of entries.values()) leaf = entry;
  const branch: SessionDisplayEntry[] = [];
  const seen = new Set<string>();
  while (leaf && !seen.has(leaf.id)) {
    seen.add(leaf.id); branch.push(leaf);
    leaf = leaf.parentId ? entries.get(leaf.parentId) : undefined;
  }
  return branch.reverse();
}
/** Full prefix validation avoids treating an unsampled in-place edit plus growth as pure append. */
async function hashPrefix(handle: FileHandle, size: number) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new Error("SESSION_FILE_CHANGED: prefix truncated");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash;
}

/** Compatibility for callers already holding a small snapshot; production file reads never use this path. */
export function indexFromText(hostPath: string, content: string): SessionDisplayIndex {
  const entries = new Map<string, SessionDisplayEntry>();
  let offset = 0;
  let metadataBytes = 0;
  for (const text of content.split("\n")) {
    const bytes = Buffer.byteLength(text);
    const entry = parseEntry(text, offset, bytes);
    if (entry) { entries.set(entry.id, entry); metadataBytes += entryBytes(entry); }
    if (metadataBytes > INDEX_BUDGET_BYTES) throw new Error("SESSION_METADATA_LIMIT: index budget");
    offset += bytes + 1;
  }
  const branch = activeBranch(entries);
  return { hostPath, size: Buffer.byteLength(content), mtimeMs: 0, version: "in-memory", identity: "in-memory", entries, activeBranch: branch, activeMessageEntries: branch.filter(e => e.type === "message" && e.hasMessage), hasCompaction: branch.some(e => e.type === "compaction"), endsWithNewline: content.endsWith("\n"), prefixDigest: "", metadataBytes };
}

/** Owns the single lightweight index shared by recent messages, identity, pages and compaction reads. */
export class SessionDisplayIndexStore {
  private readonly cache = new Map<string, SessionDisplayIndex>();
  private readonly pending = new Map<string, Promise<SessionDisplayIndex>>();
  private epoch = 0;
  private buildQueue: Promise<void> = Promise.resolve();
  private scannedBytes = 0;
  private scans = 0;
  private maxLineBytes = 0;
  private maxParseMs = 0;
  private validatedPrefixBytes = 0;

  diagnostics() { return { scannedBytes: this.scannedBytes, validatedPrefixBytes: this.validatedPrefixBytes, scans: this.scans, maxLineBytes: this.maxLineBytes, maxParseMs: this.maxParseMs, cachedIndexes: this.cache.size, metadataBytes: [...this.cache.values()].reduce((n, i) => n + i.metadataBytes, 0) }; }
  /** Clearing invalidates builders too, so completed work cannot resurrect a disposed cache. */
  clear() { this.epoch++; this.cache.clear(); this.pending.clear(); }

  async get(hostPath: string): Promise<SessionDisplayIndex> {
    const pending = this.pending.get(hostPath);
    if (pending) {
      const index = await pending;
      if (await this.isCurrent(index)) return index;
      return this.get(hostPath);
    }
    const epoch = this.epoch;
    // One disk scanner at a time bounds in-flight large-line memory across different sessions too.
    const build = this.buildQueue.then(() => {
      if (epoch !== this.epoch) throw new Error("SESSION_READ_CANCELLED");
      return this.build(hostPath, epoch);
    });
    this.buildQueue = build.then(() => undefined, () => undefined);
    const work = build.then(index => {
      if (epoch !== this.epoch) throw new Error("SESSION_READ_CANCELLED");
      this.cache.delete(hostPath); this.cache.set(hostPath, index);
      while (this.cache.size > CACHE_LIMIT || this.diagnostics().metadataBytes > CACHE_BUDGET_BYTES) {
        const key = this.cache.keys().next().value;
        if (key === undefined) break;
        this.cache.delete(key);
      }
      return index;
    });
    this.pending.set(hostPath, work);
    try { return await work; } finally { if (this.pending.get(hostPath) === work) this.pending.delete(hostPath); }
  }

  async isCurrent(index: SessionDisplayIndex): Promise<boolean> {
    return sessionFileVersion(await stat(index.hostPath)) === index.version;
  }

  private async build(hostPath: string, epoch: number): Promise<SessionDisplayIndex> {
    // Retry once if a writer changes the snapshot. Never publish a mixed old/new index.
    for (let attempt = 0; attempt < 2; attempt++) {
      const version = await stat(hostPath);
      const cached = this.cache.get(hostPath);
      if (cached?.version === sessionFileVersion(version)) return cached;
      const handle = await open(hostPath, "r");
      try {
        if (sessionFileVersion(await handle.stat()) !== sessionFileVersion(version)) continue;
        let append = Boolean(cached && cached.identity === identity(version) && version.size > cached.size && cached.endsWithNewline);
        let prefixHash = createHash("sha256");
        if (append && cached) {
          // Re-read bytes, not JSON: incremental parsing remains cheap but correctness costs bounded prefix IO.
          prefixHash = await hashPrefix(handle, cached.size);
          this.validatedPrefixBytes += cached.size;
          if (prefixHash.copy().digest("hex") !== cached.prefixDigest) { append = false; prefixHash = createHash("sha256"); }
        }
        const entries = append && cached ? new Map(cached.entries) : new Map<string, SessionDisplayEntry>();
        const start = append && cached ? cached.size : 0;
        let metadataBytes = append && cached ? cached.metadataBytes : 0;
        let endsWithNewline = start === version.size;
        this.scans++;
        this.scannedBytes += version.size - start;
        for await (const line of scanJsonl(handle, start, version.size, undefined, chunk => { prefixHash.update(chunk); })) {
          if (epoch !== this.epoch) throw new Error("SESSION_READ_CANCELLED");
          endsWithNewline = line.terminated;
          this.maxLineBytes = Math.max(this.maxLineBytes, line.byteLength);
          const parseStart = performance.now();
          const entry = parseEntry(line.text, line.offset, line.byteLength);
          this.maxParseMs = Math.max(this.maxParseMs, performance.now() - parseStart);
          if (!entry) continue;
          const previous = entries.get(entry.id);
          metadataBytes += entryBytes(entry) - (previous ? entryBytes(previous) : 0);
          if (metadataBytes > INDEX_BUDGET_BYTES) throw new Error("SESSION_METADATA_LIMIT: index budget");
          // A repeated id is a new physical leaf, not the original Map insertion position.
          entries.delete(entry.id); entries.set(entry.id, entry);
        }
        const prefixDigest = prefixHash.digest("hex");
        if (sessionFileVersion(await handle.stat()) !== sessionFileVersion(version) || sessionFileVersion(await stat(hostPath)) !== sessionFileVersion(version)) continue;
        const branch = activeBranch(entries);
        return { hostPath, size: version.size, mtimeMs: version.mtimeMs, version: sessionFileVersion(version), identity: identity(version), entries, activeBranch: branch, activeMessageEntries: branch.filter(e => e.type === "message" && e.hasMessage), hasCompaction: branch.some(e => e.type === "compaction"), endsWithNewline, prefixDigest, metadataBytes };
      } finally { await handle.close(); }
    }
    throw new Error("SESSION_FILE_CHANGED: retry history read");
  }
}
