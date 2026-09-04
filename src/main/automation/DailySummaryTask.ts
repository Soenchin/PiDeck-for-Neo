import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DailySummaryReviewRequest,
	DailySummarySettings,
} from "../../shared/types";
import type { AgentManager } from "../pi/AgentManager";
import type { SessionScanner } from "../sessions/SessionScanner";

export type DailySummaryReviewHandler = (
	request: DailySummaryReviewRequest,
) => Promise<string | null>;

const AGENT_TIMEOUT_MS = 15 * 60 * 1000;
const DAILY_SUMMARY_MODEL = { provider: "Xiaomi", id: "mimo-v2.5-pro" } as const;

export class DailySummaryTask {
	constructor(
		private readonly config: DailySummarySettings,
		private readonly sessionScanner: SessionScanner,
		private readonly agentManager: AgentManager,
		private readonly requestReview: DailySummaryReviewHandler,
	) {}

	async execute(): Promise<void> {
		const { tempFiles, userTurnCount } = await this.collectTodaySessions();
		if (tempFiles.length === 0) {
			console.log("[DailySummaryTask] 今日无会话，跳过");
			return;
		}
		if (userTurnCount < this.config.minTurns) {
			console.log(
				`[DailySummaryTask] 今日用户消息 ${userTurnCount} 轮，少于阈值 ${this.config.minTurns}，跳过`,
			);
			await this.cleanupTempFiles(tempFiles);
			return;
		}

		const date = formatLocalDate(new Date());
		const agent = await this.agentManager.create({
			projectId: "builtin-chat",
			title: `每日总结 ${date}`,
			model: DAILY_SUMMARY_MODEL,
		});

		try {
			let summary = await this.generateSummary(agent.id, tempFiles, date);
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

			await this.saveSummary(agent.id, summary, date);
			console.log("[DailySummaryTask] 每日总结任务完成");
		} finally {
			await this.agentManager.stop(agent.id);
			await this.cleanupTempFiles(tempFiles);
		}
	}

	private async collectTodaySessions(): Promise<{ tempFiles: string[]; userTurnCount: number }> {
		const now = new Date();
		const date = formatLocalDate(now);
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
		const sessions = (await this.sessionScanner.list()).filter(
			(session) => session.updatedAt >= start && session.updatedAt < end,
		);

		const tempFiles: string[] = [];
		let userTurnCount = 0;
		for (const session of sessions) {
			try {
				const allMessages = await this.sessionScanner.readMessages(session.filePath);
				// 只保留今日消息，避免跨天会话把历史内容也喂给 AI
				const todayMessages = allMessages.filter(
					(msg) => msg.timestamp >= start && msg.timestamp < end,
				);
				if (todayMessages.length === 0) continue;

				userTurnCount += todayMessages.filter((m) => m.role === "user").length;
				const tempPath = join(tmpdir(), `pideck-daily-${date}-${randomUUID()}.jsonl`);
				await writeFile(tempPath, todayMessages.map((m) => JSON.stringify(m)).join("\n"), "utf8");
				tempFiles.push(tempPath);
			} catch (error) {
				console.error(`[DailySummaryTask] 读取会话失败: ${session.filePath}`, error);
			}
		}

		return { tempFiles, userTurnCount };
	}

	private async generateSummary(
		agentId: string,
		filePaths: string[],
		date: string,
	): Promise<string> {
		await this.agentManager.sendPrompt({
			agentId,
			message: this.buildSummaryPrompt(filePaths, date),
		});
		await this.waitForAgentIdle(agentId);

		const agentMessages = this.agentManager.getMessages(agentId);
		for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
			const message = agentMessages[index];
			if (message.role === "assistant" && message.text.trim()) return message.text.trim();
		}
		throw new Error("未获取到有效的总结内容");
	}

	private buildSummaryPrompt(filePaths: string[], date: string): string {
		const fileList = filePaths.map((path) => `  - ${path}`).join("\n");
		return `请根据 ${date} 的对话记录生成每日总结。\n\n请使用 read 工具依次读取以下文件（JSONL 格式，每行一条 JSON 消息，已过滤为仅今日内容），然后生成总结。总结应覆盖完成的工作、学到的知识、遇到的问题和解决方案。\n\n今日会话文件：\n${fileList}`;
	}

	private async saveSummary(agentId: string, summary: string, date: string): Promise<void> {
		const approval = this.config.requireReview
			? "用户刚刚在 PiDeck 审核弹窗中确认了这份内容。"
			: "用户已在 PiDeck 设置中启用无需二次审核的每日总结保存。";
		await this.agentManager.sendPrompt({
			agentId,
			message: `${approval}\n请使用 memory_commit 将以下每日总结保存到 diary/${date}.md，并同步写入本地索引与 Houkai。重要性 0.8，标签 daily-summary、pideck。\n\n${summary}`,
		});
		await this.waitForAgentIdle(agentId);
	}

	private async cleanupTempFiles(files: string[]): Promise<void> {
		await Promise.all(files.map((file) => unlink(file).catch(() => {})));
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
