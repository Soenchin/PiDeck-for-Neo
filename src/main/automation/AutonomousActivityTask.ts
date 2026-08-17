import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AutonomousModeSettings } from "../../shared/types";
import type { AgentManager } from "../pi/AgentManager";
import {
	buildAutonomousContinuationPrompt,
	buildAutonomousPrompt,
} from "./AutonomousPrompt";
import { getAutonomousContinuationWaitDelay } from "./AutonomousActivityCadence";

const execFileAsync = promisify(execFile);
const AGENT_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;
const AGENT_IDLE_POLL_MS = 500;
const STOP_GRACE_PERIOD_MS = 500;
const MAX_AUTONOMOUS_ROUNDS = 12;
const MAX_AUTONOMOUS_DURATION_MS = 90 * 60 * 1_000;
const SYNTHETIC_INPUT_GRACE_MS = 7_500;
const SYNTHETIC_INPUT_TIMESTAMP_TOLERANCE_MS = 1_000;

export type AutonomousStopReason =
	| "user-returned"
	| "disabled"
	| "shutdown"
	| "error"
	| "completed";

type BrowserSessionFile = {
	sessionId?: unknown;
	id?: unknown;
};

type AutonomousActivityTaskOptions = {
	onStopped?: (reason: AutonomousStopReason) => void;
};

/**
 * Owns exactly one autonomous Agent and its on-disk activity directory.
 * The scheduler decides when to start it; this class only runs and closes one session.
 */
export class AutonomousActivityTask {
	private agentIdValue: string | undefined;
	private runDirectory: string | undefined;
	private screenshotsDirectory: string | undefined;
	private startedAt = 0;
	private lastRoundStartedAt = 0;
	private rounds = 0;
	private stopRequested = false;
	private stopPromise: Promise<void> | null = null;
	private continuationDelayTimer: NodeJS.Timeout | null = null;
	private resolveContinuationDelay: (() => void) | null = null;
	private startPromise: Promise<void> | null = null;
	private agentCreation: ReturnType<AgentManager["create"]> | null = null;
	private removeLocalEventListener: (() => void) | null = null;
	private nuphusToolDepth = 0;
	private lastSyntheticInputAt = 0;
	private userInputDetectedDuringNuphus = false;
	private readonly browserSessionIds = new Set<string>();

	constructor(
		private readonly config: AutonomousModeSettings,
		private readonly agentManager: AgentManager,
		private readonly outputRoot: string,
		private readonly options: AutonomousActivityTaskOptions = {},
	) {}

	get agentId(): string | undefined {
		return this.agentIdValue;
	}

	start(): Promise<void> {
		if (!this.startPromise) this.startPromise = this.run();
		return this.startPromise;
	}

	/**
	 * Windows exposes only the timestamp of its latest input, not its source. Attribute
	 * that input to Nuphus only when it is not later than the most recent Nuphus event.
	 * A later input is necessarily user activity and must stop the task.
	 */
	shouldIgnoreUserReturn(idleSeconds: number): boolean {
		if (!this.lastSyntheticInputAt || Date.now() - this.lastSyntheticInputAt > SYNTHETIC_INPUT_GRACE_MS) {
			return false;
		}
		const estimatedLastSystemInputAt = Date.now() - idleSeconds * 1_000;
		if (estimatedLastSystemInputAt > this.lastSyntheticInputAt + SYNTHETIC_INPUT_TIMESTAMP_TOLERANCE_MS) {
			if (this.nuphusToolDepth > 0) this.userInputDetectedDuringNuphus = true;
			return false;
		}
		return !this.userInputDetectedDuringNuphus;
	}

