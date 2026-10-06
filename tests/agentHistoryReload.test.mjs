import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { mainProcessT } = loadTsCommonJs("src/shared/i18n/mainProcessCopy.ts");
function harness(path, request) {
  const manager = new AgentManager(() => ({ id: "p", name: "P", path: "C:/project" }), () => null, { get: () => ({}) }, {}, undefined, undefined, undefined, (key, params) => mainProcessT("zh-CN", key, params));
  const runtime = { tab: { id: "a", projectId: "p", cwd: "C:/project", title: "Session", status: "idle", sessionPath: path, deckSessionId: "s", runtimeGeneration: 1, createdAt: 1 }, process: { client: { request } } };
  manager.agents.set("a", runtime);
  manager.messages.set("a", []);
  return { manager, runtime };
}
const response = text => ({ type: "response", command: "get_messages", success: true, data: { messages: [{ role: "user", content: text, timestamp: 1 }] } });
const tick = () => new Promise(resolve => setImmediate(resolve));

// New regressions found during independent review; retain the actual call chain.
test("compaction_end reload of a large session never requests unbounded history RPC", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pideck-reload-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "large.jsonl");
  await writeFile(path, JSON.stringify({ id: "old", type: "message", message: { role: "user", content: [{ type: "image", data: "A".repeat(6 * 1024 * 1024) }] } }) + "\n" + JSON.stringify({ id: "new", parentId: "old", type: "message", message: { role: "user", content: "latest" } }) + "\n");
  const calls = [];
  const { manager } = harness(path, async c => { calls.push(c.type); return response("RPC should not load"); });
  // Exercise the actual event entry and production reader, not a policy helper.
  manager.handlePiEvent("a", { type: "compaction_end", result: {} });
  for (let i = 0; i < 100 && !manager.messages.get("a").some(m => m.text === "latest"); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(manager.messages.get("a").some(m => m.text === "latest"));
  assert.equal(calls.filter(c => c === "get_messages" || c === "get_entries").length, 0);
  assert.equal(manager.messages.get("a").find(m => m.text === "latest").meta.entryId, "new");
});
test("history arriving after runtime replacement cannot write into the replacement", async () => {
  let release;
  const { manager, runtime } = harness(undefined, () => new Promise(r => { release = r; }));
  const pending = manager.loadMessages("a", true);
  const replacement = { ...runtime, process: { client: { request: async () => response("replacement") } } };
  manager.agents.set("a", replacement);
  manager.messages.set("a", [{ id: "new", agentId: "a", role: "user", text: "new runtime", timestamp: 10 }]);
  release(response("old runtime"));
  await pending;
  assert.equal(manager.messages.get("a")[0].text, "new runtime");
});
test("overlapping reloads are superseded and late old history cannot win", async () => {
  const releases = [];
  const { manager } = harness(undefined, () => new Promise(r => releases.push(r)));
  const old = manager.loadMessages("a", true);
  const latest = manager.loadMessages("a", true);
  await tick();
  releases[1](response("latest"));
  await latest;
  releases[0](response("old"));
  await old;
  assert.equal(manager.messages.get("a")[0].text, "latest");
});
test("all reloads preserve messages created or updated while history is loading", async () => {
  let release;
  const { manager } = harness(undefined, () => new Promise(r => { release = r; }));
  const running = { id: "stream", agentId: "a", role: "assistant", text: "partial", timestamp: 1, thinking: "in flight" };
  manager.messages.set("a", [running]);
  const pending = manager.loadMessages("a", true);
  running.text = "updated in flight";
  manager.messages.get("a").push({ id: "sent", agentId: "a", role: "user", text: "sent while loading", timestamp: Date.now() });
  release(response("history"));
  await pending;
  const texts = manager.messages.get("a").map(m => m.text);
  assert.ok(texts.includes("sent while loading"));
  assert.ok(texts.includes("updated in flight"));
});

test("file append during delayed RPC triggers bounded reread rather than false success", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pideck-snapshot-reload-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  const oldRow = { id: "old", type: "message", message: { role: "user", content: "old history", timestamp: 1 } };
  await writeFile(path, JSON.stringify(oldRow) + "\n");
  let release;
  let entered;
  const requestEntered = new Promise(r => { entered = r; });
  const { manager } = harness(path, () => { entered(); return new Promise(r => { release = r; }); });
  const pending = manager.loadMessages("a", true);
  await requestEntered;
  await appendFile(path, JSON.stringify({ id: "new", parentId: "old", type: "message", message: { role: "user", content: "sent", timestamp: Date.now() } }) + "\n");
  release(response("old history"));
  await pending;
  assert.ok(manager.messages.get("a").some(m => m.text === "old history"));
  assert.ok(manager.messages.get("a").some(m => m.text === "sent"));
});

