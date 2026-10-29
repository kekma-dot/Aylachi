import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDelegationStore } from './store.mjs';
import { createDelegationModule } from './hub-routes.mjs';

const ACTOR = 'actor-owner';
const PARENT = Object.freeze({ actor: ACTOR, parentCommandId: 'parent-command', parentCardId: 'parent-card', canvasId: 'canvas-main' });
const TEXT = 'private prompt input';
const timings = { pollIntervalMs: 5, waitTimeoutMs: 100 };

async function fixture(t, { hubOptions = {}, approve = () => true, resolveParent = () => PARENT, projectId = 'project-a' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'delegation-hub-routes-'));
  const path = join(root, 'tasks.sqlite');
  const store = openDelegationStore(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const hub = fakeHub(hubOptions);
  const routes = createDelegationModule({ store, hubClient: hub, projectId, resolveParent, approve, ...timings });
  return { root, path, store, hub, routes };
}

function fakeHub(options = {}) {
  const calls = { createCard: [], sendMessage: [], readCommand: [], cancelCommand: [] };
  const commands = new Map();
  const hub = {
    calls,
    commands,
    async createCard(card, requestId, signal) {
      calls.createCard.push({ card, requestId });
      if (options.createCard) return options.createCard(card, requestId, signal);
      return { card, duplicate: false };
    },
    async sendMessage(cardId, text, requestId, signal) {
      calls.sendMessage.push({ cardId, text, requestId });
      if (options.sendMessage) return options.sendMessage(cardId, text, requestId, signal, commands);
      const command = { id: requestId, state: 'RUNNING', result: null };
      commands.set(requestId, command);
      return { command, duplicate: false };
    },
    async readCommand(id, signal) {
      calls.readCommand.push(id);
      if (options.readCommand) return options.readCommand(id, signal, commands);
      const command = commands.get(id);
      if (!command) throw Object.assign(new Error('synthetic missing'), { status: 404 });
      return { command };
    },
    async cancelCommand(id, requestId, signal) {
      calls.cancelCommand.push({ id, requestId });
      return { command: { id: requestId, state: 'COMPLETED', result: { status: 'accepted' } }, duplicate: false };
    },
  };
  return hub;
}

const postContext = (requestId, text = TEXT, extra = {}) => ({
  actor: ACTOR,
  requestId,
  body: { parentCommandId: PARENT.parentCommandId, requestId, text, ...extra },
});
const byIdContext = id => ({ actor: ACTOR, params: { id }, query: {} });
const byRequestContext = (requestId, parentCommandId = PARENT.parentCommandId) => ({
  actor: ACTOR, params: {}, query: { parentCommandId, requestId },
});
const route = (routes, method, path) => routes.find(item => item.method === method && item.path === path);
async function errorOf(handler, context) {
  try { return await handler(context); }
  catch (error) { return { status: error.status, code: error.code }; }
}

for (const name of ['POST /v1/modules/delegation', 'GET /v1/modules/delegation/:id', 'GET /v1/modules/delegation']) {
  test(`route descriptors are fixed, frozen and scoped: ${name}`, async t => {
    const { routes } = await fixture(t);
    const [method, path] = name.split(' ');
    const item = route(routes, method, path);
    assert.ok(item);
    assert.ok(Object.isFrozen(routes) && Object.isFrozen(item) && Object.isFrozen(item.target));
    assert.deepEqual(item.target, { projectId: 'project-a' });
    assert.equal(item.effect, method === 'POST' ? 'write' : 'read');
    assert.equal(item.operation, method === 'POST' ? 'delegation.delegate' : 'delegation.read');
  });
}

test('constructor rejects absent dependencies, unbounded timing and invalid project scope before effects', async t => {
  const { store, hub } = await fixture(t);
  const valid = { store, hubClient: hub, projectId: 'project-a', resolveParent: () => PARENT, approve: () => true, ...timings };
  for (const bad of [
    { ...valid, store: undefined }, { ...valid, hubClient: undefined },
    { ...valid, resolveParent: undefined }, { ...valid, approve: undefined },
    { ...valid, projectId: '../project' }, { ...valid, pollIntervalMs: 0 },
    { ...valid, waitTimeoutMs: 600_001 },
  ]) assert.throws(() => createDelegationModule(bad), TypeError);
  assert.equal(hub.calls.createCard.length + hub.calls.sendMessage.length, 0);
});

