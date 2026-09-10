import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

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
	const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
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

// sessionIdentity 是相对导入（../../shared/sessionIdentity），localRequire 以测试文件为基准解析不到，
// 必须单独编译后按原 specifier 注入（与 sessionCatalog.test.mjs 同模式）
const sessionIdentity = compileModule("src/shared/sessionIdentity.ts");
const { SessionPreferenceStore } = compileModule("src/main/sessions/SessionPreferenceStore.ts", {
	"../../shared/sessionIdentity": sessionIdentity,
});
const { getProjectAgentSessionDisplay } = compileModule("src/renderer/src/agentListDisplay.ts", {
	"../../shared/sessionIdentity": sessionIdentity,
});

// vm 侧数组用 vm realm 的 Array species，deepStrictEqual 会因原型不同误报；
// 用测试侧 Array.from 重建普通数组后再比较。
function childIds(display) {
	return Array.from(display.visibleChildren, (child) => child.session.id);
}

async function makeStoreFile() {
	const dir = await mkdtemp(join(tmpdir(), "session-pref-"));
	return { dir, path: join(dir, "session-preferences.json") };
}

function makeSession(overrides = {}) {
	const id = overrides.id ?? "s1";
	return {
		id,
		filePath: `C:/proj/${id}.jsonl`,
		name: id,
		preview: "",
		updatedAt: overrides.updatedAt ?? 0,
		messageCount: 1,
		pinned: overrides.pinned,
		pinnedAt: overrides.pinnedAt,
	};
}

