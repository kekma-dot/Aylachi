import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeProjectContextToolFactory } from './project-context-tools.mjs';

const Type = {
  Object: (properties, options) => ({ properties, options }),
  String: options => ({ type: 'string', ...options }),
};
const connection = Object.freeze({ baseUrl: 'http://127.0.0.1:43127/', bearer: 'x'.repeat(32) });
const binding = () => Object.freeze({ projectId: 'project-1', cardId: 'card-1', sessionId: 'session-1', bazaPrefix: '10 Проекты/Example/' });
const turn = (sessionId = 'session-1', turnId = 'turn-1') => Object.freeze({ sessionId, turnId });
const selection = getTurnContext => Object.freeze({ sessionId: 'session-1', getTurnContext, sdk: {}, cwd: '/tmp/worker', agentDir: '/tmp/agent' });
const response = projectId => ({ projectId, excerpts: [{ path: '10 Проекты/Example/notes.md', text: 'ok' }] });
const make = overrides => createRuntimeProjectContextToolFactory({
  Type, connection, getSessionBinding: () => binding(),
  fetch: async () => { throw new Error('unexpected transport'); }, ...overrides,
});

test('absent connection or trusted binding callback disables the tool', () => {
  assert.deepEqual(createRuntimeProjectContextToolFactory({ Type })(selection(() => turn())), []);
  assert.deepEqual(createRuntimeProjectContextToolFactory({ Type, connection })(selection(() => turn())), []);
});

test('accepts SDK selection fields while tool schema accepts only query', async () => {
  const tool = make()(selection(() => turn()))[0];
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.parameters.properties), ['query']);
  assert.ok(make()({ getTurnContext: () => turn(), sessionId: 'session-1' })[0]);
  await assert.rejects(tool.execute('call', { query: 'x', projectId: 'spoof' }));
});

test('captures the trusted selection binding and disables an unbound selection', async () => {
  const mutable = { projectId: 'project-1', cardId: 'card-1', sessionId: 'session-1', bazaPrefix: '10 Проекты/Example/' };
  const replies = [];
  const factory = make({ getSessionBinding: () => mutable, fetch: async (_url, init) => {
    replies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(response('project-1')), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const tools = factory(selection(() => turn()));
  mutable.projectId = 'other-project';
  await assert.rejects(tools[0].execute('call', { query: 'x' }));
  assert.deepEqual(replies, []);
  assert.deepEqual(make({ getSessionBinding: () => null })(selection(() => turn())), []);
});

test('unfrozen, absent, mismatched, and stale turns fail before fetch', async () => {
  let fetches = 0;
  const factory = make({ fetch: async () => { fetches++; throw new Error('unexpected'); } });
  for (const getTurnContext of [
    () => undefined,
    () => ({ sessionId: 'session-1', turnId: 'turn-1' }),
    () => turn('other', 'turn-1'),
  ]) await assert.rejects(factory(selection(getTurnContext))[0].execute('call', { query: 'x' }));

  let current = turn();
  let bindingReads = 0;
  const stale = make({
    getSessionBinding: () => { if (++bindingReads === 2) current = turn('session-1', 'turn-2'); return binding(); },
    fetch: async () => { fetches++; throw new Error('unexpected'); },
  })(selection(() => current))[0];
  await assert.rejects(stale.execute('call', { query: 'x' }));
  assert.equal(fetches, 0);
});

test('each execute uses its captured current turn as commandId', async () => {
  let current = turn('session-1', 'first');
  const commands = [];
  const tool = make({ fetch: async (_url, init) => {
    commands.push(JSON.parse(init.body).commandId);
    return new Response(JSON.stringify(response('project-1')), { status: 200, headers: { 'content-type': 'application/json' } });
  } })(selection(() => current))[0];
  await tool.execute('call-a', { query: 'x' });
  current = turn('session-1', 'second');
  await tool.execute('call-b', { query: 'x' });
  assert.deepEqual(commands, ['first', 'second']);
});

test('passes abort signal and rejects wrong project replies and sanitized errors', async () => {
  const controller = new AbortController();
  let seenSignal;
  let entered;
  const fetchEntered = new Promise(resolve => { entered = resolve; });
  const tool = make({ fetch: async (_url, init) => {
    seenSignal = init.signal;
    entered();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } })(selection(() => turn()))[0];
  const pending = tool.execute('call', { query: 'x' }, controller.signal);
  await fetchEntered;
  controller.abort();
  await assert.rejects(pending);
  assert.ok(seenSignal);
  assert.equal(seenSignal.aborted, true);

  const wrong = make({ fetch: async () => new Response(JSON.stringify(response('other-project')), { status: 200, headers: { 'content-type': 'application/json' } }) })(selection(() => turn()))[0];
  await assert.rejects(wrong.execute('call', { query: 'x' }));
  const failed = make({ fetch: async () => { throw new Error('secret detail'); } })(selection(() => turn()))[0];
  await assert.rejects(failed.execute('call', { query: 'x' }), error => !error.message.includes('secret detail'));
});

test('connection and option accessors are rejected without invoking getters', () => {
  let invoked = false;
  const connectionWithGetter = { bearer: 'x'.repeat(32), get baseUrl() { invoked = true; return 'http://127.0.0.1:43127/'; } };
  assert.deepEqual(createRuntimeProjectContextToolFactory({ Type, connection: connectionWithGetter, getSessionBinding: () => binding() })(selection(() => turn())), []);
  const optionsWithGetter = { Type, connection, getSessionBinding: () => binding(), get timeoutMs() { invoked = true; return 1000; } };
  assert.deepEqual(createRuntimeProjectContextToolFactory(optionsWithGetter)(selection(() => turn())), []);
  assert.equal(invoked, false);
});
