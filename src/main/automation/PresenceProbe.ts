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
 * Reuses the established Windows presence probe. Unlike powerMonitor alone it
 * distinguishes lock screen, fullscreen media, and active audio from absence.
 */
export async function checkUserPresence(): Promise<PresenceCheckResult | null> {
	try {
		const { stdout } = await execFileAsync("python", [IDLE_CHECK_SCRIPT], {
			windowsHide: true,
			timeout: 12_000,
			maxBuffer: 16 * 1024,
			// Window titles may include characters that the legacy Windows console code
			// page cannot print. The probe emits JSON, so force a stable transport encoding.
			env: { ...process.env, PYTHONIOENCODING: "utf-8" },
		});
		const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
		if (parsed.verdict !== "PRESENT" && parsed.verdict !== "AWAY") {
			throw new Error("idle_check.py returned an unknown verdict");
		}
		return {
			verdict: parsed.verdict,
			idleSeconds: typeof parsed.idle_seconds === "number" ? parsed.idle_seconds : 0,
			reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
		};
	} catch (error) {
		console.warn("[PresenceProbe] 用户状态检查失败:", error);
		return null;
	}
}
