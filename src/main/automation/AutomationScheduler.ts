import type { AppSettings, AutonomousModeSettings, DailySummarySettings } from "../../shared/types";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { AutomationRuntimeFactory } from "./AutomationRuntime";
import { AutonomousActivityTask, type AutonomousStopReason } from "./AutonomousActivityTask";
import { DailySummaryTask, type DailySummaryReviewHandler } from "./DailySummaryTask";
import { IdleMonitor } from "./IdleMonitor";
import { checkUserPresence } from "./PresenceProbe";

const OUTPUT_ROOT = "X:\\CC\\surfing~";
const PRESENCE_RECHECK_MS = 60_000;

/** Owns both automation schedules and guarantees every timer/runtime has a paired cleanup. */
export class AutomationScheduler {
	private dailyTimer: NodeJS.Timeout | undefined;
	private dailyRunning = false;
	private idleMonitor: IdleMonitor | undefined;
	private autonomousTask: AutonomousActivityTask | undefined;
	private autonomousStartInFlight = false;
	private suppressedUntilReturn = false;
	private generation = 0;

	constructor(
		private readonly scanner: SessionScanner,
		private readonly runtimes: AutomationRuntimeFactory,
		private readonly requestReview: DailySummaryReviewHandler,
	) {}

	async start(settings: AppSettings): Promise<void> {
		if (settings.automation.dailySummary.enabled) this.scheduleDailySummary(settings.automation.dailySummary);
		if (settings.automation.autonomousMode.enabled && hasActivity(settings.automation.autonomousMode)) {
			this.startIdleMonitor(settings.automation.autonomousMode);
		}
	}

	async stop(reason: "disabled" | "shutdown" = "disabled"): Promise<void> {
		this.generation += 1;
		if (this.dailyTimer) clearTimeout(this.dailyTimer);
		this.dailyTimer = undefined;
		this.idleMonitor?.stop();
		this.idleMonitor = undefined;
		this.suppressedUntilReturn = false;
		const task = this.autonomousTask;
		this.autonomousTask = undefined;
		if (task) await task.stop(reason);
	}

	async reload(settings: AppSettings): Promise<void> {
		await this.stop();
		await this.start(settings);
	}

	private scheduleDailySummary(config: DailySummarySettings): void {
		const scheduleGeneration = this.generation;
		const delay = millisecondsUntilNextLocalTime(config.time);
		if (delay === undefined) {
			console.warn(`[AutomationScheduler] Invalid daily summary time: ${config.time}`);
			return;
		}
		this.dailyTimer = setTimeout(() => {
			this.dailyTimer = undefined;
			if (!this.dailyRunning) {
				this.dailyRunning = true;
				void new DailySummaryTask(config, this.scanner, this.runtimes, this.requestReview)
					.execute()
					.catch((error) => console.error("[AutomationScheduler] Daily summary failed", error))
					.finally(() => {
						this.dailyRunning = false;
						// A settings reload/quit invalidates the old schedule. Never resurrect it.
						if (this.generation === scheduleGeneration) this.scheduleDailySummary(config);
					});
			}
		}, delay);
		this.dailyTimer.unref?.();
		console.info(`[AutomationScheduler] Daily summary scheduled at ${config.time}`);
	}

	private startIdleMonitor(config: AutonomousModeSettings): void {
		this.idleMonitor = new IdleMonitor({
			idleThresholdMinutes: config.idleThresholdMinutes,
			onIdleReached: () => void this.startAfterPresenceCheck(config),
			onUserReturned: () => {
				this.suppressedUntilReturn = false;
				void this.autonomousTask?.stop("user-returned");
			},
		});
		this.idleMonitor.start();
	}

	private async startAfterPresenceCheck(config: AutonomousModeSettings): Promise<void> {
		if (this.autonomousTask || this.autonomousStartInFlight || this.suppressedUntilReturn) return;
		this.autonomousStartInFlight = true;
		const currentGeneration = this.generation;
		try {
			const presence = await checkUserPresence();
			if (currentGeneration !== this.generation) return;
			if (!presence || presence.verdict !== "AWAY") {
				this.idleMonitor?.stop();
				setTimeout(() => {
					if (currentGeneration === this.generation) this.idleMonitor?.start();
				}, PRESENCE_RECHECK_MS).unref?.();
				return;
			}
			const task = new AutonomousActivityTask(config, this.runtimes, OUTPUT_ROOT, (reason) => {
				if (this.autonomousTask !== task) return;
				this.autonomousTask = undefined;
				if (reason === "completed" || reason === "error") this.suppressedUntilReturn = true;
			});
			this.autonomousTask = task;
			void task.start();
		} finally {
			this.autonomousStartInFlight = false;
		}
	}
}

function hasActivity(config: AutonomousModeSettings): boolean {
	return config.activities.search || config.activities.games;
}

export function millisecondsUntilNextLocalTime(value: string, now = new Date()): number | undefined {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match) return undefined;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) return undefined;
	const next = new Date(now);
	next.setHours(hour, minute, 0, 0);
	if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
	return next.getTime() - now.getTime();
}

export type { AutonomousStopReason };
