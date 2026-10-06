import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const row = (id, parentId, role, content) => JSON.stringify({ id, parentId, type: "message", message: { id: `m-${id}`, role, content } });
function reader(stubs = {}) {
  const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts", { stubs });
  return new SessionHistoryReader({ toHostPath: p => p, convertMessages: (_a, ms, ids = []) => ms.map((m, i) => ({ id: ids[i], role: m.role, text: m.content })), trimMessages: ms => ms, translate: () => "summary" });
}
async function fixture(t, lines) {
  const dir = await fs.mkdtemp(join(tmpdir(), "pideck-stability-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  await fs.writeFile(path, lines.join("\r\n") + "\r\n");
  return path;
}

test("recent history follows the active parent chain, not physical abandoned turns", async t => {
  const path = await fixture(t, [row("u1", null, "user", "旧轮"), row("a1", "u1", "assistant", "旧回复"), row("abandoned", "a1", "user", "弃用"), row("u2", "a1", "user", "最新🙂"), row("a2", "u2", "assistant", "回复")]);
  const result = await reader().readRecentMessages(path, 1);
  assert.equal(result.data.messages.map(m => m.content).join("|"), "最新🙂|回复");
});

test("recent, identity and compaction reads never request a whole-file string", async t => {
  const path = await fixture(t, [row("u1", null, "user", [{ type: "image", data: "A".repeat(1024 * 1024) }]), JSON.stringify({ id: "c", parentId: "u1", type: "compaction", summary: "摘要" }), row("u2", "c", "user", "新轮")]);
  const bounded = reader({ "node:fs/promises": { ...fs, readFile: async () => { throw new Error("UNBOUNDED_READ"); } } });
  const recent = await bounded.readRecentMessages(path, 1);
  assert.equal(recent.data.messages[0].content, "新轮");
  assert.equal(await bounded.getActiveEntryCount(path), 2);
  assert.equal((await bounded.scanCompactions(path)).compactions[0].summary, "摘要");
});

test("growing rewrite with unchanged entry ids invalidates offsets and metadata", async t => {
  const path = await fixture(t, [row("u1", null, "user", "原文"), row("u2", "u1", "assistant", "尾部")]);
  const r = reader();
  await r.getActiveEntryCount(path);
  await fs.writeFile(path, row("u1", null, "assistant", "改文") + "\r\n" + row("u2", "u1", "assistant", "尾部") + "\r\n" + row("u3", "u2", "user", "追加") + "\n");
  const page = await r.readSessionDisplayTurnPage(path);
  assert.equal(page.messages[0].role, "assistant");
});

test("UTF8 long lines, bad lines and a partial tail recover on completion", async t => {
  const path = await fixture(t, [row("u1", null, "user", "🙂汉字".repeat(60000)), "{bad", ""]);
  const r = reader();
  const tail = row("a1", "u1", "assistant", "补全🙂");
  await fs.appendFile(path, tail.slice(0, -5));
  assert.equal(await r.getActiveEntryCount(path), 1);
  await fs.appendFile(path, tail.slice(-5) + "\n");
  const page = await r.readSessionDisplayMessagePage(path);
  assert.equal(page.total, 2);
  assert.equal(page.messages.at(-1).text, "补全🙂");
});

test("compaction summaries come only from the active branch", async t => {
  const path = await fixture(t, [row("u", null, "user", "开始"), JSON.stringify({ id: "discarded-c", parentId: "u", type: "compaction", summary: "弃用压缩" }), row("a", "u", "assistant", "活动")]);
  assert.equal((await reader().scanCompactions(path)).compactions.length, 0);
});

test("an unsampled middle parent rewrite plus append cannot reuse the old branch", async t => {
  const lines = Array.from({ length: 80 }, (_, i) => row(`e${String(i).padStart(2, "0")}`, i ? `e${String(i - 1).padStart(2, "0")}` : null, "user", "A".repeat(500)));
  const path = await fixture(t, lines);
  const r = reader();
  assert.equal(await r.getActiveEntryCount(path), 80);
  const content = await fs.readFile(path, "utf8");
  await fs.writeFile(path, content.replace('"id":"e20","parentId":"e19"', '"id":"e20","parentId":"e00"') + row("e80", "e79", "assistant", "added") + "\n");
  assert.equal(await r.getActiveEntryCount(path), 62);
});

test("same-snapshot concurrent requests share a scan and append parses only new rows", async t => {
  const path = await fixture(t, [row("u1", null, "user", "old")]);
  const r = reader();
  await Promise.all([r.getActiveEntryCount(path), r.scanCompactions(path), r.getSessionIndexVersion(path)]);
  assert.equal(r.getDiagnostics().scans, 1);
  const oldBytes = r.getDiagnostics().scannedBytes;
  const tail = row("u2", "u1", "user", "new") + "\n";
  await fs.appendFile(path, tail);
  assert.equal(await r.getActiveEntryCount(path), 2);
  assert.equal(r.getDiagnostics().scannedBytes - oldBytes, Buffer.byteLength(tail));
  r.dispose();
  assert.equal(r.getDiagnostics().cachedIndexes, 0);
});

test("full text lookup prefers entryId, falls back to native id and invalidates cached edited text", async t => {
  const path = await fixture(t, [row("u1", null, "user", "one"), row("u2", "u1", "assistant", "two")]);
  const r = reader();
  assert.equal((await r.readMessageFullText(path, "m-u1", "u2")).text, "two");
  assert.equal((await r.readMessageFullText(path, "m-u1", "missing")).text, "one");
  await fs.writeFile(path, row("u1", null, "user", "new") + "\n");
  assert.equal((await r.readMessageFullText(path, "m-u1")).text, "new");
});

test("scanner line limit reports a resource error instead of skipping a valid oversized row", async t => {
  const path = await fixture(t, [row("u", null, "user", "X".repeat(256))]);
  const { scanJsonl } = loadTsCommonJs("src/main/pi/JsonlScanner.ts");
  const handle = await fs.open(path, "r");
  try {
    await assert.rejects(async () => { for await (const _line of scanJsonl(handle, 0, (await handle.stat()).size, 128)) {} }, /SESSION_LINE_LIMIT/);
  } finally { await handle.close(); }
});

test("oversized latest turn fails explicitly without hiding valid history", async t => {
  const path = await fixture(t, [row("u", null, "user", "X".repeat(33 * 1024 * 1024))]);
  const r = reader();
  assert.equal(await r.getActiveEntryCount(path), 1);
  await assert.rejects(r.readRecentMessages(path, 1), /SESSION_PAGE_LIMIT/);
});

test("atomic same-length replacement and branch rewind invalidate the cached snapshot", async t => {
  const path = await fixture(t, [row("u1", null, "user", "one"), row("u2", "u1", "user", "two")]);
  const r = reader();
  const before = await r.getSessionIndexVersion(path);
  const replacement = path + ".replacement";
  await fs.writeFile(replacement, row("u1", null, "user", "new") + "\r\n" + row("u2", null, "user", "two") + "\r\n");
  await fs.rename(replacement, path);
  assert.notEqual(await r.getSessionIndexVersion(path), before);
  assert.equal(await r.getActiveEntryCount(path), 1);
});
