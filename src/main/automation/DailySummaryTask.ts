import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DailySummaryReviewRequest, DailySummarySettings } from "../../shared/types";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { AutomationRuntimeFactory } from "./AutomationRuntime";
import type { AppLogger } from "../logging/AppLogger";
import { DailySummaryCandidateError, inspectDailySummaryCandidate } from "./dailySummaryCandidate";

export type DailySummaryReviewHandler = (request: DailySummaryReviewRequest) => Promise<string | null>;

// 每日总结沿用旧流程的固定模型策略，避免跟随当前会话模型误用昂贵/不兼容模型。
const DAILY_SUMMARY_MODEL = { provider: "Xiaomi", modelId: "mimo-v2.5-pro" } as const;

/** Creates a reviewable daily-memory candidate. It never writes memory before review approval. */
export class DailySummaryTask {
	constructor(
		private readonly config: DailySummarySettings,
		private readonly sessionScanner: SessionScanner,
		private readonly runtimes: AutomationRuntimeFactory,
		private readonly requestReview: DailySummaryReviewHandler,
		private readonly log: Pick<AppLogger, "info" | "warn">,
	) {}

	async execute(): Promise<void> {
		const collected = await this.collectTodaySessions();
		try {
			if (collected.files.length === 0 || collected.userTurns < this.config.minTurns) {
				void this.log.info("automation", "Daily summary skipped: insufficient activity", {
					sessionFiles: collected.files.length,
					userTurns: collected.userTurns,
					minTurns: this.config.minTurns,
				});
				throw new DailySummaryCandidateError("no-activity");
			}
			const date = formatLocalDate(new Date());
			void this.log.info("automation", "Daily summary collected sessions", {
				date,
				sessionFiles: collected.files.length,
				userTurns: collected.userTurns,
			});
			const runtime = await this.runtimes.create({
				title: `每日总结 ${date}`,
				model: DAILY_SUMMARY_MODEL,
			});
			try {
				await runtime.send({
					message: "生成每日总结候选",
					agentMessage: this.buildSummaryPrompt(collected.files, date),
					description: "PiDeck 每日总结候选",
				});
				await runtime.waitForSettled();
				const response = runtime.getAssistantResponse();
				const candidate = inspectDailySummaryCandidate(response ? [response] : []);
				// Tag diagnostics now refer only to text blocks, not UI-wrapped reasoning.
				// Log only the safe projection, never the response containing summary text.
				void this.log.info("automation", "Daily summary candidate structure", {
					...candidate.diagnostics,
					source: response?.source ?? "unavailable",
					textBlocks: response?.textBlocks ?? 0,
					thinkingBlocks: response?.thinkingBlocks ?? 0,
					thinkingCharacters: response?.thinkingCharacters ?? 0,
				});
				if (!candidate.ok) throw new DailySummaryCandidateError(candidate.code);
				const summary = candidate.summary;
				void this.log.info("automation", "Daily summary candidate is ready for review", { date });

				const approved = await this.requestReview({ id: randomUUID(), summary, date });
				void this.log.info("automation", "Daily summary review resolved", { date, approved: Boolean(approved?.trim()) });
				if (!approved?.trim()) return;

				await runtime.send({
					message: "保存已审核的每日总结",
					agentMessage: buildSavePrompt(approved.trim(), date),
					description: "保存已审核的每日总结",
				});
				await runtime.waitForSettled();
			} finally {
				await runtime.stop();
			}
		} finally {
			await Promise.all(collected.files.map((file) => unlink(file).catch(() => undefined)));
		}
	}

	private async collectTodaySessions(): Promise<{ files: string[]; userTurns: number }> {
		const now = new Date();
		const date = formatLocalDate(now);
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const end = start + 24 * 60 * 60 * 1_000;
		const files: string[] = [];
		let userTurns = 0;

		for (const session of await this.sessionScanner.list()) {
			if (session.updatedAt < start || session.updatedAt >= end) continue;
			try {
				const messages = (await this.sessionScanner.readMessages(session.filePath))
					.filter((message) => message.timestamp >= start && message.timestamp < end);
				if (!messages.length) continue;
				userTurns += messages.filter((message) => message.role === "user").length;
				const path = join(tmpdir(), `pideck-daily-${date}-${randomUUID()}.jsonl`);
				await writeFile(path, messages.map((message) => JSON.stringify(message)).join("\n"), "utf8");
				files.push(path);
			} catch (error) {
				void this.log.warn("automation", "Daily summary could not read a session", {
					error: error instanceof Error ? error.name : "UnknownError",
				});
			}
		}
		return { files, userTurns };
	}

	private buildSummaryPrompt(files: string[], date: string): string {
		return `请根据 ${date} 的对话记录生成一份“每日记忆候选”。\n\n使用 read 工具读取下列 JSONL 文件（每行是一条当天消息），提炼 5–8 条真正值得长期保存的事实、决定、项目进展或踩坑经验。不要编造；瞬时闲聊不要记。输出 Markdown，中文，简洁具体。\n\n会话文件：\n${files.map((file) => `- ${file}`).join("\n")}`;
	}
}

function buildSavePrompt(summary: string, date: string): string {
	return `主人刚刚在 PiDeck 审核并确认了以下每日总结。请使用 memory_commit 保存到 diary/${date}.md，并同步更新 MEMORY.md 索引与 Houkai。分类 diary，memoryType episodic，importance 0.8，tags 为 daily-summary、pideck。\n\n${summary}`;
}

function formatLocalDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
