import type { ChatMessage, DailySummaryFailureCode } from "../../shared/types";

type TagIssue = "nested-tag" | "mismatched-tag" | "unexpected-close" | "unclosed-tag";
type CandidateMessage = Pick<ChatMessage, "role" | "text" | "stopReason"> & {
	source?: "structured-text" | "unavailable";
};

/** Numeric/enum-only metadata: safe to log without disclosing model output. */
export interface DailySummaryCandidateDiagnostics {
	stopReason: "stop" | "length" | "error" | "aborted" | "toolUse" | "pending" | "missing" | "unknown";
	characters: number;
	openingTags: number;
	closingTags: number;
	/** null means tags are literal structured body text and are deliberately not interpreted. */
	tagsBalanced: boolean | null;
	tagIssue: TagIssue | null;
	tagMode: "literal-text" | "legacy-display";
	/** Trimmed UTF-16 length; null when malformed legacy tags make extraction unreliable. */
	remainingCharacters: number | null;
	stage: "completion" | "tag-structure" | "final-body" | "accepted";
	reason: TagIssue | "missing-assistant" | "output-limit" | "unfinished-response" | "structured-body-unavailable" | "empty-body" | null;
}

type CandidateInspection =
	| { ok: true; summary: string; diagnostics: DailySummaryCandidateDiagnostics }
	| { ok: false; code: DailySummaryFailureCode; diagnostics: DailySummaryCandidateDiagnostics };

/** Safe failure codes cross IPC; model text and transport diagnostics never do. */
export class DailySummaryCandidateError extends Error {
	constructor(readonly code: DailySummaryFailureCode) {
		super(`Daily summary candidate rejected: ${code}`);
	}
}

/**
 * Validate the latest response. Structured text is already separated from reasoning by pi's
 * content blocks, so tag-looking strings there are ordinary body text. The strict tag parser
 * exists only for legacy/display-projected inputs that do not expose that semantic boundary.
 */
export function inspectDailySummaryCandidate(
	messages: ReadonlyArray<CandidateMessage>,
): CandidateInspection {
	const last = [...messages].reverse().find((message) => message.role === "assistant");
	const source = last?.text ?? "";
	const openingTags = [...source.matchAll(/<(thinking|think)>/gi)].length;
	const closingTags = [...source.matchAll(/<\/(thinking|think)>/gi)].length;
	const structured = last?.source === "structured-text";
	const unavailable = last?.source === "unavailable";
	const legacy = structured ? undefined : stripLegacyThinking(source);
	const summary = structured ? source.trim() : legacy?.text ?? "";
	const diagnostics: DailySummaryCandidateDiagnostics = {
		stopReason: safeStopReason(last?.stopReason),
		characters: source.length,
		openingTags,
		closingTags,
		tagsBalanced: structured ? null : (legacy?.issue ?? null) === null,
		tagIssue: structured ? null : legacy?.issue ?? null,
		tagMode: structured ? "literal-text" : "legacy-display",
		remainingCharacters: structured ? summary.length : legacy?.issue ? null : summary.length,
		stage: "accepted",
		reason: null,
	};
	// Completion takes precedence over body shape: partial text must never enter review.
	if (!last || last.stopReason !== "stop" || unavailable) {
		diagnostics.stage = "completion";
		diagnostics.reason = !last ? "missing-assistant"
			: last.stopReason === "length" ? "output-limit"
				: unavailable ? "structured-body-unavailable" : "unfinished-response";
		return { ok: false, code: last?.stopReason === "length" ? "output-limit" : "incomplete", diagnostics };
	}
	if (!structured && legacy?.issue) {
		diagnostics.stage = "tag-structure";
		diagnostics.reason = legacy.issue;
		return { ok: false, code: "incomplete", diagnostics };
	}
	if (!summary) {
		diagnostics.stage = "final-body";
		diagnostics.reason = "empty-body";
		return { ok: false, code: "incomplete", diagnostics };
	}
	return { ok: true, summary, diagnostics };
}

/** Accept only the latest completed assistant response, never an earlier interim answer. */
export function extractDailySummaryCandidate(messages: ReadonlyArray<CandidateMessage>): string {
	const result = inspectDailySummaryCandidate(messages);
	if (!result.ok) throw new DailySummaryCandidateError(result.code);
	return result.summary;
}

function stripLegacyThinking(source: string): { text: string; issue: TagIssue | null } {
	let openTag: string | undefined;
	let cursor = 0;
	let text = "";
	let issue: TagIssue | null = null;
	for (const match of source.matchAll(/<\/?(thinking|think)>/gi)) {
		if (issue) continue;
		const closing = match[0].startsWith("</");
		const tag = match[1].toLowerCase();
		if (!closing) {
			if (openTag) issue = "nested-tag";
			else {
				text += source.slice(cursor, match.index);
				openTag = tag;
			}
		} else if (!openTag) issue = "unexpected-close";
		else if (openTag !== tag) issue = "mismatched-tag";
		else openTag = undefined;
		cursor = match.index + match[0].length;
	}
	if (!issue && openTag) issue = "unclosed-tag";
	return { text: issue ? "" : (text + source.slice(cursor)).trim(), issue };
}

/** Never allow an arbitrary provider string into diagnostic logs. */
function safeStopReason(reason: string | undefined): DailySummaryCandidateDiagnostics["stopReason"] {
	switch (reason) {
		case "stop": case "length": case "error": case "aborted": case "toolUse": case "pending": return reason;
		case undefined: return "missing";
		default: return "unknown";
	}
}
