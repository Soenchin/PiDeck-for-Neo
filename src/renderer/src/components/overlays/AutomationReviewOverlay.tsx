import { useEffect, useState } from "react";
import type { DailySummaryReviewRequest } from "../../../../shared/types";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { Textarea } from "../ui-shadcn/textarea";

/** Daily-memory candidates are editable and require an explicit approval before any write request. */
export function AutomationReviewOverlay() {
	const [request, setRequest] = useState<DailySummaryReviewRequest | null>(null);
	const [summary, setSummary] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => desktopApi.automation.onDailySummaryReview((next) => {
		setRequest(next);
		setSummary(next.summary);
		setSaving(false);
	}), []);

	useEffect(() => desktopApi.automation.onDailySummaryFailed((code) => {
		showNotice(t(`automation.failure.${code}`), 10000, "error");
	}), []);

	const cancel = async () => {
		if (!request || saving) return;
		setSaving(true);
		try {
			await desktopApi.automation.cancelDailySummary(request.id);
			setRequest(null);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 3500, "error");
		} finally {
			setSaving(false);
		}
	};

	const confirm = async () => {
		if (!request || !summary.trim() || saving) return;
		setSaving(true);
		try {
			const accepted = await desktopApi.automation.confirmDailySummary(request.id, summary.trim());
			if (!accepted) throw new Error(t("automation.reviewUnavailable"));
			setRequest(null);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 3500, "error");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={request !== null} onOpenChange={(open) => { if (!open) void cancel(); }}>
			<DialogContent
				showCloseButton={!saving}
				className="flex h-[min(760px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] min-h-0 max-w-[min(760px,calc(100vw-2rem))] flex-col overflow-hidden"
				onPointerDownOutside={(event) => event.preventDefault()}
				onEscapeKeyDown={(event) => event.preventDefault()}
			>
				<DialogHeader className="shrink-0">
					<DialogTitle>{t("automation.reviewTitle")}</DialogTitle>
					<DialogDescription>{t("automation.reviewDescription", { date: request?.date ?? "" })}</DialogDescription>
				</DialogHeader>
				<Textarea
					value={summary}
					onChange={(event) => setSummary(event.target.value)}
					disabled={saving}
					className="min-h-0 flex-1 resize-none overflow-y-auto [field-sizing:fixed] font-mono text-sm leading-relaxed"
					aria-label={t("automation.reviewContent")}
				/>
				<DialogFooter className="shrink-0">
					<Button variant="outline" onClick={() => void cancel()} disabled={saving}>
						{t("automation.reviewCancel")}
					</Button>
					<Button onClick={() => void confirm()} loading={saving} disabled={!summary.trim()}>
						{t("automation.reviewConfirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
