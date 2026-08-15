import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { Button } from "../ui/Button";
import { CloseIconButton } from "../ui/IconButton";
import "./DailySummaryReviewModal.css";

export interface DailySummaryReviewModalProps {
	summary: string;
	date: string;
	onConfirm: (editedSummary: string) => void;
	onCancel: () => void;
}

export function DailySummaryReviewModal(props: DailySummaryReviewModalProps) {
	const [summary, setSummary] = useState(props.summary);

	useEffect(() => {
		setSummary(props.summary);
	}, [props.summary]);

	return (
		<div className="modal-backdrop" onClick={props.onCancel}>
			<div className="daily-summary-review-modal" onClick={(event) => event.stopPropagation()}>
				<div className="modal-header">
					<div>
						<h2>{t("dailySummary.reviewTitle")}</h2>
						<p className="modal-subtitle">{props.date}</p>
					</div>
					<CloseIconButton label={t("common.close")} onClick={props.onCancel} />
				</div>

				<div className="modal-body">
					<label className="modal-label" htmlFor="daily-summary-content">
						{t("dailySummary.summaryContent")}
					</label>
					<textarea
						id="daily-summary-content"
						className="summary-textarea"
						value={summary}
						onChange={(event) => setSummary(event.target.value)}
						placeholder={t("dailySummary.summaryPlaceholder")}
						autoFocus
					/>
					<p className="modal-hint">{t("dailySummary.reviewHint")}</p>
				</div>

				<div className="modal-footer">
					<Button onClick={props.onCancel}>{t("dailySummary.cancel")}</Button>
					<Button
						variant="primary"
						disabled={!summary.trim()}
						onClick={() => props.onConfirm(summary.trim())}
					>
						{t("dailySummary.confirmAndSave")}
					</Button>
				</div>
			</div>
		</div>
	);
}
