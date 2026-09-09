import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutonomousModeSettings } from "../../shared/types";
import type { AutomationRuntime, AutomationRuntimeFactory } from "./AutomationRuntime";
import { getAutonomousContinuationWaitDelay } from "./AutonomousActivityCadence";
import { buildAutonomousContinuationPrompt, buildAutonomousPrompt } from "./AutonomousPrompt";

const MAX_AUTONOMOUS_ROUNDS = 12;
const MAX_AUTONOMOUS_DURATION_MS = 90 * 60 * 1_000;

export type AutonomousStopReason = "user-returned" | "disabled" | "shutdown" | "error" | "completed";

/** Runs exactly one bounded, cancellable automation session. Scheduling belongs to its caller. */
export class AutonomousActivityTask {
	private runtime: AutomationRuntime | undefined;
	private startedAt = 0;
	private lastRoundStartedAt = 0;
	private rounds = 0;
	private stopRequested = false;
	private stopPromise: Promise<void> | undefined;
	private continuationTimer: NodeJS.Timeout | undefined;
	private resolveContinuation: (() => void) | undefined;

	constructor(
		private readonly config: AutonomousModeSettings,
		private readonly runtimes: AutomationRuntimeFactory,
		private readonly outputRoot: string,
		private readonly onStopped: (reason: AutonomousStopReason) => void,
	) {}

	async start(): Promise<void> {
		try {
			this.startedAt = Date.now();
			const runDirectory = await this.createRunDirectory();
			if (this.stopRequested) return;
			this.runtime = await this.runtimes.create({
				title: `自主活动 ${formatTimestamp(new Date())}`,
				model: this.config.model,
			});
			await this.sendRound(buildAutonomousPrompt({ activities: this.config.activities, runDirectory }));

			while (!this.stopRequested) {
				await this.runtime.waitForSettled();
				if (this.stopRequested) return;
				if (this.rounds >= MAX_AUTONOMOUS_ROUNDS || Date.now() - this.startedAt >= MAX_AUTONOMOUS_DURATION_MS) {
					await this.stop("completed");
					return;
				}
				await this.waitForContinuation();
				if (this.stopRequested || Date.now() - this.startedAt >= MAX_AUTONOMOUS_DURATION_MS) {
					if (!this.stopRequested) await this.stop("completed");
					return;
				}
				await this.sendRound(buildAutonomousContinuationPrompt());
			}
		} catch (error) {
			console.error("[AutonomousActivityTask] Automation run failed", error);
			await this.stop("error");
		} finally {
			if (!this.stopRequested) await this.stop("error");
		}
	}

	async stop(reason: AutonomousStopReason): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.stopRequested = true;
		this.cancelContinuation();
		this.stopPromise = (async () => {
			try {
				await this.runtime?.stop();
			} finally {
				this.runtime = undefined;
				this.onStopped(reason);
			}
		})();
		return this.stopPromise;
	}

	private async sendRound(agentMessage: string): Promise<void> {
		if (!this.runtime) throw new Error("Automation runtime is unavailable");
		this.lastRoundStartedAt = Date.now();
		await this.runtime.send({
			message: this.rounds === 0 ? "开始自主活动" : "继续自主活动",
			agentMessage,
			description: "PiDeck 空闲自主活动",
		});
		this.rounds += 1;
	}

	private async createRunDirectory(): Promise<string> {
		await mkdir(this.outputRoot, { recursive: true });
		const directory = join(this.outputRoot, `${formatTimestamp(new Date()).replace(" ", "_")}_${randomUUID().slice(0, 4)}`);
		await mkdir(directory);
		await writeFile(join(directory, "session-summary.md"), "# Autonomous Activity Session\n\n- Status: running\n", "utf8");
		return directory;
	}

	private waitForContinuation(): Promise<void> {
		const delay = getAutonomousContinuationWaitDelay(
			this.lastRoundStartedAt,
			this.startedAt,
			MAX_AUTONOMOUS_DURATION_MS,
		);
		if (delay <= 0 || this.stopRequested) return Promise.resolve();
		return new Promise((resolve) => {
			this.resolveContinuation = resolve;
			this.continuationTimer = setTimeout(() => {
				this.continuationTimer = undefined;
				this.resolveContinuation = undefined;
				resolve();
			}, delay);
		});
	}

	private cancelContinuation(): void {
		if (this.continuationTimer) clearTimeout(this.continuationTimer);
		this.continuationTimer = undefined;
		const resolve = this.resolveContinuation;
		this.resolveContinuation = undefined;
		resolve?.();
	}
}

function formatTimestamp(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
}
