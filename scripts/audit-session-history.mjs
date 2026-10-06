// Read-only evidence audit. Prints sizes/counts/hash only, never message content or image data.
import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";
const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/audit-session-history.mjs <session.jsonl>");
const { scanJsonl } = loadTsCommonJs("src/main/pi/JsonlScanner.ts");
const snapshot = await stat(path);
const handle = await open(path, "r");
const hash = createHash("sha256");
let lines = 0, invalid = 0, messages = 0, compactions = 0, images = 0, base64Bytes = 0, maxLineBytes = 0;
function countImages(value) {
  if (!value || typeof value !== "object") return;
  if (value.type === "image") {
    const data = value.source?.type === "base64" ? value.source.data : value.data;
    if (typeof data === "string") { images++; base64Bytes += Buffer.byteLength(data); }
  }
  for (const child of Object.values(value)) if (child && typeof child === "object") countImages(child);
}
try {
  for await (const line of scanJsonl(handle, 0, snapshot.size, undefined, data => hash.update(data))) {
    if (!line.text.trim()) continue;
    lines++;
    maxLineBytes = Math.max(maxLineBytes, line.byteLength);
    let entry;
    try { entry = JSON.parse(line.text); } catch { invalid++; continue; }
    if (entry?.type === "message") messages++;
    if (entry?.type === "compaction") compactions++;
    countImages(entry);
  }
  const after = await stat(path);
  if (after.size !== snapshot.size || after.mtimeMs !== snapshot.mtimeMs || after.ctimeMs !== snapshot.ctimeMs || after.ino !== snapshot.ino) throw new Error("File changed during evidence audit");
} finally { await handle.close(); }
console.log(JSON.stringify({ fileBytes: snapshot.size, mtimeMs: snapshot.mtimeMs, lines, invalid, messages, compactions, images, base64Bytes, maxLineBytes, sha256: hash.digest("hex") }, null, 2));
