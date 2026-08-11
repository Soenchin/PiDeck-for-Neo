import { app } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeSessionPath } from "../../shared/sessionPath";

type SessionPreference = {
	pinnedAt?: number;
};

type SessionPreferencesData = {
	version: 1;
	sessions: Record<string, SessionPreference>;
};

/**
 * 会话偏好存储：置顶状态、排序时间等 PiDeck 界面偏好
 * 独立于 pi 会话文件，不修改 .jsonl 内容
 */
export class SessionPreferenceStore {
	private readonly filePath = join(app.getPath("userData"), "session-preferences.json");
	private data: SessionPreferencesData = { version: 1, sessions: {} };

	async load(): Promise<void> {
		try {
			const raw = await readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<SessionPreferencesData>;
			// 版本未知或损坏时回退空状态，不影响启动
			if (parsed.version !== 1 || typeof parsed.sessions !== "object") {
				this.data = { version: 1, sessions: {} };
				return;
			}
			this.data = parsed as SessionPreferencesData;
		} catch {
			// 文件不存在或解析失败，使用空状态
			this.data = { version: 1, sessions: {} };
		}
	}

	get(filePath: string): SessionPreference | undefined {
		const key = normalizeSessionPath(filePath);
		return key ? this.data.sessions[key] : undefined;
	}

	isPinned(filePath: string): boolean {
		return Boolean(this.get(filePath)?.pinnedAt);
	}

	async setPinned(filePath: string, pinned: boolean): Promise<void> {
		const key = normalizeSessionPath(filePath);
		if (!key) return;

		if (pinned) {
			this.data.sessions[key] = { pinnedAt: Date.now() };
		} else {
			delete this.data.sessions[key];
		}

		await this.persist();
	}

	async remove(filePath: string): Promise<void> {
		const key = normalizeSessionPath(filePath);
		if (!key) return;
		delete this.data.sessions[key];
		await this.persist();
	}

	/**
	 * 清理不存在的会话路径，避免偏好文件持续膨胀
	 * @param existingPaths 当前扫描到的所有会话文件路径
	 */
	async prune(existingPaths: string[]): Promise<void> {
		const existingKeys = new Set(existingPaths.map(normalizeSessionPath).filter(Boolean));
		const keysToRemove = Object.keys(this.data.sessions).filter((key) => !existingKeys.has(key));
		
		if (keysToRemove.length === 0) return;

		for (const key of keysToRemove) {
			delete this.data.sessions[key];
		}

		await this.persist();
	}

	private async persist(): Promise<void> {
		await mkdir(app.getPath("userData"), { recursive: true });
		await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
	}
}
