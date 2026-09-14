import type { SendSessionPromptInput, SessionRuntimeTarget } from "../../shared/types";
import type { AssistantResponse } from "../pi/AssistantResponseCapture";

/**
 * Automation sees only this narrow runtime capability. The main-process adapter owns
 * catalog creation/binding and cleanup, so background work cannot bypass session-first.
 */
export type AutomationRuntime = {
	target: SessionRuntimeTarget;
	send: (input: Omit<SendSessionPromptInput, "sessionId" | "requestId">) => Promise<void>;
	waitForSettled: () => Promise<void>;
	getAssistantResponse: () => AssistantResponse | undefined;
	stop: () => Promise<void>;
};

export type AutomationRuntimeFactory = {
	create: (input: {
		title: string;
		model?: { provider: string; modelId: string };
	}) => Promise<AutomationRuntime>;
};
