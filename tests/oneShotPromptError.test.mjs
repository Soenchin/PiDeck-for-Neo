// OneShotPrompt 错误传播与参数契约测试（2026-09-06 自动标题全空回归）。
// 背景：pi 生成失败时以 stopReason:"error" + errorMessage 的空 assistant 消息收尾，
// 旧实现一律 resolve(collected.join(""))，失败被吞成空串，上层无法感知。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compileModule(filePath, imports = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => imports[specifier];
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: localRequire,
		console,
		setTimeout,
		clearTimeout,
	}, { filename: filePath });
	return module.exports;
}

// ── fake pi 子进程与 RPC 客户端 ──

let spawnedArgs = null;
let eventScript = null;

function makeFakeChild() {
	const child = new EventEmitter();
	child.stdin = { write() {} };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = () => {};
	return child;
}

class FakeRpcClient {
	on(name, cb) {
		if (name === "event") this.emitEvent = cb;
	}
	off() {}
	async request(command) {
		if (command.type === "set_model") return { success: true };
		if (command.type === "prompt") {
			const emit = this.emitEvent;
			const script = eventScript ?? [];
			queueMicrotask(() => { for (const event of script) emit(event); });
			return { success: true };
		}
		return { success: true };
	}
}

function loadModule() {
	spawnedArgs = null;
	return compileModule("src/main/pi/OneShotPrompt.ts", {
		"node:child_process": {
			spawn: (_command, args) => {
				spawnedArgs = args;
				return makeFakeChild();
			},
		},
		"./PiRpcClient": { PiRpcClient: FakeRpcClient },
	});
}

function makeDeps() {
	return {
		piLocator: {
			resolveCommand: () => "pi-fake",
			createInvocation: (command, args) => ({ command, args, shell: false }),
			createProcessEnv: () => ({}),
		},
		settingsStore: { get: () => ({ customPiPath: "", wslEnabled: false }) },
		log: { warn: () => {} },
	};
}

const input = {
	cwd: "X:/fake/project",
	model: { provider: "GLM", modelId: "glm-5.3-flash" },
	prompt: "生成标题",
	timeoutMs: 2000,
};

test("rejects with pi errorMessage instead of resolving empty text on generation failure", async () => {
	const { runOneShotPrompt } = loadModule();
	// 复现 GLM 1210（始终思考型模型 + 强制 off）失败形态：空 assistant 消息 + errorMessage
	eventScript = [
		{ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: '400: {"code":"1210","message":"该模型始终思考，不支持关闭思考"}' } },
		{ type: "agent_end" },
	];
	await assert.rejects(
		runOneShotPrompt(makeDeps(), input),
		/1210/,
	);
});

test("resolves collected text deltas on successful generation", async () => {
	const { runOneShotPrompt } = loadModule();
	eventScript = [
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "修复登录" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "页样式" } },
		{ type: "agent_end" },
	];
	const text = await runOneShotPrompt(makeDeps(), input);
	assert.equal(text, "修复登录页样式");
});

test("one-shot invocation must not force --thinking off", async () => {
	const { runOneShotPrompt } = loadModule();
	eventScript = [{ type: "agent_end" }];
	await runOneShotPrompt(makeDeps(), input);
	// 回归：强制 off 会让始终思考型模型直接 400（2026-09-06 GLM glm-5.3-flash）
	assert.ok(Array.isArray(spawnedArgs));
	assert.equal(spawnedArgs.includes("--thinking"), false);
});
