import type { AgentStatus } from "../../shared/types";

/** 侧栏需要关心的 Extension UI 请求字段；完整请求类型留在 App.tsx 内部。 */
export type PendingUiRequestLike = {
	agentId?: string;
	method?: string;
	completed?: boolean;
};

export type SidebarAgentStatus = AgentStatus | "question";

const INTERACTIVE_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * 找出仍在等待用户回答的 Agent。
 *
 * `activeUiRequest` 是渲染层的全局请求表，而提问框本身只展示当前 Agent；
 * 侧栏必须保留其他 Agent 的 pending 请求，才能在切到别的会话时显示“小问题”。
 */
export function getPendingQuestionAgentIds(
	requests: Record<string, PendingUiRequestLike> | null | undefined,
): Set<string> {
	const agentIds = new Set<string>();
	for (const request of Object.values(requests ?? {})) {
		if (
			request.agentId &&
			!request.completed &&
			INTERACTIVE_METHODS.has(request.method ?? "")
		) {
			agentIds.add(request.agentId);
		}
	}
	return agentIds;
}

/**
 * 计算侧栏状态。
 *
 * 提问是“正常运行中的等待”，只替换摸鱼/思考标签；启动、失败、关闭等
 * 生命周期异常必须保留，避免用户误以为 Agent 只是等一个回答。
 */
export function getSidebarAgentStatus(
	status: AgentStatus,
	hasPendingQuestion: boolean,
): SidebarAgentStatus {
	if (
		hasPendingQuestion &&
		status !== "starting" &&
		status !== "error" &&
		status !== "closed"
	) {
		return "question";
	}
	return status;
}
