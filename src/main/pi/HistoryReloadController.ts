import { stat } from "node:fs/promises";
import type { AgentTab, ChatMessage } from "../../shared/types";
import type { RpcResponse } from "./PiRpcClient";
import type { SessionArchiveData, SessionHistoryReader } from "./SessionHistoryReader";
import { sessionFileVersion } from "./SessionDisplayIndex";
import { messageFingerprint, mergeHistoryWithPreservedMessages } from "./historyMessages";

const MAX_RPC_HISTORY_BYTES = 5 * 1024 * 1024;
const RECENT_TURNS = 12;
type ReloadRuntime = { tab: AgentTab; process: { isRunning?: () => boolean; client: { request: (command: Record<string, unknown>, timeoutMs?: number) => Promise<RpcResponse> } } };
type LocalHistoryData = { messages?: unknown[]; entryIds?: string[]; headOffset?: number; indexVersion?: string; compactions?: SessionArchiveData["compactions"] };
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object"); }
function isCompaction(value: unknown): value is SessionArchiveData["compactions"][number] {
  return record(value) && typeof value.id === "string" && typeof value.summary === "string" && typeof value.timestamp === "string";
}
function localHistoryData(value: unknown): LocalHistoryData | undefined {
  if (!record(value)) return undefined;
  return {
    messages: Array.isArray(value.messages) ? value.messages : undefined,
    entryIds: Array.isArray(value.entryIds) && value.entryIds.every((id): id is string => typeof id === "string") ? value.entryIds : undefined,
    headOffset: typeof value.headOffset === "number" ? value.headOffset : undefined,
    indexVersion: typeof value.indexVersion === "string" ? value.indexVersion : undefined,
    compactions: Array.isArray(value.compactions) && value.compactions.every(isCompaction) ? value.compactions : undefined,
  };
}

/** Content comparison for reload races: tool identity fingerprints intentionally omit changing tool output. */
function reloadFingerprint(message: ChatMessage): string {
  const content = message.role === "tool" ? `${message.text}\u0000${String(message.meta?.detailText ?? "")}\u0000${String(message.meta?.status ?? "")}` : "";
  return `${messageFingerprint(message)}\u0000${message.stopReason ?? ""}\u0000${content}`;
}

/** Shared admission, supersession and preservation policy for every AgentManager history reload. */
export class HistoryReloadController {
  private readonly latest = new Map<string, symbol>();
  clear(agentId?: string) { if (agentId) this.latest.delete(agentId); else this.latest.clear(); }

  /** Leaf lookup before file edits must obey the same large-file admission as history reload. */
  async requestActiveLeaf(runtime: ReloadRuntime, reader: SessionHistoryReader, toHostPath: (path: string) => string): Promise<RpcResponse> {
    const path = runtime.tab.sessionPath;
    let since: string | undefined;
    if (path && (await stat(toHostPath(path))).size > MAX_RPC_HISTORY_BYTES) {
      since = await reader.getActiveLeafId(path);
      if (!since) throw new Error("SESSION_LEAF_UNAVAILABLE");
      // Pi returns its actual leaf even when entries since the local physical tail are empty.
      // This preserves rewind/edit semantics without transporting historic image entries.
    }
    return runtime.process.client.request({ type: "get_entries", ...(since ? { since } : {}) }, 15_000);
  }

