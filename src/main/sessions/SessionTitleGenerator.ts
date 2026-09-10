import type { AppLogger } from "../logging/AppLogger";

/**
 * 自动中文会话标题生成器（NeoNext 迁移自旧 93235755，改为 catalog 直写）。
 *
 * 设计约束：
 * - 只为「可自动命名」的会话生成：默认占位标题、或扫描器推断的首条消息截断名；
 *   手动改名（titleLocked）与已生成过的（titleGenerated）不碰。判定由 getSession 返回。
 * - 手动改名经 IPC 层写入 titleLocked，写回前二次验锁，避免与改名竞争。
 * - 模型调用经注入的 generate（main/index.ts 绑定一次性 pi 进程），本模块不碰进程。
 * - 同会话防抖 + 单飞行，飞行期间的新请求记一次补跑（压缩后场景）。
 */

/** 标题来源消息的最小形状（AgentManager ChatMessage 的子集）。 */
export type TitleSourceMessage = { role: string; text: string };

const TITLE_SOURCE_CHAR_BUDGET = 800;

/** 取首轮 user 消息 + 首条 assistant 回复，截断后拼成标题生成来源。 */
export function buildTitleSource(messages: readonly TitleSourceMessage[]): string | undefined {
	const firstUser = messages.find((message) => message.role === "user" && message.text.trim());
	const firstAssistant = messages.find(
		(message) => message.role === "assistant" && message.text.trim(),
	);
	if (!firstUser && !firstAssistant) return undefined;
	const clip = (text: string): string => {
		const cleaned = text.replace(/\s+/g, " ").trim();
		return cleaned.length > TITLE_SOURCE_CHAR_BUDGET
			? `${cleaned.slice(0, TITLE_SOURCE_CHAR_BUDGET)}…`
			: cleaned;
	};
	const parts: string[] = [];
	if (firstUser) parts.push(`<user>${clip(firstUser.text)}</user>`);
	if (firstAssistant) parts.push(`<assistant>${clip(firstAssistant.text)}</assistant>`);
	return parts.join("\n");
}

/**
 * 清洗模型输出的标题：去 Markdown/引号/“标题：”前缀，收拢空白，
 * 最多 15 个字（码点，中文友好）；清洗后为空返回 undefined（保持默认标题）。
 */
export function sanitizeGeneratedTitle(raw: string): string | undefined {
	const text = raw
		.replace(/^[#>*\s\-`]+/u, "")
		.replace(/^(?:标题|Title)\s*[:：]\s*/iu, "")
		.replace(/["'“”‘’`【】[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[。.…]+$/u, "");
	if (!text) return undefined;
	return Array.from(text).slice(0, 15).join("") || undefined;
}

export type SessionTitleGeneratorDeps = {
	/** 一次性模型调用（实现方负责进程生命周期/超时/模型选择） */
	generate: (sessionId: string, prompt: string) => Promise<string>;
	/** 读取会话当前的自动命名资格（调用方负责 titleLocked/titleGenerated 判定） */
	getSession: (sessionId: string) => { canAutoTitle: boolean } | undefined;
	/** 写回标题（实现方负责持久化与 UI 刷新通知） */
	saveTitle: (sessionId: string, title: string) => Promise<void>;
	log?: Pick<AppLogger, "info" | "warn">;
	/** 同会话防抖毫秒数；测试可注入小值 */
	debounceMs?: number;
};

const TITLE_PROMPT =
	"为下面的对话生成一个准确、可扫描的会话标题。只输出标题本身：不要引号、前缀、解释或 Markdown；必须使用中文；最多十五个汉字；概括当前主要任务而非泛泛的“聊天”或“问题”。\n\n<conversation>\n{source}\n</conversation>";

export class SessionTitleGenerator {
	private readonly inFlight = new Set<string>();
	private readonly queued = new Set<string>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private readonly deps: SessionTitleGeneratorDeps) {}

	/** 调度一次标题生成；同会话飞行中时只记录一次补跑。 */
	request(sessionId: string, source: string | undefined): void {
		if (!sessionId || !source) return;
		const session = this.deps.getSession(sessionId);
		if (!session?.canAutoTitle) return;
		if (this.inFlight.has(sessionId)) {
			this.queued.add(sessionId);
			return;
		}
		if (this.timers.has(sessionId)) return;
		const timer = setTimeout(() => {
			this.timers.delete(sessionId);
			void this.run(sessionId, source);
		}, this.deps.debounceMs ?? 600);
		timer.unref?.();
		this.timers.set(sessionId, timer);
	}

	private async run(sessionId: string, source: string): Promise<void> {
		this.inFlight.add(sessionId);
		try {
			const session = this.deps.getSession(sessionId);
			if (!session?.canAutoTitle) return;
			const raw = await this.deps.generate(
				sessionId,
				TITLE_PROMPT.replace("{source}", () => source),
			);
			const title = sanitizeGeneratedTitle(raw);
			if (!title) {
				// 生成成功但清洗后为空（空输出/全符号）：留警告，不静默吞掉
				this.deps.log?.warn("session-title", "Generated title was empty after sanitize", {
					sessionId,
					rawLength: raw?.length ?? 0,
				});
				return;
			}
			// 生成期间可能已被手动改名/生成过：写回前再验一次资格
			const latest = this.deps.getSession(sessionId);
			if (!latest?.canAutoTitle) return;
			await this.deps.saveTitle(sessionId, title);
			this.deps.log?.info("session-title", "Auto title generated", { sessionId, title });
		} catch (error) {
			// 标题生成是 best-effort：失败只留日志，不影响会话本身
			this.deps.log?.warn("session-title", "Auto title generation failed", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.inFlight.delete(sessionId);
			if (this.queued.delete(sessionId)) {
				// 飞行期间又有新请求（如压缩完成）：补跑一次
				this.request(sessionId, source);
			}
		}
	}
}
