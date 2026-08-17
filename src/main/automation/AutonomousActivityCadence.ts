const ROUND_SETTLE_DELAY_MS = 1_000;

/**
 * Small autonomous tasks can finish in seconds. Keep continuations intentionally sparse
 * so the same absence does not turn into a rapid-fire stream of new chat prompts.
 */
export const MIN_AUTONOMOUS_ROUND_INTERVAL_MS = 5 * 60 * 1_000;

export function getAutonomousContinuationDelay(
	lastRoundStartedAt: number,
	now = Date.now(),
): number {
	const elapsedSinceRoundStart = Math.max(0, now - lastRoundStartedAt);
	return Math.max(
		ROUND_SETTLE_DELAY_MS,
		MIN_AUTONOMOUS_ROUND_INTERVAL_MS - elapsedSinceRoundStart,
	);
}

export function getAutonomousContinuationWaitDelay(
	lastRoundStartedAt: number,
	sessionStartedAt: number,
	maxSessionDurationMs: number,
	now = Date.now(),
): number {
	const remainingSessionDuration = Math.max(0, maxSessionDurationMs - (now - sessionStartedAt));
	return Math.min(
		getAutonomousContinuationDelay(lastRoundStartedAt, now),
		remainingSessionDuration,
	);
}
