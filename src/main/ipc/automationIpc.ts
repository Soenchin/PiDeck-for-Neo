import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { DailySummaryReviewBroker } from "../automation/DailySummaryReviewBroker";

/** Automation IPC is deliberately narrow: renderer may only approve/cancel an existing main-process review. */
export function registerAutomationIpc(broker: DailySummaryReviewBroker): void {
	ipcMain.handle(ipcChannels.dailySummaryConfirm, (_event, id: unknown, summary: unknown) => (
		typeof id === "string" && typeof summary === "string" && broker.confirm(id, summary)
	));
	ipcMain.handle(ipcChannels.dailySummaryCancel, (_event, id: unknown) => (
		typeof id === "string" && broker.cancel(id)
	));
}
