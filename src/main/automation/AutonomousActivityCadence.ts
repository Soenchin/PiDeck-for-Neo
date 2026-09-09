const ROUND_SETTLE_DELAY_MS = 1_000;

/** 自主活动续轮的最小间隔，防止一次离开触发高频 Agent 请求。 */
export const MIN_AUTONOMOUS_ROUND_INTERVAL_MS = 60 * 60 * 1_000;

export function getAutonomousContinuationDelay(lastRoundStartedAt: number, now = Date.now()): number {
	const elapsed = Math.max(0, now - lastRoundStartedAt);
	return Math.max(ROUND_SETTLE_DELAY_MS, MIN_AUTONOMOUS_ROUND_INTERVAL_MS - elapsed);
}

export function getAutonomousContinuationWaitDelay(
	lastRoundStartedAt: number,
	sessionStartedAt: number,
	maxSessionDurationMs: number,
	now = Date.now(),
): number {
	const remaining = Math.max(0, maxSessionDurationMs - (now - sessionStartedAt));
	return Math.min(getAutonomousContinuationDelay(lastRoundStartedAt, now), remaining);
}
