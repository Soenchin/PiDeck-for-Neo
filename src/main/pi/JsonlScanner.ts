import type { FileHandle } from "node:fs/promises";

/** A single line is still parsed as JSON; cap it explicitly instead of silently losing valid history. */
export const MAX_HISTORY_LINE_BYTES = 128 * 1024 * 1024;
export const MAX_HISTORY_PAGE_BYTES = 32 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 256 * 1024;

export type JsonlLine = { text: string; offset: number; byteLength: number; terminated: boolean };

/** Scan a fixed byte range once. Buffer fragments preserve UTF-8 split across reads and true offsets. */
export async function* scanJsonl(
  handle: FileHandle,
  start: number,
  end: number,
  maxLineBytes = MAX_HISTORY_LINE_BYTES,
  onChunk?: (chunk: Buffer) => void,
): AsyncGenerator<JsonlLine> {
  let fragments: Buffer[] = [];
  let lineBytes = 0;
  let lineOffset = start;
  let position = start;
  while (position < end) {
    const chunk = Buffer.allocUnsafe(Math.min(SCAN_CHUNK_BYTES, end - position));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) throw new Error("SESSION_FILE_CHANGED: truncated during scan");
    const data = chunk.subarray(0, bytesRead);
    onChunk?.(data);
    position += bytesRead;
    let cursor = 0;
    while (cursor < data.length) {
      const newline = data.indexOf(10, cursor);
      const stop = newline < 0 ? data.length : newline;
      const part = data.subarray(cursor, stop);
      lineBytes += part.length;
      if (lineBytes > maxLineBytes) throw new Error(`SESSION_LINE_LIMIT: ${lineOffset}:${lineBytes}`);
      if (part.length) fragments.push(part);
      if (newline < 0) break;
      const text = Buffer.concat(fragments, lineBytes).toString("utf8");
      yield { text, offset: lineOffset, byteLength: lineBytes, terminated: true };
      lineOffset += lineBytes + 1;
      fragments = [];
      lineBytes = 0;
      cursor = newline + 1;
    }
  }
  if (lineBytes) yield { text: Buffer.concat(fragments, lineBytes).toString("utf8"), offset: lineOffset, byteLength: lineBytes, terminated: false };
}

/** Read one indexed row at a time; short reads are never parsed as an apparently valid stale row. */
export async function readJsonlRow(handle: FileHandle, offset: number, byteLength: number): Promise<unknown> {
  if (byteLength > MAX_HISTORY_LINE_BYTES) throw new Error(`SESSION_LINE_LIMIT: ${offset}:${byteLength}`);
  const buffer = Buffer.allocUnsafe(byteLength);
  let consumed = 0;
  while (consumed < byteLength) {
    const { bytesRead } = await handle.read(buffer, consumed, byteLength - consumed, offset + consumed);
    if (!bytesRead) throw new Error("SESSION_FILE_CHANGED: truncated during row read");
    consumed += bytesRead;
  }
  return JSON.parse(buffer.toString("utf8").replace(/\r$/, ""));
}
