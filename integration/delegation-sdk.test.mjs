import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createPiAdapter } from '../agent-host/pi-adapter.mjs';
import { sdk, Type, model, runtime } from '../agent-host/tests/fixture-runtime.mjs';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { openDelegationStore } from '../delegation/store.mjs';
import { createDelegationCoordinator } from '../delegation/coordinator.mjs';
import { createDelegationTool } from '../delegation/tool.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, done, name) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await delay(10);
  }
  throw new Error(`FIXTURE_TIMEOUT_${name}`);
}
function parentContext(store, card, commandId) {
  const command = store.getCommand(commandId);
  assert.equal(command?.cardId, card.id);
  assert.equal(command.state, 'RUNNING');
  return { actor: 'fixture-owner', parentCommandId: commandId, parentCardId: card.id, canvasId: card.canvasId };
}
function options(store, runner, resolveTarget) {
  const writes = new Set(['card.create', 'session.message', 'command.cancel']);
  return {
    store, runner, bearerSecret: 'synthetic-delegation-fixture-only-not-an-account-secret',
    authContext: { principalId: 'fixture-owner', expiresAt: 2000, revoked: false,
      grants: ['card.create', 'session.message', 'command.cancel', 'card.read', 'card.list', 'command.read', 'snapshot.read', 'events.read']
        .map(operation => ({ effect: 'allow', permission: writes.has(operation) ? 'write' : 'read', operation, projectId: 'fixture-project' })) },
    now: () => 1,
    resolveTarget: resolveTarget ?? (({ card, input }) => ({ projectId: 'fixture-project', cardId: card?.id ?? input.id, sessionId: card?.sessionId ?? input.sessionId })),
  };
}
function clientFor(address, fetchImpl) {
  return createHubClient({ baseUrl: `http://127.0.0.1:${address.port}`,
    bearer: 'synthetic-delegation-fixture-only-not-an-account-secret', ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

test('actual Pi parent tool delegates through the existing Hub to a separate Pi session and receives the child result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-delegation-sdk-'));
  let hub, store, tasks, parentAdapter, childAdapter;
  const contexts = new AsyncLocalStorage();
  const childRequestId = createHash('sha256').update(JSON.stringify(['parent-command', 'call-1'])).digest('hex');
  const modelContexts = [];
  const posts = [];
  let childEffects = 0, coordinator;
  try {
    const cwd = join(root, 'workspace'); await mkdir(cwd);
    store = openStore(join(root, 'hub.sqlite'));
    tasks = openDelegationStore(join(root, 'tasks.sqlite'));
    const parent = store.createCard({ id: 'parent-card', canvasId: 'delegation-canvas', sessionId: 'parent-session', title: 'Parent', x: 0, y: 0 });
    const parentRuntime = runtime({ toolName: 'delegate_task' });
    const observedRuntime = { ...parentRuntime, streamSimple(...args) {
      modelContexts.push({ messages: structuredClone(args[1].messages) });
      return parentRuntime.streamSimple(...args);
    } };
    const delegationTool = createDelegationTool({ Type,
      coordinator: { delegate: (...args) => coordinator.delegate(...args), wait: (...args) => coordinator.wait(...args) },
      requestIdForCall: callId => createHash('sha256').update(JSON.stringify([contexts.getStore().commandId, callId])).digest('hex'),
    });
    parentAdapter = createPiAdapter({ sdk, modelRuntime: observedRuntime, model, cwd, root: join(root, 'parent-pi'), toolDefinitions: [delegationTool] });
    childAdapter = createPiAdapter({ sdk, modelRuntime: runtime(), model, cwd, root: join(root, 'child-pi'), toolDefinitions: [{
      name: 'fixture_echo', label: 'Harmless child fixture', description: 'One harmless synthetic effect; no external host capabilities.',
      parameters: Type.Object({ text: Type.String() }),
      async execute() { childEffects++; return { content: [{ type: 'text', text: 'child-safe-effect' }] }; },
    }] });
    const runner = async ({ commandId, card, input, signal }) => {
      const adapter = card.id === parent.id ? parentAdapter : childAdapter;
      if (card.id !== parent.id) {
        const task = tasks.findRequest({ actor: 'fixture-owner', requestId: childRequestId });
        assert.equal(task?.childCardId, card.id);
        assert.equal(task.childSessionId, card.sessionId);
        assert.equal(task.childCommandId, commandId);
      }
      const abort = () => { void adapter.cancel(card.sessionId); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await contexts.run({ card, commandId }, () => adapter.prompt(card.sessionId, input.text));
        return { text: result.text }; // Native-session paths never enter Hub results.
      } finally { signal.removeEventListener('abort', abort); }
    };
    hub = createHub(options(store, runner));
    const address = await hub.listen();
    const client = clientFor(address, async (url, init) => {
      if (init.method === 'POST') posts.push(new URL(url).pathname);
      return fetch(url, init);
    });
    coordinator = createDelegationCoordinator({ store: tasks, hubClient: client,
      getParentContext() {
        const active = contexts.getStore();
        assert.ok(active, 'parent identity must come from the trusted server runner, not tool arguments');
        return parentContext(store, active.card, active.commandId);
      },
      approve: ({ parent: context }) => context.actor === 'fixture-owner' && context.parentCardId === parent.id,
      pollIntervalMs: 5, waitTimeoutMs: 5000,
    });
    const receipt = await client.sendMessage(parent.id, 'Delegate the safe synthetic fixture task.', 'parent-command');
    assert.equal(receipt.duplicate, false);
    const completedParent = await until(() => store.getCommand('parent-command'), value => value?.state !== 'RUNNING', 'PARENT');
    assert.equal(completedParent.state, 'COMPLETED');
    assert.equal(completedParent.result.status, 'ok');
    const task = tasks.findRequest({ actor: 'fixture-owner', requestId: childRequestId });
    assert.equal(task.state, 'COMPLETED');
    assert.equal(task.result.text, 'fixture complete');
    assert.notEqual(task.childSessionId, parent.sessionId);
    assert.equal(store.getCard(task.childCardId).sessionId, task.childSessionId);
    assert.equal(store.getCommand(task.childCommandId).state, 'COMPLETED');
    assert.equal(childEffects, 1);
    const receivedResults = modelContexts.flatMap(context => context.messages).filter(message => message.role === 'toolResult');
    assert.ok(receivedResults.some(message => message.toolName === 'delegate_task'), 'the actual SDK must execute the registered product tool, not a fixture alias');
    assert.ok(JSON.stringify(receivedResults).includes(`Delegated child ${task.id}: fixture complete`), 'actual parent model context must receive the child result');
    const childPosts = posts.filter(path => path === `/v1/cards/${task.childCardId}/messages`).length;
    assert.equal(childPosts, 1);
    const duplicate = await client.sendMessage(parent.id, 'Delegate the safe synthetic fixture task.', 'parent-command');
    assert.equal(duplicate.duplicate, true);
    assert.equal(childEffects, 1);
    assert.equal(posts.filter(path => path === `/v1/cards/${task.childCardId}/messages`).length, childPosts);
    tasks.close(); tasks = openDelegationStore(join(root, 'tasks.sqlite'));
    assert.deepEqual(tasks.get({ actor: 'fixture-owner', id: task.id }), task, 'task/lease/parent/child mapping and terminal result survive reopening');
    assert.equal(tasks.get({ actor: 'other-owner', id: task.id }), null);
  } finally {
    await hub?.shutdown({ abortActive: true });
    await Promise.all([parentAdapter?.shutdown(), childAdapter?.shutdown()]);
    tasks?.close(); store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('real HTTP committed lost child receipt reconciles without replay; denied delegation has no state or HTTP effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-delegation-lost-'));
  let store, tasks, hub;
  let effects = 0, lost = false, allowed = false;
  const mutations = [];
  try {
    store = openStore(join(root, 'hub.sqlite')); tasks = openDelegationStore(join(root, 'tasks.sqlite'));
    const parent = store.createCard({ id: 'parent-card', canvasId: 'canvas', sessionId: 'parent-session', title: 'Parent', x: 0, y: 0 });
    store.reserveCommand({ id: 'parent-command', cardId: parent.id, input: { operation: 'session.message', text: 'fixture parent scope' } });
    hub = createHub(options(store, async () => { effects++; return { text: 'child result retained on server' }; }));
    const address = await hub.listen();
    const client = clientFor(address, async (url, init) => {
      const path = new URL(url).pathname;
      if (init.method === 'POST') mutations.push(path);
      const response = await fetch(url, init);
      if (!lost && init.method === 'POST' && path.endsWith('/messages')) {
        lost = true;
        assert.equal(response.status, 202);
        await response.body.cancel();
        throw new Error('synthetic committed response loss');
      }
      return response;
    });
    const coordinator = createDelegationCoordinator({ store: tasks, hubClient: client,
      getParentContext: () => parentContext(store, parent, 'parent-command'),
      approve: () => allowed, pollIntervalMs: 5, waitTimeoutMs: 5000,
    });
    await assert.rejects(coordinator.delegate({ requestId: 'denied', text: 'must not run' }));
    assert.equal(tasks.findRequest({ actor: 'fixture-owner', requestId: 'denied' }), null);
    assert.deepEqual(mutations, []);
    allowed = true;
    await assert.rejects(coordinator.delegate({ requestId: 'lost-request', text: 'one child task' }));
    const uncertain = tasks.findRequest({ actor: 'fixture-owner', requestId: 'lost-request' });
    assert.equal(uncertain.state, 'NEEDS_RECONCILIATION');
    await until(() => store.getCommand(uncertain.childCommandId), command => command?.state === 'COMPLETED', 'LOST_CHILD');
    const before = [...mutations];
    const reconciled = await coordinator.reconcile(uncertain.id);
    assert.equal(reconciled.state, 'COMPLETED');
    assert.equal(reconciled.result.text, 'child result retained on server');
    const duplicate = await coordinator.delegate({ requestId: 'lost-request', text: 'one child task' });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record.id, uncertain.id);
    assert.deepEqual(mutations, before);
    assert.equal(effects, 1);
    tasks.close(); tasks = openDelegationStore(join(root, 'tasks.sqlite'));
    assert.equal(tasks.get({ actor: 'fixture-owner', id: uncertain.id }).state, 'COMPLETED');
  } finally {
    await hub?.shutdown({ abortActive: true });
    tasks?.close(); store?.close();
    await rm(root, { recursive: true, force: true });
  }
});


