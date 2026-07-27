import type { ChatMessage } from "../../../shared/types";
import type { RoomParticipant } from "../../../shared/room";
import type { RoomTimelineItem } from "./useRoom";

/**
 * pi Session 保存的是 agentMessage（带房间说明和记忆边界），而实时缓存显示 message 原文。
 * 应用重启从 Session 恢复时，将内部 prompt 还原为主人在房间里实际看到的文本。
 */
export function restoreRoomDisplayText(text: string): string {
	const tagged = text.match(/\[房间显示文本\]\s*\n([\s\S]*?)\n\s*\n\[主人最新消息 \/ 内部上下文\]/);
	if (tagged?.[1]) return tagged[1].trim();
	const legacy = text.match(/\[主人最新消息\]\s*\n([\s\S]*)$/);
	if (legacy?.[1]) return legacy[1].trim();
	return text;
}

/** 房间只展示最终答复；模型原始输出中偶尔残留的 thinking 标签必须隐藏。 */
export function stripRoomThinking(text: string): string {
	return text
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		// 流式阶段 closing tag 尚未到达时也不能短暂泄露推理文本。
		.replace(/<thinking>[\s\S]*$/gi, "")
		.replace(/<\/thinking>/gi, "")
		.trim();
}

/**
 * 将单个 Agent 的消息转成房间时间线。
 * 工具调用仍由完整 pi Agent 执行和持久化，但房间是轻量聊天视图，因此不展示 tool 消息。
 */
export function toRoomTimelineItems(
	messages: ChatMessage[],
	participant: RoomParticipant,
): RoomTimelineItem[] {
	const items: RoomTimelineItem[] = [];
	for (const message of messages) {
		if (message.role === "tool") continue;
		if (message.role === "assistant") {
			const text = stripRoomThinking(message.text);
			// thinking 流可能先创建一个只有推理、没有最终正文的 assistant 占位消息。
			if (!text && !(message.images?.length)) continue;
			items.push({
				id: `${participant}:${message.id}`,
				author: participant,
				participant,
				message: { ...message, text, thinking: undefined },
			});
			continue;
		}
		if (message.role === "user") {
			items.push({
				id: `${participant}:${message.id}`,
				author: "human",
				participant: null,
				message: { ...message, text: restoreRoomDisplayText(message.text) },
			});
			continue;
		}
		// system/error 是房间生命周期或失败反馈，保留；它们不提供“让另一位接话”。
		items.push({
			id: `${participant}:${message.id}`,
			author: "system",
			participant,
			message,
		});
	}
	return items;
}

/**
 * 用消息第一次进入房间时的 timestamp 固定排序位置。
 * AgentManager 在流式 token 到达时会刷新 assistant.timestamp；若直接按它排序，
 * Neo 与小 R 并发生成时会轮流跳到时间线底部，看起来像两块气泡互相抢位置。
 */
export function filterRoomTimelineAfter(
	items: RoomTimelineItem[],
	clearedAt?: number,
): RoomTimelineItem[] {
	if (!clearedAt) return items;
	return items.filter((item) => item.message.timestamp > clearedAt);
}

export function sortRoomTimelineStable(
	items: RoomTimelineItem[],
	anchors: Map<string, number>,
): RoomTimelineItem[] {
	// 不因某次快照短暂缺项而删除锚点：历史后台加载或 Agent 重连时消息数组可能短暂为空，
	// 若此时清理，恢复后又会采用被流式刷新的 timestamp，气泡仍可能跳位。
	for (const item of items) {
		if (!anchors.has(item.id)) anchors.set(item.id, item.message.timestamp);
	}
	return [...items].sort((a, b) => {
		const byTime = (anchors.get(a.id) ?? a.message.timestamp) -
			(anchors.get(b.id) ?? b.message.timestamp);
		return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
	});
}
