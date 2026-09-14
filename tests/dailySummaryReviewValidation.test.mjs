import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsCommonJs } from './helpers/loadTsCommonJs.mjs';
const { DailySummaryTask } = loadTsCommonJs('src/main/automation/DailySummaryTask.ts');
const { AssistantResponseCapture } = loadTsCommonJs('src/main/pi/AssistantResponseCapture.ts');

function harness(text, stopReason, thinking = '') {
  const now = Date.now();
  const capture = new AssistantResponseCapture();
  const reader = capture.track('fixture');
  capture.update('fixture', { content: [
    { type: 'thinking', thinking }, { type: 'text', text },
  ], stopReason });
  const reviews = [], sends = [], logs = [];
  let stopped = false;
  const task = new DailySummaryTask({ enabled: true, time: '23:55', minTurns: 1 }, {
    list: async () => [{ filePath: 'fixture', updatedAt: now }],
    readMessages: async () => [{ role: 'user', content: 'Decision', timestamp: now }],
  }, { create: async () => ({
    send: async p => sends.push(p), waitForSettled: async () => {},
    getAssistantResponse: reader.getResponse,
    stop: async () => { stopped = true; },
  }) }, async r => { reviews.push(r); return null; }, { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) });
  return { task, reviews, sends, logs, stopped: () => stopped };
}
test('task reviews structured body despite malformed tag literals inside reasoning', async () => {
  const h = harness('Final summary', 'stop', 'SECRET <think> <thinking>');
  await h.task.execute();
  assert.equal(h.reviews[0].summary, 'Final summary');
  const detail = h.logs.find(([, event]) => event === 'Daily summary candidate structure')[2];
  assert.equal(detail.source, 'structured-text');
  assert.equal(detail.thinkingBlocks, 1);
  assert.equal(detail.thinkingCharacters, 'SECRET <think> <thinking>'.length);
  assert.equal(detail.openingTags, 0);
  assert.equal(detail.textBlocks, 1);
  assert.equal(JSON.stringify(h.logs).includes('SECRET'), false);
});

test('task preserves thinking-looking literals inside structured body text', async () => {
  const body = '修复 `<thinking>`、`<think>` 与未闭合 <thinking> 字样';
  const h = harness(body, 'stop');
  await h.task.execute();
  assert.equal(h.reviews[0].summary, body);
  const detail = h.logs.find(([, event]) => event === 'Daily summary candidate structure')[2];
  assert.equal(detail.stage, 'accepted');
  assert.equal(detail.tagMode, 'literal-text');
  assert.equal(detail.tagsBalanced, null);
  assert.equal(detail.openingTags, 3);
  assert.equal(detail.remainingCharacters, body.length);
  assert.equal(JSON.stringify(h.logs).includes(body), false);
  assert.equal(h.sends.length, 1);
  assert.ok(h.stopped());
});

test('structured empty body is rejected with safe diagnostics', async () => {
  const h = harness('   ', 'stop', 'SECRET');
  await assert.rejects(h.task.execute(), error => error.code === 'incomplete');
  const detail = h.logs.find(([, event]) => event === 'Daily summary candidate structure')[2];
  assert.equal(detail.stage, 'final-body');
  assert.equal(detail.reason, 'empty-body');
  assert.equal(detail.remainingCharacters, 0);
  assert.equal(JSON.stringify(h.logs).includes('SECRET'), false);
  assert.equal(h.reviews.length, 0);
});

test('unfinished structured body is rejected before review', async () => {
  const h = harness('Partial BODY', 'custom-SECRET');
  await assert.rejects(h.task.execute(), error => error.code === 'incomplete');
  const detail = h.logs.find(([, event]) => event === 'Daily summary candidate structure')[2];
  assert.equal(detail.stage, 'completion');
  assert.equal(detail.reason, 'unfinished-response');
  assert.equal(detail.stopReason, 'unknown');
  assert.equal(JSON.stringify(h.logs).includes('BODY'), false);
  assert.equal(JSON.stringify(h.logs).includes('SECRET'), false);
  assert.equal(h.reviews.length, 0);
});

test('truncated task output is never sent for review or memory save', async () => {
  const h = harness('Partial answer', 'length');
  await assert.rejects(h.task.execute(), e => e.code === 'output-limit');
  assert.equal(h.reviews.length, 0);
  assert.equal(h.sends.length, 1);
  assert.ok(h.stopped());
});
