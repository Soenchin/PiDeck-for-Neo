import cron, { type ScheduledTask } from "node-cron";
import type { AppSettings, DailySummarySettings } from "../../shared/types";
import type { AgentManager } from "../pi/AgentManager";
import type { SessionScanner } from "../sessions/SessionScanner";
import {
	DailySummaryTask,
	type DailySummaryReviewHandler,
} from "./DailySummaryTask";

export class AutomationScheduler {
	private dailySummaryTask: ScheduledTask | null = null;
	private dailySummaryRunning = false;

	constructor(
		private readonly sessionScanner: SessionScanner,
		private readonly agentManager: AgentManager,
		private readonly requestReview: DailySummaryReviewHandler,
	) {}

	start(settings: AppSettings): void {
		const config = settings.automation?.dailySummary;
		if (config?.enabled) this.startDailySummary(config);

		if (settings.automation?.autonomousMode?.enabled) {
			console.warn("[AutomationScheduler] 自主活动尚未实现，已忽略启用配置");
		}
	}

	stop(): void {
		this.dailySummaryTask?.stop();
		this.dailySummaryTask = null;
	}

	reload(settings: AppSettings): void {
		this.stop();
		this.start(settings);
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