  begin(agentId: string, runtime: ReloadRuntime, getRuntime: () => ReloadRuntime | undefined, messages: ChatMessage[], isInitiallyInFlight?: (m: ChatMessage) => boolean) {
    const token = Symbol(agentId);
    const process = runtime.process;
    const client = process.client;
    this.latest.set(agentId, token);
    const path = runtime.tab.sessionPath;
    const sessionId = runtime.tab.deckSessionId;
    const piSessionId = runtime.tab.sessionId;
    const generation = runtime.tab.runtimeGeneration;
    const initial = new Map(messages.map(m => [m.id, reloadFingerprint(m)]));
    const initialInFlight = new Set(messages.filter(m => isInitiallyInFlight?.(m)).map(m => m.id));
    const startedAt = Date.now();
    let fileVersion: string | undefined;
    let forceLocal = false;
    let earlyUsed = false;
    const isCurrent = () => this.latest.get(agentId) === token && getRuntime() === runtime && runtime.process === process && process.isRunning?.() !== false && process.client === client && runtime.tab.sessionPath === path && runtime.tab.deckSessionId === sessionId && runtime.tab.sessionId === piSessionId && runtime.tab.runtimeGeneration === generation;
    return {
      isCurrent,
      retrySnapshot: async <T>(action: () => Promise<T>, obsolete: () => T): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          try { return await action(); }
          catch (error) {
            if (!isCurrent()) return obsolete();
            if (attempt === 0 && String(error).includes("SESSION_FILE_CHANGED")) { forceLocal = true; continue; }
            throw error;
          }
        }
      },
      /** Explicit finish removes the token; clearing/replacement makes all older tickets stale. */
      finish: () => { if (this.latest.get(agentId) === token) this.latest.delete(agentId); },
      fileIsCurrent: async (toHostPath: (path: string) => string) => !path || !fileVersion || sessionFileVersion(await stat(toHostPath(path))) === fileVersion,
      version: () => fileVersion,
      preserve: (history: ChatMessage[], current: ChatMessage[], preserveAfter?: number, isInFlight?: (m: ChatMessage) => boolean) => {
        const tracked = (m: ChatMessage) => initialInFlight.has(m.id) || Boolean(isInFlight?.(m));
        const preserved = current.filter(m => m.meta?.historyLoading !== true && (m.timestamp >= (preserveAfter ?? startedAt) || initial.get(m.id) !== reloadFingerprint(m) || tracked(m)));
        // Active assistant identity, not equal text, relates a partial snapshot to its evolving live copy.
        // Exact Pi timestamps (or entryId) avoid matching a separate repeated answer in an earlier turn.
        const nextHistory = [...history];
        const matched = new Set<string>();
        for (const live of preserved) {
          if (live.role !== "assistant" && live.role !== "tool") continue;
          const position = nextHistory.findLastIndex(projected => live.role === "tool"
            ? projected.role === "tool" && typeof live.meta?.toolCallId === "string" && live.meta.toolCallId === projected.meta?.toolCallId
            : tracked(live) && projected.role === "assistant" && (!projected.stopReason || projected.stopReason === "pending") && (
              live.meta?.entryId && live.meta.entryId === projected.meta?.entryId ||
              live.timestamp > 0 && live.timestamp === projected.timestamp
            ));
          if (position < 0) continue;
          const projected = nextHistory[position];
          const changed = initial.get(live.id) !== reloadFingerprint(live);
          const latest = changed || live.text.length + (live.thinking?.length ?? 0) >= projected.text.length + (projected.thinking?.length ?? 0) ? live : projected;
          nextHistory[position] = { ...latest, id: live.id, meta: { ...projected.meta, ...latest.meta, entryId: projected.meta?.entryId ?? latest.meta?.entryId } };
          matched.add(live.id);
        }
        return mergeHistoryWithPreservedMessages(nextHistory, preserved.filter(m => !matched.has(m.id)), -Infinity);
      },
      read: async (reader: SessionHistoryReader, toHostPath: (path: string) => string, timeoutMs: number, skipEntries: boolean, early?: Promise<RpcResponse>) => {
        let large = false;
        if (path) {
          // Unknown size is not permission for an unbounded RPC. Stat/read failures are display failures only.
          const version = await stat(toHostPath(path));
          fileVersion = sessionFileVersion(version);
          large = version.size > MAX_RPC_HISTORY_BYTES;
        }
        if (!isCurrent()) return undefined;
        let response: RpcResponse;
        let entriesResult: RpcResponse | undefined;
        let local = false;
        if ((large || forceLocal) && path) {
          // An obsolete eager request must not become an unhandled rejection; no caller should send it now.
          void early?.catch(() => undefined);
          response = await reader.readRecentMessages(path, RECENT_TURNS);
          local = true;
        } else {
          const messages = !earlyUsed && early ? early : client.request({ type: "get_messages" }, timeoutMs);
          earlyUsed = true;
          const entries = skipEntries ? undefined : client.request({ type: "get_entries" }, 15_000).catch(() => undefined);
          try { [response, entriesResult] = await Promise.all([messages, entries]); }
          catch (error) {
            if (!path || !isCurrent()) throw error;
            // All retries/fallbacks remain bounded, even if the file grew after admission.
            response = await reader.readRecentMessages(path, RECENT_TURNS);
            local = true;
          }
        }
        if (!response.success) throw new Error(response.error ?? "History RPC failed");
        const data = local ? localHistoryData(response.data) : undefined;
        if (data?.indexVersion) fileVersion = data.indexVersion;
        return { response, entriesResult, localData: data, local };
      },
    };
  }
}