test('in-flight sharing cannot cross parent identity or collide on colon-containing actor/request tuples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-delegation-scope-'));
  const tasks = openDelegationStore(join(root, 'tasks.sqlite'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const contexts = new AsyncLocalStorage();
  let creates = 0;
  const coordinator = createDelegationCoordinator({ store: tasks,
    hubClient: {
      async createCard(card) { creates++; await gate; return { card: { ...card, revision: 1 }, duplicate: false }; },
      async sendMessage(_card, _text, id) { return { command: { id, state: 'RUNNING' }, duplicate: false }; },
      async readCommand() { throw new Error('not needed'); },
      async cancelCommand() { throw new Error('not needed'); },
    },
    getParentContext: () => contexts.getStore(), approve: () => true,
    pollIntervalMs: 5, waitTimeoutMs: 1000,
  });
  const context = (actor, parentCommandId) => ({ actor, parentCommandId, parentCardId: 'parent-card', canvasId: 'canvas' });
  const run = (scope, requestId) => contexts.run(scope, () => coordinator.delegate({ requestId, text: 'same text' }));
  try {
    const first = run(context('same-actor', 'parent-A'), 'same-request');
    const otherParent = run(context('same-actor', 'parent-B'), 'same-request');
    const parentOutcome = otherParent.then(() => 'INCORRECT_SHARED_PARENT', error => error.code);
    const colonA = run(context('a:b', 'parent-C'), 'c');
    const colonB = run(context('a', 'parent-D'), 'b:c');
    release();
    const [a, b, c] = await Promise.all([first, colonA, colonB]);
    assert.equal(await parentOutcome, 'CONFLICT', 'same request from a different parent must not share the active task');
    assert.notEqual(b.record.id, c.record.id, 'colon tuples are distinct identities');
    assert.equal(b.record.actor, 'a:b'); assert.equal(c.record.actor, 'a');
    assert.equal(creates, 3);
    assert.equal(a.record.parentCommandId, 'parent-A');
  } finally { release(); tasks.close(); await rm(root, { recursive: true, force: true }); }
});

