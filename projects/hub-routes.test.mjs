import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectContextRoutes } from './hub-routes.mjs';
import { openStore } from '../persistence/store.mjs';
import { createHub } from '../hub/server.mjs';

const projects = [{ projectId: 'alpha', bazaPrefix: '10 Проекты/Alpha/' }];
const binding = { projectId: 'alpha', cardId: 'card-a', sessionId: 'session-a', commandId: 'command:alpha-1', bazaPrefix: projects[0].bazaPrefix };
const reply = { projectId: 'alpha', excerpts: [{ path: '10 Проекты/Alpha/Context.md', text: 'synthetic context' }] };
const request = { actor: 'owner', params: {}, query: {}, body: { commandId: binding.commandId, query: 'context' } };

test('project route descriptors match Hub contract and snapshot trusted project selection', async () => {
  const selected = projects.map(project => ({ ...project }));
  const [route] = createProjectContextRoutes({ projects: selected, resolveBinding: async () => binding, readProjectContext: async () => reply });
  selected[0].bazaPrefix = '10 Проекты/Changed/';
  assert.deepEqual(Object.keys(route).sort(), ['effect', 'handle', 'method', 'operation', 'path', 'target']);
  assert.equal(Object.isFrozen(route), true);
  assert.equal(Object.isFrozen(route.target), true);
  assert.equal(route.effect, 'read');
  assert.equal(route.path, '/v1/modules/projects/alpha/context');
  assert.deepEqual(await route.handle(request), { status: 200, body: reply });
  for (const bad of [null, [{ projectId: 'alpha', bazaPrefix: '/outside/' }], [...projects, ...projects], new Array(1)]) {
    assert.throws(() => createProjectContextRoutes({ projects: bad, resolveBinding() {}, readProjectContext() {} }), /INVALID_PROJECT_CONTEXT_CONFIG/);
  }
  let accessed = false;
  const accessor = [{ get projectId() { accessed = true; return 'alpha'; }, bazaPrefix: projects[0].bazaPrefix }];
  assert.throws(() => createProjectContextRoutes({ projects: accessor, resolveBinding() {}, readProjectContext() {} }));
  assert.equal(accessed, false);
});

test('binding denial and input mismatch prevent transport; invalid replies fail closed', async () => {
  let calls = 0;
  const make = resolveBinding => createProjectContextRoutes({ projects, resolveBinding, readProjectContext: async () => { calls++; return reply; } })[0];
  for (const bad of [null, { ...binding, commandId: 'another' }, { ...binding, projectId: 'beta' }, { ...binding, bazaPrefix: '10 Проекты/Beta/' }, { ...binding, sessionId: '' }]) {
    await assert.rejects(make(async () => bad).handle(request), { status: 404, code: 'not_found' });
  }
  await assert.rejects(make(async () => { throw Error('private backend detail'); }).handle(request), { status: 404, code: 'not_found' });
  await assert.rejects(make(async () => binding).handle({ ...request, body: { ...request.body, actor: 'spoofed' } }), { status: 400 });
  await assert.rejects(make(async () => binding).handle({ ...request, body: { ...request.body, query: 'x'.repeat(201) } }), { status: 400 });
  assert.equal(calls, 0);
  for (const bad of [{ ...reply, projectId: 'beta' }, { ...reply, excerpts: [{ path: '10 Проекты/Beta/Other.md', text: 'wrong scope' }] }, { ...reply, excerpts: [{ path: reply.excerpts[0].path, text: 'x'.repeat(32768) }] }]) {
    const [route] = createProjectContextRoutes({ projects, resolveBinding: async () => binding, readProjectContext: async () => bad });
    await assert.rejects(route.handle(request), { status: 500, code: 'context_unavailable' });
  }
});

test('actual Hub authorizes project target and actual SQLite command binding before context transport', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-project-route-'));
  const store = openStore(join(root, 'core.sqlite'));
  store.createCard({ id: binding.cardId, canvasId: 'fixture', sessionId: binding.sessionId, title: 'synthetic project card', x: 0, y: 0 });
  store.reserveCommand({ id: binding.commandId, cardId: binding.cardId, input: { text: 'synthetic command' } });
  let transportCalls = 0, bindingCalls = 0;
  const routes = createProjectContextRoutes({ projects: [...projects, { projectId: 'beta', bazaPrefix: '10 Проекты/Beta/' }],
    resolveBinding: async ({ actor, projectId, commandId }) => {
      bindingCalls++;
      const command = store.getCommand(commandId), card = command && store.getCard(command.cardId);
      return actor === 'owner' && projectId === 'alpha' && command?.state === 'RUNNING' && card?.id === binding.cardId && card.sessionId === binding.sessionId ? { ...binding, commandId } : null;
    },
    readProjectContext: async (projectId, query, signal) => {
      transportCalls++; assert.equal(projectId, 'alpha'); assert.equal(query, 'context'); assert.ok(signal instanceof AbortSignal); return reply;
    },
  });
  const bearer = 'synthetic-project-route-token-not-a-user-secret';
  const hub = createHub({ store, bearerSecret: bearer, authContext: { principalId: 'owner', revoked: false, expiresAt: 1000,
    grants: [{ operation: 'project.context.read', permission: 'read', effect: 'allow', projectId: 'alpha' }] },
    now: () => 1, resolveTarget: () => null, runner: async () => { throw Error('unused'); }, routeHandlers: routes });
  t.after(async () => { await hub.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); });
  const address = await hub.listen();
  const post = (projectId, commandId, auth = true) => fetch(`http://127.0.0.1:${address.port}/v1/modules/projects/${projectId}/context`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ commandId, query: 'context' }),
  });
  const accepted = await post('alpha', binding.commandId);
  assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), reply);
  assert.equal(transportCalls, 1);
  assert.equal((await post('beta', binding.commandId)).status, 404);
  assert.equal((await post('alpha', binding.commandId, false)).status, 401);
  assert.equal(bindingCalls, 1, 'Hub grant and bearer denial must precede binding lookup');
  assert.equal((await post('alpha', 'unknown-command')).status, 404);
  store.completeCommand(binding.commandId, { status: 'ok', value: { text: 'synthetic completion' } });
  assert.equal((await post('alpha', binding.commandId)).status, 404);
  assert.equal(transportCalls, 1, 'unknown and inactive commands must never read project context');
});
