import type { PiDesktopApi } from "../../preload";
import type { AgentTab, ChatMessage, SendPromptInput } from "../../shared/types";
import { t } from "./i18n";
import { createPreviewApi } from "./previewApi";

type UiWebRequest = {
	agentId: string;
	requestId: string;
	method: string;
	title: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	allowOther?: boolean;
	completed?: boolean;
} & Record<string, unknown>;

type WebState = {
	projects: Awaited<ReturnType<PiDesktopApi["projects"]["list"]>>;
	agents: AgentTab[];
	uiRequests?: UiWebRequest[];
};

const base = createPreviewApi();
let state: WebState = { projects: [], agents: [] };
let connected = false;
let sseAbortController: AbortController | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
const stateListeners = new Set<(tabs: AgentTab[]) => void>();
const messageListeners = new Set<(payload: { agentId: string; messages: ChatMessage[] }) => void>();
const uiRequestListeners = new Set<(request: UiWebRequest) => void>();
const connectionListeners = new Set<(connected: boolean, error?: string) => void>();
let lastUiRequests = new Map<string, UiWebRequest>();

// ── 局域网 Web 访问令牌 ─────────────────────────────────────────────────
const WEB_TOKEN_STORAGE_KEY = "pideck-web-token";

function readStoredToken(): string {
	try {
		return window.localStorage.getItem(WEB_TOKEN_STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

function persistToken(token: string) {
	try {
		if (token) window.localStorage.setItem(WEB_TOKEN_STORAGE_KEY, token);
		else window.localStorage.removeItem(WEB_TOKEN_STORAGE_KEY);
	} catch {
		// 隐身模式等场景下 localStorage 不可用，令牌仅保留在内存中。
	}
}

/**
 * 支持桌面端复制的 `?token=...` 链接直达：消费后从地址栏移除，
 * 避免令牌留在浏览历史里；随后回退到 localStorage 缓存。
 */
function consumeTokenFromUrl(): string {
	try {
		const params = new URLSearchParams(window.location.search);
		const queryToken = params.get("token")?.trim() ?? "";
		if (!queryToken) return readStoredToken();
		params.delete("token");
		const query = params.toString();
		const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
		window.history.replaceState(null, "", nextUrl);
		persistToken(queryToken);
		return queryToken;
	} catch {
		return readStoredToken();
	}
}

// 只有真正的 http(s) 网页环境才消费 URL 令牌；Electron/预览环境不受影响。
let authToken = window.location.protocol.startsWith("http") ? consumeTokenFromUrl() : "";

export function getWebAuthToken(): string {
	return authToken;
}

export function setWebAuthToken(token: string) {
	authToken = token.trim();
	persistToken(authToken);
}

export type WebAuthResult = "ok" | "unauthorized" | "error";

/** 用当前令牌探测服务：区分令牌错误和网络/服务不可用，供登录门槛展示不同提示。 */
export async function verifyWebAuth(): Promise<WebAuthResult> {
	if (!authToken) return "unauthorized";
	try {
		const response = await fetch("/api/state", {
			headers: { authorization: `Bearer ${authToken}` },
		});
		if (response.status === 401 || response.status === 403) return "unauthorized";
		if (!response.ok) return "error";
		await response.json().catch(() => undefined);
		return "ok";
	} catch {
		return "error";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Vite dev 会把未知 /api/* 回退到 index.html，写入状态前必须确认是真正的 Web 服务载荷。
function isWebState(value: unknown): value is WebState {
	if (!isRecord(value)) return false;
	return (
		Array.isArray(value.projects) &&
		Array.isArray(value.agents)
	);
}

/**
 * Vite dev server 会把未知 /api/* 回退到 index.html（200 + text/html）。
 * 用它标记"浏览器预览环境"，只有这种场景才允许回退到 preview 假数据；
 * 真实 Web 服务故障（网络错误、非 200、非 HTML 的损坏载荷）不应伪装成示例数据。
 */
class HtmlPreviewError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	// Web 服务全部 API 要求 Bearer 令牌；无令牌时服务端返回 401，由登录门槛接管。
	if (authToken) headers.authorization = `Bearer ${authToken}`;
	const response = await fetch(path, {
		headers,
		...init,
	});
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		// 200 + HTML 是 Vite 预览环境特征；其余归为真实服务故障。
		if (response.ok && (response.headers.get("content-type") ?? "").includes("text/html")) {
			throw new HtmlPreviewError();
		}
		throw new Error(
			t("errors.nonJsonResponse", {
				status: response.status,
				statusText: response.statusText,
			}),
		);
	}
	if (!response.ok || (isRecord(data) && data.ok === false)) {
		throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : response.statusText);
	}
	return data as T;
}

async function refreshState() {
	const nextState = await request<unknown>("/api/state");
	if (!isWebState(nextState)) {
		throw new Error("Invalid web service state payload");
	}
	state = nextState;
	connected = true;
	for (const listener of stateListeners) listener(state.agents);
	// UI 请求变化检测
	const currentAsk = new Map<string, UiWebRequest>();
	for (const req of state.uiRequests ?? []) {
		currentAsk.set(`${req.agentId}::${req.requestId}`, req);
	}
	for (const key of currentAsk.keys()) {
		if (!lastUiRequests.has(key)) {
			const req = currentAsk.get(key)!;
			for (const listener of uiRequestListeners) listener(req);
		}
	}
	for (const [key, req] of lastUiRequests) {
		if (!currentAsk.has(key)) {
			for (const listener of uiRequestListeners) listener({ ...req, completed: true });
		}
	}
	lastUiRequests = currentAsk;
	return state;
}

/** 建立 SSE 连接，接收状态、消息和 UI 请求推送 */
async function connectSSE() {
	if (sseAbortController) {
		console.log("[SSE] Connection already in progress, skipping");
		return;
	}
	console.log("[SSE] Connecting to /api/events... authToken present:", !!authToken);
	sseAbortController = new AbortController();
	let shouldReconnect = false;
	try {
		const response = await fetch("/api/events", {
			headers: { authorization: `Bearer ${authToken}` },
			signal: sseAbortController.signal,
		});
		if (!response.ok) {
			throw new Error(`SSE connection failed: ${response.status}`);
		}
		if (!response.body) {
			throw new Error("SSE response body is null");
		}
		console.log("[SSE] Connected successfully");
		connected = true;
		for (const listener of connectionListeners) listener(true);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		// 跨分片状态保留：event 和 data 在整个读取循环生命周期中持续累积
		let event = "";
		let data = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				// 正常 EOF：服务器或中间网络关闭了响应流，需要重连
				console.log("[SSE] Connection closed by server (EOF)");
				shouldReconnect = true;
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith("event:")) {
					event = line.slice(6).trim();
				} else if (line.startsWith("data:")) {
					data = line.slice(5).trim();
				} else if (line === "" && event && data) {
					console.log("[SSE] Received event:", event, "data length:", data.length);
					handleSSEEvent(event, data);
					event = "";
					data = "";
				}
			}
		}
	} catch (error: unknown) {
		if ((error as { name?: string }).name === "AbortError") {
			console.log("[SSE] Connection aborted by user");
			return;
		}
		console.error("[SSE] Connection error:", error);
		shouldReconnect = true;
	} finally {
		sseAbortController = null;
		if (shouldReconnect) {
			connected = false;
			for (const listener of connectionListeners) listener(false);
			// 断线后 3 秒重连
			console.log("[SSE] Reconnecting in 3 seconds...");
			sseReconnectTimer = setTimeout(() => {
				sseReconnectTimer = null;
				void connectSSE();
			}, 3000);
		}
	}
}

