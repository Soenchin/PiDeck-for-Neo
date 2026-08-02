import { net } from "electron";
import type { ConfigManager, PiAuthFile, PiProviderConfig } from "../config/ConfigManager";
import type { ProviderUsageSnapshot } from "../../shared/types";

const SX_USAGE_URL = "https://sui-xiang.com/v1/usage";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 读取当前 SX provider 的账户用量。
 * API Key 始终留在主进程；renderer 只会收到规范化后的统计快照。
 */
export class SxUsageService {
	private readonly snapshots = new Map<string, ProviderUsageSnapshot>();

	constructor(private readonly configManager: ConfigManager) {}

	async fetchForProvider(providerId?: string): Promise<ProviderUsageSnapshot> {
		const provider = providerId?.trim();
		if (!provider || !this.isSxProvider(provider)) {
			return {
				providerId: provider ?? "",
				unit: "USD",
				balance: null,
				todayActualCost: null,
				totalActualCost: null,
				todayCost: null,
				totalCost: null,
				todayRequests: null,
				todayInputTokens: null,
				todayOutputTokens: null,
				todayTokens: null,
				totalRequests: null,
				totalTokens: null,
				fetchedAt: new Date().toISOString(),
				source: "unavailable",
				isValid: null,
				error: "当前 Provider 不是 SX 账户",
			};
		}

		const [modelsResult, authResult] = await Promise.all([
			this.configManager.getModelsConfig(),
			this.configManager.getAuthConfig(),
		]);
		const providerConfig = modelsResult.parsed.providers?.[provider];
		const apiKey = this.resolveApiKey(provider, providerConfig, authResult.parsed);
		if (!apiKey) return this.withError(provider, "未找到该 Provider 的 API Key");

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await net.fetch(SX_USAGE_URL, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
				signal: controller.signal,
			});
			if (!response.ok) {
				const message = response.status === 401 || response.status === 403
					? "API Key 无效或已过期"
					: response.status === 404
						? "用量接口不可用"
						: `用量请求失败（HTTP ${response.status}）`;
				return this.withError(provider, message);
			}
			const body = await response.json() as Record<string, unknown>;
			const snapshot = this.normalizeSnapshot(provider, body);
			this.snapshots.set(provider, snapshot);
			return snapshot;
		} catch (error) {
			const message = error instanceof Error && error.name === "AbortError"
				? "用量请求超时"
				: "用量请求失败，请检查网络";
			return this.withError(provider, message);
		} finally {
			clearTimeout(timer);
		}
	}

	getLastSnapshot(providerId?: string) {
		return providerId ? this.snapshots.get(providerId) : undefined;
	}

	private normalizeSnapshot(providerId: string, body: Record<string, unknown>): ProviderUsageSnapshot {
		const usage = this.asRecord(body.usage);
		const today = this.asRecord(usage?.today);
		const total = this.asRecord(usage?.total);
		const todayActualCost = this.number(today?.actual_cost);
		const totalActualCost = this.number(total?.actual_cost);
		const todayCost = this.number(today?.cost);
		const totalCost = this.number(total?.cost);
		return {
			providerId,
			unit: typeof body.unit === "string" ? body.unit : "USD",
			balance: this.number(body.balance) ?? this.number(body.remaining),
			todayActualCost,
			totalActualCost,
			todayCost,
			totalCost,
			todayRequests: this.number(today?.requests),
			todayInputTokens: this.number(today?.input_tokens),
			todayOutputTokens: this.number(today?.output_tokens),
			todayTokens: this.number(today?.total_tokens),
			totalRequests: this.number(total?.requests),
			totalTokens: this.number(total?.total_tokens),
			fetchedAt: new Date().toISOString(),
			source: todayActualCost != null || totalActualCost != null
				? "actual_cost"
				: todayCost != null || totalCost != null
					? "cost"
					: "unavailable",
			isValid: typeof body.isValid === "boolean" ? body.isValid : null,
		};
	}

	private withError(providerId: string, error: string): ProviderUsageSnapshot {
		const previous = this.snapshots.get(providerId);
		if (previous) return { ...previous, error };
		return {
			providerId,
			unit: "USD",
			balance: null,
			todayActualCost: null,
			totalActualCost: null,
			todayCost: null,
			totalCost: null,
			todayRequests: null,
			todayInputTokens: null,
			todayOutputTokens: null,
			todayTokens: null,
			totalRequests: null,
			totalTokens: null,
			fetchedAt: new Date().toISOString(),
			source: "unavailable",
			isValid: null,
			error,
		};
	}

	private resolveApiKey(providerId: string, provider: PiProviderConfig | undefined, auth: PiAuthFile): string | undefined {
		const configured = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
		if (configured && !configured.startsWith("$") && !configured.startsWith("!")) return configured;
		const credential = auth[providerId];
		if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim()) {
			return credential.key.trim();
		}
		if (configured.startsWith("$")) {
			const envName = configured.replace(/^\$\{?/, "").replace(/\}?$/, "");
			return process.env[envName]?.trim() || undefined;
		}
		return undefined;
	}

	private isSxProvider(providerId: string) {
		return providerId.toLowerCase().startsWith("sx-");
	}

	private asRecord(value: unknown): Record<string, unknown> | undefined {
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
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
