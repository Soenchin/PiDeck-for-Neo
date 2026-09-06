import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

// ── 以下 loader 与 sessionScannerSubagents.test.mjs 同模式 ──

function loadCodexMetaModule() {
	const source = readFileSync("src/shared/codexSessionMeta.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, { filename: "codexSessionMeta.ts" });
	return sandbox.exports;
}


function loadMessageContentModule() {
	const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
	const docActions = { exports: {} };
	vm.runInNewContext(
		ts.transpileModule(readFileSync("src/main/feishu/docActions.ts", "utf8"), { compilerOptions }).outputText,
		docActions,
		{ filename: "docActions.ts" },
	);
	const messageContent = {
		exports: {},
		require: (id) => {
			if (id === "../feishu/docActions") return docActions.exports;
			throw new Error(`Unexpected messageContent import: ${id}`);
		},
	};
	vm.runInNewContext(
		ts.transpileModule(readFileSync("src/main/pi/messageContent.ts", "utf8"), { compilerOptions }).outputText,
		messageContent,
		{ filename: "messageContent.ts" },
	);
	return messageContent.exports;
}

function loadWslPathsModule() {
	const { outputText } = ts.transpileModule(readFileSync("src/main/wsl/WslPaths.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, require };
	vm.runInNewContext(outputText, sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadFsRetryModule() {
	const { outputText } = ts.transpileModule(readFileSync("src/main/utils/fsRetry.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { clearTimeout, exports: {}, process, require, setTimeout };
	vm.runInNewContext(outputText, sandbox, { filename: "fsRetry.ts" });
	return sandbox.exports;
}

function loadSessionSummaryCacheModule(homePath) {
	const { outputText } = ts.transpileModule(readFileSync("src/main/sessions/sessionSummaryCache.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const fsRetry = loadFsRetryModule();
	const sandbox = {
		clearTimeout: () => undefined,
		exports: {},
		process,
		require: (id) => {
			if (id === "electron") {
				return {
					app: {
						getPath: (name) => name === "userData" ? join(homePath, "user-data") : homePath,
					},
				};
			}
			if (id === "../utils/fsRetry") return fsRetry;
			return require(id);
		},
		setTimeout: () => ({ unref: () => undefined }),
	};
	vm.runInNewContext(outputText, sandbox, { filename: "sessionSummaryCache.ts" });
	return sandbox.exports;
}

function loadSessionNameLineModule() {
	const { outputText } = ts.transpileModule(readFileSync("src/main/sessions/sessionNameLine.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, process, require, setTimeout };
	vm.runInNewContext(outputText, sandbox, { filename: "sessionNameLine.ts" });
	return sandbox.exports;
}

function loadSessionScanner(homePath, fsOverrides = {}) {
	const { outputText } = ts.transpileModule(readFileSync("src/main/sessions/SessionScanner.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const codexMeta = loadCodexMetaModule();
	const messageContent = loadMessageContentModule();
	const sessionSummaryCache = loadSessionSummaryCacheModule(homePath);
	const wslPaths = loadWslPathsModule();
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		process,
		setTimeout,
		require: (id) => {
			if (id === "electron") return { app: { getPath: () => homePath }, shell: {} };
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "../pi/messageContent") return messageContent;
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			if (id === "./sessionNameLine") return loadSessionNameLineModule();
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			if (id === "node:fs") return { ...require(id), ...fsOverrides };
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "SessionScanner.ts" });
	return sandbox.exports;
}

function writeSession(filePath, entries) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function session(name, cwd, message = "hello") {
	return [
		{ type: "session_info", name, cwd },
		{ type: "message", message: { role: "user", content: message } },
	];
}

// ── 嵌套项目归属边界（NeoNext Batch 1 收尾：旧 a6673e77 session hijack 回归）──

test("parent project scan must not hijack child project sessions (encoded-token boundary)", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-boundary-"));
	try {
		const parentProject = "X:/CC/projects";
		const childProject = "X:/CC/projects/PiDeck";
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		// encoded-cwd 目录尾部带 -- 标记：父 token --x--cc-projects-- 不得成为子目录的子串
		writeSession(join(sessionsRoot, "--x--cc-projects--", "parent.jsonl"), session("Parent work", parentProject));
		writeSession(join(sessionsRoot, "--x--cc-projects-pideck--", "child.jsonl"), session("Child work", childProject));

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();

		const parentList = await scanner.list(parentProject);
		const parentPaths = parentList.map((item) => item.filePath);
		assert.equal(parentPaths.some((p) => p.includes("parent.jsonl")), true, "父项目应看到自己的会话");
		assert.equal(
			parentPaths.some((p) => p.includes("child.jsonl")),
			false,
			"父项目扫描不得抢走子项目会话（旧屋 session hijack 回归）",
		);

		const childList = await scanner.list(childProject);
		const childPaths = childList.map((item) => item.filePath);
		assert.equal(childPaths.some((p) => p.includes("child.jsonl")), true, "子项目应看到自己的会话");
		assert.equal(
			childPaths.some((p) => p.includes("parent.jsonl")),
			false,
			"子项目扫描不得抢走父项目会话（父会话文本未提及子项目路径）",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("legacy parent-cwd session shows under child project only when text mentions the child path", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-legacy-"));
	try {
		const parentProject = "X:/CC/projects";
		const childProject = "X:/CC/projects/PiDeck";
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		// 早期用户在父目录启动 pi：cwd 是父目录；正文明确操作子项目 → 允许归属子项目
		writeSession(
			join(sessionsRoot, "--x--cc-projects--", "legacy-mention.jsonl"),
			session("Legacy home session", parentProject, `帮我看下 ${childProject} 的构建问题`),
		);
		// 正文不提及子项目的父目录会话：不得被拖进子项目
		writeSession(
			join(sessionsRoot, "--x--cc-projects--", "legacy-quiet.jsonl"),
			session("Quiet parent session", parentProject),
		);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const childList = await scanner.list(childProject);
		const childPaths = childList.map((item) => item.filePath);
		assert.equal(
			childPaths.some((p) => p.includes("legacy-mention.jsonl")),
			true,
			"提及子项目路径的父目录会话应归属子项目（带内容校验的遗留兼容）",
		);
		assert.equal(
			childPaths.some((p) => p.includes("legacy-quiet.jsonl")),
			false,
			"未提及子项目的父目录会话不得被拖进子项目",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
