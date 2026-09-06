import { spawn } from "node:child_process";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import { PiRpcClient } from "./PiRpcClient";
import type { PiLocator } from "./PiLocator";

export type OneShotPromptDeps = {
	piLocator: PiLocator;
	settingsStore: SettingsStore;
	log?: Pick<AppLogger, "warn">;
};

export type OneShotPromptInput = {
	/** 进程工作目录（一般为会话所属项目路径） */
	cwd: string;
	model: { provider: string; modelId: string };
	prompt: string;
	/** 总超时（含进程启动 + 生成）；默认 45s */
	timeoutMs?: number;
};

/**
 * 一次性短生命周期 pi RPC 调用（自动标题等辅助生成专用）。
 *
 * 与 gitIpc 的常驻 QuickGen 进程互不影响：每个调用独立进程、用完即退，
 * 不与 AI 提交摘要争抢同一个 busy 进程。启动参数与 QuickGen 同源
 * （无会话/无工具/无扩展），生成任务只允许纯文本输出。
 */
export async function runOneShotPrompt(
	deps: OneShotPromptDeps,
	input: OneShotPromptInput,
): Promise<string> {
	const settings = deps.settingsStore.get();
	const command = deps.piLocator.resolveCommand(
		settings.customPiPath,
		settings.wslEnabled,
		settings.wslDistro,
		settings.wslUser,
	);
	const invocation = deps.piLocator.createInvocation(command, [
		"--mode", "rpc",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-themes",
		// 注意：不传 --thinking。强制 off 会让「始终思考」型模型（如 GLM 5.3 系列）
		// 直接 400（code 1210），任务只会拿到空文本；沿用 pi 配置的默认思考级别。
	]);
	const child = spawn(invocation.command, invocation.args, {
		cwd: input.cwd,
		env: deps.piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
		stdio: ["pipe", "pipe", "pipe"],
		shell: invocation.shell,
		windowsHide: true,
		windowsVerbatimArguments: invocation.windowsVerbatimArguments,
	});
	const rpc = new PiRpcClient(child.stdin!, child.stdout!);
	const timeoutMs = input.timeoutMs ?? 45_000;

	return await new Promise<string>((resolve, reject) => {
		const collected: string[] = [];
		let settled = false;
		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			rpc.off("event", onEvent);
			// 短生命周期进程：结果落定后立即退出，不占常驻内存
			try { child.kill(); } catch { /* 已退出则忽略 */ }
			settle();
		};
		const timeout = setTimeout(() => {
			deps.log?.warn("one-shot", "One-shot prompt timed out", { cwd: input.cwd });
			finish(() => reject(new Error("One-shot prompt timed out")));
		}, timeoutMs);
		// pi 生成失败时以 stopReason:"error" + errorMessage 的空 assistant 消息收尾，
		// 此时仍会发 agent_end/agent_settled；必须把错误带出去 reject，
		// 否则上层拿到空字符串会把失败静默吞掉（2026-09-06 自动标题全空的根因）。
		let lastError: string | undefined;
		const onEvent = (event: Record<string, unknown>) => {
			if (event.type === "message_update") {
				const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					collected.push(assistantEvent.delta);
				}
			}
			if (event.type === "message_end") {
				const message = event.message as { errorMessage?: unknown } | undefined;
				if (message && typeof message.errorMessage === "string" && message.errorMessage) {
					lastError = message.errorMessage;
				}
			}
			if (event.type === "agent_settled" || event.type === "agent_end") {
				finish(() => lastError
					? reject(new Error(lastError))
					: resolve(collected.join("")));
			}
		};
		rpc.on("event", onEvent);
		child.on("error", (error) => finish(() => reject(error)));
		void (async () => {
			try {
				const modelResponse = await rpc.request(
					{ type: "set_model", provider: input.model.provider, modelId: input.model.modelId },
					10_000,
				);
				if (!modelResponse.success) {
					throw new Error(modelResponse.error ?? `Unable to select model ${input.model.provider}/${input.model.modelId}`);
				}
				const promptResponse = await rpc.request({ type: "prompt", message: input.prompt }, timeoutMs);
				if (!promptResponse.success) {
					throw new Error(promptResponse.error ?? "Prompt rejected");
				}
			} catch (error) {
				finish(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		})();
	});
}
