import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsCommonJs } from './helpers/loadTsCommonJs.mjs';

const { extractDailySummaryCandidate } = loadTsCommonJs('src/main/automation/dailySummaryCandidate.ts');
const message = (text, stopReason = 'stop') => ({ role: 'assistant', text, stopReason });

test('review contains only final text after complete thinking blocks', () => {
  assert.equal(extractDailySummaryCandidate([message('<thinking>private analysis</thinking>\n# Summary\n- Decision')]), '# Summary\n- Decision');
  assert.equal(extractDailySummaryCandidate([message('<think>analysis</think>Final')]), 'Final');
});

test('complete plain text is kept unchanged', () => {
  assert.equal(extractDailySummaryCandidate([message('# Summary\n- one\n- two')]), '# Summary\n- one\n- two');
});

for (const reason of ['length', 'error', 'aborted', 'toolUse', 'pending', undefined]) {
  test(`rejects unfinished output (${reason}) rather than offering it for review`, () => {
    assert.throws(() => extractDailySummaryCandidate([{ role: 'assistant', text: 'Partial result', stopReason: reason }]),
      error => error.code === (reason === 'length' ? 'output-limit' : 'incomplete'));
  });
}

for (const text of ['<thinking>analysis', '<thinking>analysis</thinking>', '</thinking>Final', '<think>unfinished</thinking>', '']) {
  test(`rejects missing final answer or malformed thinking: ${text}`, () => {
    assert.throws(() => extractDailySummaryCandidate([message(text)]), error => error.code === 'incomplete');
  });
}

test('never falls back to an earlier answer if the latest assistant failed or is blank', () => {
  assert.throws(() => extractDailySummaryCandidate([message('Previous answer'), message('', 'length')]), error => error.code === 'output-limit');
  assert.throws(() => extractDailySummaryCandidate([message('Previous answer'), message('')]), error => error.code === 'incomplete');
});