function handleSSEEvent(event: string, data: string) {
	try {
		const payload = JSON.parse(data);
		if (event === "state" && isWebState(payload)) {
			console.log("[SSE] State update - agents:", payload.agents.length, "projects:", payload.projects.length);
			state = payload;
			for (const listener of stateListeners) listener(state.agents);
			// UI 请求变化
			const currentAsk = new Map<string, UiWebRequest>();
			for (const req of state.uiRequests ?? []) {
				currentAsk.set(`${req.agentId}::${req.requestId}`, req);
			}
			for (const key of currentAsk.keys()) {
				if (!lastUiRequests.has(key)) {
					const req = currentAsk.get(key)!;
					for (const listener of uiRequestListeners) listener(req);
				}
			}
			for (const [key, req] of lastUiRequests) {
				if (!currentAsk.has(key)) {
					for (const listener of uiRequestListeners) listener({ ...req, completed: true });
				}
			}
			lastUiRequests = currentAsk;
		} else if (event === "messages" && isRecord(payload) && typeof payload.agentId === "string" && Array.isArray(payload.messages)) {
			console.log("[SSE] Messages update - agentId:", payload.agentId, "count:", payload.messages.length);
			for (const listener of messageListeners) listener({ agentId: payload.agentId, messages: payload.messages as ChatMessage[] });
		} else if (event === "ui-request" && isRecord(payload)) {
			if (Array.isArray(payload.requests)) {
				const currentAsk = new Map<string, UiWebRequest>();
				for (const req of payload.requests as UiWebRequest[]) {
					currentAsk.set(`${req.agentId}::${req.requestId}`, req);
				}
				for (const key of currentAsk.keys()) {
					if (!lastUiRequests.has(key)) {
						const req = currentAsk.get(key)!;
						for (const listener of uiRequestListeners) listener(req);
					}
				}
				for (const [key, req] of lastUiRequests) {
					if (!currentAsk.has(key)) {
						for (const listener of uiRequestListeners) listener({ ...req, completed: true });
					}
				}
				lastUiRequests = currentAsk;
			}
		}
	} catch {
		// 忽略无法解析的事件
	}
}