test("a delayed partial snapshot and its active updated assistant merge into one identity", async () => {
  let release;
  const { manager } = harness(undefined, () => new Promise(r => { release = r; }));
  manager.messages.set("a", [{ id: "live", agentId: "a", role: "assistant", text: "partial", timestamp: 1 }]);
  manager.activeAssistantMessageIds.set("a", "live");
  const pending = manager.loadMessages("a", true);
  manager.messages.get("a")[0].text = "partial updated";
  release({ type: "response", command: "get_messages", success: true, data: { messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }], timestamp: 1 }] } });
  await pending;
  const assistants = manager.messages.get("a").filter(m => m.role === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, "partial updated");
  assert.equal(manager.activeAssistantMessageIds.get("a"), assistants[0].id);
});

test("a changed runtime generation or a stopped runtime invalidates an outstanding history load", async () => {
  for (const stop of [false, true]) {
    let release;
    const { manager, runtime } = harness(undefined, () => new Promise(r => { release = r; }));
    const pending = manager.loadMessages("a", true);
    if (stop) { manager.agents.delete("a"); manager.messages.delete("a"); }
    else { runtime.tab.runtimeGeneration++; manager.messages.set("a", [{ id: "new", role: "user", text: "generation two", timestamp: 1 }]); }
    release(response("stale"));
    await pending;
    assert.equal(stop ? manager.messages.has("a") : manager.messages.get("a")[0].text, stop ? false : "generation two");
  }
});

test("unknown file size is a display error and never grants an unbounded RPC fallback", async () => {
  const calls = [];
  const { manager, runtime } = harness("C:/missing-pideck-stability/session.jsonl", async c => { calls.push(c); return response("bad fallback"); });
  await assert.rejects(manager.loadMessages("a"), /ENOENT/);
  assert.equal(calls.length, 0);
  assert.equal(runtime.tab.status, "idle");
});

test("large-file edit leaf lookup uses since at the local tail rather than full entries", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pideck-leaf-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  await writeFile(path, JSON.stringify({ id: "tail", type: "message", message: { role: "user", content: "A".repeat(6 * 1024 * 1024) } }) + "\n");
  const commands = [];
  const { manager, runtime } = harness(path, async c => { commands.push(c); return { type: "response", command: c.type, success: true, data: { leafId: "tail" } }; });
  assert.equal(await manager.getActiveSessionLeafId("a", runtime), "tail");
  assert.equal(commands[0].type, "get_entries");
  assert.equal(commands[0].since, "tail");
});

test("actual assistant event timestamps and pending snapshots preserve one evolving message", async () => {
  let release;
  const { manager } = harness(undefined, () => new Promise(r => { release = r; }));
  const message = text => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "pending", timestamp: 1234 });
  manager.handlePiEvent("a", { type: "message_start", message: message("partial") });
  const pending = manager.loadMessages("a", true);
  manager.handlePiEvent("a", { type: "message_update", assistantMessageEvent: { type: "text_end", partial: message("partial updated") } });
  release({ type: "response", command: "get_messages", success: true, data: { messages: [message("partial")] } });
  await pending;
  const assistants = manager.messages.get("a").filter(m => m.role === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, "partial updated");
  assert.equal(assistants[0].timestamp, 1234);
});

test("assistant that settles during history load keeps its completed body without a stale partial copy", async () => {
  let release;
  const { manager } = harness(undefined, () => new Promise(r => { release = r; }));
  const raw = (text, stopReason) => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 1234 });
  manager.handlePiEvent("a", { type: "message_start", message: raw("partial", "pending") });
  const pending = manager.loadMessages("a", true);
  manager.handlePiEvent("a", { type: "message_end", message: raw("completed", "stop") });
  release({ type: "response", command: "get_messages", success: true, data: { messages: [raw("partial", "pending")] } });
  await pending;
  const assistants = manager.messages.get("a").filter(m => m.role === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, "completed");
  assert.equal(assistants[0].stopReason, "stop");
});

test("tool updated while loading wins over an older snapshot with the same toolCallId", async () => {
  let release;
  const { manager } = harness(undefined, () => new Promise(r => { release = r; }));
  manager.upsertToolMessage("a", { toolCallId: "tc", toolName: "bash", args: {} }, "running");
  const pending = manager.loadMessages("a", true);
  manager.upsertToolMessage("a", { toolCallId: "tc", toolName: "bash", result: { content: [{ type: "text", text: "fresh tool output" }] } }, "done");
  release({ type: "response", command: "get_messages", success: true, data: { messages: [{ role: "toolResult", toolCallId: "tc", toolName: "bash", content: [{ type: "text", text: "old tool output" }], timestamp: Date.now() }] } });
  await pending;
  const tools = manager.messages.get("a").filter(m => m.role === "tool");
  assert.equal(tools.length, 1);
  assert.ok(tools[0].meta.detailText.includes("fresh tool output"));
});
