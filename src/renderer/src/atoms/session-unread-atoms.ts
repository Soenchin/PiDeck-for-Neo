import { atom } from "jotai";
import {
	clearSessionUnread as clearSessionUnreadState,
	markSessionsUnread as markSessionsUnreadState,
} from "../sessionUnread";

/**
 * 后台会话完成未读标记（session-owned，按稳定 sessionId 键控）。
 * 内存态即可：未读点是「本次应用运行期间还没看过」的信号，重启清空符合直觉，
 * 与旧版行为一致；落盘反而会让历史会话长期挂绿点。
 */
export const sessionUnreadIdsAtom = atom<ReadonlySet<string>>(new Set<string>());

/** 批量打未读标记（bridge 在 runtime 状态落定时调用）。 */
export const markSessionsUnreadAtom = atom(
	null,
	(_get, set, sessionIds: readonly string[]) => {
		set(sessionUnreadIdsAtom, (current) => markSessionsUnreadState(current, sessionIds));
	},
);

/** 用户点开会话即清除该会话的未读标记。 */
export const clearSessionUnreadAtom = atom(
	null,
	(_get, set, sessionId: string) => {
		set(sessionUnreadIdsAtom, (current) => clearSessionUnreadState(current, sessionId));
	},
);
