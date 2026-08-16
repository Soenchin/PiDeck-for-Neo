import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadDddUsageService(netFetch) {
	const source = readFileSync("src/main/usage/DddUsageService.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "electron") return { net: { fetch: netFetch } };
			throw new Error(`Unexpected require: ${id}`);
		},
		AbortController,
		Date,
		URL,
		setTimeout,
		clearTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "DddUsageService.ts" });
	return sandbox.exports.DddUsageService;
}

function configFor(providerId) {
	return {
		getModelsConfig: async () => ({
			parsed: {
				providers: {
					[providerId]: {
						baseUrl: "https://dddai.dev/v1",
						apiKey: "test-key",
						models: [],
					},
				},
			},
		}),
		getAuthConfig: async () => ({ parsed: {} }),
	};
}

test("uses the DDD subscription balance endpoint and preserves wallet balance", async () => {
	const calls = [];
	const DddUsageService = loadDddUsageService(async (url, options) => {
		calls.push({ url, options });
		return {
			ok: true,
			json: async () => ({
				balance: 42.85601,
				data: [
					{ planName: "订阅", extra: "日限额", remaining: 42.85601, unit: "USD" },
					{ planName: "钱包余额", remaining: 3.526798, unit: "USD" },
				],
				is_active: true,
			}),
		};
	});
	const usage = await new DddUsageService(configFor("ddd-sub-gpt")).fetchForProvider("ddd-sub-gpt");

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://dddai.dev/v1/user/balance");
	assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
	assert.equal(usage.balance, 3.526798);
	assert.equal(usage.todaySubscriptionRemaining, 42.85601);
	assert.equal(usage.todayActualCost, null);
	assert.equal(usage.source, "subscription");
	assert.equal(usage.isValid, true);
});

test("keeps normal DDD providers on the existing usage endpoint", async () => {
	const calls = [];
	const DddUsageService = loadDddUsageService(async (url) => {
		calls.push(url);
		return {
			ok: true,
			json: async () => ({
				unit: "USD",
				balance: { remaining: 5 },
				usage: { total: 1.5 },
				isValid: true,
			}),
		};
	});
	const usage = await new DddUsageService(configFor("ddd-gpt")).fetchForProvider("ddd-gpt");

	assert.deepEqual(calls, ["https://dddai.dev/v1/usage"]);
	assert.equal(usage.balance, 5);
	assert.equal(usage.totalActualCost, 1.5);
	assert.equal(usage.todaySubscriptionRemaining, undefined);
});
