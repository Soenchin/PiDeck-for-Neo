import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { DailySummaryReviewBroker } from "../automation/DailySummaryReviewBroker";
import type { DailySummaryRunResult } from "../../shared/types";

export type AutomationIpcDeps = {
	runDailySummaryNow: () => Promise<DailySummaryRunResult>;
};

/** Automation IPC is deliberately narrow: renderer may request a reviewable candidate or resolve an existing review. */
export function registerAutomationIpc(broker: DailySummaryReviewBroker, deps: AutomationIpcDeps): void {
	ipcMain.handle(ipcChannels.dailySummaryRunNow, () => deps.runDailySummaryNow());
	ipcMain.handle(ipcChannels.dailySummaryConfirm, (_event, id: unknown, summary: unknown) => (
		typeof id === "string" && typeof summary === "string" && broker.confirm(id, summary)
	));
	ipcMain.handle(ipcChannels.dailySummaryCancel, (_event, id: unknown) => (
		typeof id === "string" && broker.cancel(id)
	));
}
