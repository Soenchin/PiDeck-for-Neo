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
	
	// 跟踪定时器，用于测试后清理
	const timers = new Set();
	
	const sandbox = {
		exports: {},
		console: {
			log: () => undefined,
			error: () => undefined,
		},
		AbortController: globalThis.AbortController,
		fetch: (url, init) => globalThis.fetch(url, init),
		require: (specifier) => {
			if (specifier === "./i18n") {
				return {
					t: (key) => key,
				};
			}
			if (specifier === "./previewApi") {
				return {
					createPreviewApi: () => ({
						projects: { list: async () => [] },
						agents: {
							list: async () => [],
							onState: () => () => undefined,
							onMessages: () => () => undefined,
						},
						sessions: { list: async () => [] },
						settings: { get: async () => ({}) },
					}),
				};
			}
			throw new Error(`Unexpected require: ${specifier}`);
		},
		window: {
			location: { protocol: "http:", search: "" },
			localStorage: {
				getItem: () => null,
				setItem: () => undefined,
				removeItem: () => undefined,
			},
			history: {
				replaceState: () => undefined,
			},
			setInterval: () => 1,
			clearInterval: () => undefined,
			addEventListener: () => undefined,
		},
		document: {
			visibilityState: "visible",
			addEventListener: () => undefined,
		},
		setTimeout: (fn, ms) => {
			const id = globalThis.setTimeout(fn, ms);
			timers.add(id);
			return id;
		},
		clearTimeout: (id) => {
			timers.delete(id);
			globalThis.clearTimeout(id);
		},
	};
	
	vm.runInNewContext(outputText, sandbox, { filename: "browserApi.ts" });
	
	// 返回模块和清理函数
	return {
		...sandbox.exports,
		cleanup: () => {
			for (const id of timers) {
				globalThis.clearTimeout(id);
			}
			timers.clear();
		},
	};
}

