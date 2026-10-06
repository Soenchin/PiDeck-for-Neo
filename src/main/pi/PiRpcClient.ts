import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { RpcLineFramer } from "./RpcLineFramer";

export type RpcResponse = { id?: string; type: "response"; command: string; success: boolean; data?: unknown; error?: string };
type PendingRequest = { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** JSONL RPC transport. Closing any stream releases framing, listeners and every pending request. */
export class PiRpcClient extends EventEmitter {
  private readonly framer: RpcLineFramer;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();
  private closedError?: Error;
  private readonly onData = (chunk: Buffer | string) => this.consumeChunk(chunk);
  private readonly onEnd = () => this.consumeEnd();
  private readonly onClose = () => this.eof();
  private readonly onError = (error: Error) => this.fail(error);

  constructor(private readonly stdin: NodeJS.WritableStream, private readonly stdout: NodeJS.ReadableStream, options?: { maxLineBytes?: number }) {
    super();
    this.framer = new RpcLineFramer(options?.maxLineBytes);
    stdout.on("data", this.onData);
    stdout.on("end", this.onEnd);
    stdout.on("close", this.onClose);
    stdout.on("error", this.onError);
    stdin.on("error", this.onError);
  }
  getFramingDiagnostics() { return this.framer.diagnostics(); }
  isClosed(): boolean { return this.closedError !== undefined; }

  request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = String(command.id ?? randomUUID());
    if (this.pending.has(id)) return Promise.reject(new Error(`RPC duplicate pending id: ${id}`));
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out after ${timeoutMs}ms: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ ...command, id }); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  notify(command: Record<string, unknown>) { this.write(command); }
  /** Extension replies use JSONL without a pending request. */
  sendRaw(payload: Record<string, unknown>) {
    if (this.closedError) throw this.closedError;
    this.stdin.write(`${JSON.stringify(payload)}\n`);
  }
  close(error?: Error) {
    if (this.closedError) return;
    this.closedError = error ?? new Error("RPC client closed before response");
    this.stdout.removeListener("data", this.onData);
    this.stdout.removeListener("end", this.onEnd);
    this.stdout.removeListener("close", this.onClose);
    this.stdout.removeListener("error", this.onError);
    this.stdin.removeListener("error", this.onError);
    this.framer.clear();
    this.decoder.end();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.closedError); }
    this.pending.clear();
  }
  /** EOF may precede a normal child exit; reject pending now but let the owner resolve exit ordering. */
  private eof() {
    if (this.closedError) return;
    const error = new Error("RPC stdout closed before process exit");
    this.close(error);
    this.emit("transport-eof", error);
  }
  /** Fatal stream/limit errors invalidate the process owner, not just this transport's pending map. */
  private fail(error: Error) {
    if (this.closedError) return;
    this.close(error);
    this.emit("transport-fatal", error);
  }
  private write(payload: Record<string, unknown>) {
    if (this.closedError) throw this.closedError;
    this.emit("log", { direction: "send", data: payload });
    this.stdin.write(`${JSON.stringify(payload)}\n`);
  }
  private consumeChunk(chunk: Buffer | string) {
    if (this.closedError) return;
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    try { this.framer.consume(text, line => { this.handleLine(line); return !this.closedError; }); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // An overflow is fatal: never drop a fragment and later parse the remainder as a valid message.
      this.fail(failure);
      this.emit("protocol-error", failure.message);
    }
  }
  private consumeEnd() {
    if (this.closedError) return;
    this.consumeChunk(this.decoder.end());
    this.framer.end(line => { this.handleLine(line); return !this.closedError; });
    this.eof();
  }
  private handleLine(line: string) {
    if (!line.trim() || this.closedError) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.emit("protocol-error", line); return; }
    this.emit("log", { direction: "recv", data: message });
    if (this.isResponse(message) && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id); clearTimeout(pending.timer); pending.resolve(message);
    } else this.emit("event", message);
  }
  private isResponse(value: unknown): value is RpcResponse { return Boolean(value && typeof value === "object" && "type" in value && value.type === "response"); }
}
