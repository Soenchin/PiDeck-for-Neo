import { net } from "electron";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigManager, PiAuthFile, PiProviderConfig } from "../config/ConfigManager";
import type { ProviderUsageSnapshot } from "../../shared/types";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

// DeepSeek 价格表：百万 Token 输入（缓存命中/未命中）和输出，最后按用户指定倍率调整。
const CACHE_READ_PRICE_PER_MILLION = 0.02;
const INPUT_PRICE_PER_MILLION = 1;
const OUTPUT_PRICE_PER_MILLION = 2;
const PRICE_MULTIPLIER = 1.75;

type DeepSeekUsageRecord = {
	recordId: string;
	providerId: string;
	timestamp: number;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	estimatedCost: number;
};

type ParsedSessionFile = {
	mtimeMs: number;
	size: number;
	records: DeepSeekUsageRecord[];
};

type LocalUsageAggregate = {
	hasRecords: boolean;
	todayCost: number;
	totalCost: number;
	todayRequests: number;
	todayInputTokens: number;
	todayOutputTokens: number;
	todayTokens: number;
	totalRequests: number;
	totalTokens: number;
};

type BalanceInfo = {
	balance: number | null;
	unit: string;
	isValid: boolean | null;
};

/**
 * DeepSeek 官方账户适配器。
 *
 * DeepSeek 没有公开账户级 usage 接口，因此余额走官方 /user/balance，
 * 今日/累计花费则只扫描本地 session 中的 assistant usage 元数据并估算。
 * 扫描过程不会读取或保存会话正文，也不会改变 Pi 的请求。
 */
export class DeepSeekUsageService {
	private readonly snapshots = new Map<string, ProviderUsageSnapshot>();
	private readonly sessionFileCache = new Map<string, ParsedSessionFile>();

	constructor(
		private readonly configManager: ConfigManager,
		private readonly sessionsRoot = DEFAULT_SESSIONS_ROOT,
	) {}

	async supportsProvider(providerId?: string): Promise<boolean> {
		const provider = providerId?.trim();
		if (!provider) return false;
		const modelsResult = await this.configManager.getModelsConfig();
		return this.isDeepSeekProvider(provider, modelsResult.parsed.providers?.[provider]);
	}

	async fetchForProvider(providerId?: string): Promise<ProviderUsageSnapshot> {
		const provider = providerId?.trim() ?? "";
		const [modelsResult, authResult] = await Promise.all([
			this.configManager.getModelsConfig(),
			this.configManager.getAuthConfig(),
		]);
		const providerConfig = modelsResult.parsed.providers?.[provider];

		if (!provider || !this.isDeepSeekProvider(provider, providerConfig)) {
			return this.unavailable(provider, "当前 Provider 不是官方 DeepSeek 账户");
		}

		const localUsage = await this.collectLocalUsage(provider);
		const apiKey = this.resolveApiKey(provider, providerConfig, authResult.parsed);
		if (!apiKey) return this.withError(provider, "未找到该 Provider 的 DeepSeek API Key", localUsage);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await net.fetch(DEEPSEEK_BALANCE_URL, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
				signal: controller.signal,
			});
			if (!response.ok) {
				const message = response.status === 401 || response.status === 403
					? "DeepSeek API Key 无效或已过期"
					: response.status === 404
						? "DeepSeek 余额接口不可用"
						: `DeepSeek 余额请求失败（HTTP ${response.status}）`;
				return this.withError(provider, message, localUsage);
			}

