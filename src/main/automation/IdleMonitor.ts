import { powerMonitor } from "electron";

const IDLE_POLL_INTERVAL_MS = 5_000;
const RETURN_CONFIRMATION_POLLS = 2;
const RETURN_INPUT_WINDOW_SECONDS = Math.ceil(IDLE_POLL_INTERVAL_MS / 1_000) + 1;

export type IdleMonitorOptions = {
	idleThresholdMinutes: number;
	onIdleReached: () => void;
	onUserReturned: () => void;
	getSystemIdleTime?: () => number;
	pollIntervalMs?: number;
	returnConfirmationPolls?: number;
};

/** Observes user presence only; task creation and cleanup stay in AutomationScheduler. */
export class IdleMonitor {
	private interval: NodeJS.Timeout | undefined;
	private idleReached = false;
	private returnConfirmationCount = 0;
	private previousIdleSeconds: number | undefined;

	constructor(private readonly options: IdleMonitorOptions) {}

	start(): void {
		if (this.interval) return;
		this.poll();
		this.interval = setInterval(() => this.poll(), this.options.pollIntervalMs ?? IDLE_POLL_INTERVAL_MS);
	}

	stop(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
		this.idleReached = false;
		this.returnConfirmationCount = 0;
		this.previousIdleSeconds = undefined;
	}

	private poll(): void {
		const idleSeconds = this.systemIdleSeconds();
		if (!this.idleReached) {
			this.previousIdleSeconds = idleSeconds;
			if (idleSeconds < Math.max(1, this.options.idleThresholdMinutes * 60)) return;
			this.idleReached = true;
			this.options.onIdleReached();
			return;
		}

		const recentInput = idleSeconds <= RETURN_INPUT_WINDOW_SECONDS;
		const wentBackward = this.previousIdleSeconds !== undefined && idleSeconds < this.previousIdleSeconds;
		this.previousIdleSeconds = idleSeconds;
		if (!recentInput && !wentBackward) {
			this.returnConfirmationCount = 0;
			return;
		}
		this.returnConfirmationCount += 1;
		if (this.returnConfirmationCount < (this.options.returnConfirmationPolls ?? RETURN_CONFIRMATION_POLLS)) return;
		this.idleReached = false;
		this.returnConfirmationCount = 0;
		this.options.onUserReturned();
	}

	private systemIdleSeconds(): number {
		try {
			const value = (this.options.getSystemIdleTime ?? (() => powerMonitor.getSystemIdleTime()))();
			return Number.isFinite(value) && value >= 0 ? value : 0;
		} catch (error) {
			console.warn("[IdleMonitor] Failed to read system idle time", error);
			return 0;
		}
	}
}
