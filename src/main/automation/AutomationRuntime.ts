import type { ChatMessage, SendSessionPromptInput, SessionRuntimeTarget } from "../../shared/types";

/**
 * Automation sees only this narrow runtime capability. The main-process adapter owns
 * catalog creation/binding and cleanup, so background work cannot bypass session-first.
 */
export type AutomationRuntime = {
	target: SessionRuntimeTarget;
	send: (input: Omit<SendSessionPromptInput, "sessionId" | "requestId">) => Promise<void>;
	waitForSettled: () => Promise<void>;
	getMessages: () => ChatMessage[];
	stop: () => Promise<void>;
};

export type AutomationRuntimeFactory = {
	create: (input: {
		title: string;
		model?: { provider: string; modelId: string };
	}) => Promise<AutomationRuntime>;
};
