import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type {
	AgentTab,
	AgentRuntimeState,
	AvailableModel,
	AppSettings,
	ChatMessage,
	CreateAgentInput,
	Project,
	SendPromptInput,
	SessionSummary,
} from "../../shared/types";

type WebServiceSettings = Pick<
	AppSettings,
	"webServiceEnabled" | "webServiceHost" | "webServicePort" | "webServiceToken"
>;

type WebServiceDependencies = {
	listProjects: () => Project[];
	listAgents: () => AgentTab[];
	listSessions: (projectId: string) => Promise<SessionSummary[]>;
	getMessages: (agentId: string) => ChatMessage[];
	createAgent: (input: CreateAgentInput) => Promise<AgentTab>;
	sendPrompt: (input: SendPromptInput) => Promise<void>;
	stopAgent: (agentId: string) => Promise<void>;
	runtimeState: (agentId: string) => Promise<AgentRuntimeState>;
	cycleModel: (agentId: string) => Promise<AgentRuntimeState>;
	availableModels: (agentId: string) => Promise<AvailableModel[]>;
	setModel: (agentId: string, provider: string, modelId: string) => Promise<AgentRuntimeState>;
	cycleThinking: (agentId: string) => Promise<AgentRuntimeState>;
	setThinking: (agentId: string, level: string) => Promise<AgentRuntimeState>;
	/** 回传 ask_question 的回答到 agent（等价桌面端 sendUiResponse）。 */
	sendUiResponse: (
		agentId: string,
		requestId: string,
		response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean },
	) => void | Promise<void>;
	/** 返回所有仍未回答的 ask_question 请求，供手机端轮询弹窗。 */
	getPendingUIRequests: () => Array<{ agentId: string; requestId: string } & Record<string, unknown>>;
};

/** 单次请求体上限：手机端目前只发文本消息，预留长文本余量。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** 限流窗口与阈值：防止暴力猜测令牌，也防止异常客户端打爆服务。 */
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 1200;
const MAX_AUTH_FAILURES_PER_WINDOW = 20;

type RateWindow = { count: number; resetAt: number };

export class WebServiceManager {
	private server: Server | null = null;
	private current: { host: string; port: number } | null = null;
	private readonly rendererRoot = join(__dirname, "../renderer");
	/** 访问令牌：所有非健康检查 API 必须携带 Bearer 令牌，无令牌时全部拒绝。 */
	private authToken = "";
	/** 按 IP 的请求量与鉴权失败计数，窗口过期后自动重置。 */
	private readonly requestCounts = new Map<string, RateWindow>();
	private readonly authFailureCounts = new Map<string, RateWindow>();
	/** SSE 连接管理：按连接 ID 存储响应对象，用于广播事件和断连时清理。 */
	private readonly sseConnections = new Map<string, ServerResponse>();
	private sseIdCounter = 0;

	constructor(private readonly deps: WebServiceDependencies) {}

	async applySettings(settings: WebServiceSettings) {
		// 令牌先同步：即使 host/port 未变化、不重启服务器，新令牌也要立即生效。
		this.authToken = typeof settings.webServiceToken === "string" ? settings.webServiceToken : "";
		if (!settings.webServiceEnabled) {
			await this.stop();
			return;
		}

		const host = settings.webServiceHost.trim() || "0.0.0.0";
		const port = this.normalizePort(settings.webServicePort);
		if (this.server && this.current?.host === host && this.current.port === port) return;
		await this.stop();
		await this.start(host, port);
	}

