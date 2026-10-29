import assert from 'node:assert/strict';
import test from 'node:test';
import { createDelegationTool } from './tool.mjs';
const Type = { String: options => ({ type: 'string', ...options }), Object: (properties, options) => ({ type: 'object', properties, ...options }) };
const completed = { id: 'task-1', childCardId: 'child-card', childCommandId: 'child-command', state: 'COMPLETED', result: { status: 'ok', text: 'child answer' } };

test('optional tool binds stable trusted request identity, executes once, and returns bounded coordinator result', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const tool = createDelegationTool({ Type, requestIdForCall: call => `parent-${call}`, coordinator: {
    async delegate(input, options) { calls.push(['delegate', input, options.signal]); return { record: { id: completed.id }, duplicate: false }; },
    async wait(id, options) { calls.push(['wait', id, options.signal]); return completed; },
  } });
  assert.equal(tool.name, 'delegate_task');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(calls, [], 'registration is inert');
  const result = await tool.execute('call-1', { text: 'bounded task' }, signal);
  assert.deepEqual(calls, [['delegate', { requestId: 'parent-call-1', text: 'bounded task' }, signal], ['wait', 'task-1', signal]]);
  assert.equal(result.content[0].text, 'Delegated child task-1: child answer');
  assert.deepEqual(result.details, { taskId: 'task-1', childCardId: 'child-card', childCommandId: 'child-command' });
});

test('missing bindings and malformed model arguments fail before effects', async () => {
  assert.throws(() => createDelegationTool({ Type }), /EXPLICIT_DELEGATION_BINDING_REQUIRED/);
  let effects = 0;
  const tool = createDelegationTool({ Type, requestIdForCall: () => 'trusted-request', coordinator: {
    async delegate() { effects++; }, async wait() { effects++; },
  } });
  const getter = Object.defineProperty({}, 'text', { enumerable: true, get() { throw new Error('GETTER_MUST_NOT_RUN'); } });
  for (const input of [null, [], {}, { text: '' }, { text: 'task', requestId: 'model-selected' }, getter, { text: '界'.repeat(6000) }]) {
    await assert.rejects(tool.execute('call-1', input), /INVALID_INPUT/);
  }
  assert.equal(effects, 0);
});

test('raw injected failures and unsuccessful child results are never presented as success', async () => {
  const make = (coordinator, resolver = () => 'request') => createDelegationTool({ Type, coordinator, requestIdForCall: resolver });
  const raw = make({ async delegate() { throw new Error('https://private.invalid/?token=synthetic-sensitive'); }, async wait() {} });
  await assert.rejects(raw.execute('call', { text: 'task' }), error => error.message === 'DELEGATION_FAILED');
  const known = make({ async delegate() { throw Object.assign(new Error('raw detail'), { code: 'POLICY_DENIED' }); }, async wait() {} });
  await assert.rejects(known.execute('call', { text: 'task' }), error => error.message === 'POLICY_DENIED');
  const cancelled = make({ async delegate() { return { record: completed }; }, async wait() { return { ...completed, result: { status: 'cancelled' } }; } });
  await assert.rejects(cancelled.execute('call', { text: 'task' }), /CHILD_CANCELLED/);
  const badBinding = make({ async delegate() { throw new Error('MUST_NOT_RUN'); }, async wait() {} }, () => { throw new Error('raw binding detail'); });
  await assert.rejects(badBinding.execute('call', { text: 'task' }), /DELEGATION_BINDING_FAILED/);
});
