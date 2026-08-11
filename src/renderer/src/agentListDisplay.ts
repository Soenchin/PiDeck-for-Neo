import type { AgentTab, SessionSummary } from "../../shared/types";
import { normalizeSessionPath, isSameSessionPath as isSameSessionPathUtil } from "../../shared/sessionPath";

const DEFAULT_VISIBLE_PROJECT_CHILD_LIMIT = 5;

export type ProjectChildItem =
	| {
			type: "agent";
			key: string;
			agent: AgentTab;
			sortAt: number;
			/** 该 Agent 对应的会话来源（历史会话激活时从 SessionSummary 传递） */
			source?: "pi" | "codex" | "claude" | "opencode";
			codexSubagents: SessionSummary[];
			/** 置顶时间戳；置顶会话优先排序 */
			pinnedAt?: number;
	  }
	| {
			type: "session";
			key: string;
			session: SessionSummary;
			sortAt: number;
			codexSubagents: SessionSummary[];
			/** 置顶时间戳；置顶会话优先排序 */
			pinnedAt?: number;
	  };

export type ProjectAgentSessionDisplay = {
	children: ProjectChildItem[];
	visibleChildren: ProjectChildItem[];
	hiddenChildCount: number;
};

// 向后兼容：导出为旧名
export const normalizeSessionPathForCompare = normalizeSessionPath;
export const isSameSessionPath = isSameSessionPathUtil;

function getSessionKey(sessionPath?: string) {
	return normalizeSessionPath(sessionPath);
}

function getCodexParentKey(session: SessionSummary) {
	return session.codexSessionId ?? session.id;
}

function getAgentSortAt(agent: AgentTab, sessionByKey: Map<string, SessionSummary>) {
	const sessionKey = getSessionKey(agent.sessionPath);
	// 历史会话激活成 Agent 后仍按原会话更新时间排序；全新 Agent 没有历史文件时按创建时间排到最新。
	return sessionKey ? (sessionByKey.get(sessionKey)?.updatedAt ?? agent.createdAt) : agent.createdAt;
}

function chooseAgentForSession(current: AgentTab, candidate: AgentTab) {
	// 如果异常状态下同一个 sessionPath 已经产生多个 Agent，UI 只保留一个：优先保留更新创建的运行态，避免继续暴露重复入口。
	if (candidate.createdAt !== current.createdAt) {
		return candidate.createdAt > current.createdAt ? candidate : current;
	}
	return candidate.status === "running" ? candidate : current;
}

export function getProjectAgentSessionDisplay({
	agents,
	sessions,
	visibleChildCount,
}: {
	agents: AgentTab[];
	sessions: SessionSummary[];
	visibleChildCount?: number;
}): ProjectAgentSessionDisplay {
	const sessionByKey = new Map<string, SessionSummary>();
	const unkeyedSessions: SessionSummary[] = [];
	const codexSubagentsByParent = new Map<string, SessionSummary[]>();
	const parentCandidateSessions = sessions.filter(
		(session) => session.codexThreadSource !== "subagent",
	);
	const parentCodexIds = new Set(
		parentCandidateSessions.map(getCodexParentKey).filter(Boolean),
	);
	for (const session of sessions) {
		if (
			session.codexThreadSource === "subagent" &&
			session.codexParentThreadId &&
			parentCodexIds.has(session.codexParentThreadId)
		) {
			const children = codexSubagentsByParent.get(session.codexParentThreadId) ?? [];
			children.push(session);
			codexSubagentsByParent.set(session.codexParentThreadId, children);
			continue;
		}
		const sessionKey = getSessionKey(session.filePath);
		if (sessionKey) sessionByKey.set(sessionKey, session);
		else unkeyedSessions.push(session);
	}

	const agentBySessionKey = new Map<string, AgentTab>();
	const unkeyedAgents: AgentTab[] = [];
	for (const agent of agents) {
		const sessionKey = getSessionKey(agent.sessionPath);
		if (!sessionKey) {
			unkeyedAgents.push(agent);
			continue;
		}
		const current = agentBySessionKey.get(sessionKey);
		agentBySessionKey.set(
			sessionKey,
			current ? chooseAgentForSession(current, agent) : agent,
		);
	}

	const children: ProjectChildItem[] = [
		...unkeyedAgents.map<ProjectChildItem>((agent) => ({
			type: "agent",
			key: `agent:${agent.id}`,
			agent,
			sortAt: agent.createdAt,
			codexSubagents: [],
		})),
		...[...agentBySessionKey.entries()].map<ProjectChildItem>(
			([sessionKey, agent]) => {
				const linkedSession = sessionByKey.get(sessionKey);
				return {
					type: "agent",
					key: `session-agent:${sessionKey}`,
					agent,
					sortAt: getAgentSortAt(agent, sessionByKey),
					// 历史会话激活为 Agent 后仍携带来源标记，供侧边栏区分导入会话
					source: linkedSession?.source,
					codexSubagents: linkedSession
						? (codexSubagentsByParent.get(getCodexParentKey(linkedSession)) ?? [])
						: [],
					// Agent 继承对应会话的置顶状态
					pinnedAt: linkedSession?.pinnedAt,
				};
			},
		),
		...[...sessionByKey.entries()]
			.filter(([sessionKey]) => !agentBySessionKey.has(sessionKey))
			.map<ProjectChildItem>(([sessionKey, session]) => ({
				type: "session",
				key: `session:${sessionKey}`,
				session,
				sortAt: session.updatedAt,
				codexSubagents: codexSubagentsByParent.get(getCodexParentKey(session)) ?? [],
				pinnedAt: session.pinnedAt,
			})),
		...unkeyedSessions.map<ProjectChildItem>((session) => ({
			type: "session",
			key: `session-file:${session.filePath}`,
			session,
			sortAt: session.updatedAt,
			codexSubagents: codexSubagentsByParent.get(getCodexParentKey(session)) ?? [],
			pinnedAt: session.pinnedAt,
		})),
	];

	// 置顶会话优先排序：置顶按 pinnedAt 倒序，普通按 sortAt 倒序
	const pinnedChildren = children.filter((child) => child.pinnedAt != null);
	const normalChildren = children.filter((child) => child.pinnedAt == null);
	
	pinnedChildren.sort((left, right) => (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0));
	normalChildren.sort((left, right) => right.sortAt - left.sortAt);

	const sortedChildren = [...pinnedChildren, ...normalChildren];

	// 置顶会话绕过默认显示数量限制，普通会话补足剩余名额
	const limit = visibleChildCount ?? DEFAULT_VISIBLE_PROJECT_CHILD_LIMIT;
	const visibleChildren = [
		...pinnedChildren,
		...normalChildren.slice(0, Math.max(0, limit - pinnedChildren.length)),
	];
	
	return {
		children: sortedChildren,
		visibleChildren,
		hiddenChildCount: Math.max(0, normalChildren.length - (limit - pinnedChildren.length)),
	};
}