// 页面可见性和网络状态监听：用于后台恢复和网络恢复时重连
let visibilityListenerAttached = false;

function attachVisibilityAndOnlineListeners() {
	if (visibilityListenerAttached) return;
	visibilityListenerAttached = true;
	
	// 页面从后台回到前台时重连
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") {
				const hasSubscriptions = stateListeners.size > 0 || messageListeners.size > 0 || uiRequestListeners.size > 0 || connectionListeners.size > 0;
				if (hasSubscriptions && !sseAbortController && !connected) {
					console.log("[SSE] Page became visible, reconnecting...");
					void connectSSE();
				}
			}
		});
	}
	
	// 网络恢复时重连
	if (typeof window !== "undefined") {
		window.addEventListener("online", () => {
			const hasSubscriptions = stateListeners.size > 0 || messageListeners.size > 0 || uiRequestListeners.size > 0 || connectionListeners.size > 0;
			if (hasSubscriptions && !sseAbortController && !connected) {
				console.log("[SSE] Network came online, reconnecting...");
				void connectSSE();
			}
		});
	}
}

function subscribe<T>(set: Set<(payload: T) => void>, callback: (payload: T) => void) {
	const wasEmpty = stateListeners.size === 0 && messageListeners.size === 0 && uiRequestListeners.size === 0 && connectionListeners.size === 0;
	set.add(callback);
	console.log(`[SSE] Subscription added. Listener counts - state: ${stateListeners.size}, messages: ${messageListeners.size}, uiRequest: ${uiRequestListeners.size}, connection: ${connectionListeners.size}`);
	// 首次订阅时启动 SSE 连接并附加可见性/网络监听
	if (wasEmpty) {
		console.log("[SSE] First subscription, starting SSE connection...");
		attachVisibilityAndOnlineListeners();
		void connectSSE();
	}
	return () => {
		set.delete(callback);
		// 无订阅时断开 SSE 并清理重连定时器
		if (stateListeners.size === 0 && messageListeners.size === 0 && uiRequestListeners.size === 0 && connectionListeners.size === 0) {
			console.log("[SSE] All subscriptions removed, cleaning up connection and timers");
			sseAbortController?.abort();
			sseAbortController = null;
			if (sseReconnectTimer) {
				clearTimeout(sseReconnectTimer);
				sseReconnectTimer = null;
			}
			connected = false;
		}
	};
}