test('accepted delegation returns bounded public IDs; read reconciliation includes child result text only', async t => {
  const { routes, hub } = await fixture(t);
  const post = route(routes, 'POST', '/v1/modules/delegation');
  const created = await post.handle(postContext('request-normal'));
  assert.equal(created.status, 201);
  assert.equal(created.body.duplicate, false);
  assert.deepEqual(Object.keys(created.body.record), [
    'id', 'requestId', 'parentCommandId', 'parentCardId', 'canvasId', 'childCardId', 'childSessionId', 'childCommandId', 'state', 'result',
  ]);
  assert.equal(created.body.record.state, 'DISPATCHED');
  assert.equal(created.body.record.result, null);
  const firstJson = JSON.stringify(created.body);
  for (const secret of [TEXT, ACTOR, 'leaseId', 'cancelRequestId', 'nativeSessionFile']) assert.equal(firstJson.includes(secret), false);

  const childCommand = hub.commands.get(created.body.record.childCommandId);
  childCommand.state = 'COMPLETED';
  childCommand.result = { status: 'ok', text: 'child answer' };
  const get = route(routes, 'GET', '/v1/modules/delegation/:id');
  const reconciled = await get.handle(byIdContext(created.body.record.id));
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.record.state, 'COMPLETED');
  assert.deepEqual(reconciled.body.record.result, { status: 'ok', text: 'child answer' });
  const readByRequest = route(routes, 'GET', '/v1/modules/delegation');
  assert.deepEqual((await readByRequest.handle(byRequestContext('request-normal'))).body, reconciled.body);
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 1);
  assert.equal(hub.calls.cancelCommand.length, 0);
});

test('known unknown POST outcome is explicit HTTP 200 and GET only reconciles without replay', async t => {
  const { routes, store, hub } = await fixture(t, {
    hubOptions: { sendMessage: async () => { throw new Error('raw provider failure /private/native-session'); } },
  });
  const post = route(routes, 'POST', '/v1/modules/delegation');
  const result = await post.handle(postContext('request-unknown'));
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['duplicate', 'outcome', 'record']);
  assert.equal(result.body.outcome, 'unknown');
  assert.equal(result.body.duplicate, false);
  assert.equal(result.body.record.state, 'NEEDS_RECONCILIATION');
  assert.equal(JSON.stringify(result.body).includes('raw provider failure'), false);
  assert.equal(JSON.stringify(result.body).includes('/private/native-session'), false);
  assert.equal(store.findRequest({ actor: ACTOR, requestId: 'request-unknown' }).state, 'NEEDS_RECONCILIATION');

  const readsBefore = hub.calls.readCommand.length;
  const read = await route(routes, 'GET', '/v1/modules/delegation').handle(byRequestContext('request-unknown'));
  assert.equal(read.body.record.state, 'NEEDS_RECONCILIATION');
  assert.equal(hub.calls.readCommand.length, readsBefore + 1);
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 1);
  assert.equal(hub.calls.cancelCommand.length, 0);
});

test('durable request identity prevents sequential replay and changed-payload conflict', async t => {
  const { routes, hub } = await fixture(t);
  const post = route(routes, 'POST', '/v1/modules/delegation');
  const first = await post.handle(postContext('request-dedupe'));
  const duplicate = await post.handle(postContext('request-dedupe'));
  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.record.id, first.body.record.id);
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 1);
  assert.deepEqual(await errorOf(post.handle, postContext('request-dedupe', 'different payload')), { status: 409, code: 'conflict' });
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 1);
});

