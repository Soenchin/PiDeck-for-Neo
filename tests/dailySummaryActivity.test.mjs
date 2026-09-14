import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadTsCommonJs } from './helpers/loadTsCommonJs.mjs';

const { SessionScanner } = loadTsCommonJs('src/main/sessions/SessionScanner.ts', {
  stubs: { electron: { app: { getPath: () => tmpdir() }, shell: {} } },
});
const { DailySummaryTask } = loadTsCommonJs('src/main/automation/DailySummaryTask.ts');

// Exercise the real scanner-to-task boundary: ISO dates used to become NaN and silently remove every message.
test('daily summary counts ISO-dated messages and waits for review before saving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daily-activity-'));
  try {
    const filePath = join(directory, 'session.jsonl');
    const now = Date.now();
    await writeFile(filePath, JSON.stringify({ type: 'message', timestamp: new Date(now).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'A lasting project decision' }], timestamp: now },
    }) + '\n');
    const scanner = new SessionScanner();
    const messages = await scanner.readMessages(filePath);
    assert.equal(messages[0].timestamp, now);
    const sends = [];
    let stopped = false;
    const logs = [];
    const task = new DailySummaryTask({ enabled: true, time: '23:55', minTurns: 1 }, {
      list: async () => [{ filePath, updatedAt: now }],
      readMessages: path => scanner.readMessages(path),
    }, { create: async () => ({
      send: async prompt => { sends.push(prompt); },
      waitForSettled: async () => {},
      getAssistantResponse: () => ({ role: 'assistant', text: 'Candidate', stopReason: 'stop', source: 'structured-text', textBlocks: 1, thinkingBlocks: 0, thinkingCharacters: 0 }),
      stop: async () => { stopped = true; },
    }) }, async request => {
      assert.equal(request.summary, 'Candidate');
      assert.equal(sends.length, 1, 'no save before approval');
      return null;
    }, { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) });
    await task.execute();
    assert.equal(sends.length, 1, 'cancel must not save');
    assert.ok(stopped);
    assert.ok(logs.some(row => row[1] === 'Daily summary candidate is ready for review'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