test("SSE event parsing survives network fragmentation across event/data lines", async () => {
	const module = loadBrowserApiModule();
	const { createBrowserApi, setWebAuthToken, cleanup } = module;
	setWebAuthToken("test-token");
	
	let readIndex = 0;
	const fragments = [
		// 第一个分片：只有 event: 行
		"event: state\n",
		// 第二个分片：data 行和结束空行
		'data: {"projects":[],"agents":[]}\n\n',
	];

	const mockBody = {
		getReader: () => ({
			read: async () => {
				if (readIndex >= fragments.length) {
					return { done: true, value: undefined };
				}
				const chunk = new TextEncoder().encode(fragments[readIndex++]);
				return { done: false, value: chunk };
			},
		}),
	};

	const previousFetch = globalThis.fetch;
	const stateUpdates = [];
	
	try {
		globalThis.fetch = async (url) => {
			if (url === "/api/events") {
				return {
					ok: true,
					status: 200,
					body: mockBody,
				};
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const api = createBrowserApi();
		const unsubscribe = api.agents.onState((agents) => {
			stateUpdates.push(agents);
		});

		// 等待事件处理
		await new Promise((resolve) => setTimeout(resolve, 200));
		
		unsubscribe();
		
		// 断言：跨分片的事件应该被正确解析
		// 当前实现会丢失这个事件，因为 event 和 data 在不同的 lines 处理批次中
		assert.equal(stateUpdates.length, 1, "Should receive 1 state update from fragmented SSE event");
	} finally {
		globalThis.fetch = previousFetch;
		cleanup();
	}
});

test("SSE reconnects after normal EOF (done: true)", { timeout: 5000 }, async () => {
	const module = loadBrowserApiModule();
	const { createBrowserApi, setWebAuthToken, cleanup } = module;
	setWebAuthToken("test-token");
	
	let connectionCount = 0;
	const previousFetch = globalThis.fetch;
	
	try {
		globalThis.fetch = async (url) => {
			if (url === "/api/events") {
				connectionCount++;
				// 模拟服务器关闭连接（正常 EOF）
				const mockBody = {
					getReader: () => ({
						read: async () => {
							// 第一次读取立即返回 EOF
							return { done: true, value: undefined };
						},
					}),
				};
				return {
					ok: true,
					status: 200,
					body: mockBody,
				};
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const api = createBrowserApi();
		const unsubscribe = api.agents.onState(() => undefined);

		// 等待初始连接
		await new Promise((resolve) => setTimeout(resolve, 100));
		
		assert.equal(connectionCount, 1, "Should establish initial connection");
		
		// 等待重连（当前实现不会重连，因为正常 EOF 不进 catch 块）
		await new Promise((resolve) => setTimeout(resolve, 3500));
		
		unsubscribe();
		
		// 断言：正常 EOF 后应该自动重连
		assert.ok(connectionCount >= 2, `Should reconnect after normal EOF, but only saw ${connectionCount} connection(s)`);
	} finally {
		globalThis.fetch = previousFetch;
		cleanup();
	}
});

test("SSE does not reconnect after user-initiated cancellation", { timeout: 5000 }, async () => {
	const module = loadBrowserApiModule();
	const { createBrowserApi, setWebAuthToken, cleanup } = module;
	setWebAuthToken("test-token");
	
	let connectionCount = 0;
	let abortController = null;
	const previousFetch = globalThis.fetch;
	
	try {
		globalThis.fetch = async (url, init) => {
			if (url === "/api/events") {
				connectionCount++;
				abortController = init?.signal;
				const mockBody = {
					getReader: () => ({
						read: async () => {
							// 保持连接直到被 abort
							return new Promise((resolve) => {
								const checkAbort = () => {
									if (init?.signal?.aborted) {
										const error = new Error("AbortError");
										error.name = "AbortError";
										resolve({ done: false, value: undefined });
										throw error;
									}
									setTimeout(checkAbort, 50);
								};
								checkAbort();
							});
						},
					}),
				};
				return {
					ok: true,
					status: 200,
					body: mockBody,
				};
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const api = createBrowserApi();
		const unsubscribe = api.agents.onState(() => undefined);

		// 等待连接建立
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(connectionCount, 1, "Should establish initial connection");
		
		// 用户主动取消订阅
		unsubscribe();
		
		// 等待可能的错误重连
		await new Promise((resolve) => setTimeout(resolve, 3500));
		
		// 断言：用户主动取消后不应该重连
		assert.equal(connectionCount, 1, "Should not reconnect after user cancellation");
	} finally {
		globalThis.fetch = previousFetch;
		cleanup();
	}
});

test("SSE establishes only one connection when multiple subscriptions exist", { timeout: 2000 }, async () => {
	const module = loadBrowserApiModule();
	const { createBrowserApi, setWebAuthToken, cleanup } = module;
	setWebAuthToken("test-token");
	
	let connectionCount = 0;
	const previousFetch = globalThis.fetch;
	
	try {
		globalThis.fetch = async (url) => {
			if (url === "/api/events") {
				connectionCount++;
				const mockBody = {
					getReader: () => ({
						read: async () => {
							// 保持连接不结束
							return new Promise(() => undefined);
						},
					}),
				};
				return {
					ok: true,
					status: 200,
					body: mockBody,
				};
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const api = createBrowserApi();
		
		// 添加多个订阅
		const unsubscribe1 = api.agents.onState(() => undefined);
		const unsubscribe2 = api.agents.onMessages(() => undefined);
		
		await new Promise((resolve) => setTimeout(resolve, 200));
		
		// 断言：多个订阅只建立一个 SSE 连接
		assert.equal(connectionCount, 1, "Should establish only one SSE connection for multiple subscriptions");
		
		unsubscribe1();
		unsubscribe2();
	} finally {
		globalThis.fetch = previousFetch;
		cleanup();
	}
});
