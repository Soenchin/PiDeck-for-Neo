import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function loadCadenceModule() {
	const source = readFileSync("src/main/automation/AutonomousActivityCadence.ts", "utf8");
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const module = { exports: {} };
	vm.runInNewContext(compiled.outputText, { module, exports: module.exports });
	return module.exports;
}

test("autonomous activity waits one hour between prompt starts", () => {
	const { MIN_AUTONOMOUS_ROUND_INTERVAL_MS, getAutonomousContinuationDelay } = loadCadenceModule();
	const startedAt = 1_000_000;

	assert.equal(MIN_AUTONOMOUS_ROUND_INTERVAL_MS, 60 * 60 * 1_000);
	assert.equal(getAutonomousContinuationDelay(startedAt, startedAt), 60 * 60 * 1_000);
	assert.equal(
		getAutonomousContinuationDelay(startedAt, startedAt + 59 * 60 * 1_000),
		60 * 1_000,
	);
});

test("autonomous activity retains a small settle delay after a one-hour round", () => {
	const { getAutonomousContinuationDelay } = loadCadenceModule();
	const startedAt = 1_000_000;

	assert.equal(getAutonomousContinuationDelay(startedAt, startedAt + 60 * 60 * 1_000), 1_000);
	assert.equal(getAutonomousContinuationDelay(startedAt, startedAt + 61 * 60 * 1_000), 1_000);
});

test("the duration cap shortens a pending continuation wait", () => {
	const { getAutonomousContinuationWaitDelay } = loadCadenceModule();
	const sessionStartedAt = 1_000_000;
	const maxDurationMs = 90 * 60 * 1_000;
	const now = sessionStartedAt + maxDurationMs - 1_000;

	assert.equal(
		getAutonomousContinuationWaitDelay(now, sessionStartedAt, maxDurationMs, now),
		1_000,
	);
	assert.equal(
		getAutonomousContinuationWaitDelay(now, sessionStartedAt, maxDurationMs, now + 1_000),
		0,
	);
});

test("the task loop uses the cadence calculation and cancels it on stop", () => {
	const taskSource = readFileSync("src/main/automation/AutonomousActivityTask.ts", "utf8");

	assert.match(
		taskSource,
		/getAutonomousContinuationWaitDelay\(\s*this\.lastRoundStartedAt,\s*this\.startedAt,\s*MAX_AUTONOMOUS_DURATION_MS,/,
	);
	assert.match(
		taskSource,
		/await this\.waitForContinuationDelay\([\s\S]*?if \(Date\.now\(\) - this\.startedAt >= MAX_AUTONOMOUS_DURATION_MS\) \{[\s\S]*?await this\.stop\("completed"\);/,
	);
	assert.match(taskSource, /this\.cancelContinuationDelay\(\);/);
});