	async stop() {
		if (!this.server) return;
		const server = this.server;
		this.server = null;
		this.current = null;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	private async start(host: string, port: number) {
		const server = createServer(async (request, response) => {
			try {
				await this.handleRequest(request, response, host, port, server);
			} catch (error) {
				// readJson 会携带 statusCode（413/400），其余错误统一 500。
				const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
					? (error as { statusCode: number }).statusCode
					: 500;
				this.sendError(response, statusCode, error instanceof Error ? error.message : String(error));
			}
		});

		server.on("clientError", (_error, socket) => {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		});

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.server = server;
		this.current = { host, port: this.getPort(server, port) };
	}

	private async handleRequest(
		request: IncomingMessage,
		response: ServerResponse,
		host: string,
		port: number,
		server: Server,
	) {
			const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
			if (request.method === "OPTIONS") {
				this.sendNoContent(response);
				return;
			}

			const clientIp = request.socket.remoteAddress ?? "unknown";
			if (!this.allowRequest(clientIp)) {
				this.sendError(response, 429, "请求过于频繁，请稍后再试");
				return;
			}

			if (url.pathname === "/api/health") {
				this.sendJson(response, {
					ok: true,
					service: "PiDeck",
					host,
					port: this.getPort(server, port),
				});
				return;
			}
			// health 保留公开用于连通探测；其余 API 一律要求访问令牌。
			if (url.pathname.startsWith("/api/")) {
				if (!this.allowAuthAttempt(clientIp)) {
					this.sendError(response, 429, "鉴权失败次数过多，请稍后再试");
					return;
				}
				if (!this.isAuthorized(request)) {
					this.recordAuthFailure(clientIp);
					this.sendError(response, 401, "访问令牌缺失或不正确");
					return;
				}
			}

			if (url.pathname === "/api/state") {
				this.sendJson(response, this.getState());
				return;
			}
			const sessionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
			if (sessionsMatch && request.method === "GET") {
				const sessions = await this.deps.listSessions(decodeURIComponent(sessionsMatch[1]));
				// 会话路径替换为不透明 ID，避免向网络客户端泄漏本机目录结构。
				this.sendJson(response, { sessions: sessions.map((session) => this.toWebSession(session)) });
				return;
			}
			if (url.pathname === "/api/agents" && request.method === "POST") {
				const body = await this.readJson<{ projectId?: string; sessionPath?: string }>(request);
				if (!body.projectId) {
					this.sendError(response, 400, "projectId 不能为空");
					return;
				}
				// 打开历史 Session：只接受不透明会话 ID，由服务端反查真实文件；
				// 绝不接受网络传入的原始路径，避免任意路径试探本机文件。
				let sessionPath: string | undefined;
				if (typeof body.sessionPath === "string" && body.sessionPath.trim()) {
					sessionPath = await this.resolveWebSessionRef(body.projectId, body.sessionPath.trim());
					if (!sessionPath) {
						this.sendError(response, 404, "会话不存在或不属于该项目");
						return;
					}
				}
				const agent = await this.deps.createAgent({ projectId: body.projectId, sessionPath });
				this.sendJson(response, { agent: this.toWebAgent(agent) });
				return;
			}
			const promptMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/prompt$/);
			if (promptMatch && request.method === "POST") {
				const body = await this.readJson<{ message?: string }>(request);
				const message = body.message?.trim() ?? "";
				if (!message) {
					this.sendError(response, 400, "message 不能为空");
					return;
				}
				await this.deps.sendPrompt({ agentId: decodeURIComponent(promptMatch[1]), message });
				this.sendJson(response, { ok: true });
				return;
			}
			const stopMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
			if (stopMatch && request.method === "POST") {
				await this.deps.stopAgent(decodeURIComponent(stopMatch[1]));
				this.sendJson(response, { ok: true });
				return;
			}
			const runtimeMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/runtime$/);
			if (runtimeMatch && request.method === "GET") {
				const state = await this.deps.runtimeState(decodeURIComponent(runtimeMatch[1]));
				this.sendJson(response, { state });
				return;
			}
			const cycleModelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/cycle-model$/);
			if (cycleModelMatch && request.method === "POST") {
				const state = await this.deps.cycleModel(decodeURIComponent(cycleModelMatch[1]));
				this.sendJson(response, { state });
				return;
			}
			const modelsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/models$/);
			if (modelsMatch && request.method === "GET") {
				const models = await this.deps.availableModels(decodeURIComponent(modelsMatch[1]));
				this.sendJson(response, { models });
				return;
			}
			const setModelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/model$/);
			if (setModelMatch && request.method === "POST") {
				const body = await this.readJson<{ provider?: string; modelId?: string }>(request);
				const state = await this.deps.setModel(
					decodeURIComponent(setModelMatch[1]),
					body.provider ?? "",
					body.modelId ?? "",
				);
				this.sendJson(response, { state });
				return;
			}
			const cycleThinkingMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/cycle-thinking$/);
			if (cycleThinkingMatch && request.method === "POST") {
				const state = await this.deps.cycleThinking(decodeURIComponent(cycleThinkingMatch[1]));
				this.sendJson(response, { state });
				return;
			}
			const setThinkingMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/thinking$/);
			if (setThinkingMatch && request.method === "POST") {
				const body = await this.readJson<{ level?: string }>(request);
				const state = await this.deps.setThinking(decodeURIComponent(setThinkingMatch[1]), body.level ?? "");
				this.sendJson(response, { state });
				return;
			}
			// 单 Agent 消息分页接口：只返回指定 Agent 的消息，支持向前翻页。
			const messagesMatch = url.pathname.match(/^\/api\/agents\/([^\/]+)\/messages$/);
			if (messagesMatch && request.method === "GET") {
				const agentId = decodeURIComponent(messagesMatch[1]);
				const allMessages = this.deps.getMessages(agentId);
				const limit = Math.min(
					Number(url.searchParams.get("limit")) || 100,
					200,
				);
				const before = Number(url.searchParams.get("before")) || allMessages.length;
				const end = Math.min(before, allMessages.length);
				const start = Math.max(0, end - limit);
				const messages = allMessages.slice(start, end);
				this.sendJson(response, {
					messages,
					hasMore: start > 0,
					nextBefore: start > 0 ? start : null,
				});
				return;
			}
			// SSE 事件流：保持连接，推送 state/messages/ui-request 事件。
			if (url.pathname === "/api/events" && request.method === "GET") {
				const connectionId = `sse-${++this.sseIdCounter}`;
				response.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-store",
					"connection": "keep-alive",
					"x-accel-buffering": "no",
				});
				this.sseConnections.set(connectionId, response);
				// 立即发送初始状态快照
				this.sendSseEvent(response, "state", this.getState());
				// 心跳：每 25 秒发送注释保持连接活跃
				const heartbeat = setInterval(() => {
					if (!this.sseConnections.has(connectionId)) {
						clearInterval(heartbeat);
						return;
					}
					try {
						response.write(": heartbeat\n\n");
					} catch {
						clearInterval(heartbeat);
						this.sseConnections.delete(connectionId);
					}
				}, 25000);
				request.on("close", () => {
					clearInterval(heartbeat);
					this.sseConnections.delete(connectionId);
				});
				return;
			}
			// ask_question 答案回传：手机端选项/确认/文本回答都走这里。
			const uiResponseMatch = url.pathname.match(/^\/api\/agents\/([^\/]+)\/ui-response$/);
			if (uiResponseMatch && request.method === "POST") {
				const body = await this.readJson<{ requestId?: string; value?: string | boolean; cancelled?: boolean; confirmed?: boolean }>(request);
				if (!body.requestId) {
					this.sendError(response, 400, "requestId 不能为空");
					return;
				}
				await this.deps.sendUiResponse(decodeURIComponent(uiResponseMatch[1]), body.requestId, {
					value: body.value,
					cancelled: body.cancelled,
					confirmed: body.confirmed,
				});
				this.sendJson(response, { ok: true });
				return;
			}
			if (url.pathname.startsWith("/api/")) {
				this.sendError(response, 404, "API 不存在");
				return;
			}

			await this.serveRenderer(url.pathname, response);
	}

	private getState() {
		const agents = this.deps.listAgents().map((agent) => this.toWebAgent(agent));
		return {
			projects: this.deps.listProjects(),
			agents,
			uiRequests: this.deps.getPendingUIRequests(),
		};
	}

	private renderPage() {
		return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>PiDeck Web Service</title>
	<style>
		:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		body { margin: 0; background: #f4f6f8; color: #252a31; }
		.app { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100vh; }
		aside { border-right: 1px solid #dfe5ee; background: #fff; padding: 16px; overflow: auto; }
		main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
		header { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 18px; border-bottom: 1px solid #dfe5ee; background: #fff; }
		h1 { margin: 0; font-size: 16px; }
		.status { font-size: 12px; color: #687280; }
		.list { display: grid; gap: 8px; }
		button { border: 1px solid #d7dce4; background: #fff; border-radius: 8px; padding: 8px 10px; color: #252a31; cursor: pointer; transition: transform .12s ease, border-color .12s ease, background .12s ease, opacity .12s ease; }
		button:hover:not(:disabled) { transform: translateY(-1px); border-color: #b8c2d0; }
		button.primary { border-color: #14a514; background: #14a514; color: #fff; min-width: 88px; font-weight: 700; }
		button.primary:hover:not(:disabled) { background: #129212; border-color: #129212; }
		button.danger { color: #d93025; border-color: #f1b9b9; background: #fff7f7; }
		button.ghost { color: #687280; background: #f8fafc; }
		.header-actions { display: flex; align-items: center; gap: 8px; }
		.header-actions button { height: 34px; padding: 0 12px; }
		button:disabled { opacity: .6; cursor: not-allowed; }
		.item { text-align: left; display: grid; gap: 3px; min-width: 0; }
		.item.loading { border-color: #14a514; background: #f0fdf4; }
		.item.active { border-color: #14a514; box-shadow: 0 0 0 2px rgba(20,165,20,.12); }
		.item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.item small { color: #687280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.section-title { margin: 18px 0 8px; color: #687280; font-size: 12px; font-weight: 700; }
		.agent-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: stretch; }
		.close-agent { padding: 0 10px; font-size: 12px; }
		.messages { overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
		.message { max-width: min(820px, 88%); border: 1px solid #dfe5ee; background: #fff; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; line-height: 1.55; }
		.message.user { align-self: flex-end; background: #eaf8ee; border-color: #bee8c6; }
		.message.error { border-color: #ffd0d0; background: #fff4f4; color: #b42318; }
		.role { display: block; margin-bottom: 4px; font-size: 11px; font-weight: 700; color: #687280; }
		.composer { display: grid; gap: 8px; padding: 12px; border-top: 1px solid #dfe5ee; background: #fff; }
		.composer-box { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; border: 1px solid #d7dce4; border-radius: 10px; padding: 8px; background: #fff; }
		textarea { width: 100%; min-height: 44px; max-height: 160px; resize: vertical; border: 0; outline: 0; padding: 6px 8px; font: inherit; line-height: 1.5; }
		.composer-actions { display: flex; align-items: center; gap: 8px; }
		.composer-hint { color: #8a94a6; font-size: 12px; padding-left: 4px; }
		.empty { margin: auto; color: #687280; text-align: center; }
		.pulse { display: inline-flex; width: 8px; height: 8px; border-radius: 999px; background: #14a514; animation: pulse 1s infinite ease-in-out; margin-right: 6px; }
		@keyframes pulse { 0%, 100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
		@media (max-width: 760px) { .app { grid-template-columns: 1fr; } aside { max-height: 42vh; border-right: 0; border-bottom: 1px solid #dfe5ee; } }
	</style>
</head>
<body>
	<div class="app">
		<aside>
			<h1>PiDeck</h1>
			<div class="section-title">项目</div>
			<div id="projects" class="list"></div>
			<div class="section-title">Agent</div>
			<div id="agents" class="list"></div>
		</aside>
		<main>
			<header>
				<h1 id="title">选择或创建 Agent</h1>
				<div class="header-actions">
					<span id="status" class="status">连接中...</span>
					<button class="danger" type="button" id="stop">关闭 Agent</button>
				</div>
			</header>
			<div id="messages" class="messages"><div class="empty">从左侧选择项目创建 Agent，或选择现有 Agent。</div></div>
			<form id="composer" class="composer">
				<div class="composer-box">
					<textarea id="prompt" placeholder="发送消息到当前 Agent"></textarea>
					<div class="composer-actions">
						<button class="primary" type="submit">发送</button>
					</div>
				</div>
				<div class="composer-hint">Enter 发送，Shift/Ctrl + Enter 换行</div>
			</form>
		</main>
	</div>
	<script>
		let state = { projects: [], agents: [], messagesByAgent: {} };
		let activeAgentId = "";
		let creatingProjectId = "";
		let refreshing = false;
		const el = (id) => document.getElementById(id);
		function resolveAuthToken() {
			const queryToken = new URLSearchParams(window.location.search).get("token");
			if (queryToken) {
				localStorage.setItem("pideck-web-token", queryToken);
				return queryToken;
			}
			let token = localStorage.getItem("pideck-web-token") || "";
			if (!token) {
				token = window.prompt("请输入 PiDeck Web 服务访问令牌") || "";
				if (token.trim()) localStorage.setItem("pideck-web-token", token.trim());
			}
			return token.trim();
		}
		const authToken = resolveAuthToken();
		async function api(path, options) {
			const res = await fetch(path, { headers: { "content-type": "application/json", authorization: "Bearer " + authToken }, ...options });
			if (!res.ok) throw new Error((await res.json()).error || res.statusText);
			return res.json();
		}
		async function refresh() {
			if (refreshing) return;
			refreshing = true;
			try {
				state = await api("/api/state");
				if (!activeAgentId && state.agents[0]) activeAgentId = state.agents[0].id;
				render();
				el("status").textContent = "已连接";
			} catch (error) {
				el("status").textContent = error.message || String(error);
			} finally {
				refreshing = false;
			}
		}
		function render() {
			el("projects").innerHTML = state.projects.map(project => \`
				<button class="item \${project.id === creatingProjectId ? "loading" : ""}" data-project="\${project.id}" \${creatingProjectId ? "disabled" : ""}>
					<strong>\${escapeHtml(project.name)}</strong>
					<small>\${project.id === creatingProjectId ? '<span class="pulse"></span>正在打开...' : escapeHtml(project.path)}</small>
				</button>\`).join("");
			el("agents").innerHTML = state.agents.map(agent => \`
				<div class="agent-row">
					<button class="item \${agent.id === activeAgentId ? "active" : ""}" data-agent="\${agent.id}">
						<strong>\${escapeHtml(agent.title)}</strong>
						<small>\${agent.status === "running" ? '<span class="pulse"></span>' : ""}\${agent.status} · \${escapeHtml(agent.cwd)}</small>
					</button>
					<button class="close-agent ghost" data-close-agent="\${agent.id}" title="关闭 Agent">关闭</button>
				</div>\`).join("");
			const agent = state.agents.find(item => item.id === activeAgentId);
			el("title").textContent = agent ? agent.title : "选择或创建 Agent";
			el("status").innerHTML = agent?.status === "running" ? '<span class="pulse"></span>正在响应...' : (agent ? agent.status : "已连接");
			const messages = activeAgentId ? state.messagesByAgent[activeAgentId] || [] : [];
			el("messages").innerHTML = messages.length
				? messages.map(message => \`<div class="message \${message.role}"><span class="role">\${message.role}</span>\${escapeHtml(message.text || "")}</div>\`).join("")
				: '<div class="empty">暂无消息</div>';
			el("prompt").disabled = !agent;
			el("composer").querySelector("button[type=submit]").disabled = !agent;
			el("stop").disabled = !agent || agent.status === "closed";
			el("stop").textContent = agent?.status === "running" ? "停止响应" : "关闭 Agent";
		}
		document.addEventListener("click", async (event) => {
			const closeButton = event.target.closest("[data-close-agent]");
			if (closeButton) {
				const agentId = closeButton.dataset.closeAgent;
				closeButton.disabled = true;
				closeButton.textContent = "关闭中";
				try {
					await api(\`/api/agents/\${encodeURIComponent(agentId)}/stop\`, { method: "POST" });
					if (activeAgentId === agentId) activeAgentId = "";
					await refresh();
				} finally {
					closeButton.disabled = false;
					closeButton.textContent = "关闭";
				}
				return;
			}
			const projectButton = event.target.closest("[data-project]");
			if (projectButton) {
				creatingProjectId = projectButton.dataset.project;
				render();
				try {
					const result = await api("/api/agents", { method: "POST", body: JSON.stringify({ projectId: projectButton.dataset.project }) });
					activeAgentId = result.agent.id;
					await refresh();
				} finally {
					creatingProjectId = "";
					render();
				}
				return;
			}
			const agentButton = event.target.closest("[data-agent]");
			if (agentButton) {
				activeAgentId = agentButton.dataset.agent;
				render();
			}
		});
		el("composer").addEventListener("submit", async (event) => {
			event.preventDefault();
			const message = el("prompt").value.trim();
			if (!message || !activeAgentId) return;
			el("prompt").value = "";
			await api(\`/api/agents/\${encodeURIComponent(activeAgentId)}/prompt\`, { method: "POST", body: JSON.stringify({ message }) });
			await refresh();
		});
		el("prompt").addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
			event.preventDefault();
			el("composer").requestSubmit();
		});
		el("stop").addEventListener("click", async () => {
			if (!activeAgentId) return;
			el("stop").disabled = true;
			el("stop").textContent = "处理中";
			try {
				await api(\`/api/agents/\${encodeURIComponent(activeAgentId)}/stop\`, { method: "POST" });
				activeAgentId = "";
				await refresh();
			} finally {
				el("stop").textContent = "关闭 Agent";
			}
		});
		function escapeHtml(value) {
			return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
		}
		refresh();
		setInterval(refresh, 600);
	</script>
</body>
</html>`;
	}

	private async serveRenderer(pathname: string, response: ServerResponse) {
		const requestedPath = decodeURIComponent(pathname);
		const relativePath = requestedPath === "/" || !extname(requestedPath)
			? "index.html"
			: requestedPath.replace(/^\/+/, "");
		const filePath = normalize(join(this.rendererRoot, relativePath));
		if (!filePath.startsWith(normalize(this.rendererRoot)) || !existsSync(filePath)) {
			if (relativePath !== "index.html" && existsSync(join(this.rendererRoot, "index.html"))) {
				return this.sendFile(join(this.rendererRoot, "index.html"), response);
			}
			this.sendHtml(response, this.renderPage());
			return;
		}
		await this.sendFile(filePath, response);
	}

	private async sendFile(filePath: string, response: ServerResponse) {
		const body = await readFile(filePath);
		response.writeHead(200, {
			"content-type": this.contentType(filePath),
			"cache-control": filePath.endsWith("index.html") || filePath.endsWith(".webmanifest") ? "no-store" : "public, max-age=31536000, immutable",
		});
		response.end(body);
	}

	private sendHtml(response: ServerResponse, html: string) {
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		});
		response.end(html);
	}

	private contentType(filePath: string) {
		switch (extname(filePath).toLowerCase()) {
			case ".html":
				return "text/html; charset=utf-8";
			case ".js":
				return "text/javascript; charset=utf-8";
			case ".css":
				return "text/css; charset=utf-8";
			case ".svg":
				return "image/svg+xml";
			case ".png":
				return "image/png";
			case ".ico":
				return "image/x-icon";
			case ".webmanifest":
				// PWA manifest 必须是 JSON 系 MIME，浏览器才认；octet-stream 会被拒
				return "application/manifest+json; charset=utf-8";
			default:
				return "application/octet-stream";
		}
	}

	private sendJson(response: ServerResponse, body: unknown) {
		// 不下发 CORS 头：同源页面正常调用，其他来源的网页无法跨域访问该服务。
		response.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		response.end(JSON.stringify(body));
	}

	private sendError(response: ServerResponse, statusCode: number, error: string) {
		response.writeHead(statusCode, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			// 413 后连接会被主动断开，提前声明避免客户端继续复用该连接。
			...(statusCode === 413 ? { connection: "close" } : {}),
		});
		response.end(JSON.stringify({ error }));
	}

	private sendNoContent(response: ServerResponse) {
		response.writeHead(204);
		response.end();
	}

	private readJson<T>(request: IncomingMessage): Promise<T> {
		return new Promise<T>((resolvePromise, rejectPromise) => {
			const chunks: Buffer[] = [];
			let totalBytes = 0;
			let oversized = false;
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				rejectPromise(error);
			};
			request.on("data", (chunk: Buffer) => {
				if (settled) return;
				totalBytes += chunk.length;
				// 远超上限的请求不值得继续排空，直接断开，接受客户端看到重置。
				if (totalBytes > MAX_BODY_BYTES * 8) {
					request.destroy();
					fail(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
					return;
				}
				// 超限后停止缓存但继续排空剩余数据：客户端发完才能完整收到 413，
				// 中途断连会让上传中的 fetch 只看到 ECONNRESET。
				if (totalBytes > MAX_BODY_BYTES) {
					oversized = true;
					return;
				}
				chunks.push(chunk);
			});
			request.on("end", () => {
				if (settled) return;
				if (oversized) {
					fail(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
					return;
				}
				if (chunks.length === 0) {
					resolvePromise({} as T);
					return;
				}
				try {
					resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
				} catch {
					fail(Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400 }));
				}
			});
			request.on("error", (error) => fail(error));
		});
	}

	private getPort(server: Server, fallback: number) {
		const address = server.address();
		return typeof address === "object" && address ? (address as AddressInfo).port : fallback;
	}

	private normalizePort(value: number) {
		const port = Number(value);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error("Web 服务端口必须是 1-65535 之间的整数");
		}
		return port;
	}

	// ── 局域网安全与会话标识 ─────────────────────────────────────────

	private isAuthorized(request: IncomingMessage): boolean {
		// 令牌未配置时全部拒绝，绝不退回无鉴权行为。
		if (!this.authToken) return false;
		const header = request.headers.authorization ?? "";
		const match = header.match(/^Bearer\s+(.+)$/i);
		if (!match) return false;
		const provided = Buffer.from(match[1].trim());
		const expected = Buffer.from(this.authToken);
		if (provided.length !== expected.length) return false;
		// 等长比较用 timingSafeEqual，避免时序侧信道逐字节猜令牌。
		return timingSafeEqual(provided, expected);
	}

	private allowRequest(ip: string): boolean {
		const entry = this.touchRateWindow(this.requestCounts, ip);
		entry.count += 1;
		return entry.count <= MAX_REQUESTS_PER_WINDOW;
	}

	private allowAuthAttempt(ip: string): boolean {
		return this.touchRateWindow(this.authFailureCounts, ip).count < MAX_AUTH_FAILURES_PER_WINDOW;
	}

	private recordAuthFailure(ip: string) {
		this.touchRateWindow(this.authFailureCounts, ip).count += 1;
	}

	private touchRateWindow(map: Map<string, RateWindow>, ip: string): RateWindow {
		const now = Date.now();
		const existing = map.get(ip);
		if (existing && now < existing.resetAt) return existing;
		// 懒清理过期窗口，防止长时间运行后 Map 无限增长。
		if (map.size > 4096) {
			for (const [key, win] of map) {
				if (now >= win.resetAt) map.delete(key);
			}
		}
		const fresh: RateWindow = { count: 0, resetAt: now + RATE_WINDOW_MS };
		map.set(ip, fresh);
		return fresh;
	}

	/**
	 * Web 侧会话标识：本地会话文件路径的 sha256。
	 * 手机端只接触不透明 ID，看不到机器目录结构；同一路径哈希恒定，
	 * 恢复历史 Session 后前端仍能按 sessionPath 匹配 Agent。
	 */
	private webSessionRef(filePath: string): string {
		return createHash("sha256").update(filePath).digest("hex");
	}

	/** 把不透明 ID 反查为真实会话文件；只接受 64 位十六进制，拒绝任何路径形态输入。 */
	private async resolveWebSessionRef(projectId: string, ref: string): Promise<string | undefined> {
		if (!/^[0-9a-f]{64}$/.test(ref)) return undefined;
		const sessions = await this.deps.listSessions(projectId);
		return sessions.find((session) => this.webSessionRef(session.filePath) === ref)?.filePath;
	}

	/** Web 侧会话摘要：路径字段替换为不透明 ID，防止泄漏本地目录结构。 */
	private toWebSession(session: SessionSummary): SessionSummary {
		const ref = this.webSessionRef(session.filePath);
		return { ...session, id: ref, filePath: ref, projectPath: undefined, parentSessionPath: undefined };
	}

	/** Web 侧 Agent：sessionPath 替换为同一套不透明 ID，保证前端 Agent/会话分组仍成立。 */
	private toWebAgent(agent: AgentTab): AgentTab {
		return agent.sessionPath ? { ...agent, sessionPath: this.webSessionRef(agent.sessionPath) } : agent;
	}

	// ── SSE 事件推送 ─────────────────────────────────────────────────

	/** 向单个 SSE 连接发送事件 */
	private sendSseEvent(response: ServerResponse, event: string, data: unknown) {
		try {
			const payload = JSON.stringify(data);
			response.write(`event: ${event}\ndata: ${payload}\n\n`);
		} catch {
			// 连接已关闭或写入失败，静默忽略
		}
	}

	/** 向所有活跃 SSE 连接广播事件 */
	private broadcastSseEvent(event: string, data: unknown) {
		const payload = JSON.stringify(data);
		const deadConnections: string[] = [];
		for (const [id, response] of this.sseConnections) {
			try {
				response.write(`event: ${event}\ndata: ${payload}\n\n`);
			} catch {
				deadConnections.push(id);
			}
		}
		for (const id of deadConnections) {
			this.sseConnections.delete(id);
		}
	}

	/** 广播状态变化（项目、Agent、UI 请求） */
	broadcastStateChange() {
		this.broadcastSseEvent("state", this.getState());
	}

	/** 广播单个 Agent 的消息更新 */
	broadcastMessagesUpdate(agentId: string, messages: ChatMessage[]) {
		this.broadcastSseEvent("messages", { agentId, messages });
	}

	/** 广播 UI 请求变化 */
	broadcastUiRequestChange() {
		this.broadcastSseEvent("ui-request", { requests: this.deps.getPendingUIRequests() });
	}
}
