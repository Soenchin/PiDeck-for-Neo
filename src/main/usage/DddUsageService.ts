import { net } from "electron";
import type { ConfigManager, PiAuthFile, PiProviderConfig } from "../config/ConfigManager";
import type { ProviderUsageSnapshot } from "../../shared/types";

const DDD_HOSTNAME = "dddai.dev";
const DDD_SUB_PROVIDER_PREFIX = "ddd-sub-";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 读取嘀嘀嘀 AI 账户的余额和累计扣费。
 *
 * 普通 DDD Provider 继续读取 /v1/usage。订阅 Provider 的日限额仅由
 * /v1/user/balance 返回，因此 ddd-sub-* 单独走该端点，并把订阅剩余和钱包余额分开。
 */
export class DddUsageService {
	private readonly snapshots = new Map<string, ProviderUsageSnapshot>();

	constructor(private readonly configManager: ConfigManager) {}

	async supportsProvider(providerId?: string): Promise<boolean> {
		const provider = providerId?.trim();
		if (!provider) return false;
		const models = await this.configManager.getModelsConfig();
		return this.isDddProvider(models.parsed.providers?.[provider]);
	}

	async fetchForProvider(providerId?: string): Promise<ProviderUsageSnapshot> {
		const provider = providerId?.trim() ?? "";
		const [modelsResult, authResult] = await Promise.all([
			this.configManager.getModelsConfig(),
			this.configManager.getAuthConfig(),
		]);
		const providerConfig = modelsResult.parsed.providers?.[provider];
		if (!provider || !this.isDddProvider(providerConfig)) {
			return this.unavailable(provider, "当前 Provider 不是嘀嘀嘀 AI 账户");
		}

		const apiKey = this.resolveApiKey(provider, providerConfig, authResult.parsed);
		if (!apiKey) return this.withError(provider, "未找到该 Provider 的 API Key");

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await net.fetch(this.endpointUrl(provider, providerConfig.baseUrl), {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
				signal: controller.signal,
			});
			if (!response.ok) {
				const message = response.status === 401 || response.status === 403
					? "DDD API Key 无效或已过期"
					: response.status === 404
						? "DDD 用量接口不可用"
						: `DDD 用量请求失败（HTTP ${response.status}）`;
				return this.withError(provider, message);
			}
			const body = this.asRecord(await response.json());
			const snapshot = this.normalizeSnapshot(provider, body);
			this.snapshots.set(provider, snapshot);
			return snapshot;
		} catch (error) {
			const message = error instanceof Error && error.name === "AbortError"
				? "DDD 用量请求超时"
				: "DDD 用量请求失败，请检查网络";
			return this.withError(provider, message);
		} finally {
			clearTimeout(timer);
		}
	}

	private normalizeSnapshot(providerId: string, body: Record<string, unknown> | undefined): ProviderUsageSnapshot {
		if (this.isDddSubscriptionProvider(providerId)) {
			return this.normalizeSubscriptionSnapshot(providerId, body);
		}

		const balance = this.asRecord(body?.balance);
		const usage = this.asRecord(body?.usage);
		const subscription = this.asRecord(body?.subscription);
		const daily = this.asRecord(subscription?.daily);
		const monthly = this.asRecord(subscription?.monthly);
		const unit = this.stringValue(body?.unit)?.toUpperCase() ?? "USD";
		const isCurrency = unit === "USD" || unit === "CNY" || unit === "RMB";

		// DDD 的 usage.total 是服务端按当前计费窗口实际聚合出的扣费；只有货币单位时
		// 才作为金额展示，避免把订阅套餐的次数/配额错误渲染成美元。
		const todayActualCost = isCurrency ? this.meterUsed(daily) : null;
		const totalActualCost = isCurrency
			? this.meterUsed(monthly) ?? this.number(usage?.total)
			: null;
		return {
			providerId,
			unit,
			balance: this.number(balance?.remaining) ?? this.number(body?.remaining) ?? this.number(balance?.raw),
			todayActualCost,
			totalActualCost,
			todayCost: null,
			totalCost: null,
			todayRequests: null,
			todayInputTokens: null,
			todayOutputTokens: null,
			todayTokens: null,
			totalRequests: null,
			totalTokens: null,
			fetchedAt: new Date().toISOString(),
			source: todayActualCost != null || totalActualCost != null ? "actual_cost" : "unavailable",
			isValid: typeof body?.isValid === "boolean" ? body.isValid : null,
		};
	}

	private normalizeSubscriptionSnapshot(providerId: string, body: Record<string, unknown> | undefined): ProviderUsageSnapshot {
		const entries = Array.isArray(body?.data)
			? body.data.map((entry) => this.asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry != null)
			: [];
		const subscription = entries.find((entry) =>
			this.stringValue(entry.planName) === "订阅" && this.stringValue(entry.extra) === "日限额",
		);
		const wallet = entries.find((entry) => this.stringValue(entry.planName) === "钱包余额");
		const subscriptionTodayRemaining = this.number(subscription?.remaining)
			?? this.number(body?.remaining)
			?? this.number(body?.balance);
		const unit = this.stringValue(subscription?.unit)
			?? this.stringValue(wallet?.unit)
			?? this.stringValue(body?.unit)
			?? "USD";
		const isActive = typeof body?.is_active === "boolean"
			? body.is_active
			: typeof body?.isValid === "boolean"
				? body.isValid
				: null;

		return {
			providerId,
			unit: unit.toUpperCase(),
			balance: this.number(wallet?.remaining),
			todayActualCost: null,
			todaySubscriptionRemaining: subscriptionTodayRemaining,
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
			source: subscriptionTodayRemaining != null ? "subscription" : "unavailable",
			isValid: isActive,
		};
	}

	private endpointUrl(providerId: string, baseUrl?: string) {
		return this.isDddSubscriptionProvider(providerId)
			? this.balanceUrl(baseUrl)
			: this.usageUrl(baseUrl);
	}

	private usageUrl(baseUrl?: string) {
		return this.dddUrl(baseUrl, "/v1/usage");
	}

	private balanceUrl(baseUrl?: string) {
		return this.dddUrl(baseUrl, "/v1/user/balance");
	}

	private dddUrl(baseUrl: string | undefined, path: string) {
		try {
			return `${new URL(baseUrl ?? `https://${DDD_HOSTNAME}/v1`).origin}${path}`;
		} catch {
			return `https://${DDD_HOSTNAME}${path}`;
		}
	}

	private meterUsed(meter: Record<string, unknown> | undefined) {
		return this.number(meter?.used) ?? this.number(meter?.consumed) ?? this.number(meter?.total_used);
	}

	private withError(providerId: string, error: string): ProviderUsageSnapshot {
		const previous = this.snapshots.get(providerId);
		if (previous) return { ...previous, error };
		return this.unavailable(providerId, error);
	}

	private unavailable(providerId: string, error: string): ProviderUsageSnapshot {
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
		const configured = this.resolveConfiguredValue(typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "");
		if (configured) return configured;
		const credential = auth[providerId];
		if (credential?.type !== "api_key" || typeof credential.key !== "string") return undefined;
		return this.resolveConfiguredValue(credential.key.trim());
	}

	private resolveConfiguredValue(value: string): string | undefined {
		if (!value || value.startsWith("!")) return undefined;
		if (!value.startsWith("$")) return value;
		const envName = value.replace(/^\$\{?/, "").replace(/\}?$/, "");
		return process.env[envName]?.trim() || undefined;
	}

	private isDddProvider(provider?: PiProviderConfig) {
		if (!provider?.baseUrl) return false;
		try {
			const hostname = new URL(provider.baseUrl).hostname.toLowerCase();
			return hostname === DDD_HOSTNAME || hostname.endsWith(`.${DDD_HOSTNAME}`);
		} catch {
			return false;
		}
	}

	private isDddSubscriptionProvider(providerId: string) {
		return providerId.trim().toLowerCase().startsWith(DDD_SUB_PROVIDER_PREFIX);
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