export function createBrowserApi(): PiDesktopApi {
	console.log("[BrowserApi] Initializing browser API");
	console.log("[BrowserApi] Auth token present:", !!authToken);
	console.log("[BrowserApi] Protocol:", window.location.protocol);
	return {
		...base,
		projects: {
			...base.projects,
			list: async () => {
				try {
					return (await refreshState()).projects;
				} catch (error) {
					// 仅 Vite 预览环境回退到 preview 假数据；真实服务故障绝不伪造预览数据。
					if (error instanceof HtmlPreviewError) return base.projects.list();
					if (connected) return state.projects;
					throw error;
				}
			},
		},
		sessions: {
			...base.sessions,
			list: async (projectId) => {
				if (!projectId) return [];
				const result = await request<{ sessions: Awaited<ReturnType<PiDesktopApi["sessions"]["list"]>> }>(
					`/api/projects/${encodeURIComponent(projectId)}/sessions`,
				);
				return result.sessions;
			},
		},
		agents: {
			...base.agents,
			// LAN renderer 不接触 Electron 主进程配置，也不能调用 SX 账户接口；
			// 返回不可用快照，避免把预览数据误显示成真实余额。
			providerUsage: async (providerId?: string) => ({
				providerId: providerId ?? "",
				unit: "USD",
				balance: null,
				todayActualCost: null,
				totalActualCost: null,
				todayCost: null,
				totalCost: null,
				todayRequests: null,
				todayInputTokens: null,
				todayOutputTokens: null,
				todayTokens: null,
				totalRequests: null,
				totalTokens: null,
				fetchedAt: new Date().toISOString(),
				source: "unavailable" as const,
				isValid: null,
				error: "Usage data is only available in the desktop window",
			}),
			list: async () => {
				try {
					return (await refreshState()).agents;
				} catch (error) {
					// 仅 Vite 预览环境回退到 preview 假数据；真实服务故障绝不伪造预览数据。
					if (error instanceof HtmlPreviewError) return base.agents.list();
					if (connected) return state.agents;
					throw error;
				}
			},
			create: async (input) => {
				const result = await request<{ agent: AgentTab }>("/api/agents", {
					method: "POST",
					body: JSON.stringify(input),
				});
				// Agent 创建后立即刷新状态，确保前端能看到新 Agent
				await refreshState();
				return result.agent;
			},
			stop: async (agentId) => {
				await request(`/api/agents/${encodeURIComponent(agentId)}/stop`, {
					method: "POST",
					body: "{}",
				});
				await refreshState();
			},
			abort: async (agentId) => {
				await request(`/api/agents/${encodeURIComponent(agentId)}/stop`, {
					method: "POST",
					body: "{}",
				});
				await refreshState();
			},
			prompt: async (input: SendPromptInput) => {
				await request(`/api/agents/${encodeURIComponent(input.agentId)}/prompt`, {
					method: "POST",
					body: JSON.stringify({ message: input.message, streamingBehavior: input.streamingBehavior }),
				});
				await refreshState();
			},
			runtimeState: async (agentId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["runtimeState"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/runtime`,
				);
				return result.state;
			},
			cycleModel: async (agentId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["cycleModel"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/cycle-model`,
					{ method: "POST", body: "{}" },
				);
				return result.state;
			},
			availableModels: async (agentId) => {
				const result = await request<{ models: Awaited<ReturnType<PiDesktopApi["agents"]["availableModels"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/models`,
				);
				return result.models;
			},
			setModel: async (agentId, provider, modelId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["setModel"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/model`,
					{ method: "POST", body: JSON.stringify({ provider, modelId }) },
				);
				return result.state;
			},
			cycleThinking: async (agentId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["cycleThinking"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/cycle-thinking`,
					{ method: "POST", body: "{}" },
				);
				return result.state;
			},
			setThinking: async (agentId, level) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["setThinking"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/thinking`,
					{ method: "POST", body: JSON.stringify({ level }) },
				);
				return result.state;
			},
			onState: (callback) => subscribe(stateListeners, callback),
			onMessages: (callback) => subscribe(messageListeners, callback),
			onUiRequest: (callback) => subscribe(uiRequestListeners, callback),
			sendUiResponse: async (agentId, requestId, response) => {
				await request(`/api/agents/${encodeURIComponent(agentId)}/ui-response`, {
					method: "POST",
					body: JSON.stringify({ requestId, ...response }),
				});
				await refreshState();
			},
		},
		settings: {
			...base.settings,
			get: async () => ({
				...(await base.settings.get()),
				webServiceEnabled: true,
			}),
		},
	};
}
