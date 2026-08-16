import { powerMonitor } from "electron";

const IDLE_POLL_INTERVAL_MS = 5_000;
const RETURN_CONFIRMATION_POLLS = 2;
const RETURN_INPUT_WINDOW_SECONDS = Math.ceil(IDLE_POLL_INTERVAL_MS / 1_000) + 1;

type IdleTimeSource = () => number;

export type IdleMonitorOptions = {
	idleThresholdMinutes: number;
	onIdleReached: () => void;
	onUserReturned: () => void;
	/** Nuphus can reset Windows' idle counter; callers suppress only attributable synthetic input. */
	shouldIgnoreUserReturn?: (idleSeconds: number) => boolean;
	getSystemIdleTime?: IdleTimeSource;
	pollIntervalMs?: number;
	returnConfirmationPolls?: number;
};

/**
 * Owns system idle observation only. It deliberately knows nothing about Agent lifetimes,
 * so the scheduler remains the single owner of autonomous task creation and cleanup.
 */
export class IdleMonitor {
	private interval: NodeJS.Timeout | null = null;
	private idleReached = false;
	private returnConfirmationCount = 0;
	private previousIdleSeconds: number | null = null;
	private nextIdleCheckAt = 0;

	constructor(private readonly options: IdleMonitorOptions) {}

	start(): void {
		if (this.interval) return;
		this.poll();
		this.interval = setInterval(
			() => this.poll(),
			this.options.pollIntervalMs ?? IDLE_POLL_INTERVAL_MS,
		);
	}

	stop(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
		this.idleReached = false;
		this.returnConfirmationCount = 0;
		this.previousIdleSeconds = null;
		this.nextIdleCheckAt = 0;
	}

	/** Delay another idle-reached callback without leaving an interval behind. */
	deferIdleReached(delayMs: number): void {
		this.idleReached = false;
		this.returnConfirmationCount = 0;
		this.nextIdleCheckAt = Date.now() + Math.max(0, delayMs);
	}

	private poll(): void {
		const idleSeconds = this.getIdleSeconds();
		const thresholdSeconds = Math.max(1, this.options.idleThresholdMinutes * 60);

		if (!this.idleReached) {
			this.previousIdleSeconds = idleSeconds;
			if (Date.now() < this.nextIdleCheckAt || idleSeconds < thresholdSeconds) return;
			this.idleReached = true;
			this.returnConfirmationCount = 0;
			this.notify(this.options.onIdleReached, "空闲阈值回调失败");
			return;
		}

		if (this.options.shouldIgnoreUserReturn?.(idleSeconds)) {
			this.returnConfirmationCount = 0;
			this.previousIdleSeconds = idleSeconds;
			return;
		}

		const recentlyActive = idleSeconds <= RETURN_INPUT_WINDOW_SECONDS;
		const idleTimeMovedBackward =
			this.previousIdleSeconds !== null && idleSeconds < this.previousIdleSeconds;
		this.previousIdleSeconds = idleSeconds;

		if (!recentlyActive && !idleTimeMovedBackward) {
			this.returnConfirmationCount = 0;
			return;
		}

		this.returnConfirmationCount += 1;
		if (this.returnConfirmationCount < (this.options.returnConfirmationPolls ?? RETURN_CONFIRMATION_POLLS)) {
			return;
		}

		this.idleReached = false;
		this.returnConfirmationCount = 0;
		this.notify(this.options.onUserReturned, "用户回归回调失败");
	}

	private getIdleSeconds(): number {
		try {
			const idleSeconds = (this.options.getSystemIdleTime ?? (() => powerMonitor.getSystemIdleTime()))();
			return Number.isFinite(idleSeconds) && idleSeconds >= 0 ? idleSeconds : 0;
		} catch (error) {
			console.error("[IdleMonitor] 读取系统空闲时间失败:", error);
			return 0;
		}
	}

	private notify(callback: () => void, errorMessage: string): void {
		try {
			callback();
		} catch (error) {
			console.error(`[IdleMonitor] ${errorMessage}:`, error);
		}
	}
}
