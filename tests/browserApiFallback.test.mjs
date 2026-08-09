import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadBrowserApiModule() {
	const source = readFileSync("src/renderer/src/browserApi.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const previewProjects = [{ id: "preview-project", name: "Preview" }];
	const previewAgents = [{ id: "preview-agent", title: "Preview Agent" }];
	const sandbox = {
		exports: {},
		// 沙箱 vm context 看不到宿主全局；转发到宿主 fetch，测试替换 globalThis.fetch 时才生效。
		fetch: (url, init) => globalThis.fetch(url, init),
		require: (specifier) => {
			if (specifier === "./i18n") {
				return {
					t: (key, params) => `${key}:${params?.status ?? ""}:${params?.statusText ?? ""}`,
				};
			}
			if (specifier === "./previewApi") {
				return {
					createPreviewApi: () => ({
						projects: {
							list: async () => previewProjects,
						},
						agents: {
							list: async () => previewAgents,
							onState: () => () => undefined,
							onMessages: () => () => undefined,
						},
						sessions: {
							list: async () => [],
						},
						settings: {
							get: async () => ({ webServiceEnabled: false }),
						},
					}),
				};
			}
			throw new Error(`Unexpected require: ${specifier}`);
		},
		window: {
			setInterval: () => 1,
			clearInterval: () => undefined,
			// authToken 只在 http(s) 下从 URL/localStorage 消费；非 http 协议让其保持为空。
			location: { protocol: "file:" },
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "browserApi.ts",
	});
	return sandbox.exports;
}

test("falls back to preview lists only when Vite returns HTML for web state", async () => {
	const { createBrowserApi } = loadBrowserApiModule();
	const previousFetch = globalThis.fetch;
	// Vite dev server 把未知 /api/* 回退到 index.html：200 + text/html。
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		headers: { get: (name) => (name === "content-type" ? "text/html; charset=utf-8" : null) },
		json: async () => {
			throw new Error("Unexpected token <");
		},
	});

	const api = createBrowserApi();

	try {
		const projects = await api.projects.list();
		const agents = await api.agents.list();

		assert.deepEqual(projects, [{ id: "preview-project", name: "Preview" }]);
		assert.deepEqual(agents, [{ id: "preview-agent", title: "Preview Agent" }]);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("real web service failure does not fall back to preview lists", async () => {
	const { createBrowserApi } = loadBrowserApiModule();
	const previousFetch = globalThis.fetch;
	// 真实服务离线：网络错误，不是 Vite 的 HTML 回退。
	globalThis.fetch = async () => {
		throw new Error("network down");
	};

	const api = createBrowserApi();

	try {
		await assert.rejects(async () => {
			await api.projects.list();
		}, /network down/);
		await assert.rejects(async () => {
			await api.agents.list();
		}, /network down/);
	} finally {
		globalThis.fetch = previousFetch;
	}
});