test('real HTTP reconciliation handles RESERVED crash windows and UTF8-bounded completed results without POSTs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-delegation-observe-'));
  let store, tasks, hub;
  const mutations = [];
  try {
    store = openStore(join(root, 'hub.sqlite')); tasks = openDelegationStore(join(root, 'tasks.sqlite'));
    const parent = store.createCard({ id: 'parent-card', canvasId: 'canvas', sessionId: 'parent-session', title: 'Parent', x: 0, y: 0 });
    store.reserveCommand({ id: 'parent-command', cardId: parent.id, input: { operation: 'session.message', text: 'fixture parent' } });
    hub = createHub(options(store, async () => { throw new Error('MUST_NOT_DISPATCH'); }));
    const client = clientFor(await hub.listen(), async (url, init) => {
      if (init.method === 'POST') mutations.push(new URL(url).pathname);
      return fetch(url, init);
    });
    const coordinator = createDelegationCoordinator({ store: tasks, hubClient: client,
      getParentContext: () => parentContext(store, parent, 'parent-command'), approve: () => true,
      pollIntervalMs: 5, waitTimeoutMs: 1000,
    });
    const incomplete = [];
    for (const [requestId, text, dispatched] of [['crash-window', 'already completed', false], ['unicode-result', '界'.repeat(8000), true]]) {
      const { record } = tasks.reserve({ ...parentContext(store, parent, 'parent-command'), requestId, text: 'one task', now: Date.now() });
      store.createCard({ id: record.childCardId, canvasId: record.canvasId, sessionId: record.childSessionId, title: 'Child', x: 0, y: 0 });
      store.reserveCommand({ id: record.childCommandId, cardId: record.childCardId, input: { operation: 'session.message', text: record.text } });
      store.completeCommand(record.childCommandId, { status: 'ok', value: { text } });
      if (dispatched) tasks.transition({ actor: record.actor, id: record.id, expectedState: 'RESERVED', nextState: 'DISPATCHED', now: Date.now() });
      const completed = await coordinator.reconcile(record.id);
      if (completed.state !== 'COMPLETED') { incomplete.push({ requestId, actualState: completed.state }); continue; }
      assert.equal(completed.result.status, 'ok');
      assert.ok(Buffer.byteLength(completed.result.text) <= 16 * 1024, 'result must fit the store UTF8 byte boundary');
      assert.ok(completed.result.text.length > 0);
      assert.equal(text.startsWith(completed.result.text), true);
      assert.equal(completed.result.text.includes('\ufffd'), false, 'byte truncation must preserve code points');
    }
    assert.deepEqual(incomplete, [], 'authoritatively completed children must settle even across crash/Unicode boundaries');
    assert.deepEqual(mutations, [], 'authoritative reconciliation must not replay any POST');
  } finally {
    await hub?.shutdown({ abortActive: true }); tasks?.close(); store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent authoritative observations resolve actual SQLite CONFLICT; validation errors still propagate', async () => {
  const tasks = openDelegationStore(':memory:');
  const scope = { actor: 'owner', parentCommandId: 'parent-command', parentCardId: 'parent-card', canvasId: 'canvas' };
  const { record } = tasks.reserve({ ...scope, requestId: 'request', text: 'task', now: 1 });
  tasks.transition({ actor: scope.actor, id: record.id, expectedState: 'RESERVED', nextState: 'NEEDS_RECONCILIATION', now: 2 });
  const reads = [];
  let posts = 0;
  const client = {
    createCard() { posts++; throw new Error('UNEXPECTED_POST'); },
    sendMessage() { posts++; throw new Error('UNEXPECTED_POST'); },
    cancelCommand() { posts++; throw new Error('UNEXPECTED_POST'); },
    readCommand() { return new Promise(resolve => reads.push(resolve)); },
  };
  const coordinator = createDelegationCoordinator({ store: tasks, hubClient: client,
    getParentContext: () => scope, approve: () => true, now: () => 3, pollIntervalMs: 1, waitTimeoutMs: 100,
  });
  try {
    const first = coordinator.reconcile(record.id);
    const second = coordinator.reconcile(record.id);
    await Promise.resolve(); // Read adapters may be invoked in a protected microtask.
    assert.equal(reads.length, 2);
    reads[0]({ command: { id: record.childCommandId, state: 'RUNNING' } });
    await first;
    reads[1]({ command: { id: record.childCommandId, state: 'COMPLETED', result: { status: 'ok', text: 'done' } } });
    const raced = await second;
    assert.ok(['DISPATCHED', 'COMPLETED'].includes(raced.state), 'a lost CAS must return authoritative state, not throw');
    const final = coordinator.reconcile(record.id);
    await Promise.resolve();
    reads[2]({ command: { id: record.childCommandId, state: 'COMPLETED', result: { status: 'ok', text: 'done' } } });
    assert.equal((await final).state, 'COMPLETED');
    assert.equal(posts, 0);

    const { record: invalidClock } = tasks.reserve({ ...scope, requestId: 'clock-request', text: 'task', now: 4 });
    tasks.transition({ actor: scope.actor, id: invalidClock.id, expectedState: 'RESERVED', nextState: 'NEEDS_RECONCILIATION', now: 5 });
    const invalid = coordinator.reconcile(invalidClock.id);
    await Promise.resolve();
    reads[3]({ command: { id: invalidClock.childCommandId, state: 'RUNNING' } });
    await assert.rejects(invalid, error => error.code === 'INVALID_REQUEST', 'store validation failures must not be treated as benign CAS races');
    assert.equal(tasks.get({ actor: scope.actor, id: invalidClock.id }).state, 'NEEDS_RECONCILIATION');
  } finally { tasks.close(); }
});

