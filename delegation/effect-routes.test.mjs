import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDelegationStore } from './store.mjs';
import { createDelegationModule } from './hub-routes.mjs';
import { openToolEffectStore } from './effects.mjs';
import { createDelegationEffectRoutes } from './effect-routes.mjs';

const ACTOR = 'actor-owner';
const PARENT = Object.freeze({ actor: ACTOR, parentCommandId: 'parent-command', parentCardId: 'parent-card', canvasId: 'canvas-main' });
const post = (requestId = 'request-1', text = 'child task') => ({ actor: ACTOR, requestId, body: { parentCommandId: PARENT.parentCommandId, requestId, text } });
const route = (routes, method, path) => routes.find(item => item.method === method && item.path === path);

async function fixture(t, { approval = false, sendMessage } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'delegation-effects-routes-'));
  const tasks = openDelegationStore(join(root, 'tasks.sqlite'));
  const effects = openToolEffectStore(join(root, 'effects.sqlite'));
  const calls = { create: 0, send: 0, read: 0 };
  const commands = new Map();
  const hub = {
    async createCard(card) { calls.create++; return { card, duplicate: false }; },
    async sendMessage(cardId, text, requestId) {
      calls.send++;
      if (sendMessage) return sendMessage(requestId, commands);
      const command = { id: requestId, state: 'RUNNING', result: null }; commands.set(requestId, command);
      return { command, duplicate: false };
    },
    async readCommand(id) { calls.read++; const command = commands.get(id); if (!command) throw Object.assign(new Error('missing'), { status: 404 }); return { command }; },
    async cancelCommand() { throw new Error('not used'); },
  };
  const base = createDelegationModule({ store: tasks, hubClient: hub, projectId: 'project-a', resolveParent: () => PARENT,
    approve: () => true, pollIntervalMs: 5, waitTimeoutMs: 100 });
  const emitted = [];
  const routes = createDelegationEffectRoutes({ routes: base, effects, resolveParent: () => PARENT, approve: () => true,
    requireApproval: () => approval, ownerId: 'hub-owner', now: (() => { let value = 0; return () => ++value; })(), onEffect: effect => emitted.push(effect) });
  t.after(async () => { tasks.close(); effects.close(); await rm(root, { recursive: true, force: true }); });
  return { routes, effects, calls, commands, emitted };
}

test('approval checkpoints before dispatch and approval of the same payload executes once', async t => {
  const f = await fixture(t, { approval: true });
  const pending = await route(f.routes, 'POST', '/v1/modules/delegation').handle(post());
  assert.equal(pending.status, 202);
  assert.equal(pending.body.effect.state, 'PENDING_APPROVAL');
  assert.equal(f.calls.create, 0); assert.equal(f.calls.send, 0);
  const effect = pending.body.effect;
  await assert.rejects(route(f.routes, 'POST', '/v1/modules/delegation-effects/:id/approval').handle({ actor: ACTOR, params: { id: effect.id }, body: { parentCommandId: effect.parentCommandId, attempt: 1, payloadHash: '0'.repeat(64) } }), /EFFECT_CONFLICT/);
  assert.equal(f.calls.create, 0);
  const approved = await route(f.routes, 'POST', '/v1/modules/delegation-effects/:id/approval').handle({ actor: ACTOR, params: { id: effect.id }, body: { parentCommandId: effect.parentCommandId, attempt: 1, payloadHash: effect.payloadHash } });
  assert.equal(approved.status, 201);
  assert.equal(f.calls.create, 1); assert.equal(f.calls.send, 1);
  assert.equal(f.effects.get({ actor: ACTOR, id: effect.id }).state, 'SUCCEEDED');
  const duplicate = await route(f.routes, 'POST', '/v1/modules/delegation').handle(post());
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
  assert.equal(f.calls.create, 1); assert.equal(f.calls.send, 1);
  assert.deepEqual(f.emitted.map(item => item.state), ['PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'SUCCEEDED']);
});

test('an unknown dispatch response never replays create/send and reconciles by reads', async t => {
  const f = await fixture(t, { sendMessage: async (requestId, commands) => {
    commands.set(requestId, { id: requestId, state: 'RUNNING', result: null });
    throw Object.assign(new Error('connection lost'), { code: 'CONNECTION_FAILED' });
  } });
  const first = await route(f.routes, 'POST', '/v1/modules/delegation').handle(post());
  assert.equal(first.status, 202); assert.equal(first.body.outcome, 'unknown');
  assert.equal(first.body.effect.state, 'UNKNOWN');
  assert.equal(f.calls.create, 1); assert.equal(f.calls.send, 1);
  const second = await route(f.routes, 'POST', '/v1/modules/delegation').handle(post());
  assert.equal(second.status, 200); assert.equal(second.body.duplicate, true);
  assert.equal(f.calls.create, 1); assert.equal(f.calls.send, 1);
  assert.equal(f.calls.read, 1);
  assert.equal(f.effects.get({ actor: ACTOR, id: first.body.effect.id }).state, 'SUCCEEDED');
});

test('a pre-dispatch policy failure creates no effect and no child operation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'delegation-effects-denied-'));
  const tasks = openDelegationStore(join(root, 'tasks.sqlite')), effects = openToolEffectStore(join(root, 'effects.sqlite'));
  t.after(async () => { tasks.close(); effects.close(); await rm(root, { recursive: true, force: true }); });
  let calls = 0;
  const base = createDelegationModule({ store: tasks, hubClient: { createCard: async () => { calls++; }, sendMessage: async () => { calls++; }, readCommand: async () => { calls++; }, cancelCommand: async () => { calls++; } },
    projectId: 'p', resolveParent: () => PARENT, approve: () => false, pollIntervalMs: 5, waitTimeoutMs: 100 });
  const routes = createDelegationEffectRoutes({ routes: base, effects, resolveParent: () => PARENT, approve: () => false, ownerId: 'hub-owner' });
  await assert.rejects(route(routes, 'POST', '/v1/modules/delegation').handle(post()), error => error.status === 404);
  assert.equal(calls, 0);
  // The checkpoint exists, but its conservative outcome is unknown rather than false success.
  const effect = effects.findRequest({ actor: ACTOR, requestId: 'request-1' });
  assert.equal(effect.state, 'UNKNOWN');
});
