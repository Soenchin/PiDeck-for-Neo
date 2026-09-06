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
		setTimeout,
		clearTimeout,
	}, { filename: filePath });
	return module.exports;
}

const {
	buildTitleSource,
	sanitizeGeneratedTitle,
	SessionTitleGenerator,
} = compileModule("src/main/sessions/SessionTitleGenerator.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("buildTitleSource clips first user message and first assistant reply", () => {
	const source = buildTitleSource([
		{ role: "user", text: "帮我修复登录页的样式 bug" },
		{ role: "tool", text: "工具输出不应进入标题来源" },
		{ role: "assistant", text: "好的，我来修复登录页样式" },
		{ role: "assistant", text: "第二条回复不应出现" },
	]);
	assert.match(source, /<user>帮我修复登录页的样式 bug<\/user>/);
	assert.match(source, /<assistant>好的，我来修复登录页样式<\/assistant>/);
	assert.doesNotMatch(source, /工具输出/);
	assert.doesNotMatch(source, /第二条回复/);
});

test("buildTitleSource truncates overlong messages and returns undefined without content", () => {
	const long = "x".repeat(1200);
	const source = buildTitleSource([{ role: "user", text: long }]);
	assert.equal(source.length, "<user></user>".length + 800 + 1);
	assert.match(source, /…<\/user>$/);
	assert.equal(buildTitleSource([]), undefined);
	assert.equal(buildTitleSource([{ role: "user", text: "   " }]), undefined);
});

test("sanitizeGeneratedTitle strips markdown, quotes and prefixes; caps at 15 chars", () => {
	assert.equal(sanitizeGeneratedTitle("## 修复登录页样式"), "修复登录页样式");
	assert.equal(sanitizeGeneratedTitle('标题："修复登录页"'), "修复登录页");
	assert.equal(sanitizeGeneratedTitle("Title: fix login page"), "fix login page");
	assert.equal(sanitizeGeneratedTitle("修复登录页样式。"), "修复登录页样式");
	assert.equal(sanitizeGeneratedTitle("x".repeat(30)), "x".repeat(15));
	assert.equal(sanitizeGeneratedTitle("   "), undefined);
});

function makeDeps(overrides = {}) {
	const calls = { generate: 0, save: 0 };
	let session = overrides.session ?? { canAutoTitle: true };
	const deferred = overrides.deferred ?? null;
	const deps = {
		generate: async () => {
			calls.generate += 1;
			if (deferred) return await deferred.promise;
			return overrides.rawTitle ?? "修复登录页样式";
		},
		getSession: () => session,
		saveTitle: async (_sessionId, title) => {
			calls.save += 1;
			if (!overrides.keepUnsaved) session = { ...session, title };
		},
		debounceMs: 1,
		...overrides.deps,
	};
	return { deps, calls, getSessionState: () => session, setSession: (next) => { session = next; } };
}

test("request generates and saves a sanitized title for auto-titlable sessions", async () => {
	const { deps, calls } = makeDeps();
	const generator = new SessionTitleGenerator(deps);
	generator.request("s1", "<user>问题</user>");
	await sleep(20);
	assert.equal(calls.generate, 1);
	assert.equal(calls.save, 1);
	assert.equal(deps.getSession().title, "修复登录页样式");
});

test("request skips locked sessions and empty sources", async () => {
	const { deps, calls } = makeDeps({
		session: { canAutoTitle: false },
	});
	const generator = new SessionTitleGenerator(deps);
	generator.request("s1", "<user>问题</user>");
	generator.request("s2", undefined);
	await sleep(20);
	assert.equal(calls.generate, 0);
});

test("inferred first-message titles without lock remain overridable (scanner sync race regression)", async () => {
	// 回归：扫描器把首条消息截断名（如「你好」）先写进 catalog，
	// 旧逻辑只认「新会话/未命名会话」为默认标题，生成器会静默跳过。
	// 新契约：资格判定由 getSession.canAutoTitle 表达，推断名（未锁定）可覆盖。
	const { deps, calls } = makeDeps({ session: { canAutoTitle: true } });
	const generator = new SessionTitleGenerator(deps);
	generator.request("s1", "<user>你好</user>");
	await sleep(20);
	assert.equal(calls.generate, 1);
	assert.equal(calls.save, 1);
});

test("manual rename during generation prevents the late auto title from saving", async () => {
	let generateStarted;
	const deferredCreate = () => new Promise((resolve) => { generateStarted = resolve; });
	const { deps, calls, setSession } = makeDeps({ deferred: { promise: deferredCreate() } });
	const generator = new SessionTitleGenerator(deps);
	generator.request("s1", "<user>问题</user>");
	await sleep(10);
	// 生成期间用户手动改名（资格失效）
	setSession({ canAutoTitle: false });
	generateStarted("修复登录页样式");
	await sleep(20);
	assert.equal(calls.save, 0);
});

test("request while in flight queues exactly one follow-up run", async () => {
	const genCalls = [];
	let resolveFirst;
	const { deps, calls } = makeDeps({
		deps: {
			generate: async () => {
				genCalls.push(1);
				if (genCalls.length === 1) {
					return await new Promise((resolve) => { resolveFirst = resolve; });
				}
				return "修复登录页样式";
			},
		},
	});
	const generator = new SessionTitleGenerator(deps);
	generator.request("s1", "<user>问题</user>");
	await sleep(10);
	assert.equal(genCalls.length, 1);
	// 飞行期间再触发（如压缩完成）：只记一次补跑
	generator.request("s1", "<user>问题</user>");
	generator.request("s1", "<user>问题</user>");
	// 第一次生成输出为空 → 不保存，标题保持默认 → 补跑才真正生成
	resolveFirst("   ");
	await sleep(30);
	assert.equal(genCalls.length, 2);
	assert.equal(calls.save, 1);
});

test("generate failure is swallowed without saving or throwing", async () => {
	const { deps, calls } = makeDeps({
		deps: {
			generate: async () => { throw new Error("model unavailable"); },
		},
	});
	const generator = new SessionTitleGenerator(deps);
	generator.request("s1", "<user>问题</user>");
	await sleep(20);
	assert.equal(calls.save, 0);
});
