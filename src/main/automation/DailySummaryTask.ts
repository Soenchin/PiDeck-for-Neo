import { randomUUID } from "node:crypto";
import type {
	DailySummaryReviewRequest,
	DailySummarySettings,
} from "../../shared/types";
import type { AgentManager } from "../pi/AgentManager";
import type { SessionScanner } from "../sessions/SessionScanner";

type SessionMessage = Awaited<ReturnType<SessionScanner["readMessages"]>>[number];
export type DailySummaryReviewHandler = (
	request: DailySummaryReviewRequest,
) => Promise<string | null>;

const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

export class DailySummaryTask {
	constructor(
		private readonly config: DailySummarySettings,
		private readonly sessionScanner: SessionScanner,
		private readonly agentManager: AgentManager,
		private readonly requestReview: DailySummaryReviewHandler,
	) {}

	async execute(): Promise<void> {
		const messages = await this.collectTodayMessages();
		const turnCount = messages.filter((message) => message.role === "user").length;
		if (turnCount < this.config.minTurns) {
			console.log(
				`[DailySummaryTask] 今日用户消息 ${turnCount} 轮，少于阈值 ${this.config.minTurns}，跳过`,
			);
			return;
		}

		const date = formatLocalDate(new Date());
		let summary = await this.generateSummary(messages, date);
		if (this.config.requireReview) {
			const reviewed = await this.requestReview({
				id: randomUUID(),
				summary,
				date,
			});
			if (reviewed === null) {
				console.log("[DailySummaryTask] 用户取消了每日总结保存");
				return;
			}
			summary = reviewed.trim();
			if (!summary) {
				console.log("[DailySummaryTask] 审核后的总结为空，跳过保存");
				return;
			}
		}

		await this.saveSummary(summary, date);
		console.log("[DailySummaryTask] 每日总结任务完成");
	}

	private async collectTodayMessages(): Promise<SessionMessage[]> {
		const now = new Date();
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
		const sessions = (await this.sessionScanner.list()).filter(
			(session) => session.updatedAt >= start && session.updatedAt < end,
		);

		const messages: SessionMessage[] = [];
		for (const session of sessions) {
			try {
				const sessionMessages = await this.sessionScanner.readMessages(session.filePath);
				messages.push(
					...sessionMessages.filter(
						(message) => message.timestamp >= start && message.timestamp < end,
					),
				);
			} catch (error) {
				console.error(`[DailySummaryTask] 读取会话失败: ${session.filePath}`, error);
			}
		}

		return messages.sort((left, right) => left.timestamp - right.timestamp);
	}

	private async generateSummary(messages: SessionMessage[], date: string): Promise<string> {
		const agent = await this.agentManager.create({
			projectId: "builtin-chat",
			title: `每日总结 ${date}`,
		});

		try {
			await this.agentManager.sendPrompt({
				agentId: agent.id,
				message: this.buildSummaryPrompt(messages, date),
			});
			await this.waitForAgentIdle(agent.id);

			const agentMessages = this.agentManager.getMessages(agent.id);
			for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
				const message = agentMessages[index];
				if (message.role === "assistant" && message.text.trim()) return message.text.trim();
			}
			throw new Error("未获取到有效的总结内容");
		} finally {
			await this.agentManager.stop(agent.id);
		}
	}

	private buildSummaryPrompt(messages: SessionMessage[], date: string): string {
		const conversations = messages
			.map((message) => `${message.role === "user" ? "用户" : "助手"}: ${message.content}`)
			.join("\n\n");

		return `请根据以下 ${date} 的对话记录生成每日总结，覆盖完成的工作、学到的知识、遇到的问题和解决方案。直接输出总结正文，不要调用任何工具。\n\n对话记录：\n${conversations}`;
	}

	private async saveSummary(summary: string, date: string): Promise<void> {
		const agent = await this.agentManager.create({
			projectId: "builtin-chat",
			title: `保存每日总结 ${date}`,
		});

		try {
			const approval = this.config.requireReview
				? "用户刚刚在 PiDeck 审核弹窗中确认了这份内容。"
				: "用户已在 PiDeck 设置中启用无需二次审核的每日总结保存。";
			await this.agentManager.sendPrompt({
				agentId: agent.id,
				message: `${approval}\n请使用 memory_commit 将以下每日总结保存到 diary/${date}.md，并同步写入本地索引与 Houkai。重要性 0.8，标签 daily-summary、pideck。\n\n${summary}`,
			});
			await this.waitForAgentIdle(agent.id);
		} finally {
			await this.agentManager.stop(agent.id);
		}
	}

	private async waitForAgentIdle(agentId: string): Promise<void> {
		const deadline = Date.now() + AGENT_TIMEOUT_MS;
		await delay(1_000);

		while (Date.now() < deadline) {
			const agent = this.agentManager.list().find((item) => item.id === agentId);
			if (!agent) throw new Error("临时 Agent 已意外退出");
			if (agent.status === "idle") return;
			if (agent.status === "error") throw new Error("临时 Agent 执行失败");
			await delay(500);
		}

		throw new Error("等待临时 Agent 完成超时");
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}