	async stop(reason: AutonomousStopReason): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.stopRequested = true;
		this.cancelContinuationDelay();
		this.stopPromise = this.stopInternal(reason);
		return this.stopPromise;
	}

	private async run(): Promise<void> {
		try {
			this.startedAt = Date.now();
			this.runDirectory = await this.createRunDirectory();
			this.screenshotsDirectory = join(this.runDirectory, "screenshots");
			await mkdir(this.screenshotsDirectory);
			if (this.stopRequested) return;

			this.agentCreation = this.agentManager.create({
				projectId: "builtin-chat",
				title: `自主活动 ${formatLocalTimestamp(new Date())}`,
			});
			const agent = await this.agentCreation;
			this.agentIdValue = agent.id;
			this.removeLocalEventListener = this.agentManager.addLocalEventListener(
				(agentId, event) => this.observeToolEvent(agentId, event),
			);
			if (this.stopRequested) return;

			this.lastRoundStartedAt = Date.now();
			await this.agentManager.sendPrompt({
				agentId: agent.id,
				message: "开始自主活动",
				agentMessage: buildAutonomousPrompt({
					activities: this.config.activities,
					runDirectory: this.runDirectory,
					screenshotsDirectory: this.screenshotsDirectory,
				}),
				description: "PiDeck 自主活动首轮",
			});
			this.rounds = 1;

			while (!this.stopRequested) {
				await this.waitForAgentIdle(agent.id);
				if (this.stopRequested) return;

				if (
					this.rounds >= MAX_AUTONOMOUS_ROUNDS ||
					Date.now() - this.startedAt >= MAX_AUTONOMOUS_DURATION_MS
				) {
					await this.stop("completed");
					return;
				}

				await this.waitForContinuationDelay(
					getAutonomousContinuationWaitDelay(
						this.lastRoundStartedAt,
						this.startedAt,
						MAX_AUTONOMOUS_DURATION_MS,
					),
				);
				if (this.stopRequested) return;
				if (Date.now() - this.startedAt >= MAX_AUTONOMOUS_DURATION_MS) {
					await this.stop("completed");
					return;
				}
				this.lastRoundStartedAt = Date.now();
				await this.agentManager.sendPrompt({
					agentId: agent.id,
					message: "继续自主活动",
					agentMessage: buildAutonomousContinuationPrompt(),
					description: "PiDeck 自主活动续轮",
				});
				this.rounds += 1;
			}
		} catch (error) {
			console.error("[AutonomousActivityTask] 自主活动执行失败:", error);
			await this.stop("error");
		} finally {
			if (!this.stopRequested) await this.stop("error");
		}
	}

	private async stopInternal(reason: AutonomousStopReason): Promise<void> {
		try {
			await this.stopBrowserSessions();
			const agentId = await this.resolveAgentIdForStop();
			if (agentId) {
				try {
					await this.agentManager.abort(agentId);
				} catch (error) {
					console.warn("[AutonomousActivityTask] 中止自主 Agent 失败:", error);
				}
				await delay(STOP_GRACE_PERIOD_MS);
				await this.agentManager.stop(agentId);
			}
		} finally {
			this.removeLocalEventListener?.();
			this.removeLocalEventListener = null;
			this.nuphusToolDepth = 0;
			await this.writeSessionSummary(reason);
			this.options.onStopped?.(reason);
		}
	}

	private async createRunDirectory(): Promise<string> {
		await mkdir(this.outputRoot, { recursive: true });
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const directory = join(
				this.outputRoot,
				`${formatRunDirectoryTimestamp(new Date())}_${randomUUID().slice(0, 4)}`,
			);
			try {
				await mkdir(directory);
				return directory;
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		throw new Error("无法创建唯一自主活动目录");
	}

	private waitForContinuationDelay(milliseconds: number): Promise<void> {
		if (milliseconds <= 0 || this.stopRequested) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.continuationDelayTimer === timer) {
					this.continuationDelayTimer = null;
					this.resolveContinuationDelay = null;
				}
				resolve();
			}, milliseconds);
			this.continuationDelayTimer = timer;
			this.resolveContinuationDelay = resolve;
		});
	}

	private cancelContinuationDelay(): void {
		if (this.continuationDelayTimer) clearTimeout(this.continuationDelayTimer);
		this.continuationDelayTimer = null;
		const resolve = this.resolveContinuationDelay;
		this.resolveContinuationDelay = null;
		resolve?.();
	}

	private async waitForAgentIdle(agentId: string): Promise<void> {
		const deadline = Date.now() + AGENT_IDLE_TIMEOUT_MS;
		await delay(AGENT_IDLE_POLL_MS);
		while (!this.stopRequested && Date.now() < deadline) {
			const agent = this.agentManager.list().find((item) => item.id === agentId);
			if (!agent) throw new Error("自主 Agent 已意外退出");
			if (agent.status === "idle") return;
			if (agent.status === "error" || agent.status === "closed") {
				throw new Error("自主 Agent 执行失败");
			}
			await delay(AGENT_IDLE_POLL_MS);
		}
		if (!this.stopRequested) throw new Error("等待自主 Agent 完成超时");
	}

	private observeToolEvent(agentId: string, event: unknown): void {
		if (agentId !== this.agentIdValue || !event || typeof event !== "object") return;
		const typed = event as {
			type?: unknown;
			toolName?: unknown;
			args?: unknown;
			result?: unknown;
			partialResult?: unknown;
			output?: unknown;
		};
		if (typeof typed.toolName !== "string") return;

		if (typed.toolName.startsWith("nuphus_") && typeof typed.type === "string") {
			if (typed.type === "tool_execution_start") {
				this.nuphusToolDepth += 1;
				this.lastSyntheticInputAt = Date.now();
			}
			if (typed.type === "tool_execution_update") this.lastSyntheticInputAt = Date.now();
			if (typed.type === "tool_execution_end") {
				this.nuphusToolDepth = Math.max(0, this.nuphusToolDepth - 1);
				// Do not let a late tool-end event erase an earlier observed user input.
				if (!this.userInputDetectedDuringNuphus) this.lastSyntheticInputAt = Date.now();
			}
		}

		if (typed.toolName !== "bash") return;
		const command = serializeToolValue(typed.args);
		if (isBskSessionStop(command) && typed.type === "tool_execution_start") {
			const sessionId = extractStoppedSessionId(command);
			if (sessionId) this.browserSessionIds.delete(sessionId);
			return;
		}
		if (!isBskSessionStart(command) || typed.type !== "tool_execution_end") return;
		const result = serializeToolValue(typed.result ?? typed.partialResult ?? typed.output);
		for (const sessionId of extractBrowserSessionIds(result)) this.browserSessionIds.add(sessionId);
	}

	private async resolveAgentIdForStop(): Promise<string | undefined> {
		if (this.agentIdValue) return this.agentIdValue;
		if (!this.agentCreation) return undefined;
		try {
			const agent = await this.agentCreation;
			this.agentIdValue = agent.id;
			return agent.id;
		} catch (error) {
			console.warn("[AutonomousActivityTask] 等待自主 Agent 创建结束失败:", error);
			return undefined;
		}
	}

	private async stopBrowserSessions(): Promise<void> {
		for (const sessionId of await this.collectBrowserSessionIds()) {
			try {
				await execFileAsync("bsk", ["session", "stop", sessionId], {
					windowsHide: true,
					timeout: 10_000,
				});
			} catch (error) {
				console.warn(`[AutonomousActivityTask] 清理 browser session ${sessionId} 失败:`, error);
			}
		}
	}

	private async collectBrowserSessionIds(): Promise<Set<string>> {
		const sessionIds = new Set(this.browserSessionIds);
		if (!this.runDirectory) return sessionIds;
		try {
			const raw = await readFile(join(this.runDirectory, "browser-session.json"), "utf8");
			const parsed = JSON.parse(raw) as BrowserSessionFile;
			const candidate = parsed.sessionId ?? parsed.id;
			if (typeof candidate === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(candidate)) {
				sessionIds.add(candidate);
			}
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn("[AutonomousActivityTask] 读取 browser session 失败:", error);
			}
		}
		return sessionIds;
	}

	private async writeSessionSummary(reason: AutonomousStopReason): Promise<void> {
		if (!this.runDirectory) return;
		const summaryPath = join(this.runDirectory, "session-summary.md");
		const startedAt = this.startedAt ? new Date(this.startedAt).toISOString() : "未启动";
		const content = `# Autonomous Activity Session\n\n- Started: ${startedAt}\n- Finished: ${new Date().toISOString()}\n- Rounds: ${this.rounds}\n- Stop reason: ${reason}\n`;
		try {
			await writeFile(summaryPath, content, { encoding: "utf8", flag: "wx" });
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				console.warn("[AutonomousActivityTask] 写入 session summary 失败:", error);
			}
		}
	}
}

