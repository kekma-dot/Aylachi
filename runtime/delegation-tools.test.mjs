import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createRuntimeDelegationToolFactory } from './delegation-tools.mjs';

const baseUrl = 'http://127.0.0.1:46231';
const bearer = 's'.repeat(48);
const Type = {
  Object(properties, options) { return { kind: 'object', properties, options }; },
  String(options) { return { kind: 'string', options }; },
};
const context = (sessionId, turnId) => Object.freeze({ sessionId, turnId });
function record({ id, requestId, parentCommandId, state = 'DISPATCHED', result = null }) {
  return {
    id, requestId, parentCommandId, parentCardId: `parent-card-${parentCommandId}`, canvasId: 'canvas-1',
    childCardId: `child-card-${id}`, childSessionId: `child-session-${id}`, childCommandId: `child-command-${id}`, state, result,
  };
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function factory(fetch, allowSession = () => true, connection = { baseUrl, bearer }, options = {}) {
  return createRuntimeDelegationToolFactory({ Type, connection, allowSession, fetch, timeoutMs: 1000, waitTimeoutMs: 1000, pollIntervalMs: 1, ...options });
}
function expectedRequestId(sessionId, turnId, toolCallId) {
  const digest = createHash('sha256').update(JSON.stringify([sessionId, turnId, toolCallId]), 'utf8').digest('hex');
  return `delegation-${digest}`;
}
function responseForPost(body, task) {
  return json({ record: record({ id: task, requestId: body.requestId, parentCommandId: body.parentCommandId }), duplicate: false }, 201);
}
function makeHub(fetchCalls, { answer = 'child result', postMode, taskIdForBody } = {}) {
  let taskIndex = 0;
  const requests = [];
  const byRequest = new Map();
  const byTask = new Map();
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ method: init.method, path: parsed.pathname, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal });
    fetchCalls?.push(requests.at(-1));
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (postMode === 'unknown') return json({ record: record({ id: 'task-unknown', requestId: body.requestId, parentCommandId: body.parentCommandId, state: 'NEEDS_RECONCILIATION' }), duplicate: false, outcome: 'unknown' }, 200);
      const old = byRequest.get(body.requestId);
      if (old) return json({ record: record({ id: old.taskId, requestId: body.requestId, parentCommandId: body.parentCommandId }), duplicate: true }, 200);
      const taskId = taskIdForBody ? taskIdForBody(body) : `task-${++taskIndex}`;
      byRequest.set(body.requestId, { taskId, body });
      byTask.set(taskId, body);
      return responseForPost(body, taskId);
    }
    const task = parsed.pathname.split('/').at(-1);
    const body = byTask.get(task);
    if (!body) return new Response('', { status: 404 });
    return json({ record: record({ id: task, requestId: body.requestId, parentCommandId: body.parentCommandId, state: 'COMPLETED', result: { status: 'ok', text: answer } }) });
  };
  return { fetch, requests };
}
function select(factoryFn, sessionId, getTurnContext = () => context(sessionId, 'turn-default')) {
  return factoryFn({ sessionId, getTurnContext, sdk: {}, cwd: '/unused', agentDir: '/unused' });
}

 test('missing connection or allowSession disables the factory without effects', () => {
  let allowCalls = 0, fetchCalls = 0;
  const disabledConnection = createRuntimeDelegationToolFactory({ Type, allowSession: () => { allowCalls++; return true; } });
  const disabledPolicy = createRuntimeDelegationToolFactory({ Type, connection: { baseUrl, bearer } });
  assert.deepEqual(select(disabledConnection, 'parent'), []);
  assert.deepEqual(select(disabledPolicy, 'parent'), []);
  assert.equal(allowCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('parent session is enabled only by literal true; child and truthy non-boolean remain disabled', () => {
  const hub = makeHub([]);
  const create = factory(hub.fetch, sessionId => sessionId === 'parent' ? true : sessionId === 'truthy' ? 1 : false);
  assert.equal(select(create, 'parent').length, 1);
  assert.deepEqual(select(create, 'child'), []);
  assert.deepEqual(select(create, 'truthy'), []);
  assert.equal(hub.requests.length, 0);
});

test('concurrent sessions bind each request to its own active turn and forward no model authority', async () => {
  const calls = [];
  const hub = makeHub(calls, { answer: 'ok', taskIdForBody: body => body.parentCommandId.endsWith('A') ? 'task-A' : 'task-B' });
  const create = factory(async (url, init) => { await new Promise(resolve => setTimeout(resolve, 4)); return hub.fetch(url, init); });
  let contextReadsA = 0, contextReadsB = 0;
  const [toolA] = select(create, 'session-a', () => { contextReadsA++; return context('session-a', 'parent-command-A'); });
  const [toolB] = select(create, 'session-b', () => { contextReadsB++; return context('session-b', 'parent-command-B'); });
  const [resultA, resultB] = await Promise.all([
    toolA.execute('sdk-call-a', { text: 'alpha' }),
    toolB.execute('sdk-call-b', { text: 'beta' }),
  ]);
  const posts = calls.filter(call => call.method === 'POST').map(call => call.body);
  assert.equal(contextReadsA, 1);
  assert.equal(contextReadsB, 1);
  assert.deepEqual(posts.map(body => body.parentCommandId).sort(), ['parent-command-A', 'parent-command-B']);
  assert.deepEqual(posts.map(body => body.requestId).sort(), [
    expectedRequestId('session-a', 'parent-command-A', 'sdk-call-a'),
    expectedRequestId('session-b', 'parent-command-B', 'sdk-call-b'),
  ].sort());
  assert.equal(resultA.content[0].text, 'Delegated child task-A: ok');
  assert.equal(resultB.content[0].text, 'Delegated child task-B: ok');
});

test('request identity is stable for the same turn and SDK call, and changes with turn', async () => {
  const calls = [];
  const hub = makeHub(calls);
  let active = context('session-a', 'turn-one');
  const [tool] = select(factory(hub.fetch), 'session-a', () => active);
  await tool.execute('same-sdk-call', { text: 'first' });
  await tool.execute('same-sdk-call', { text: 'first' });
  active = context('session-a', 'turn-two');
  await tool.execute('same-sdk-call', { text: 'third' });
  const posts = calls.filter(call => call.method === 'POST').map(call => call.body);
  assert.deepEqual(posts.map(body => body.requestId), [
    expectedRequestId('session-a', 'turn-one', 'same-sdk-call'),
    expectedRequestId('session-a', 'turn-one', 'same-sdk-call'),
    expectedRequestId('session-a', 'turn-two', 'same-sdk-call'),
  ]);
  assert.deepEqual(posts.map(body => body.parentCommandId), ['turn-one', 'turn-one', 'turn-two']);
});

test('missing, stale, unfrozen, accessor, or mismatched turn context rejects before network', async () => {
  const calls = [];
  const hub = makeHub(calls);
  const invalidContexts = [
    () => undefined,
    () => ({ sessionId: 'session-a', turnId: 'turn-a' }),
    () => context('session-b', 'turn-a'),
    () => { const value = {}; Object.defineProperty(value, 'sessionId', { enumerable: true, get() { throw new Error('no'); } }); Object.defineProperty(value, 'turnId', { enumerable: true, value: 'turn-a' }); return Object.freeze(value); },
  ];
  for (const getTurnContext of invalidContexts) {
    const [tool] = select(factory(hub.fetch), 'session-a', getTurnContext);
    await assert.rejects(tool.execute('sdk-call', { text: 'task' }), error => error.message === 'DELEGATION_BINDING_FAILED');
  }
  let active = context('session-a', 'turn-live');
  const [staleTool] = select(factory(hub.fetch), 'session-a', () => active);
  active = undefined;
  await assert.rejects(staleTool.execute('sdk-call-stale', { text: 'task' }), error => error.message === 'DELEGATION_BINDING_FAILED');
  assert.equal(calls.length, 0);
});

test('model parameters cannot supply parent, session, turn, or request identity', async () => {
  const calls = [];
  const hub = makeHub(calls);
  let contextReads = 0;
  const [tool] = select(factory(hub.fetch), 'session-a', () => { contextReads++; return context('session-a', 'trusted-turn'); });
  await assert.rejects(tool.execute('sdk-call', { text: 'task', parentCommandId: 'attacker', sessionId: 'attacker', turnId: 'attacker', requestId: 'attacker' }), error => error.message === 'INVALID_INPUT');
  assert.equal(contextReads, 1);
  assert.equal(calls.length, 0);
});

test('unknown POST outcome is not retried and exposes no transport credentials', async () => {
  const calls = [];
  const hub = makeHub(calls, { postMode: 'unknown' });
  const [tool] = select(factory(hub.fetch), 'session-a', () => context('session-a', 'trusted-turn'));
  await assert.rejects(tool.execute('sdk-call', { text: 'task' }), error => {
    assert.equal(error.message, 'DELEGATE_OUTCOME_UNKNOWN');
    assert.equal(error.message.includes(bearer), false);
    assert.equal(error.message.includes(baseUrl), false);
    return true;
  });
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.method === 'GET').length, 0);
});

test('completed result is delivered without leaking connection or parent metadata', async () => {
  const calls = [];
  const hub = makeHub(calls, { answer: 'task complete' });
  const [tool] = select(factory(hub.fetch), 'session-a', () => context('session-a', 'parent-command-private'));
  const result = await tool.execute('sdk-call', { text: 'do task' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'Delegated child task-1: task complete' }]);
  assert.deepEqual(result.details, { taskId: 'task-1', childCardId: 'child-card-task-1', childCommandId: 'child-command-task-1' });
  const visible = JSON.stringify(result);
  assert.equal(visible.includes(bearer), false);
  assert.equal(visible.includes(baseUrl), false);
  assert.equal(visible.includes('parent-command-private'), false);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.method === 'GET').length, 1);
});