test('SQLite reservation prevents duplicate dispatch across concurrent module/store instances', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'delegation-race-'));
  const path = join(root, 'tasks.sqlite');
  const firstStore = openDelegationStore(path);
  const secondStore = openDelegationStore(path);
  let releaseCreate;
  let startedCreate;
  const createGate = new Promise(resolve => { releaseCreate = resolve; });
  const createStarted = new Promise(resolve => { startedCreate = resolve; });
  const hub = fakeHub({ createCard: async card => { startedCreate(); await createGate; return { card, duplicate: false }; } });
  const make = store => createDelegationModule({ store, hubClient: hub, projectId: 'project-a', resolveParent: () => PARENT, approve: () => true, ...timings });
  const first = route(make(firstStore), 'POST', '/v1/modules/delegation');
  const second = route(make(secondStore), 'POST', '/v1/modules/delegation');
  t.after(async () => {
    try { releaseCreate(); } catch {}
    firstStore.close(); secondStore.close();
    await rm(root, { recursive: true, force: true });
  });
  const firstRun = first.handle(postContext('request-race'));
  await createStarted;
  const secondResult = await second.handle(postContext('request-race'));
  releaseCreate();
  const firstResult = await firstRun;
  assert.equal(secondResult.body.duplicate, true);
  assert.equal(firstResult.body.duplicate, false);
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 1);
  assert.equal(firstResult.body.record.id, secondResult.body.record.id);
});

test('changed parent identity and denied/missing records share concealed 404', async t => {
  const base = await fixture(t);
  const post = route(base.routes, 'POST', '/v1/modules/delegation');
  const created = await post.handle(postContext('request-owned'));
  const missing = await errorOf(route(base.routes, 'GET', '/v1/modules/delegation/:id').handle, byIdContext('task-missing'));
  const deniedRoutes = createDelegationModule({
    store: base.store, hubClient: base.hub, projectId: 'project-a', resolveParent: () => null, approve: () => true, ...timings,
  });
  const deniedPost = await errorOf(route(deniedRoutes, 'POST', '/v1/modules/delegation').handle, postContext('request-denied'));
  const deniedRead = await errorOf(route(deniedRoutes, 'GET', '/v1/modules/delegation/:id').handle, byIdContext(created.body.record.id));
  const policyDeniedRoutes = createDelegationModule({
    store: base.store, hubClient: base.hub, projectId: 'project-a', resolveParent: () => PARENT, approve: () => false, ...timings,
  });
  const policyDenied = await errorOf(route(policyDeniedRoutes, 'GET', '/v1/modules/delegation/:id').handle, byIdContext(created.body.record.id));
  const wrongParentQuery = await errorOf(route(base.routes, 'GET', '/v1/modules/delegation').handle, byRequestContext('request-owned', 'other-parent'));
  assert.deepEqual(missing, { status: 404, code: 'not_found' });
  assert.deepEqual(deniedPost, missing);
  assert.deepEqual(deniedRead, missing);
  assert.deepEqual(policyDenied, missing);
  assert.deepEqual(wrongParentQuery, missing);
});

test('authorization is re-resolved before effects and again before response after asynchronous dispatch', async t => {
  let allowed = true;
  let resolverActions = [];
  let lastApproval;
  const { routes, store, hub } = await fixture(t, {
    resolveParent: input => { resolverActions.push(input.action); return PARENT; },
    approve: input => { lastApproval = input; return allowed; },
    hubOptions: { sendMessage: async (_card, _text, id, _signal, commands) => {
      commands.set(id, { id, state: 'RUNNING', result: null });
      allowed = false;
      return { command: commands.get(id), duplicate: false };
    } },
  });
  const post = route(routes, 'POST', '/v1/modules/delegation');
  const deniedAfterDispatch = await errorOf(post.handle, postContext('request-revoked'));
  assert.deepEqual(deniedAfterDispatch, { status: 404, code: 'not_found' });
  assert.deepEqual(resolverActions, ['delegate', 'delegate', 'delegate', 'delegate', 'delegate']);
  assert.deepEqual(Object.keys(lastApproval).sort(), ['action', 'context', 'record', 'request']);
  assert.equal(lastApproval.action, 'delegate');
  assert.equal(lastApproval.context.actor, ACTOR);
  assert.equal(lastApproval.request.text, TEXT);
  assert.ok(Object.isFrozen(lastApproval) && Object.isFrozen(lastApproval.context) && Object.isFrozen(lastApproval.record));
  assert.ok(store.findRequest({ actor: ACTOR, requestId: 'request-revoked' }), 'effects and persisted task are retained, not claimed absent');
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 1);
});