test("setPinned persists across store instances and round-trips", async () => {
	const { dir, path } = await makeStoreFile();
	try {
		const store = new SessionPreferenceStore(path);
		await store.load();
		assert.equal(store.isPinned("C:/Proj/a.jsonl", "native"), false);
		const pinnedAt = await store.setPinned("C:\\Proj\\a.jsonl", "native", true);
		assert.equal(typeof pinnedAt, "number");
		// 大小写/斜杠差异归一化到同一个键（native 环境不区分大小写）
		assert.equal(store.isPinned("C:/proj/a.jsonl", "native"), true);

		const reopened = new SessionPreferenceStore(path);
		await reopened.load();
		assert.equal(reopened.isPinned("C:/Proj/A.JSONL", "native"), true);
		assert.equal(typeof reopened.get("C:/proj/a.jsonl", "native")?.pinnedAt, "number");

		const raw = JSON.parse(await readFile(path, "utf8"));
		assert.equal(raw.version, 1);
		assert.ok(raw.sessions["native:c:/proj/a.jsonl"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("unpin removes the entry and writes through", async () => {
	const { dir, path } = await makeStoreFile();
	try {
		const store = new SessionPreferenceStore(path);
		await store.load();
		await store.setPinned("C:/proj/a.jsonl", "native", true);
		const result = await store.setPinned("C:/proj/a.jsonl", "native", false);
		assert.equal(result, undefined);
		assert.equal(store.isPinned("C:/proj/a.jsonl", "native"), false);
		const raw = JSON.parse(await readFile(path, "utf8"));
		assert.deepEqual(raw.sessions, {});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("wsl and native environments keep separate preference keys", async () => {
	const { dir, path } = await makeStoreFile();
	try {
		const store = new SessionPreferenceStore(path);
		await store.load();
		await store.setPinned("/mnt/c/proj/a.jsonl", "wsl", true);
		// 同一路径在 native 环境是另一个键：互不影响
		assert.equal(store.isPinned("/mnt/c/proj/a.jsonl", "native"), false);
		assert.equal(store.isPinned("/mnt/c/proj/a.jsonl", "wsl"), true);
		// wsl 路径区分大小写
		assert.equal(store.isPinned("/mnt/c/Proj/A.jsonl", "wsl"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("corrupted preference file falls back to an empty usable state", async () => {
	const { dir, path } = await makeStoreFile();
	try {
		await writeFile(path, "{ this is not json", "utf8");
		const store = new SessionPreferenceStore(path);
		await store.load();
		assert.equal(store.isPinned("C:/proj/a.jsonl", "native"), false);
		await store.setPinned("C:/proj/a.jsonl", "native", true);
		const raw = JSON.parse(await readFile(path, "utf8"));
		assert.equal(raw.version, 1);
		assert.ok(raw.sessions["native:c:/proj/a.jsonl"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("prune removes preferences for sessions that no longer exist", async () => {
	const { dir, path } = await makeStoreFile();
	try {
		const store = new SessionPreferenceStore(path);
		await store.load();
		await store.setPinned("C:/proj/kept.jsonl", "native", true);
		await store.setPinned("C:/proj/gone.jsonl", "native", true);
		await store.prune([
			{ filePath: "C:/proj/kept.jsonl", environment: "native" },
			{ filePath: "C:/proj/other.jsonl", environment: "native" },
		]);
		assert.equal(store.isPinned("C:/proj/kept.jsonl", "native"), true);
		assert.equal(store.isPinned("C:/proj/gone.jsonl", "native"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("legacy bare-path keys are upgraded to environment-prefixed keys on load", async () => {
	const { dir, path } = await makeStoreFile();
	try {
		// 旧屋 0.6.x 格式：裸规范化路径键（正斜杠+小写），无环境前缀
		await writeFile(path, JSON.stringify({
			version: 1,
			sessions: {
				"c:/proj/a.jsonl": { pinnedAt: 100 },
				"/mnt/c/proj/b.jsonl": { pinnedAt: 200 },
				"native:c:/proj/c.jsonl": { pinnedAt: 300 },
				"broken-entry": { pinnedAt: "not-a-number" },
			},
		}), "utf8");
		const store = new SessionPreferenceStore(path);
		await store.load();
		// native 裸键：大小写不敏感匹配（含盘符冒号，不能被误判为新格式）
		assert.equal(store.isPinned("C:/PROJ/A.JSONL", "native"), true);
		// wsl 裸键：按路径开头识别
		assert.equal(store.isPinned("/mnt/c/proj/b.jsonl", "wsl"), true);
		// 新格式键原样保留
		assert.equal(store.isPinned("c:/proj/c.jsonl", "native"), true);
		// 非法值条目被丢弃
		assert.equal(store.isPinned("broken-entry", "native"), false);
		// 升级后回写：裸键消失，新键落盘
		const raw = JSON.parse(await readFile(path, "utf8"));
		assert.deepEqual(Object.keys(raw.sessions).sort(), [
			"native:c:/proj/a.jsonl",
			"native:c:/proj/c.jsonl",
			"wsl:/mnt/c/proj/b.jsonl",
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("legacy migration runs once: upgraded file loads without rewriting", async () => {
	const { dir, path } = await makeStoreFile();
	try {
		await writeFile(path, JSON.stringify({
			version: 1,
			sessions: { "c:/proj/a.jsonl": { pinnedAt: 100 } },
		}), "utf8");
		const store = new SessionPreferenceStore(path);
		await store.load();
		const upgraded = JSON.parse(await readFile(path, "utf8"));
		assert.ok(upgraded.sessions["native:c:/proj/a.jsonl"]);
		// 二次加载（新实例读升级后的文件）不再改写
		const reopened = new SessionPreferenceStore(path);
		await reopened.load();
		const again = JSON.parse(await readFile(path, "utf8"));
		assert.deepEqual(again, upgraded);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pinned sessions sort first by pinnedAt and keep all visible beyond the child limit", () => {
	const sessions = [
		makeSession({ id: "s1", updatedAt: 100 }),
		makeSession({ id: "s2", updatedAt: 500 }),
		makeSession({ id: "s3", updatedAt: 400 }),
		makeSession({ id: "s4", updatedAt: 300 }),
		makeSession({ id: "s5", updatedAt: 200, pinned: true, pinnedAt: 20 }),
		makeSession({ id: "s6", updatedAt: 50, pinned: true, pinnedAt: 10 }),
	];
	const display = getProjectAgentSessionDisplay({ agents: [], sessions, visibleChildCount: 5 });
	// 置顶组按 pinnedAt 倒序；普通会话按更新时间倒序补足剩余名额
	assert.deepEqual(
		childIds(display),
		["s5", "s6", "s2", "s3", "s4"],
	);
	assert.equal(display.hiddenChildCount, 1);
});

test("all pinned sessions stay visible even when they exceed the limit", () => {
	const sessions = [
		makeSession({ id: "s1", updatedAt: 100, pinned: true, pinnedAt: 3 }),
		makeSession({ id: "s2", updatedAt: 500, pinned: true, pinnedAt: 2 }),
		makeSession({ id: "s3", updatedAt: 400, pinned: true, pinnedAt: 1 }),
		makeSession({ id: "s4", updatedAt: 300 }),
	];
	const display = getProjectAgentSessionDisplay({ agents: [], sessions, visibleChildCount: 2 });
	assert.deepEqual(
		childIds(display),
		["s1", "s2", "s3"],
	);
	assert.equal(display.hiddenChildCount, 1);
});

test("unpinned sessions keep the original recency order and limit", () => {
	const sessions = [
		makeSession({ id: "s1", updatedAt: 100 }),
		makeSession({ id: "s2", updatedAt: 500 }),
		makeSession({ id: "s3", updatedAt: 400 }),
	];
	const display = getProjectAgentSessionDisplay({ agents: [], sessions, visibleChildCount: 2 });
	assert.deepEqual(
		childIds(display),
		["s2", "s3"],
	);
	assert.equal(display.hiddenChildCount, 1);
});
