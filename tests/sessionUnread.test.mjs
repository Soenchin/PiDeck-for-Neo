import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compileModule(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		console,
	}, { filename: filePath });
	return module.exports;
}

const { shouldMarkSessionUnread, markSessionsUnread, clearSessionUnread } =
	compileModule("src/renderer/src/sessionUnread.ts");

test("background finish marks unread: working status settles while session is not focused", () => {
	assert.equal(shouldMarkSessionUnread({
		sessionId: "s1",
		focusedSessionId: "s2",
		previousStatus: "running",
		nextStatus: "idle",
	}), true);
	assert.equal(shouldMarkSessionUnread({
		sessionId: "s1",
		focusedSessionId: "s2",
		previousStatus: "starting",
		nextStatus: "error",
	}), true);
	assert.equal(shouldMarkSessionUnread({
		sessionId: "s1",
		focusedSessionId: "s2",
		previousStatus: "waiting",
		nextStatus: "idle",
	}), true);
});

test("focused session never gets an unread mark", () => {
	assert.equal(shouldMarkSessionUnread({
		sessionId: "s1",
		focusedSessionId: "s1",
		previousStatus: "running",
		nextStatus: "idle",
	}), false);
});

test("initial snapshot without a previous status does not mark unread", () => {
	// 启动时全量快照里的 idle 会话不算「刚完成」
	assert.equal(shouldMarkSessionUnread({
		sessionId: "s1",
		focusedSessionId: "s2",
		previousStatus: undefined,
		nextStatus: "idle",
	}), false);
});

test("non-finish transitions do not mark unread", () => {
	const base = { sessionId: "s1", focusedSessionId: "s2" };
	assert.equal(shouldMarkSessionUnread({ ...base, previousStatus: "running", nextStatus: "running" }), false);
	assert.equal(shouldMarkSessionUnread({ ...base, previousStatus: "idle", nextStatus: "idle" }), false);
	assert.equal(shouldMarkSessionUnread({ ...base, previousStatus: "idle", nextStatus: "running" }), false);
	assert.equal(shouldMarkSessionUnread({ ...base, previousStatus: "detached", nextStatus: "idle" }), false);
});

test("markSessionsUnread is additive and returns the same reference when nothing changes", () => {
	const state = new Set(["s1"]);
	const next = markSessionsUnread(state, ["s2"]);
	assert.deepEqual([...next].sort(), ["s1", "s2"]);
	assert.equal(markSessionsUnread(next, ["s2", ""]), next);
	// 空字符串 id 不入集合
	assert.equal(next.has(""), false);
});

test("clearSessionUnread removes the viewed session and keeps others", () => {
	const state = new Set(["s1", "s2"]);
	const next = clearSessionUnread(state, "s1");
	assert.deepEqual([...next], ["s2"]);
	assert.equal(clearSessionUnread(next, "s9"), next);
});
