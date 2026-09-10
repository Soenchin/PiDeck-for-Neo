import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function loadModule(path, imports = {}, extra = {}) {
  const source = readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
  vm.runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    setTimeout,
    clearTimeout,
    Date,
    ...extra,
  });
  return module.exports;
}

test("automation defaults are opt-in and preserve the requested cadence", () => {
  const source = readFileSync("src/shared/types/settings.ts", "utf8");
  assert.match(source, /DEFAULT_AUTOMATION_SETTINGS[\s\S]{0,500}enabled: false/);
  assert.match(source, /time: "23:55"/);
  assert.match(source, /idleThresholdMinutes: 40/);

  const { getAutonomousContinuationDelay, getAutonomousContinuationWaitDelay } =
    loadModule("src/main/automation/AutonomousActivityCadence.ts");
  const start = 1_000_000;
  assert.equal(getAutonomousContinuationDelay(start, start), 60 * 60 * 1_000);
  assert.equal(getAutonomousContinuationDelay(start, start + 60 * 60 * 1_000), 1_000);
  assert.equal(
    getAutonomousContinuationWaitDelay(start, start, 90 * 60 * 1_000, start + 90 * 60 * 1_000),
    0,
  );
});

test("daily scheduler computes the next local 23:55 occurrence", () => {
  const { millisecondsUntilNextLocalTime } = loadModule(
    "src/main/automation/AutomationScheduler.ts",
    {
      "./AutonomousActivityTask": { AutonomousActivityTask: class {} },
      "./DailySummaryTask": { DailySummaryTask: class {} },
      "./IdleMonitor": { IdleMonitor: class {} },
      "./PresenceProbe": { checkUserPresence: async () => null },
    },
  );
  const before = new Date(2026, 8, 8, 23, 54, 30, 0);
  assert.equal(millisecondsUntilNextLocalTime("23:55", before), 30_000);
  const after = new Date(2026, 8, 8, 23, 56, 0, 0);
  assert.equal(millisecondsUntilNextLocalTime("23:55", after), 23 * 60 * 60 * 1_000 + 59 * 60 * 1_000);
  assert.equal(millisecondsUntilNextLocalTime("24:00", before), undefined);
});

test("idle automation hard limits and stop path are present", () => {
  const task = readFileSync("src/main/automation/AutonomousActivityTask.ts", "utf8");
  assert.match(task, /MAX_AUTONOMOUS_ROUNDS = 12/);
  assert.match(task, /MAX_AUTONOMOUS_DURATION_MS = 90 \* 60 \* 1_000/);
  assert.match(task, /await this\.runtime\?\.stop\(\)/);
  assert.match(task, /this\.cancelContinuation\(\)/);

  const scheduler = readFileSync("src/main/automation/AutomationScheduler.ts", "utf8");
  assert.match(scheduler, /idleThresholdMinutes: config\.idleThresholdMinutes/);
  assert.match(scheduler, /presence\.verdict !== "AWAY"/);
  assert.match(scheduler, /void this\.autonomousTask\?\.stop\("user-returned"\)/);
});

test("daily summary gates the memory write behind the review result", () => {
  const source = readFileSync("src/main/automation/DailySummaryTask.ts", "utf8");
  const reviewIndex = source.indexOf("await this.requestReview");
  const saveIndex = source.indexOf("buildSavePrompt");
  assert.ok(reviewIndex >= 0, "review request must exist");
  assert.ok(saveIndex > reviewIndex, "save prompt must be built after review");
  assert.match(source, /if \(!approved\?\.trim\(\)\) return/);
  assert.match(source, /memory_commit/);
  assert.match(source, /DAILY_SUMMARY_MODEL/);
});

test("automation runtime is hidden from renderer runtime listings", () => {
  const source = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
  assert.match(source, /catalog\.get\(sessionId\)\?\.automation/);
  assert.match(source, /continue;/);
  const catalog = readFileSync("src/main/sessions/SessionCatalog.ts", "utf8");
  assert.match(catalog, /automation\?: boolean/);
  assert.match(catalog, /automation: input\.automation === true/);
});
