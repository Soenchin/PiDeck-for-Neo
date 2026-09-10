/**
 * 后台会话完成未读标记的纯逻辑（NeoNext 迁移自旧 4915ea5a，改为按 sessionId 键控）。
 * 只做判定与集合运算，不依赖 React/atom：bridge 负责事件接入，侧栏负责展示。
 */

/** 视为「正在工作」的 runtime 状态（与侧栏状态点语义一致）。 */
const WORKING_STATUSES = new Set(["running", "starting", "waiting"]);

/** 视为「已落定」的状态：正常完成或异常结束都算「有新内容可看」。 */
const SETTLED_STATUSES = new Set(["idle", "error"]);

export type ShouldMarkSessionUnreadInput = {
	sessionId: string;
	/** 当前聚焦的会话；聚焦中的会话永远不打未读标记。 */
	focusedSessionId: string | undefined;
	/** 上一条事件里的状态；runtime 被替换（重启）时由调用方传 undefined，避免误判。 */
	previousStatus: string | undefined;
	nextStatus: string | undefined;
};

/**
 * 后台会话完成判定：同一 runtime 从工作状态落定到 idle/error，
 * 且不是当前聚焦会话。初始快照（无 previousStatus）不算完成，
 * 避免「启动应用时所有 idle 会话」被误标为未读。
 */
export function shouldMarkSessionUnread(input: ShouldMarkSessionUnreadInput): boolean {
	if (!input.sessionId || input.sessionId === input.focusedSessionId) return false;
	if (!input.previousStatus || !input.nextStatus) return false;
	return WORKING_STATUSES.has(input.previousStatus) && SETTLED_STATUSES.has(input.nextStatus);
}

/** 打未读标记；集合内容不变时返回原引用（减少订阅者重渲染）。 */
export function markSessionsUnread(
	state: ReadonlySet<string>,
	sessionIds: readonly string[],
): ReadonlySet<string> {
	let changed = false;
	const next = new Set(state);
	for (const sessionId of sessionIds) {
		if (sessionId && !next.has(sessionId)) {
			next.add(sessionId);
			changed = true;
		}
	}
	return changed ? next : state;
}

/** 用户点开会话即视为已读；未读集合不含该会话时返回原引用。 */
export function clearSessionUnread(
	state: ReadonlySet<string>,
	sessionId: string,
): ReadonlySet<string> {
	if (!sessionId || !state.has(sessionId)) return state;
	const next = new Set(state);
	next.delete(sessionId);
	return next;
}
