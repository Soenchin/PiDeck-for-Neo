import type { BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { DailySummaryReviewRequest } from "../../shared/types";

/**
 * Keeps review promises in the main process. A renderer crash/reload cannot silently
 * turn an approved-memory workflow into a lost candidate or an unattended write.
 */
export class DailySummaryReviewBroker {
	private readonly pending = new Map<string, {
		request: DailySummaryReviewRequest;
		resolve: (summary: string | null) => void;
	}>();

	constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

	request(request: DailySummaryReviewRequest): Promise<string | null> {
		return new Promise((resolve, reject) => {
			const window = this.getMainWindow();
			if (!window || window.isDestroyed()) {
				reject(new Error("Main window is unavailable for daily summary review"));
				return;
			}
			this.pending.set(request.id, { request, resolve });
			window.show();
			window.focus();
			window.webContents.send(ipcChannels.dailySummaryReview, request);
		});
	}

	confirm(id: string, summary: string): boolean {
		const pending = this.pending.get(id);
		if (!pending || !summary.trim()) return false;
		this.pending.delete(id);
		pending.resolve(summary.trim());
		return true;
	}

	cancel(id: string): boolean {
		const pending = this.pending.get(id);
		if (!pending) return false;
		this.pending.delete(id);
		pending.resolve(null);
		return true;
	}

	/** Call after each did-finish-load so a recovered renderer can render the pending review. */
	replay(): void {
		const window = this.getMainWindow();
		if (!window || window.isDestroyed()) return;
		for (const { request } of this.pending.values()) {
			window.webContents.send(ipcChannels.dailySummaryReview, request);
		}
	}

	cancelAll(): void {
		for (const { resolve } of this.pending.values()) resolve(null);
		this.pending.clear();
	}
}