test('coordinator rejects malformed receipts/exotic inputs and bounds hung reads with a constant store clock', async () => {
  const scope = { actor: 'owner', parentCommandId: 'parent-command', parentCardId: 'parent-card', canvasId: 'canvas' };
  const tasks = openDelegationStore(':memory:');
  let sends = 0, approvals = 0;
  const client = {
    async createCard(card) { return { card: { ...card, revision: 1 }, duplicate: false }; },
    async sendMessage() { sends++; return {}; },
    async readCommand() { return new Promise(() => {}); }, // Deliberately ignores AbortSignal.
    async cancelCommand() { throw new Error('UNEXPECTED_CANCEL'); },
  };
  const make = hubClient => createDelegationCoordinator({ store: tasks, hubClient,
    getParentContext: () => scope, approve() { approvals++; return true; }, now: () => 3,
    pollIntervalMs: 1, waitTimeoutMs: 30,
  });
  const coordinator = make(client);
  try {
    for (const key of ['hidden', Symbol('extra')]) {
      const input = { requestId: 'invalid-extras', text: 'task' };
      Object.defineProperty(input, key, { value: true, enumerable: false });
      await assert.rejects(coordinator.delegate(input), error => error.code === 'INVALID_INPUT');
    }
    assert.equal(approvals, 0, 'invalid own properties must be rejected before policy or effects');
    await assert.rejects(coordinator.delegate({ requestId: 'bad-ack', text: 'task' }), error => error.code === 'DELEGATE_OUTCOME_UNKNOWN');
    assert.equal(tasks.findRequest({ actor: scope.actor, requestId: 'bad-ack' }).state, 'NEEDS_RECONCILIATION');
    assert.equal(sends, 1);
    const wrongCard = make({ ...client, async createCard(card) { return { card: { ...card, sessionId: 'foreign-session' }, duplicate: false }; } });
    await assert.rejects(wrongCard.delegate({ requestId: 'bad-card', text: 'task' }), error => error.code === 'DELEGATE_OUTCOME_UNKNOWN');
    assert.equal(sends, 1, 'a mismatched child card mapping must not dispatch a message');

    const { record } = tasks.reserve({ ...scope, requestId: 'hung-child', text: 'task', now: 1 });
    tasks.transition({ actor: scope.actor, id: record.id, expectedState: 'RESERVED', nextState: 'DISPATCHED', now: 2 });
    let timer;
    const bounded = async promise => {
      try { return await Promise.race([promise.then(() => 'UNEXPECTED_SUCCESS', error => error.code), new Promise(resolve => { timer = setTimeout(() => resolve('UNBOUNDED_READ'), 500); })]); }
      finally { clearTimeout(timer); }
    };
    assert.equal(await bounded(coordinator.wait(record.id)), 'WAIT_TIMEOUT', 'constant wallclock and hung read must not disable the wait deadline');
    const abort = new AbortController();
    const waiting = coordinator.wait(record.id, { signal: abort.signal });
    setTimeout(() => abort.abort(), 5);
    assert.equal(await bounded(waiting), 'ABORTED', 'abort while a read is pending must settle promptly');
    assert.equal(tasks.get({ actor: scope.actor, id: record.id }).state, 'DISPATCHED');
    assert.equal(sends, 1, 'timeouts/aborts must not send, replay, or cancel child work');
  } finally { tasks.close(); }
});
