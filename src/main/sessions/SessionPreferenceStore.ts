import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionEnvironment } from "../../shared/types";
import { canonicalizeSessionPath } from "../../shared/sessionIdentity";

/** 单个会话的界面偏好（当前只有置顶）。 */
export type SessionPreference = {
	/** 置顶时间戳，用于置顶会话之间的稳定排序 */
	pinnedAt: number;
};

type SessionPreferencesData = {
	version: 1;
	/**
	 * key = `${environment}:${canonicalizeSessionPath(filePath)}`。
	 * 按规范化会话文件路径键控（与 SessionCatalog originKey 同一套归一化规则），
	 * 不依赖 catalog id：归档/恢复后文件路径不变，置顶状态得以保留。
	 */
	sessions: Record<string, SessionPreference>;
};

/**
 * 会话界面偏好存储（置顶等）：独立于 pi 会话文件，不修改 .jsonl 内容。
 * 构造函数注入持久化文件路径（主进程装配层传 userData 下的固定文件），
 * 不 import electron，测试可直接指向临时文件。
 */
export class SessionPreferenceStore {
	private data: SessionPreferencesData = { version: 1, sessions: {} };
	private loaded = false;
	/** load 时发现旧格式键并完成升级后置位，用于一次性回写 */
	private migratedLegacy = false;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = await readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<SessionPreferencesData> | null;
			// 版本未知或结构损坏时回退空状态：偏好丢失可接受，不能阻塞启动
			if (
				parsed?.version !== 1 ||
				typeof parsed.sessions !== "object" ||
				parsed.sessions === null
			) {
				this.data = { version: 1, sessions: {} };
				return;
			}
			this.data = this.migrateLegacyKeys(parsed.sessions);
			if (this.migratedLegacy) {
				// 升级一次后立刻回写，后续加载不再重复迁移
				this.migratedLegacy = false;
				await this.persist();
			}
		} catch {
			// 文件不存在或 JSON 损坏：从空状态开始，首次写入会重建文件
			this.data = { version: 1, sessions: {} };
		}
	}

	/**
	 * 旧版（0.6.x NeoNisch）键为裸规范化路径（旧 normalizeSessionPath：正斜杠+小写+无尾斜杠），
	 * 无环境前缀。迁移规则：
	 * - 带 native:/wsl: 前缀 → 新格式原样保留；
	 * - 以 / 开头的裸键 → wsl 路径（旧版已强制小写，大小写信息不可恢复，原样接前缀）；
	 * - 其余裸键（含盘符冒号）→ native Windows 路径，重新归一化（幂等）。
	 * 非法值条目直接丢弃；新键碰撞时保留先到条目。
	 */
	private migrateLegacyKeys(
		sessions: Record<string, unknown>,
	): SessionPreferencesData {
		const upgraded: Record<string, SessionPreference> = {};
		for (const [key, rawValue] of Object.entries(sessions)) {
			const value = rawValue as Partial<SessionPreference> | null;
			if (!value || typeof value !== "object" || typeof value.pinnedAt !== "number") {
				this.migratedLegacy = true;
				continue;
			}
			const preference: SessionPreference = { pinnedAt: value.pinnedAt };
			if (key.startsWith("native:") || key.startsWith("wsl:")) {
				if (!upgraded[key]) upgraded[key] = preference;
				continue;
			}
			this.migratedLegacy = true;
			const environment: SessionEnvironment = key.startsWith("/") ? "wsl" : "native";
			const newKey = `${environment}:${canonicalizeSessionPath(key, environment)}`;
			if (!upgraded[newKey]) upgraded[newKey] = preference;
		}
		return { version: 1, sessions: upgraded };
	}

	get(filePath: string, environment: SessionEnvironment): SessionPreference | undefined {
		const key = this.buildKey(filePath, environment);
		return key ? this.data.sessions[key] : undefined;
	}

	isPinned(filePath: string, environment: SessionEnvironment): boolean {
		return Boolean(this.get(filePath, environment));
	}

	/** 置顶/取消置顶；返回新的 pinnedAt（取消时为 undefined）供调用方回显。 */
	async setPinned(
		filePath: string,
		environment: SessionEnvironment,
		pinned: boolean,
	): Promise<number | undefined> {
		const key = this.buildKey(filePath, environment);
		if (!key) return undefined;
		let result: number | undefined;
		if (pinned) {
			const pinnedAt = Date.now();
			this.data.sessions[key] = { pinnedAt };
			result = pinnedAt;
		} else {
			delete this.data.sessions[key];
		}
		await this.persist();
		return result;
	}

	async remove(filePath: string, environment: SessionEnvironment): Promise<void> {
		const key = this.buildKey(filePath, environment);
		if (!key) return;
		delete this.data.sessions[key];
		await this.persist();
	}

	/** 清理已不存在的会话偏好（如外部删除的会话文件），防止文件无限膨胀。 */
	async prune(
		existing: ReadonlyArray<{ filePath?: string; environment: SessionEnvironment }>,
	): Promise<void> {
		const keys = new Set(
			existing
				.filter((item): item is { filePath: string; environment: SessionEnvironment } =>
					Boolean(item.filePath))
				.map((item) => this.buildKey(item.filePath, item.environment))
				.filter((key): key is string => Boolean(key)),
		);
		const stale = Object.keys(this.data.sessions).filter((key) => !keys.has(key));
		if (stale.length === 0) return;
		for (const key of stale) delete this.data.sessions[key];
		await this.persist();
	}

	private buildKey(filePath: string, environment: SessionEnvironment): string | undefined {
		const trimmed = filePath.trim();
		if (!trimmed) return undefined;
		return `${environment}:${canonicalizeSessionPath(trimmed, environment)}`;
	}

	private persist(): Promise<void> {
		// 串行写队列：置顶/取消/清理并发触发时不产生交错的部分写
		this.writeQueue = this.writeQueue.then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
		});
		return this.writeQueue;
	}
}