test('rechecks policy after createCard resolves; revoked task remains reconcilable and skips sendMessage', { timeout: 5000 }, async t => {
  let allowed = true, releaseCreate, announceCreate;
  const gate = new Promise(resolve => { releaseCreate = resolve; });
  const started = new Promise(resolve => { announceCreate = resolve; });
  const { routes, store, hub } = await fixture(t, {
    approve: () => allowed,
    hubOptions: {
      createCard: async card => { announceCreate(); await gate; return { card, duplicate: false }; },
      sendMessage: async (_cardId, _text, id, _signal, commands) => {
        const command = { id, state: 'RUNNING', result: null };
        commands.set(id, command);
        return { command, duplicate: false };
      },
    },
  });
  t.after(() => releaseCreate());
  const post = route(routes, 'POST', '/v1/modules/delegation');
  const pending = post.handle(postContext('request-revoke-after-card'));
  await started;
  allowed = false;
  releaseCreate();
  const outcome = await pending.then(value => ({ value }), error => ({ error }));
  assert.equal(outcome.error?.status, 404);
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 0);
  const retained = store.findRequest({ actor: ACTOR, requestId: 'request-revoke-after-card' });
  assert.equal(retained.state, 'NEEDS_RECONCILIATION');
  assert.equal(retained.parentCardId, PARENT.parentCardId);
});

test('parent mapping change during createCard await denies the next mutation', async t => {
  let mapping = PARENT;
  const { routes, store, hub } = await fixture(t, {
    resolveParent: ({ actor, parentCommandId }) => ({ actor, parentCommandId, parentCardId: mapping.parentCardId, canvasId: mapping.canvasId }),
    hubOptions: {
      createCard: async card => {
        mapping = { ...PARENT, parentCardId: 'parent-card-reassigned' };
        await Promise.resolve();
        return { card, duplicate: false };
      },
    },
  });
  const result = await errorOf(route(routes, 'POST', '/v1/modules/delegation').handle, postContext('request-parent-remap'));
  assert.deepEqual(result, { status: 404, code: 'not_found' });
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 0);
  const retained = store.findRequest({ actor: ACTOR, requestId: 'request-parent-remap' });
  assert.equal(retained.state, 'NEEDS_RECONCILIATION');
  assert.equal(retained.parentCardId, PARENT.parentCardId);
});

test('read revocation during child HTTP reconciliation suppresses the persisted result', async t => {
  const base = await fixture(t);
  const created = await route(base.routes, 'POST', '/v1/modules/delegation').handle(postContext('request-read-revoke'));
  let allowed = true;
  const command = { id: created.body.record.childCommandId, state: 'COMPLETED', result: { status: 'ok', text: 'private child result' } };
  const readHub = fakeHub({ readCommand: async () => { allowed = false; return { command }; } });
  const readRoutes = createDelegationModule({
    store: base.store, hubClient: readHub, projectId: 'project-a', resolveParent: () => PARENT,
    approve: () => allowed, ...timings,
  });
  assert.deepEqual(await errorOf(route(readRoutes, 'GET', '/v1/modules/delegation/:id').handle, byIdContext(created.body.record.id)), {
    status: 404, code: 'not_found',
  });
  assert.equal(base.store.get({ actor: ACTOR, id: created.body.record.id }).state, 'COMPLETED');
  assert.equal(readHub.calls.readCommand.length, 1);
});

test('strict input validation rejects accessors, symbols, extras and over-byte-limit text before policy or effects', async t => {
  let policyCalls = 0, resolverCalls = 0;
  const { routes, hub } = await fixture(t, {
    resolveParent: () => { resolverCalls++; return PARENT; },
    approve: () => { policyCalls++; return true; },
  });
  const post = route(routes, 'POST', '/v1/modules/delegation');
  const getter = { parentCommandId: PARENT.parentCommandId, requestId: 'request-getter' };
  Object.defineProperty(getter, 'text', { enumerable: true, get() { throw new Error('must not invoke getter'); } });
  const symbol = { parentCommandId: PARENT.parentCommandId, requestId: 'request-symbol', text: TEXT, [Symbol('extra')]: true };
  const hidden = { parentCommandId: PARENT.parentCommandId, requestId: 'request-hidden', text: TEXT };
  Object.defineProperty(hidden, 'secret', { value: true, enumerable: false });
  const exotic = Object.assign(Object.create({ inherited: true }), { parentCommandId: PARENT.parentCommandId, requestId: 'request-exotic', text: TEXT });
  for (const body of [
    { parentCommandId: PARENT.parentCommandId, requestId: 'request-extra', text: TEXT, actor: ACTOR },
    getter, symbol, hidden, exotic,
    { parentCommandId: PARENT.parentCommandId, requestId: 'request-empty', text: '  ' },
    { parentCommandId: PARENT.parentCommandId, requestId: 'request-large', text: 'é'.repeat(8193) },
  ]) {
    const requestId = body.requestId ?? 'request-getter';
    const result = await errorOf(post.handle, { actor: ACTOR, requestId, body });
    assert.equal(result.status, body.requestId === 'request-large' ? 413 : 400);
  }
  assert.equal(policyCalls, 0);
  assert.equal(resolverCalls, 0);
  assert.equal(hub.calls.createCard.length, 0);
  assert.equal(hub.calls.sendMessage.length, 0);

  const exactLimit = await post.handle(postContext('request-limit', 'é'.repeat(8192)));
  assert.equal(exactLimit.status, 201, '16384 UTF-8 bytes are accepted');
  assert.equal(JSON.stringify(exactLimit.body).includes('é'), false, 'input task text is not projected');
});

