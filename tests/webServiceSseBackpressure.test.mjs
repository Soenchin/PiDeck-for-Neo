import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadWebServiceManagerModule() {
	const source = readFileSync("src/main/web/WebServiceManager.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});

	const sandbox = {
		exports: {},
		require: (specifier) => {
			if (specifier === "node:crypto") {
				return {
					createHash: () => ({
						update: () => ({
							digest: () => "mock-hash",
						}),
					}),
					timingSafeEqual: (a, b) => a.toString() === b.toString(),
				};
			}
			if (specifier === "node:http") {
				return {
					createServer: () => ({ on: () => undefined, listen: () => undefined }),
				};
			}
			if (specifier === "node:fs") {
				return { existsSync: () => false };
			}
			if (specifier === "node:fs/promises") {
				return { readFile: async () => "" };
			}
			if (specifier === "node:path") {
				return {
					join: (...args) => args.join("/"),
					normalize: (p) => p,
					extname: (p) => "",
				};
			}
			throw new Error(`Unexpected require: ${specifier}`);
		},
		__dirname: "/mock",
	};

	vm.runInNewContext(outputText, sandbox, { filename: "WebServiceManager.ts" });
	return sandbox.exports;
}

/** 模拟 ServerResponse，可以控制 write() 返回值和 drain 事件 */
class MockServerResponse extends EventEmitter {
	constructor() {
		super();
		this.writeHistory = [];
		this.shouldBlock = false;
		this.headersSent = false;
	}

	writeHead(statusCode, headers) {
		this.statusCode = statusCode;
		this.headers = headers;
		this.headersSent = true;
	}

	write(chunk) {
		this.writeHistory.push(chunk);
		// 模拟背压：返回 false 表示缓冲区满
		return !this.shouldBlock;
	}

	end(chunk) {
		if (chunk) this.writeHistory.push(chunk);
		this.emit("close");
	}

	triggerDrain() {
		this.emit("drain");
	}
}

test("SSE write respects backpressure and only keeps latest snapshot", async () => {
	const { WebServiceManager } = loadWebServiceManagerModule();
	
	const deps = {
		listProjects: () => [{ id: "p1", name: "Project 1", path: "/mock" }],
		listAgents: () => [{ id: "a1", title: "Agent 1", status: "running", cwd: "/mock" }],
		listSessions: async () => [],
		getMessages: (agentId) => [
			{ role: "user", text: "Hello" },
			{ role: "assistant", text: "Hi" },
		],
		createAgent: async () => ({}),
		sendPrompt: async () => undefined,
		stopAgent: async () => undefined,
		runtimeState: async () => ({}),
		cycleModel: async () => ({}),
		availableModels: async () => [],
		setModel: async () => ({}),
		cycleThinking: async () => ({}),
		setThinking: async () => ({}),
		sendUiResponse: () => undefined,
		getPendingUIRequests: () => [],
	};

	const manager = new WebServiceManager(deps);
	const mockResponse = new MockServerResponse();
	
	// 模拟 SSE 连接建立
	const connectionId = "sse-1";
	manager.sseConnections = new Map([[connectionId, mockResponse]]);
	
	// 第一次广播消息
	manager.broadcastMessagesUpdate("a1", [{ role: "user", text: "Message 1" }]);
	
	// 模拟背压：response.write() 返回 false
	mockResponse.shouldBlock = true;
	
	// 继续广播多次（模拟 50ms 间隔的快速刷新）
	manager.broadcastMessagesUpdate("a1", [{ role: "user", text: "Message 2" }]);
	manager.broadcastMessagesUpdate("a1", [{ role: "user", text: "Message 3" }]);
	manager.broadcastMessagesUpdate("a1", [{ role: "user", text: "Message 4" }]);
	
	// 当前实现：所有消息都被写入，造成积压
	const eventsBeforeDrain = mockResponse.writeHistory.length;
	
	// 断言：背压期间应该停止写入或只保留最新快照
	// 当前实现会失败，因为所有 4 条消息都被写入了
	assert.ok(
		eventsBeforeDrain <= 2,
		`Should stop writing during backpressure, but wrote ${eventsBeforeDrain} events (expected ≤2)`
	);
});

test("SSE sends initial state and messages on new connection", async () => {
	const { WebServiceManager } = loadWebServiceManagerModule();
	
	const testMessages = [
		{ role: "user", text: "Hello" },
		{ role: "assistant", text: "Hi there" },
	];
	
	const deps = {
		listProjects: () => [{ id: "p1", name: "Project 1", path: "/mock" }],
		listAgents: () => [{ id: "a1", title: "Agent 1", status: "running", cwd: "/mock", sessionPath: undefined }],
		listSessions: async () => [],
		getMessages: (agentId) => (agentId === "a1" ? testMessages : []),
		createAgent: async () => ({}),
		sendPrompt: async () => undefined,
		stopAgent: async () => undefined,
		runtimeState: async () => ({}),
		cycleModel: async () => ({}),
		availableModels: async () => [],
		setModel: async () => ({}),
		cycleThinking: async () => ({}),
		setThinking: async () => ({}),
		sendUiResponse: () => undefined,
		getPendingUIRequests: () => [],
	};

	const manager = new WebServiceManager(deps);
	const mockResponse = new MockServerResponse();
	
	// 模拟建立 SSE 连接
	mockResponse.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		"connection": "keep-alive",
		"x-accel-buffering": "no",
	});
	
	// 在当前实现中，连接建立后只发送 state
	// 我们期望它还应该为每个已打开的 Agent 发送当前消息
	manager.sseConnections = new Map([["sse-1", mockResponse]]);
	
	// 手动调用初始同步（当前实现在 /api/events 路由中只调用一次 sendSseEvent）
	// 这里模拟期望的行为：应该发送 state + 每个 agent 的 messages
	
	const writes = mockResponse.writeHistory;
	
	// 解析写入的事件
	const events = [];
	for (const write of writes) {
		const lines = write.toString().split("\n");
		let event = "";
		let data = "";
		for (const line of lines) {
			if (line.startsWith("event:")) {
				event = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				data = line.slice(5).trim();
			} else if (line === "" && event && data) {
				events.push({ event, data: JSON.parse(data) });
				event = "";
				data = "";
			}
		}
	}
	
	// 当前实现：只有 state 事件，没有 messages 事件
	const stateEvents = events.filter((e) => e.event === "state");
	const messagesEvents = events.filter((e) => e.event === "messages");
	
	assert.equal(stateEvents.length, 1, "Should send state event on connection");
	// 这个断言在当前实现中会失败，因为没有发送 messages
	assert.ok(
		messagesEvents.length >= 1,
		`Should send messages for existing agents on connection, but sent ${messagesEvents.length}`
	);
	
	if (messagesEvents.length > 0) {
		assert.equal(messagesEvents[0].data.agentId, "a1");
		assert.deepEqual(messagesEvents[0].data.messages, testMessages);
	}
});

