import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsCommonJs } from './helpers/loadTsCommonJs.mjs';
const { AssistantResponseCapture } = loadTsCommonJs('src/main/pi/AssistantResponseCapture.ts');
const { inspectDailySummaryCandidate } = loadTsCommonJs('src/main/automation/dailySummaryCandidate.ts');

const message = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason });

test('reasoning containing literal unbalanced tags cannot contaminate structured body', () => {
  const capture = new AssistantResponseCapture();
  const reader = capture.track('a');
  capture.update('a', message([
    { type: 'thinking', thinking: 'SECRET <thinking> <think>' },
    { type: 'text', text: 'Final ' },
    { type: 'toolCall', text: 'NOT BODY', arguments: { private: true } },
    { type: 'text', text: 'summary' },
  ]));
  const response = reader.getResponse();
  assert.equal(response.text, 'Final summary');
  assert.equal(response.textBlocks, 2);
  assert.equal(response.thinkingBlocks, 1);
  assert.equal(response.source, 'structured-text');
  assert.equal(JSON.stringify(response).includes('SECRET'), false);
  const result = inspectDailySummaryCandidate([response]);
  assert.equal(result.ok, true);
  assert.equal(result.summary, 'Final summary');
});

test('empty final body replaces older successful output and is rejected', () => {
  const capture = new AssistantResponseCapture();
  const reader = capture.track('a');
  capture.update('a', message([{ type: 'text', text: 'Older answer' }]));
  capture.update('a', message([{ type: 'thinking', thinking: 'SECRET' }]));
  assert.equal(reader.getResponse().text, '');
  assert.equal(inspectDailySummaryCandidate([reader.getResponse()]).ok, false);
});

test('reset, disposal and agent cleanup do not retain old responses or cross agents', () => {
  const capture = new AssistantResponseCapture();
  const a = capture.track('a'), b = capture.track('b');
  capture.update('a', message([{ type: 'text', text: 'A' }]));
  assert.equal(b.getResponse(), undefined);
  a.reset();
  assert.equal(a.getResponse(), undefined);
  capture.update('a', message([{ type: 'text', text: 'New A' }]));
  a.dispose();
  capture.update('a', message([{ type: 'text', text: 'Late A' }]));
  assert.equal(a.getResponse(), undefined);
  capture.update('b', message([{ type: 'text', text: 'B' }]));
  capture.clear('b');
  assert.equal(b.getResponse(), undefined);
});

test('unknown string content is not mistaken for structured body', () => {
  const capture = new AssistantResponseCapture();
  const reader = capture.track('a');
  capture.update('a', message('Potential reasoning'));
  assert.equal(reader.getResponse().source, 'unavailable');
  assert.equal(reader.getResponse().text, '');
  const result = inspectDailySummaryCandidate([reader.getResponse()]);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.reason, 'structured-body-unavailable');
});

test('thinking tag literals in a structured text block are preserved as body text', () => {
  const capture = new AssistantResponseCapture();
  const reader = capture.track('a');
  capture.update('a', message([{ type: 'text', text: 'Fixed literal `<thinking>` and `<think>` handling' }]));
  const result = inspectDailySummaryCandidate([reader.getResponse()]);
  assert.equal(result.ok, true);
  assert.equal(result.summary, 'Fixed literal `<thinking>` and `<think>` handling');
  assert.equal(result.diagnostics.tagMode, 'literal-text');
  assert.equal(result.diagnostics.tagsBalanced, null);
});

test('length termination remains rejected even with structured body text', () => {
  const capture = new AssistantResponseCapture();
  const reader = capture.track('a');
  capture.update('a', message([{ type: 'text', text: 'Partial' }], 'length'));
  assert.equal(inspectDailySummaryCandidate([reader.getResponse()]).code, 'output-limit');
});
