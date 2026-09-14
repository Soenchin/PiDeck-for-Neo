/** Main-process-only response: structured text plus safe content metadata, never reasoning. */
export interface AssistantResponse {
	role: "assistant";
	text: string;
	stopReason?: string;
	source: "structured-text" | "unavailable";
	textBlocks: number;
	thinkingBlocks: number;
	thinkingCharacters: number;
}

export interface AssistantResponseReader {
	getResponse: () => AssistantResponse | undefined;
	reset: () => void;
	dispose: () => void;
}

/** Opt-in, latest-response-only capture. No full history, images, or reasoning are retained. */
export class AssistantResponseCapture {
	private readonly readers = new Map<string, { response?: AssistantResponse }>();

	/** The runtime adapter owns this handle and disposes it on stop or failed creation. */
	track(agentId: string): AssistantResponseReader {
		if (this.readers.has(agentId)) throw new Error("Assistant response reader already registered");
		const slot: { response?: AssistantResponse } = {};
		this.readers.set(agentId, slot);
		return {
			getResponse: () => slot.response ? { ...slot.response } : undefined,
			reset: () => { slot.response = undefined; },
			dispose: () => {
				slot.response = undefined;
				if (this.readers.get(agentId) === slot) this.readers.delete(agentId);
			},
		};
	}

	/** Receives the original pi message before display projection adds thinking tags. */
	update(agentId: string, message: unknown): void {
		const slot = this.readers.get(agentId);
		if (!slot || !message || typeof message !== "object") return;
		const content: unknown = Reflect.get(message, "content");
		const stopReason: unknown = Reflect.get(message, "stopReason");
		const response: AssistantResponse = {
			role: "assistant", text: "", source: Array.isArray(content) ? "structured-text" : "unavailable",
			stopReason: typeof stopReason === "string" ? stopReason : undefined,
			textBlocks: 0, thinkingBlocks: 0, thinkingCharacters: 0,
		};
		if (Array.isArray(content)) {
			for (const item of content) {
				if (!item || typeof item !== "object") continue;
				const type: unknown = Reflect.get(item, "type");
				if (type === "text") {
					const text: unknown = Reflect.get(item, "text");
					if (typeof text === "string") {
						response.textBlocks += 1;
						// Text items may be stream fragments, not paragraph boundaries.
						response.text += text;
					}
				} else if (type === "thinking") {
					const thinking: unknown = Reflect.get(item, "thinking");
					response.thinkingBlocks += 1;
					if (typeof thinking === "string") response.thinkingCharacters += thinking.length;
				}
			}
		}
		// Empty/new pending responses must overwrite older success, never fall back to it.
		slot.response = response;
	}

	/** Agent shutdown also invalidates outstanding handles. */
	clear(agentId: string): void {
		const slot = this.readers.get(agentId);
		if (slot) slot.response = undefined;
		this.readers.delete(agentId);
	}
}