			const body = this.asRecord(await response.json());
			const balanceInfo = this.normalizeBalance(body);
			const snapshot = this.createSnapshot(provider, localUsage, balanceInfo);
			this.snapshots.set(provider, snapshot);
			return snapshot;
		} catch (error) {
			const message = error instanceof Error && error.name === "AbortError"
				? "DeepSeek 余额请求超时"
				: "DeepSeek 余额请求失败，请检查网络";
			return this.withError(provider, message, localUsage);
		} finally {
			clearTimeout(timer);
		}
	}

	getLastSnapshot(providerId?: string) {
		return providerId ? this.snapshots.get(providerId) : undefined;
	}

	private createSnapshot(
		providerId: string,
		local: LocalUsageAggregate,
		balance: BalanceInfo,
		error?: string,
	): ProviderUsageSnapshot {
		return {
			providerId,
			unit: balance.unit,
			costUnit: "CNY",
			balance: balance.balance,
			todayActualCost: null,
			totalActualCost: null,
			todayCost: local.hasRecords ? local.todayCost : null,
			totalCost: local.hasRecords ? local.totalCost : null,
			// DeepSeek 账户没有公开 usage 接口；按需求只把本地估算费用用于第二环，
			// 不在详情区追加本地请求数/Token 明细，避免把本地统计误认为官方账单。 
			todayRequests: null,
			todayInputTokens: null,
			todayOutputTokens: null,
			todayTokens: null,
			totalRequests: null,
			totalTokens: null,
			fetchedAt: new Date().toISOString(),
			source: local.hasRecords ? "cost" : "unavailable",
			isValid: balance.isValid,
			error,
		};
	}

	private withError(
		providerId: string,
		error: string,
		local: LocalUsageAggregate,
	): ProviderUsageSnapshot {
		const previous = this.snapshots.get(providerId);
		if (previous) {
			const next = local.hasRecords
				? this.createSnapshot(providerId, local, {
						balance: previous.balance,
						unit: previous.unit,
						isValid: previous.isValid,
					})
				: { ...previous };
			return { ...next, fetchedAt: previous.fetchedAt, error };
		}

		return this.createSnapshot(providerId, local, {
			balance: null,
			unit: "CNY",
			isValid: null,
		}, error);
	}

	private unavailable(providerId: string, error: string): ProviderUsageSnapshot {
		return this.createSnapshot(providerId, this.emptyLocalUsage(), {
			balance: null,
			unit: "CNY",
			isValid: null,
		}, error);
	}

	private normalizeBalance(body: Record<string, unknown> | undefined): BalanceInfo {
		const infos = Array.isArray(body?.balance_infos)
			? body.balance_infos.map((item) => this.asRecord(item)).filter((item): item is Record<string, unknown> => !!item)
			: [];
		const preferred =
			infos.find((item) => String(item.currency ?? "").toUpperCase() === "CNY") ??
			infos.find((item) => String(item.currency ?? "").toUpperCase() === "USD") ??
			infos[0];
		const currency = typeof preferred?.currency === "string" && preferred.currency.trim()
			? preferred.currency.trim().toUpperCase()
			: "CNY";
		return {
			balance: this.number(preferred?.total_balance),
			unit: currency,
			isValid: typeof body?.is_available === "boolean" ? body.is_available : null,
		};
	}

	private async collectLocalUsage(providerId: string): Promise<LocalUsageAggregate> {
		const files = await this.listSessionFiles(this.sessionsRoot);
		const normalizedProvider = providerId.toLowerCase();
		const activeCacheKeys = new Set(files.map((filePath) => this.sessionCacheKey(filePath, normalizedProvider)));
		await Promise.all(files.map(async (filePath) => {
			const metadata = await stat(filePath).catch(() => undefined);
			if (!metadata) return;
			const cacheKey = this.sessionCacheKey(filePath, normalizedProvider);
			const cached = this.sessionFileCache.get(cacheKey);
			if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) return;
			const records = await this.parseSessionFile(filePath, normalizedProvider);
			this.sessionFileCache.set(cacheKey, {
				mtimeMs: metadata.mtimeMs,
				size: metadata.size,
				records,
			});
		}));
		for (const cacheKey of this.sessionFileCache.keys()) {
			if (!activeCacheKeys.has(cacheKey)) this.sessionFileCache.delete(cacheKey);
		}

		const todayKey = this.localDayKey(Date.now());
		const aggregate = this.emptyLocalUsage();
		const seenRecordIds = new Set<string>();
		for (const file of this.sessionFileCache.values()) {
			for (const record of file.records) {
				// 分支/复制 session 可能保留同一个 assistant entry；按 entry id 去重，避免本地费用膨胀。
				if (seenRecordIds.has(record.recordId)) continue;
				seenRecordIds.add(record.recordId);
				aggregate.hasRecords = true;
				aggregate.totalCost += record.estimatedCost;
				aggregate.totalRequests += 1;
				aggregate.totalTokens += record.totalTokens;
				if (this.localDayKey(record.timestamp) !== todayKey) continue;
				aggregate.todayCost += record.estimatedCost;
				aggregate.todayRequests += 1;
				aggregate.todayInputTokens += record.inputTokens;
				aggregate.todayOutputTokens += record.outputTokens;
				aggregate.todayTokens += record.totalTokens;
			}
		}
		return aggregate;
	}

	private async parseSessionFile(filePath: string, providerId: string): Promise<DeepSeekUsageRecord[]> {
		const records: DeepSeekUsageRecord[] = [];
		const input = createReadStream(filePath, { encoding: "utf8" });
		const lines = createInterface({ input, crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				if (!line.trim()) continue;
				// 大多数 session 行不属于当前 provider；先做轻量字符串筛选，避免对整棵历史树反复 JSON.parse。
				if (!line.includes(`"provider":"${providerId}"`) && !line.includes(`"provider": "${providerId}"`)) continue;
				let entry: Record<string, unknown>;
				try {
					// 只保留 usage 元数据；会话正文不进入适配器的对象结构。
					entry = JSON.parse(line, (key, value) =>
						["content", "text", "thinking", "arguments", "partialJson"].includes(key)
							? undefined
							: value,
					) as Record<string, unknown>;
				} catch {
					continue;
				}
				const message = this.asRecord(entry.message);
				if (message?.role !== "assistant") continue;
				const stopReason = this.stringValue(message.stopReason);
				if (stopReason === "aborted" || stopReason === "error") continue;
				const messageProvider = this.stringValue(message.provider);
				if (!messageProvider || messageProvider.toLowerCase() !== providerId) continue;
				const usage = this.asRecord(message.usage);
				if (!usage) continue;
				const inputTokens = this.number(usage.input) ?? this.number(usage.inputTokens) ?? 0;
				const outputTokens = this.number(usage.output) ?? this.number(usage.outputTokens) ?? 0;
				const cacheRead = this.number(usage.cacheRead) ?? this.number(this.asRecord(usage.cache)?.read) ?? 0;
				const cacheWrite = this.number(usage.cacheWrite) ?? this.number(this.asRecord(usage.cache)?.write) ?? 0;
				const totalTokens = this.number(usage.totalTokens) ?? inputTokens + outputTokens + cacheRead + cacheWrite;
				const timestamp = this.timestamp(message.timestamp) ?? this.timestamp(entry.timestamp);
				if (!timestamp || inputTokens + outputTokens + cacheRead + cacheWrite <= 0) continue;
				const recordId = this.stringValue(entry.id) ??
					this.stringValue(message.responseId) ??
					`${filePath}:${messageProvider}:${timestamp}:${inputTokens}:${outputTokens}:${cacheRead}:${cacheWrite}`;
				const estimatedCost = (
					cacheRead * CACHE_READ_PRICE_PER_MILLION +
					(inputTokens + cacheWrite) * INPUT_PRICE_PER_MILLION +
					outputTokens * OUTPUT_PRICE_PER_MILLION
				) / 1_000_000 * PRICE_MULTIPLIER;
				records.push({
					recordId,
					providerId: messageProvider,
					timestamp,
					inputTokens,
					outputTokens,
					cacheRead,
					cacheWrite,
					totalTokens,
					estimatedCost,
				});
			}
		} catch {
			// 会话可能在刷新时仍被 Pi 追加；保留已经读到的完整行。
		} finally {
			lines.close();
			input.destroy();
		}
		return records;
	}

	private sessionCacheKey(filePath: string, providerId: string) {
		return `${providerId}::${filePath}`;
	}

	private async listSessionFiles(directory: string): Promise<string[]> {
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		const files: string[] = [];
		await Promise.all(entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				files.push(...await this.listSessionFiles(path));
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(path);
			}
		}));
		return files;
	}

	private resolveApiKey(providerId: string, provider: PiProviderConfig | undefined, auth: PiAuthFile): string | undefined {
		const configured = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
		const configuredKey = this.resolveConfiguredValue(configured);
		if (configuredKey) return configuredKey;

		for (const authId of [providerId, "deepseek"]) {
			const credential = auth[authId];
			if (!credential || credential.type !== "api_key" || typeof credential.key !== "string") continue;
			const value = credential.key.trim();
			if (!value) continue;
			if (value.startsWith("$")) {
				const envName = value.replace(/^\$\{?/, "").replace(/\}?$/, "");
				const scopedEnv = this.asRecord(credential.env)?.[envName];
				const resolved = this.stringValue(scopedEnv) ?? process.env[envName]?.trim();
				if (resolved) return resolved;
			} else if (!value.startsWith("!")) {
				return value;
			}
		}
		return undefined;
	}

	private resolveConfiguredValue(value: string): string | undefined {
		if (!value || value.startsWith("!")) return undefined;
		if (!value.startsWith("$")) return value;
		const envName = value.replace(/^\$\{?/, "").replace(/\}?$/, "");
		return process.env[envName]?.trim() || undefined;
	}

	private isDeepSeekProvider(providerId: string, provider?: PiProviderConfig): boolean {
		const id = providerId.toLowerCase();
		if (id.startsWith("sx-")) return false;
		if (!provider?.baseUrl) return id === "deepseek" || id === "deepseek-direct";
		try {
			return new URL(provider.baseUrl).hostname.toLowerCase() === "api.deepseek.com";
		} catch {
			return false;
		}
	}

	private emptyLocalUsage(): LocalUsageAggregate {
		return {
			hasRecords: false,
			todayCost: 0,
			totalCost: 0,
			todayRequests: 0,
			todayInputTokens: 0,
			todayOutputTokens: 0,
			todayTokens: 0,
			totalRequests: 0,
			totalTokens: 0,
		};
	}

	private localDayKey(timestamp: number): string {
		const date = new Date(timestamp);
		return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
	}

	private timestamp(value: unknown): number | null {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) {
			const numeric = Number(value);
			if (Number.isFinite(numeric)) return numeric;
			const parsed = Date.parse(value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}

	private asRecord(value: unknown): Record<string, unknown> | undefined {
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
	}

	private stringValue(value: unknown): string | undefined {
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	}

	private number(value: unknown): number | null {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}
}
