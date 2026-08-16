import cron, { type ScheduledTask } from "node-cron";
import type {
	AppSettings,
	AutonomousModeSettings,
	DailySummarySettings,
} from "../../shared/types";
import type { AgentManager } from "../pi/AgentManager";
import type { SessionScanner } from "../sessions/SessionScanner";
import {
	AutonomousActivityTask,
	type AutonomousStopReason,
} from "./AutonomousActivityTask";
import {
	DailySummaryTask,
	type DailySummaryReviewHandler,
} from "./DailySummaryTask";
import { IdleMonitor } from "./IdleMonitor";
import { checkUserPresence } from "./PresenceProbe";

const AUTONOMOUS_OUTPUT_ROOT = "X:\\CC\\surfing~";
const PRESENCE_RECHECK_AFTER_PRESENT_MS = 60_000;
const ACTIVE_PRESENCE_CHECK_INTERVAL_MS = 30_000;

export class AutomationScheduler {
	private dailySummaryTask: ScheduledTask | null = null;
	private dailySummaryRunning = false;
	private idleMonitor: IdleMonitor | null = null;
	private autonomousTask: AutonomousActivityTask | null = null;
	private autonomousSuppressedUntilUserReturn = false;
	private autonomousStartInFlight = false;
	private activePresenceCheckTimer: NodeJS.Timeout | null = null;
	private activePresenceCheckInFlight = false;
	/** Invalidates an idle-triggered async presence check when settings reload or app exit begins. */
	private lifecycleGeneration = 0;

	constructor(
		private readonly sessionScanner: SessionScanner,
		private readonly agentManager: AgentManager,
		private readonly requestReview: DailySummaryReviewHandler,
	) {}

	async start(settings: AppSettings): Promise<void> {
		const dailySummaryConfig = settings.automation?.dailySummary;
		if (dailySummaryConfig?.enabled) this.startDailySummary(dailySummaryConfig);

		const autonomousConfig = settings.automation?.autonomousMode;
		if (!autonomousConfig?.enabled) return;
		if (!autonomousConfig.activities.search && !autonomousConfig.activities.games) {
			console.warn("[AutomationScheduler] 自主活动未选择任何活动，未启动空闲监控");
			return;
		}
		this.startAutonomousMonitor(autonomousConfig);
	}

	async stop(reason: "disabled" | "shutdown" = "disabled"): Promise<void> {
		this.lifecycleGeneration += 1;
		this.dailySummaryTask?.stop();
		this.dailySummaryTask = null;
		this.idleMonitor?.stop();
		this.idleMonitor = null;
		this.stopActivePresenceChecks();
		this.autonomousSuppressedUntilUserReturn = false;

		const task = this.autonomousTask;
		this.autonomousTask = null;
		if (task) await task.stop(reason);
	}

	async reload(settings: AppSettings): Promise<void> {
		await this.stop("disabled");
		await this.start(settings);
	}

	private startAutonomousMonitor(config: AutonomousModeSettings): void {
		if (this.idleMonitor) return;
		this.idleMonitor = new IdleMonitor({
			idleThresholdMinutes: config.idleThresholdMinutes,
			onIdleReached: () => this.startAutonomousActivity(config),
			onUserReturned: () => this.stopForUserReturn(),
			shouldIgnoreUserReturn: (idleSeconds) =>
				this.autonomousTask?.shouldIgnoreUserReturn(idleSeconds) ?? false,
		});
		this.idleMonitor.start();
		console.log(`[AutomationScheduler] 自主活动空闲监控已启动，阈值 ${config.idleThresholdMinutes} 分钟`);
	}

	private startAutonomousActivity(config: AutonomousModeSettings): void {
		void this.startAutonomousActivityAfterPresenceCheck(config);
	}