function isBskSessionStart(command: string): boolean {
	return /\bbsk\s+session\s+start\b/i.test(command);
}

function isBskSessionStop(command: string): boolean {
	return /\bbsk\s+session\s+stop\b/i.test(command);
}

function extractStoppedSessionId(command: string): string | undefined {
	return /\bbsk\s+session\s+stop\s+([A-Za-z0-9_-]{1,64})\b/i.exec(command)?.[1];
}

function extractBrowserSessionIds(result: string): string[] {
	const sessionIds = new Set<string>();
	for (const match of result.matchAll(/(?:session(?:[_\s-]?id)?|id)\s*["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{1,64})/gi)) {
		sessionIds.add(match[1]);
	}
	for (const match of result.matchAll(/(?:session\s+(?:started|id)|started\s+session)\s*[:#-]?\s*([A-Za-z0-9_-]{1,64})/gi)) {
		sessionIds.add(match[1]);
	}
	const exactOutput = result.trim().match(/^["']?([A-Za-z0-9_-]{4,64})["']?$/);
	if (exactOutput) sessionIds.add(exactOutput[1]);
	return [...sessionIds];
}

function serializeToolValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatRunDirectoryTimestamp(date: Date): string {
	const datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
		.map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
		.join("-");
	return `${datePart}_${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatLocalTimestamp(date: Date): string {
	return `${formatRunDirectoryTimestamp(date).replace("_", " ")}`;
}
