import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { openDelegationStore } from '../delegation/store.mjs';
import { createDelegationModule } from '../delegation/hub-routes.mjs';

const token = 'public-synthetic-delegation-http-fixture-not-a-credential';
const owner = 'fixture-owner', projectId = 'fixture-project', canvasId = 'fixture-canvas';
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

test('optional delegation module uses actual Hub/SQLite with trusted running parent, durable child result and no replay', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-delegation-http-parent-'));
  let core, tasks, hub, client, effects = 0, permit = true, lost = false;
  const childPosts = [];
  try {
    core = openStore(join(root, 'core.sqlite'));
    tasks = openDelegationStore(join(root, 'tasks.sqlite'));
    const parent = core.createCard({ id: 'parent-card', sessionId: 'parent-session', canvasId, title: 'Parent', x: 0, y: 0 });
    core.reserveCommand({ id: 'parent-command', cardId: parent.id, input: { operation: 'session.message', text: 'fixture parent' } });
    const readParent = ({ actor, parentCommandId, action }) => {
      const command = core.getCommand(parentCommandId);
      const card = command && core.getCard(command.cardId);
      if (!permit || actor !== owner || !card || card.id !== parent.id || card.canvasId !== canvasId || card.sessionId !== parent.sessionId || (action === 'delegate' && command.state !== 'RUNNING')) return null;
      return { actor, parentCommandId, parentCardId: card.id, canvasId: card.canvasId };
    };
    const bridge = {
      createCard: (...args) => client.createCard(...args),
      sendMessage: (...args) => client.sendMessage(...args),
      readCommand: (...args) => client.readCommand(...args),
      cancelCommand: () => { throw new Error('UNEXPECTED_CANCEL'); },
    };
    const routes = createDelegationModule({ store: tasks, hubClient: bridge, projectId, resolveParent: readParent,
      approve: () => permit, pollIntervalMs: 5, waitTimeoutMs: 1000 });
    const operations = ['card.create','session.message','command.cancel','card.read','card.list','command.read','snapshot.read','events.read','delegation.delegate','delegation.read'];
    const writes = new Set(['card.create','session.message','command.cancel','delegation.delegate']);
    hub = createHub({ store: core, bearerSecret: token,
      authContext: { principalId: owner, revoked: false, expiresAt: Date.now() + 60000,
        grants: operations.map(operation => ({ operation, permission: writes.has(operation) ? 'write' : 'read', effect: 'allow', projectId })) },
      resolveTarget: ({ card, input }) => ({ projectId, ...(card ? { cardId: card.id, sessionId: card.sessionId } : input?.id ? { cardId: input.id, sessionId: input.sessionId } : {}) }),
      runner: async ({ card }) => { assert.notEqual(card.id, parent.id); effects++; return { text: 'CHILD_HTTP_OK' }; },
      routeHandlers: routes,
    });
    const address = await hub.listen();
    const base = `http://127.0.0.1:${address.port}`;
    client = createHubClient({ baseUrl: base, bearer: token, fetch: async (url, init) => {
      if (init.method === 'POST') childPosts.push(new URL(url).pathname);
      const response = await fetch(url, init);
      if (!lost && init.method === 'POST' && new URL(url).pathname.endsWith('/messages')) {
        lost = true; await response.body.cancel(); throw new Error('SYNTHETIC_COMMITTED_RECEIPT_LOSS');
      }
      return response;
    } });
    const request = async (path, body, bearer = token) => {
      const response = await fetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { authorization: `Bearer ${bearer}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await request('/v1/modules/delegation', { parentCommandId: 'parent-command', requestId: 'bad-auth', text: 'task' }, 'wrong')).status, 401);
    permit = false;
    const denied = await request('/v1/modules/delegation', { parentCommandId: 'parent-command', requestId: 'denied', text: 'task' });
    const absent = await request('/v1/modules/delegation', { parentCommandId: 'missing-command', requestId: 'absent', text: 'task' });
    assert.equal(denied.status, 404); assert.deepEqual(denied.body, absent.body);
    assert.equal(tasks.findRequest({ actor: owner, requestId: 'denied' }), null);
    assert.deepEqual(childPosts, []);
    permit = true;
    const intent = { parentCommandId: 'parent-command', requestId: 'stable-task', text: 'one child task' };
    const uncertain = await request('/v1/modules/delegation', intent);
    assert.equal(uncertain.status, 200);
    assert.equal(uncertain.body.outcome, 'unknown');
    const stored = tasks.findRequest({ actor: owner, requestId: intent.requestId });
    assert.ok(stored);
    const deadline = Date.now() + 3000;
    while (core.getCommand(stored.childCommandId)?.state !== 'COMPLETED' && Date.now() < deadline) await pause();
    assert.equal(core.getCommand(stored.childCommandId)?.state, 'COMPLETED');
    const mutationsBeforeRead = [...childPosts];
    const found = await request('/v1/modules/delegation?parentCommandId=parent-command&requestId=stable-task');
    assert.equal(found.status, 200);
    assert.equal(found.body.record.state, 'COMPLETED');
    assert.deepEqual(found.body.record.result, { status: 'ok', text: 'CHILD_HTTP_OK' });
    const read = await request(`/v1/modules/delegation/${stored.id}`);
    assert.equal(read.status, 200); assert.deepEqual(read.body.record, found.body.record);
    assert.deepEqual(childPosts, mutationsBeforeRead, 'read-only reconciliation must not replay child POSTs');
    const duplicate = await request('/v1/modules/delegation', intent);
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
    assert.equal(effects, 1); assert.deepEqual(childPosts, mutationsBeforeRead);
    assert.equal((await request('/v1/modules/delegation', { ...intent, text: 'changed task' })).status, 409);
    const publicText = JSON.stringify(found.body);
    for (const privateField of ['leaseId','cancelRequestId','nativeSessionFile','SYNTHETIC_COMMITTED_RECEIPT_LOSS']) assert.equal(publicText.includes(privateField), false);
    permit = false;
    const hidden = await request(`/v1/modules/delegation/${stored.id}`);
    const missing = await request('/v1/modules/delegation/missing-task');
    assert.equal(hidden.status, 404); assert.deepEqual(hidden.body, missing.body);
    tasks.close(); tasks = openDelegationStore(join(root, 'tasks.sqlite'));
    assert.equal(tasks.get({ actor: owner, id: stored.id }).state, 'COMPLETED');
  } finally {
    await hub?.shutdown({ abortActive: true });
    tasks?.close(); core?.close();
    await rm(root, { recursive: true, force: true });
  }
});