	private async startAutonomousActivityAfterPresenceCheck(
		config: AutonomousModeSettings,
	): Promise<void> {
		if (
			this.autonomousTask ||
			this.autonomousSuppressedUntilUserReturn ||
			this.autonomousStartInFlight
		) {
			return;
		}
		this.autonomousStartInFlight = true;
		const generation = this.lifecycleGeneration;
		try {
			const presence = await checkUserPresence();
			if (generation !== this.lifecycleGeneration) return;
			if (!presence || presence.verdict === "PRESENT") {
				console.log(
					`[AutomationScheduler] 用户仍在场或状态未知，延后自主活动${presence ? ` (${presence.reason})` : ""}`,
				);
				this.idleMonitor?.deferIdleReached(PRESENCE_RECHECK_AFTER_PRESENT_MS);
				return;
			}

			const task = new AutonomousActivityTask(config, this.agentManager, AUTONOMOUS_OUTPUT_ROOT, {
				onStopped: (reason) => this.handleAutonomousTaskStopped(task, reason),
			});
			this.autonomousTask = task;
			this.startActivePresenceChecks(task);
			void task.start().catch((error) => {
				console.error("[AutomationScheduler] 自主活动任务执行失败:", error);
			});
		} finally {
			this.autonomousStartInFlight = false;
		}
	}

	private stopForUserReturn(): void {
		this.autonomousSuppressedUntilUserReturn = false;
		const task = this.autonomousTask;
		if (task) void task.stop("user-returned");
	}

	private handleAutonomousTaskStopped(
		task: AutonomousActivityTask,
		reason: AutonomousStopReason,
	): void {
		if (this.autonomousTask !== task) return;
		this.stopActivePresenceChecks();
		this.autonomousTask = null;
		// Reaching an internal limit or failing must not immediately consume another
		// autonomous session while the same absence is still in progress.
		if (reason === "completed" || reason === "error") {
			this.autonomousSuppressedUntilUserReturn = true;
		}
	}

	private startActivePresenceChecks(task: AutonomousActivityTask): void {
		this.stopActivePresenceChecks();
		this.activePresenceCheckTimer = setInterval(() => {
			void this.checkActiveUserPresence(task);
		}, ACTIVE_PRESENCE_CHECK_INTERVAL_MS);
	}

	private stopActivePresenceChecks(): void {
		if (this.activePresenceCheckTimer) clearInterval(this.activePresenceCheckTimer);
		this.activePresenceCheckTimer = null;
		this.activePresenceCheckInFlight = false;
	}

	private async checkActiveUserPresence(task: AutonomousActivityTask): Promise<void> {
		if (this.autonomousTask !== task || this.activePresenceCheckInFlight) return;
		this.activePresenceCheckInFlight = true;
		try {
			const presence = await checkUserPresence();
			if (this.autonomousTask !== task || !presence || presence.verdict !== "PRESENT") return;
			const nuphusInputIsExplained =
				presence.reason === "recent_input" && task.shouldIgnoreUserReturn(presence.idleSeconds);
			if (nuphusInputIsExplained) return;
			console.log(`[AutomationScheduler] 自主活动期间检测到用户在场 (${presence.reason})`);
			void task.stop("user-returned");
		} finally {
			this.activePresenceCheckInFlight = false;
		}
	}

	private startDailySummary(config: DailySummarySettings): void {
		const match = /^(\d{2}):(\d{2})$/.exec(config.time);
		if (!match) {
			console.error(`[AutomationScheduler] 无效的每日总结时间: ${config.time}`);
			return;
		}

		const hour = Number(match[1]);
		const minute = Number(match[2]);
		const cronExpression = `${minute} ${hour} * * *`;
		if (hour > 23 || minute > 59 || !cron.validate(cronExpression)) {
			console.error(`[AutomationScheduler] 无效的每日总结时间: ${config.time}`);
			return;
		}

		this.dailySummaryTask = cron.schedule(cronExpression, () => {
			if (this.dailySummaryRunning) {
				console.warn("[AutomationScheduler] 上一次每日总结仍在运行，本次跳过");
				return;
			}

			this.dailySummaryRunning = true;
			const task = new DailySummaryTask(
				config,
				this.sessionScanner,
				this.agentManager,
				this.requestReview,
			);
			void task.execute()
				.catch((error) => {
					console.error("[AutomationScheduler] 每日总结任务执行失败:", error);
				})
				.finally(() => {
					this.dailySummaryRunning = false;
				});
		});

		console.log(`[AutomationScheduler] 每日总结已安排在 ${config.time}`);
	}
}