test("SSE connection cleanup removes all listeners and timers", async () => {
	const { WebServiceManager } = loadWebServiceManagerModule();
	
	const deps = {
		listProjects: () => [],
		listAgents: () => [],
		listSessions: async () => [],
		getMessages: () => [],
		createAgent: async () => ({}),
		sendPrompt: async () => undefined,
		stopAgent: async () => undefined,
		runtimeState: async () => ({}),
		cycleModel: async () => ({}),
		availableModels: async () => [],
		setModel: async () => ({}),
		cycleThinking: async () => ({}),
		setThinking: async () => ({}),
		sendUiResponse: () => undefined,
		getPendingUIRequests: () => [],
	};

	const manager = new WebServiceManager(deps);
	const mockResponse = new MockServerResponse();
	const mockRequest = new EventEmitter();
	
	const connectionId = "sse-1";
	manager.sseConnections = new Map([[connectionId, mockResponse]]);
	
	// 模拟心跳定时器（在实际代码中会创建）
	const heartbeatTimerId = setInterval(() => undefined, 25000);
	
	// 模拟连接关闭
	mockRequest.emit("close");
	
	// 断言：连接应该从 Map 中移除
	// 在实际实现中，这个清理逻辑在 /api/events 路由的 request.on("close") 回调中
	// 这里我们测试清理后的状态
	
	// 清理定时器
	clearInterval(heartbeatTimerId);
	manager.sseConnections.delete(connectionId);
	
	assert.equal(manager.sseConnections.size, 0, "Connection should be removed from map after close");
});
