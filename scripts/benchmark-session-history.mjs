// Isolated, read-only production replay. No Electron app or real Pi process is started.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { stat, mkdtemp, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const mode = option("--mode", "history");
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let peak = process.memoryUsage();
const sample = () => { const m = process.memoryUsage(); for (const k of Object.keys(m)) peak[k] = Math.max(peak[k], m[k]); };
const timer = setInterval(sample, 5);
await new Promise(r => setTimeout(r, 20));
const startMemory = process.memoryUsage();
const results = [];
async function measure(label, action) {
  const start = performance.now();
  const value = await action();
  sample();
  const elapsedMs = performance.now() - start;
  await new Promise(r => setTimeout(r, 20));
  results.push({ label, elapsedMs: Math.round(elapsedMs), ...value });
}
let directory;
try {
  if (mode === "rpc") {
    const { PiRpcClient } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");
    for (const mib of option("--sizes", "16,32,64").split(",").map(Number)) {
      const stdout = new PassThrough();
      const client = new PiRpcClient(new Writable({ write: (_c, _e, cb) => cb() }), stdout);
      let events = 0;
      client.on("event", () => events++);
      // Build the fixture before starting the timing. Feed exactly 64 KiB chunks.
      const line = Buffer.from('{"type":"synthetic","data":"' + "A".repeat(mib * 1024 * 1024) + '"}\n');
      await measure(`${mib}MiB`, async () => {
        for (let offset = 0; offset < line.length; offset += 65536) stdout.emit("data", line.subarray(offset, offset + 65536));
        return { inputBytes: line.length, events, framing: client.getFramingDiagnostics?.() };
      });
      client.close();
    }
  } else {
    const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");
    const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
    const { trimHistoryMessages } = loadTsCommonJs("src/main/pi/agentUtils.ts");
    const projector = new AgentMessageProjector({ translate: () => "summary", isAskAborted: () => false });
    const reader = new SessionHistoryReader({ toHostPath: p => p, convertMessages: (...a) => projector.convert(...a), trimMessages: trimHistoryMessages, translate: () => "summary" });
    let path = option("--session");
    if (!path) {
      directory = await mkdtemp(join(tmpdir(), "pideck-history-bench-"));
      path = join(directory, "synthetic.jsonl");
      // Many old image rows followed by text-only latest turns; streamed fixture creation.
      for (let i = 0; i < 96; i++) await appendFile(path, JSON.stringify({ id: `e${i}`, parentId: i ? `e${i - 1}` : null, type: "message", message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "A".repeat(1024 * 1024) }] } }) + "\n");
      for (let i = 96; i < 116; i++) await appendFile(path, JSON.stringify({ id: `e${i}`, parentId: `e${i - 1}`, type: "message", message: { role: "user", content: [{ type: "text", text: `turn ${i}` }] } }) + "\n");
    }
    const version = await stat(path);
    await measure("cold-recovery", async () => {
      const response = await reader.readRecentMessages(path, 12);
      sample();
      const total = await reader.getActiveEntryCount(path);
      sample();
      const compactions = await reader.scanCompactions(path);
      sample();
      const raw = response.data.messages;
      const projected = projector.convert("bench", raw, response.data.entryIds);
      return { fileBytes: version.size, total, compactions: compactions.compactions.length, rawCount: raw.length, ipcBytes: Buffer.byteLength(JSON.stringify(projected)), readerDiagnostics: reader.getDiagnostics?.() };
    });
    await measure("hot-recovery", async () => {
      const response = await reader.readRecentMessages(path, 12);
      await reader.getActiveEntryCount(path);
      await reader.scanCompactions(path);
      return { rawCount: response.data.messages.length };
    });
    if (directory) {
      await appendFile(path, JSON.stringify({ id: "appended", parentId: "e115", type: "message", message: { role: "user", content: "appended" } }) + "\n");
      await measure("append-recovery", async () => ({ total: await reader.getActiveEntryCount(path) }));
    }
    reader.dispose?.();
  }
} finally {
  await new Promise(r => setTimeout(r, 20));
  sample();
  clearInterval(timer);
  delay.disable();
  if (directory) await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, mode, startMemory, peak, maxRssBytes: process.resourceUsage().maxRSS * 1024, eventLoopDelayMaxMs: Math.round(delay.max / 1e6), results }, null, 2));
