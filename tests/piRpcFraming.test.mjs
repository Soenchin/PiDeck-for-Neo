import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { PiRpcClient } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");
function harness(options) {
  const stdout = new PassThrough();
  const client = new PiRpcClient(new Writable({ write: (_c, _e, cb) => cb() }), stdout, options);
  return { client, stdout };
}
test("RPC preserves Unicode across chunks, CRLF, multiple lines and end tail", () => {
  const { client, stdout } = harness();
  const events = [];
  client.on("event", e => events.push(e));
  const bytes = Buffer.from('{"text":"🙂汉字"}\r\n{"n":2}\n{"tail":true}');
  for (const byte of bytes) stdout.emit("data", Buffer.from([byte]));
  stdout.emit("end");
  assert.equal(events[0].text, "🙂汉字");
  assert.equal(events[1].n, 2);
  assert.equal(events[2].tail, true);
});
test("RPC framing scans each arriving character once rather than accumulated prefixes", () => {
  const { client, stdout } = harness();
  const size = 1024 * 1024;
  const line = '{"text":"' + 'A'.repeat(size) + '"}\n';
  for (let i = 0; i < line.length; i += 1024) stdout.emit("data", line.slice(i, i + 1024));
  const diagnostics = client.getFramingDiagnostics();
  assert.equal(diagnostics.scannedChars, line.length);
  assert.equal(diagnostics.bufferedBytes, 0);
  client.close();
});
test("RPC overflow rejects pending immediately, discards buffers and detaches listeners", async () => {
  const { client, stdout } = harness({ maxLineBytes: 128 });
  const rejected = assert.rejects(client.request({ type: "get_messages" }), /RPC_LINE_LIMIT/);
  const errors = [];
  client.on("protocol-error", e => errors.push(e));
  stdout.emit("data", "A".repeat(129));
  await rejected;
  assert.equal(stdout.listenerCount("data"), 0);
  assert.equal(client.getFramingDiagnostics().bufferedBytes, 0);
  assert.match(String(errors[0]), /RPC_LINE_LIMIT/);
  await assert.rejects(client.request({ type: "get_state" }), /RPC_LINE_LIMIT/);
});
for (const event of ["end", "close", "error"]) {
  test(`RPC ${event} rejects pending without waiting for the timeout`, async () => {
    const { client, stdout } = harness();
    const rejection = assert.rejects(client.request({ type: "get_state" }, 100), /closed|broken/);
    stdout.emit(event, ...(event === "error" ? [new Error("broken")] : []));
    await rejection;
    assert.equal(stdout.listenerCount("data"), 0);
  });
}
test("RPC pending id matching and recoverable protocol pollution remain unchanged", async () => {
  const { client, stdout } = harness();
  const errors = [];
  client.on("protocol-error", e => errors.push(e));
  const response = client.request({ type: "get_state", id: "fixed" });
  stdout.emit("data", 'not-json\r\n{"type":"response","id":"fixed","command":"get_state","success":true}\n');
  assert.equal((await response).id, "fixed");
  assert.equal(errors[0], "not-json");
  client.close();
});

async function ownerHarness() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const state = { kills: 0 };
  child.kill = () => { state.kills++; return true; };
  class BoundedRpc extends PiRpcClient { constructor(stdin, stdout) { super(stdin, stdout, { maxLineBytes: 128 }); } }
  const { PiProcess } = loadTsCommonJs("src/main/pi/PiProcess.ts", { globals: { console: { log() {}, warn() {}, error() {} } }, stubs: {
    "./PiRpcClient": { PiRpcClient: BoundedRpc },
    "node:child_process": { spawn: () => child, execFile: (_c, _a, _o, cb) => { cb(null, "0.85.1", ""); return new EventEmitter(); } },
    "../logging/sharedLogger": { getAppLogger: () => null },
  } });
  const pi = new PiProcess("mock-project", { piRpcNoExtensions: true }, { resolveCommand: () => "mock-pi", createInvocation: (_c, args) => ({ command: "mock-pi", args, shell: false }), createProcessEnv: () => ({}) });
  const errors = [];
  pi.on("error", e => errors.push(String(e)));
  const client = await pi.start();
  return { child, pi, client, state, errors };
}

test("fatal framing overflow invalidates the PiProcess owner and terminates only its mocked child", async () => {
  const { child, pi, client, state, errors } = await ownerHarness();
  const rejected = assert.rejects(client.request({ type: "get_messages" }), /RPC_LINE_LIMIT/);
  child.stdout.emit("data", "A".repeat(129));
  await rejected;
  assert.equal(pi.isRunning(), false);
  assert.equal(state.kills, 1);
  assert.equal(errors.length, 1);
  assert.throws(() => pi.client, /not running/);
  child.emit("exit", null, "SIGTERM");
});

test("normal stdout EOF before exit(0) is not fatal or a forced kill", async () => {
  const { child, pi, state, errors } = await ownerHarness();
  const exits = [];
  pi.on("exit", e => exits.push(e));
  child.stdout.emit("end");
  assert.equal(state.kills, 0);
  assert.equal(errors.length, 0);
  child.emit("exit", 0, null);
  assert.equal(exits[0].code, 0);
  assert.equal(pi.isRunning(), false);
});

test("stdout EOF without child exit fails after a bounded grace period", async () => {
  const { child, pi, state } = await ownerHarness();
  // A ref timer keeps this isolated test alive; production's EOF grace timer is intentionally unref'ed.
  const keepAlive = setTimeout(() => {}, 1500);
  try {
    const failure = new Promise(resolve => pi.once("error", resolve));
    child.stdout.emit("end");
    assert.equal(state.kills, 0);
    assert.match(String(await failure), /RPC.*closed/);
    assert.equal(state.kills, 1);
    assert.equal(pi.isRunning(), false);
  } finally { clearTimeout(keepAlive); child.emit("exit", null, "SIGTERM"); }
});