test('GET validation is exact and strips unsafe transport metadata from child result', async t => {
  const { routes, hub } = await fixture(t);
  const created = await route(routes, 'POST', '/v1/modules/delegation').handle(postContext('request-safe-result'));
  const id = created.body.record.id;
  const getById = route(routes, 'GET', '/v1/modules/delegation/:id');
  assert.deepEqual(await errorOf(getById.handle, { actor: ACTOR, params: { id }, query: { extra: 'x' } }), { status: 400, code: 'invalid_request' });
  const getByRequest = route(routes, 'GET', '/v1/modules/delegation');
  assert.deepEqual(await errorOf(getByRequest.handle, { actor: ACTOR, params: {}, query: { parentCommandId: PARENT.parentCommandId, requestId: 'request-safe-result', actor: ACTOR } }), { status: 400, code: 'invalid_request' });

  const command = hub.commands.get(created.body.record.childCommandId);
  command.state = 'COMPLETED';
  command.result = { status: 'ok', text: 'bounded child answer', nativeSessionFile: '/private/native.session' };
  // Coordinator maps only its own bounded child result shape and deliberately ignores transport metadata.
  const result = await getById.handle(byIdContext(id));
  assert.deepEqual(result.body.record.result, { status: 'ok', text: 'bounded child answer' });
  assert.equal(JSON.stringify(result.body).includes('nativeSessionFile'), false);
  assert.equal(JSON.stringify(result.body).includes('/private/native.session'), false);
  assert.equal(JSON.stringify(result.body).includes(TEXT), false);
});

test('escaped public JSON remains within 64 KiB or fails with static 413', async t => {
  const { routes, hub } = await fixture(t);
  const created = await route(routes, 'POST', '/v1/modules/delegation').handle(postContext('request-output-bound'));
  const command = hub.commands.get(created.body.record.childCommandId);
  command.state = 'COMPLETED';
  command.result = { status: 'ok', text: '\0'.repeat(16 * 1024) };
  assert.deepEqual(await errorOf(route(routes, 'GET', '/v1/modules/delegation/:id').handle, byIdContext(created.body.record.id)), {
    status: 413, code: 'too_large',
  });
});

test('malformed persisted result shape fails closed without exposing raw fields', async t => {
  const { routes, hub, path } = await fixture(t);
  const created = await route(routes, 'POST', '/v1/modules/delegation').handle(postContext('request-corrupt-result'));
  const command = hub.commands.get(created.body.record.childCommandId);
  command.state = 'COMPLETED';
  command.result = { status: 'ok', text: 'safe child output' };
  await route(routes, 'GET', '/v1/modules/delegation/:id').handle(byIdContext(created.body.record.id));
  const db = new DatabaseSync(path);
  try {
    db.prepare('UPDATE delegation_records SET result_json=? WHERE id=?').run(
      JSON.stringify({ status: 'ok', text: 'do not leak', nativeSessionFile: '/private/native.session' }), created.body.record.id,
    );
  } finally { db.close(); }
  assert.deepEqual(await errorOf(route(routes, 'GET', '/v1/modules/delegation/:id').handle, byIdContext(created.body.record.id)), {
    status: 500, code: 'internal_error',
  });
});
