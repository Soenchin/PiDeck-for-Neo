import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsCommonJs } from './helpers/loadTsCommonJs.mjs';
const { AgentManager } = loadTsCommonJs('src/main/pi/AgentManager.ts');
const { inspectDailySummaryCandidate } = loadTsCommonJs('src/main/automation/dailySummaryCandidate.ts');

function harness() {
  const manager = new AgentManager(
    () => ({ id: 'project', name: 'Project', path: 'C:/project' }),
    () => null, { get: () => ({}) }, {},
  );
  manager.agents.set('agent', {
    tab: { id: 'agent', projectId: 'project', title: 'Summary', cwd: 'C:/project', status: 'running', createdAt: 1 },
    process: { client: { request: async () => ({ success: true, data: {} }) } },
  });
  return { manager, reader: manager.trackAssistantResponse('agent') };
}
const assistant = (text, thinking = '') => ({ role: 'assistant', stopReason: 'stop', content: [
  { type: 'thinking', thinking }, { type: 'text', text },
] });

test('pi message events keep display projection but automation reads only structured body', () => {
  const { manager, reader } = harness();
  try {
    manager.handlePiEvent('agent', { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
    manager.handlePiEvent('agent', { type: 'message_end', message: assistant('Final summary', 'SECRET <thinking> <think>') });
    const display = manager.getMessages('agent');
    // Reproduces the original false rejection without changing normal chat projection.
    assert.equal(inspectDailySummaryCandidate(display).diagnostics.reason, 'nested-tag');
    const captured = reader.getResponse();
    assert.equal(inspectDailySummaryCandidate([captured]).summary, 'Final summary');
    assert.equal(JSON.stringify(captured).includes('SECRET'), false);
  } finally {
    reader.dispose();
    manager.clearAgentState('agent');
  }
});

test('structured body preserves literal thinking tags from the summary subject', () => {
  const { manager, reader } = harness();
  try {
    const body = '修复每日总结中的 `<thinking>` 与 `<think>` 解析问题';
    manager.handlePiEvent('agent', { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
    manager.handlePiEvent('agent', { type: 'message_end', message: assistant(body, 'Private reasoning') });
    const result = inspectDailySummaryCandidate([reader.getResponse()]);
    assert.equal(result.ok, true);
    assert.equal(result.summary, body);
    assert.equal(result.diagnostics.tagMode, 'literal-text');
  } finally { reader.dispose(); }
});

test('top-level final event replaces prior success even after display identity is cleared', () => {
  const { manager, reader } = harness();
  try {
    manager.handlePiEvent('agent', { type: 'message_end', message: assistant('Earlier answer') });
    assert.equal(reader.getResponse().text, 'Earlier answer');
    manager.handlePiEvent('agent', { type: 'message_end', message: assistant('', 'Only thinking') });
    assert.equal(reader.getResponse().text, '');
    assert.equal(inspectDailySummaryCandidate([reader.getResponse()]).ok, false);
    manager.clearAgentState('agent');
    assert.equal(reader.getResponse(), undefined);
  } finally { reader.dispose(); }
});
