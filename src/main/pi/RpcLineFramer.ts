const DEFAULT_MAX_LINE_BYTES = 128 * 1024 * 1024;

/** Only searches newly decoded chunks. An unfinished JSON line is joined exactly once at its delimiter. */
export class RpcLineFramer {
  private fragments: string[] = [];
  private smallFragments: string[] = [];
  private smallChars = 0;
  private bufferedBytes = 0;
  private scannedChars = 0;
  constructor(private readonly maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error("Invalid RPC line budget");
  }
  diagnostics() { return { scannedChars: this.scannedChars, bufferedBytes: this.bufferedBytes }; }
  clear() { this.fragments = []; this.smallFragments = []; this.smallChars = 0; this.bufferedBytes = 0; }
  consume(text: string, onLine: (line: string) => boolean) {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      this.scannedChars += end - start + (newline < 0 ? 0 : 1);
      this.append(text.slice(start, end));
      if (newline < 0) return;
      if (!onLine(this.takeLine())) return;
      start = newline + 1;
    }
  }
  end(onLine: (line: string) => boolean) { if (this.bufferedBytes) onLine(this.takeLine()); }
  private append(part: string) {
    const bytes = Buffer.byteLength(part);
    if (this.bufferedBytes + bytes > this.maxLineBytes) throw new Error(`RPC_LINE_LIMIT: limit=${this.maxLineBytes}, received=${this.bufferedBytes + bytes}`);
    this.bufferedBytes += bytes;
    if (part) { this.smallFragments.push(part); this.smallChars += part.length; }
    // A malicious stream of 1-byte chunks must not allocate millions of fragment array slots.
    if (this.smallChars >= 65536 || this.smallFragments.length >= 4096) this.flushSmallFragments();
  }
  private flushSmallFragments() {
    if (this.smallFragments.length) this.fragments.push(this.smallFragments.join(""));
    this.smallFragments = []; this.smallChars = 0;
  }
  private takeLine(): string {
    this.flushSmallFragments();
    const line = this.fragments.join("");
    this.clear();
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }
}
