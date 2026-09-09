import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IDLE_CHECK_SCRIPT = "X:\\CC\\.workbuddy\\scripts\\idle_check.py";

export type PresenceCheckResult = {
	verdict: "PRESENT" | "AWAY";
	idleSeconds: number;
	reason: string;
};

/**
 * Supplements Electron's idle timer with the established Windows probe: lock screen,
 * active media and audio count as present rather than silently starting automation.
 */
export async function checkUserPresence(): Promise<PresenceCheckResult | null> {
	try {
		const result = await execFileAsync("python", [IDLE_CHECK_SCRIPT], {
			windowsHide: true,
			timeout: 12_000,
			maxBuffer: 16 * 1024,
			env: { ...process.env, PYTHONIOENCODING: "utf-8" },
		});
		const parsed: unknown = JSON.parse(result.stdout.trim());
		if (!isPresenceRecord(parsed)) throw new Error("idle_check.py returned an invalid record");
		return {
			verdict: parsed.verdict,
			idleSeconds: typeof parsed.idle_seconds === "number" ? parsed.idle_seconds : 0,
			reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
		};
	} catch (error) {
		console.warn("[PresenceProbe] Presence check failed", error);
		return null;
	}
}

function isPresenceRecord(value: unknown): value is {
	verdict: "PRESENT" | "AWAY";
	idle_seconds?: unknown;
	reason?: unknown;
} {
	return typeof value === "object" && value !== null &&
		((value as { verdict?: unknown }).verdict === "PRESENT" || (value as { verdict?: unknown }).verdict === "AWAY");
}
