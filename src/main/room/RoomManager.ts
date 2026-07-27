/**
 * Neo × ROCKET 双 Agent 房间编排器（主进程）。
 *
 * 职责：
 * 1. 持久化房间配置（userData/room-config.json），跨重启恢复。
 * 2. 预置两个隐藏 PiDeck 项目：Neo 房间工作区 + ROCKET 项目（path=X:/CC/projects/ROCKET）。
 * 3. 为 ROCKET 准备独立 agentDir（硬链接全局 models.json/auth.json，无 Neo 人设/无扩展），实现记忆隔离。
 * 4. 创建/恢复两个独立 pi agent（Neo 走默认全局环境=真实 Neo；ROCKET 走隔离 agentDir）。
 * 5. 接收房间发送请求，按 target 投递给对应 agent，并把房间上下文包裹进 agentMessage。
 * 6. 推送 RoomState 给渲染层。
 *
 * 不维护消息文本：渲染层自行从 agents.onMessages 订阅两个 agent 的消息流合并成共享时间线。
 */
import { app, type BrowserWindow } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { cp, link, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type {
	AgentStatus,
	AgentTab,
	ImageContent,
	SendPromptInput,
} from "../../shared/types";
import type {
	RoomClearResult,
	RoomConfig,
	RoomMessagesSnapshot,
	RoomSendInput,
	RoomSetModelInput,
	RoomState,
	RoomStopInput,
} from "../../shared/room";
import type { AgentManager } from "../pi/AgentManager";
import type { ProjectStore } from "../projects/ProjectStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { AppLogger } from "../logging/AppLogger";

/** Neo × ROCKET 房间使用的固定路径与常量。实际 ROCKET 项目路径允许通过环境变量覆盖以便测试。 */
const ROCKET_PROJECT_PATH =
	process.env.PIDECK_ROOM_ROCKET_PATH || "X:\\CC\\projects\\ROCKET";
const ROOM_CONFIG_FILE = "room-config.json";
const NEO_WORKSPACE_DIR = "room-workspace-neo";
const ROCKET_AGENT_DIR_NAME = "room-rocket-agent";
const NEO_MEMORY_PATH = "X:\\CC\\memory";
const ROCKET_MEMORY_PATH = join(ROCKET_PROJECT_PATH, "memory");

export class RoomManager {
	private config?: RoomConfig;
	private state: RoomState = { status: "idle" };
	/** provisioning in-flight 锁：React StrictMode / 多 IPC 并发进入房间时只允许创建一套 Agent。 */
	private provisionPromise?: Promise<void>;
	private readonly getConfigDir = () => app.getPath("userData");

	constructor(
		private readonly agentManager: AgentManager,
		private readonly projectStore: ProjectStore,
		private readonly configManager: ConfigManager,
		private readonly appLogger?: AppLogger,
		private readonly getWindow: () => BrowserWindow | null = () => null,
	) {}

	/** 渲染层进入房间时调用：返回当前状态，并按需 provisioning/restore。 */
	async getState(): Promise<RoomState> {
		// 首次进入或另一个调用正在 provisioning：统一等待同一个 in-flight Promise。
		if (this.state.status !== "ready") {
			// error 也允许再次进入房间时重试，避免一次 provider/网络故障把房间永久锁死。
			void this.appLogger?.info("room", "Room state requested, provisioning");
			await this.ensureReady(false);
		}
		return this.state;
	}

	/** 读取两边当前消息快照，供渲染层进入房间时立即恢复共享时间线。 */
	async getMessages(): Promise<RoomMessagesSnapshot> {
		await this.ensureReady();
		return {
			neo: this.config?.neoAgentId ? this.agentManager.getMessages(this.config.neoAgentId) : [],
			rocket: this.config?.rocketAgentId ? this.agentManager.getMessages(this.config.rocketAgentId) : [],
		};
	}

	/** 发送消息到指定参与者。 */
	async send(input: RoomSendInput): Promise<void> {
		await this.ensureReady();
		const cfg = this.config;
		if (!cfg) throw new Error("Room not provisioned");

		const targets: ("neo" | "rocket")[] =
			input.target === "both" ? ["neo", "rocket"] : [input.target];

		// 房间上下文包裹：让每个 agent 知道自己处在与另一位独立 AI 的共享房间中，
		// 并能看到最近交互的提示。这里只做轻量包裹，长历史由各自 Session 管理。
		for (const participant of targets) {
			const agentId = participant === "neo" ? cfg.neoAgentId : cfg.rocketAgentId;
			if (!agentId) continue;
			// 每位参与者单独生成房间上下文，显式声明各自记忆边界。
			// ROCKET 不只依赖进程级 agentDir 隔离，prompt 层也明确禁止访问 Houkai，形成双重护栏。
			const wrapped = this.wrapRoomContext(
				input.message,
				input.contextMessage ?? input.message,
				participant,
				cfg,
			);
			// message=用户原文（各自 Session 的 UI 历史显示原文），agentMessage=房间包裹后内容（pi 实际收到的 prompt）。
			const promptInput: SendPromptInput = {
				agentId,
				message: input.message,
				agentMessage: wrapped,
				images: input.images,
			};
			try {
				await this.agentManager.sendPrompt(promptInput);
			} catch (error) {
				void this.appLogger?.error("room", "Room send failed", { participant, error });
			}
		}
	}

	/** 中止当前生成但保留 Agent 进程与 Session，供房间输入框红色停止键使用。 */
	async abort(input: RoomStopInput): Promise<void> {
		const cfg = this.config;
		if (!cfg) return;
		const ids: string[] = [];
		if (!input?.participant || input.participant === "neo") if (cfg.neoAgentId) ids.push(cfg.neoAgentId);
		if (!input?.participant || input.participant === "rocket") if (cfg.rocketAgentId) ids.push(cfg.rocketAgentId);
		await Promise.all(ids.map((id) => this.agentManager.abort(id).catch((error) => {
			void this.appLogger?.error("room", "Room abort failed", { agentId: id, error });
		})));
	}

	/** 停止指定参与者或两人进程；仅用于房间生命周期清理，不用于停止当前回答。 */
	async stop(input: RoomStopInput): Promise<void> {
		const cfg = this.config;
		if (!cfg) return;
		const ids: string[] = [];
		if (!input?.participant || input.participant === "neo") if (cfg.neoAgentId) ids.push(cfg.neoAgentId);
		if (!input?.participant || input.participant === "rocket") if (cfg.rocketAgentId) ids.push(cfg.rocketAgentId);
		for (const id of ids) {
			try {
				await this.agentManager.stop(id);
			} catch (error) {
				void this.appLogger?.error("room", "Room stop failed", { agentId: id, error });
			}
		}
		if (!input?.participant || input.participant === "neo") cfg.neoAgentId = undefined;
		if (!input?.participant || input.participant === "rocket") cfg.rocketAgentId = undefined;
		this.setState({
			status: "idle",
			neoAgentId: cfg.neoAgentId,
			rocketAgentId: cfg.rocketAgentId,
		});
		await this.saveConfig();
	}

	/**
	 * 只清理房间视觉时间线：持久化一个时间边界，不修改两个 Session 的上下文与长期记忆。
	 * 生成中拒绝清屏，避免同一条流式回复在边界之后继续更新而重新冒出来。
	 */
	async clearTimeline(): Promise<RoomClearResult> {
		await this.ensureReady();
		const cfg = this.config;
		if (!cfg) throw new Error("Room not provisioned");
		const live = new Map(this.agentManager.list().map((tab) => [tab.id, tab] as const));
		if (
			live.get(cfg.neoAgentId ?? "")?.status === "running" ||
			live.get(cfg.rocketAgentId ?? "")?.status === "running"
		) {
			throw new Error("请先停止 Neo 和小 R 的当前回答，再清屏");
		}
		cfg.timelineClearedAt = Date.now();
		await this.saveConfig();
		this.setState({ timelineClearedAt: cfg.timelineClearedAt });
		return { timelineClearedAt: cfg.timelineClearedAt };
	}

	/**
	 * 新开一桌：关闭当前两条 RPC 进程并解除旧 Session 绑定，再创建两条全新 Session。
	 * 旧 Session 文件不删除，双方长期记忆路径与模型偏好也不改变。
	 */
	async newTable(): Promise<RoomState> {
		await this.ensureReady();
		const cfg = this.config;
		if (!cfg) throw new Error("Room not provisioned");
		await this.stop({});
		cfg.neoSessionPath = undefined;
		cfg.rocketSessionPath = undefined;
		cfg.timelineClearedAt = Date.now();
		// 必须先落盘解绑旧 Session，再 provisioning；即使此后应用意外退出，重启也不会回到旧桌。
		await this.saveConfig();
		void this.appLogger?.info("room", "Starting a new room table with fresh sessions");
		await this.ensureReady();
		return this.state;
	}

	/** 切换某参与者的模型。 */
	async setModel(input: RoomSetModelInput): Promise<void> {
		await this.ensureReady();
		const cfg = this.config;
		if (!cfg) return;
		const agentId = input.participant === "neo" ? cfg.neoAgentId : cfg.rocketAgentId;
		if (!agentId) return;
		try {
			await this.agentManager.setModel(agentId, input.provider, input.modelId);
			if (input.participant === "neo") cfg.neoModel = { provider: input.provider, modelId: input.modelId };
			else cfg.rocketModel = { provider: input.provider, modelId: input.modelId };
			await this.saveConfig();
		} catch (error) {
			void this.appLogger?.error("room", "Room setModel failed", { participant: input.participant, error });
		}
	}

	/** 应用启动后调用一次：只加载配置与预置项目，不立刻拉起 agent（首次进入房间才拉起）。 */
	async initOnStartup(): Promise<void> {
		this.config = await this.loadConfig();
		if (this.config) {
			// 确保隐藏项目已存在，便于用户直接在其他入口看到 session。
			await this.ensureProjects(this.config);
		}
	}

	// ────────────────────── 内部：provisioning ──────────────────────

	private async provision(): Promise<void> {
		try {
			this.setState({ status: "provisioning", error: undefined });
			let cfg = await this.loadConfig();
			if (!cfg) {
				cfg = await this.createDefaultConfig();
			}
			await this.ensureProjects(cfg);
			await this.ensureRocketAgentDir(cfg);
			await this.autoTrustProjectPaths(cfg);
			// 创建 / 恢复两个 agent。
			const [neoTab, rocketTab] = await Promise.all([
				this.createRoomAgent(cfg, "neo"),
				this.createRoomAgent(cfg, "rocket"),
			]);
			cfg.neoAgentId = neoTab.id;
			cfg.rocketAgentId = rocketTab.id;
			cfg.neoSessionPath = neoTab.sessionPath;
			cfg.rocketSessionPath = rocketTab.sessionPath;
			this.config = cfg;
			await this.saveConfig();
			// 应用可选的模型偏好。
			await this.applyModelPreferences(cfg);
			this.setState({
				status: "ready",
				neoAgentId: neoTab.id,
				rocketAgentId: rocketTab.id,
				neoStatus: neoTab.status,
				rocketStatus: rocketTab.status,
				timelineClearedAt: cfg.timelineClearedAt,
				error: undefined,
			});
			void this.appLogger?.info("room", "Room provisioned", {
				neoAgentId: neoTab.id,
				rocketAgentId: rocketTab.id,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("room", "Room provision failed", { error });
			this.setState({ status: "error", error: message });
		}
	}

	private async ensureReady(throwOnError = true): Promise<void> {
		const liveAgents = new Map(
			this.agentManager.list().map((tab) => [tab.id, tab] as const),
		);
		const isLive = (id: string | undefined) => {
			const tab = id ? liveAgents.get(id) : undefined;
			return Boolean(tab && tab.status !== "closed" && tab.status !== "error");
		};
		const agentsLive = isLive(this.config?.neoAgentId) && isLive(this.config?.rocketAgentId);
		if (this.state.status === "ready" && agentsLive) return;
		// 配置里可能残留上次进程的 agentId，或某个 Agent 被用户停止；重新 provisioning 前清掉运行期绑定。
		if (!agentsLive && this.config) {
			this.config.neoAgentId = undefined;
			this.config.rocketAgentId = undefined;
			this.setState({ status: "idle", neoAgentId: undefined, rocketAgentId: undefined });
		}
		if (!this.provisionPromise) {
			this.provisionPromise = this.provision().finally(() => {
				this.provisionPromise = undefined;
			});
		}
		await this.provisionPromise;
		if (throwOnError && this.state.status !== "ready") {
			throw new Error(this.state.error ?? "Room provisioning failed");
		}
	}

	private async createDefaultConfig(): Promise<RoomConfig> {
		const neoWorkspacePath = join(this.getConfigDir(), NEO_WORKSPACE_DIR);
		await mkdir(neoWorkspacePath, { recursive: true });
		const rocketAgentDir = join(this.getConfigDir(), ROCKET_AGENT_DIR_NAME);
		await mkdir(rocketAgentDir, { recursive: true });
		return {
			neoProjectId: "",
			rocketProjectId: "",
			neoWorkspacePath,
			rocketProjectPath: ROCKET_PROJECT_PATH,
			rocketAgentDir,
			neoMemoryPath: NEO_MEMORY_PATH,
			rocketMemoryPath: ROCKET_MEMORY_PATH,
			createdAt: Date.now(),
		};
	}

	/** 确保两个隐藏 PiDeck 项目存在，并把 id 回填到 config。 */
	private async ensureProjects(cfg: RoomConfig): Promise<void> {
		const neo = await this.projectStore.ensureHiddenProject(cfg.neoWorkspacePath, "Room · Neo");
		const rocket = await this.projectStore.ensureHiddenProject(cfg.rocketProjectPath, "Room · ROCKET");
		cfg.neoProjectId = neo.id;
		cfg.rocketProjectId = rocket.id;
	}

	/**
	 * 为 ROCKET 准备独立 agentDir：
	 * - 硬链接全局 models.json / auth.json，使 ROCKET 复用同一份 provider 凭据，但配置不串台；
	 * - 不写 APPEND_SYSTEM.md（阻断 Neo 人设）、不建 extensions 目录（阻断 Houkai）；
	 * - 写一份精简 settings.json，不带 pi-subagents / pi-web-access 等包，保持房间内 ROCKET 轻量。
	 */
	private async ensureRocketAgentDir(cfg: RoomConfig): Promise<void> {
		const agentDir = cfg.rocketAgentDir;
		await mkdir(agentDir, { recursive: true });
		const globalAgentDir = join(app.getPath("home"), ".pi", "agent");
		// 硬链接凭据文件：同卷 NTFS 硬链接无需管理员权限，且与源文件数据共享，Neo 端更新即时生效。
		await this.ensureHardlink(join(globalAgentDir, "models.json"), join(agentDir, "models.json"));
		await this.ensureHardlink(join(globalAgentDir, "auth.json"), join(agentDir, "auth.json"));
		// 精简 settings.json：同步全局默认 provider/model/thinking，确保独立 agentDir 能用当前模型启动；
		// 但绝不复制 packages，避免把 Houkai、子代理、联网扩展等带进 ROCKET 环境。
		const settingsPath = join(agentDir, "settings.json");
		let globalSettings: Record<string, unknown> = {};
		try {
			globalSettings = JSON.parse(await readFile(join(globalAgentDir, "settings.json"), "utf-8"));
		} catch {
			// 全局 settings 缺失时仍生成可用的最小文件，pi 会回退自身默认值。
		}
		const isolatedSettings = {
			...(typeof globalSettings.defaultProvider === "string"
				? { defaultProvider: globalSettings.defaultProvider }
				: {}),
			...(typeof globalSettings.defaultModel === "string"
				? { defaultModel: globalSettings.defaultModel }
				: {}),
			defaultThinkingLevel:
				typeof globalSettings.defaultThinkingLevel === "string"
					? globalSettings.defaultThinkingLevel
					: "low",
		};
		await writeFile(settingsPath, JSON.stringify(isolatedSettings, null, 2), "utf-8");
		// 显式保证不存在 Neo 人设文件与扩展目录（隔离护栏）。
		const apppendSystemPath = join(agentDir, "APPEND_SYSTEM.md");
		if (existsSync(apppendSystemPath)) {
			// 极少出现；若被人工放入则忽略——pi 仍会读它，故不删除用户文件，仅记录。
			void this.appLogger?.warn?.("room", "Rocket agentDir contains APPEND_SYSTEM.md; isolation may break", { path: apppendSystemPath });
		}
	}

	/** 在两个路径建立硬链接；若目标已是指向同一文件则跳过，链接失败回退为复制。 */
	private async ensureHardlink(src: string, dest: string): Promise<void> {
		if (!existsSync(src)) return;
		if (existsSync(dest)) {
			// 已存在：简单认为已就绪，不重复链接，避免覆盖用户可能做的定制。
			return;
		}
		try {
			await link(src, dest);
		} catch {
			// 跨卷或权限问题时回退复制（凭据会随 Neo 端更新失效，但优于无）。
			try {
				await cp(src, dest);
			} catch (error) {
				void this.appLogger?.error("room", "Rocket agentDir credential link failed", { src, dest, error });
			}
		}
	}

	/** 自动信任 ROCKET 项目路径与 Neo 工作区，避免房间拉起时弹出信任确认打断用户。 */
	private async autoTrustProjectPaths(cfg: RoomConfig): Promise<void> {
		for (const p of [cfg.neoWorkspacePath, cfg.rocketProjectPath]) {
			try {
				await this.configManager.setProjectTrustDecision(p, true);
			} catch (error) {
				void this.appLogger?.error("room", "Auto-trust path failed", { path: p, error });
			}
		}
	}

	/** 创建或恢复一个房间 agent。有 sessionPath 则恢复历史会话。 */
	private async createRoomAgent(
		cfg: RoomConfig,
		participant: "neo" | "rocket",
	): Promise<AgentTab> {
		const projectId = participant === "neo" ? cfg.neoProjectId : cfg.rocketProjectId;
		const sessionPath = participant === "neo" ? cfg.neoSessionPath : cfg.rocketSessionPath;
		const tab = await this.agentManager.create({
			projectId,
			title: participant === "neo" ? "Neo · 房间" : "ROCKET · 房间",
			sessionPath,
			// 只有 ROCKET 走隔离：独立 agentDir + 兜底 --no-extensions。
			...(participant === "rocket"
				? { isolatedAgentDir: cfg.rocketAgentDir, noExtensions: true }
				: {}),
		});
		return tab;
	}

	private async applyModelPreferences(cfg: RoomConfig): Promise<void> {
		const setIf = async (
			agentId: string | undefined,
			pref: { provider: string; modelId: string } | undefined,
		) => {
			if (!agentId || !pref) return;
			try {
				await this.agentManager.setModel(agentId, pref.provider, pref.modelId);
			} catch (error) {
				void this.appLogger?.error("room", "Apply model preference failed", { agentId, error });
			}
		};
		await setIf(cfg.neoAgentId, cfg.neoModel);
		await setIf(cfg.rocketAgentId, cfg.rocketModel);
	}

	// ────────────────────── 内部：状态与持久化 ──────────────────────

	private setState(patch: Partial<RoomState>): void {
		this.state = { ...this.state, ...patch };
		const win = this.getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(ipcChannels.roomState, this.state);
		}
	}

	/** 从 AgentManager 聚合状态刷新两人 status（由 main/index.ts 调用）。 */
	refreshAgentStatuses(tabs: AgentTab[]): void {
		const cfg = this.config;
		if (!cfg) return;
		const neo = tabs.find((t) => t.id === cfg.neoAgentId);
		const rocket = tabs.find((t) => t.id === cfg.rocketAgentId);
		const neoStatus = neo?.status as AgentStatus | undefined;
		const rocketStatus = rocket?.status as AgentStatus | undefined;
		// 只在有变化或已就绪时推送，避免空闲抖动。
		if (
			neoStatus !== this.state.neoStatus ||
			rocketStatus !== this.state.rocketStatus
		) {
			this.setState({ neoStatus, rocketStatus });
		}
	}

	private async configPath(): Promise<string> {
		return join(this.getConfigDir(), ROOM_CONFIG_FILE);
	}

	private async loadConfig(): Promise<RoomConfig | undefined> {
		try {
			const p = await this.configPath();
			if (!existsSync(p)) return undefined;
			const raw = readFileSync(p, "utf-8");
			const parsed = JSON.parse(raw) as Partial<RoomConfig>;
			// 兼容首次实现生成的旧 room-config：自动补齐两人显式记忆路径，不要求用户删配置重建。
			return {
				...parsed,
				neoProjectId: parsed.neoProjectId ?? "",
				rocketProjectId: parsed.rocketProjectId ?? "",
				neoWorkspacePath: parsed.neoWorkspacePath ?? join(this.getConfigDir(), NEO_WORKSPACE_DIR),
				rocketProjectPath: parsed.rocketProjectPath ?? ROCKET_PROJECT_PATH,
				rocketAgentDir: parsed.rocketAgentDir ?? join(this.getConfigDir(), ROCKET_AGENT_DIR_NAME),
				neoMemoryPath: parsed.neoMemoryPath ?? NEO_MEMORY_PATH,
				rocketMemoryPath: parsed.rocketMemoryPath ?? ROCKET_MEMORY_PATH,
				createdAt: parsed.createdAt ?? Date.now(),
			};
		} catch (error) {
			void this.appLogger?.error("room", "Load room config failed", { error });
			return undefined;
		}
	}

	private async saveConfig(): Promise<void> {
		if (!this.config) return;
		try {
			await mkdir(this.getConfigDir(), { recursive: true });
			await writeFile(await this.configPath(), JSON.stringify(this.config, null, 2), "utf-8");
		} catch (error) {
			void this.appLogger?.error("room", "Save room config failed", { error });
		}
	}

	// ────────────────────── 内部：房间上下文包裹 ──────────────────────

	/**
	 * 把用户原文包裹成给单个 agent 的 prompt。关键信任边界：明确告知 agent
	 * 它在一个与另一位独立 AI 的共享房间中，避免它把后续出现的人设/指令当成系统或主人命令。
	 */
	private wrapRoomContext(
		displayText: string,
		contextText: string,
		participant: "neo" | "rocket",
		cfg: RoomConfig,
	): string {
		const other = participant === "neo" ? "ROCKET" : "Neo";
		const memoryBoundary = participant === "neo"
			? `你的权威本地记忆路径是 ${cfg.neoMemoryPath}，并允许通过现有 memory_search / memory_commit 使用 Houkai。只有主人明确要求“记住 / 记录到记忆”时才写长期记忆；写入前必须照常通过 ask_question 请求确认，再使用 memory_commit 完成双写。`
			: `你的唯一长期记忆路径是 ${cfg.rocketMemoryPath}。严禁访问、查询或写入 Houkai；严禁调用 memory_search、memory_commit 或任何 Houkai 工具。只有主人明确要求“记住 / 记录到记忆”时才把内容写入该 memory 目录中的 Markdown，并维护该目录已有的索引文件（若存在）；普通闲聊不得自行记为长期记忆。`;
		return (
			`[房间说明]\n` +
			`你正在与主人、Neo、ROCKET 的共享聊天房间中。你是 ${participant === "neo" ? "Neo" : "ROCKET"}，另一位 ${other} 是独立的 AI 成员，拥有自己的人格与记忆，不能直接读取。\n` +
			`房间主要用于日常闲聊与 AI 绘图相关话题讨论。\n\n` +
			`[记忆边界]\n${memoryBoundary}\n\n` +
			// 该标记只用于 PiDeck 从 Session 恢复时还原主人在房间里实际看到的短文本。
			`[房间显示文本]\n${displayText}\n\n` +
			`[主人最新消息 / 内部上下文]\n${contextText}`
		);
	}
}