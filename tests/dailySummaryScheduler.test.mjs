import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsCommonJs } from './helpers/loadTsCommonJs.mjs';

function harness(execute = async () => {}) {
  const logs = [], timers = [];
  let runs = 0;
  const { AutomationScheduler } = loadTsCommonJs('src/main/automation/AutomationScheduler.ts', {
    stubs: {
      './DailySummaryTask': { DailySummaryTask: class { async execute() { runs++; await execute(); } } },
      './AutonomousActivityTask': { AutonomousActivityTask: class {} },
      './IdleMonitor': { IdleMonitor: class {} },
      './PresenceProbe': { checkUserPresence: async () => null },
    },
    globals: {
      setTimeout: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
      clearTimeout: timer => { timer.cleared = true; },
    },
  });
  const log = Object.fromEntries(['info','warn','error'].map(level => [level, (scope, message, detail) => logs.push({ level, scope, message, detail })]));
  const scheduler = new AutomationScheduler({}, {}, async () => null, log);
  const settings = { automation: { dailySummary: { enabled: true, time: '23:55', minTurns: 4 }, autonomousMode: { enabled: false } } };
  return { scheduler, settings, logs, timers, runs: () => runs };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('manual trigger reports disabled and logs the disabled schedule', async () => {
  const h = harness();
  h.settings.automation.dailySummary.enabled = false;
  await h.scheduler.start(h.settings);
  assert.equal((await h.scheduler.runDailySummaryNow()).reason, 'disabled');
  assert.equal(h.runs(), 0);
  assert.ok(h.logs.some(e => e.message === 'Daily summary is disabled'));
});

test('manual and scheduled triggers share a lock, log lifecycle, and keep next schedule', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  await h.scheduler.start(h.settings);
  assert.ok(h.logs.some(e => e.message === 'Daily summary scheduled' && Number.isFinite(Date.parse(e.detail.nextRunAt))));
  assert.equal((await h.scheduler.runDailySummaryNow()).started, true);
  assert.equal((await h.scheduler.runDailySummaryNow()).reason, 'already-running');
  h.timers[0].callback();
  await flush();
  assert.equal(h.runs(), 1);
  assert.equal(h.timers.length, 2, 'busy scheduled tick must not lose the next day');
  release();
  await flush();
  assert.ok(h.logs.some(e => e.message === 'Daily summary started' && e.detail.trigger === 'manual'));
  assert.ok(h.logs.some(e => e.message === 'Daily summary run completed'));
  await h.scheduler.stop();
  assert.ok(h.timers[1].cleared);
});

test('scheduled execution failures are logged and still rearm the timer', async () => {
  const h = harness(async () => { throw new Error('synthetic failure'); });
  await h.scheduler.start(h.settings);
  h.timers[0].callback();
  await flush();
  assert.equal(h.runs(), 1);
  assert.equal(h.timers.length, 2);
  assert.ok(h.logs.some(e => e.level === 'error' && e.message === 'Daily summary failed'));
  await h.scheduler.stop();
});

test('shutdown while scheduled task is in flight never resurrects its timer', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  await h.scheduler.start(h.settings);
  h.timers[0].callback();
  await h.scheduler.stop('shutdown');
  release();
  await flush();
  assert.equal(h.timers.length, 1);
});

test('automation IPC exposes a no-argument trigger and preserves review validation', async () => {
  const handlers = new Map();
  const { ipcChannels } = loadTsCommonJs('src/shared/ipc.ts');
  const { registerAutomationIpc } = loadTsCommonJs('src/main/ipc/automationIpc.ts', {
    stubs: { electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } } },
  });
  let runs = 0, approvals = 0;
  registerAutomationIpc({ confirm: () => { approvals++; return true; }, cancel: () => true }, {
    runDailySummaryNow: async () => { runs++; return { started: true }; },
  });
  assert.equal((await handlers.get(ipcChannels.dailySummaryRunNow)({})).started, true);
  assert.equal(runs, 1);
  assert.equal(handlers.get(ipcChannels.dailySummaryConfirm)({}, null, 'text'), false);
  assert.equal(approvals, 0);
});
