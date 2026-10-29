import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
import { openWiki } from '../wiki/wiki.mjs';
import { createWikiRouteHandlers } from '../wiki/hub-routes.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { createWikiClient } from '../desktop-ui/wiki-client.mjs';
import { createWikiController } from '../desktop-ui/wiki-controller.mjs';

const bearer = 'a'.repeat(64); // Synthetic test credential, never a user token.
const prefix = '/v1/modules/wiki';
const operations = ['create', 'read', 'search', 'write', 'history', 'diff', 'restore', 'links'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-wiki-http-'));
  const denied = new Set();
  const store = openStore(join(root, 'hub.sqlite'));
  const wiki = await openWiki({ root: join(root, 'wiki'), authorize: async ({ actor, noteId }) => actor === 'owner' && !denied.has(noteId) });
  let hub;
  const context = { principalId: 'owner', expiresAt: Date.now() + 60000, revoked: false, grants: operations.map(name => ({ effect: 'allow', permission: ['create', 'write', 'restore'].includes(name) ? 'write' : 'read', operation: `wiki.${name}`, projectId: 'project' })) };
  context.grants.push({ effect: 'allow', permission: 'write', operation: 'card.create', projectId: 'project' });
  let base;
  async function start(enabled = true) {
    hub = createHub({ store, bearerSecret: bearer, authContext: context, resolveTarget: ({ card, input }) => ({ projectId: 'project', cardId: card?.id ?? input.id, sessionId: card?.sessionId ?? input.sessionId }), runner: async () => ({ text: 'unused' }), routeHandlers: enabled ? createWikiRouteHandlers({ wiki, projectId: 'project' }) : [] });
    base = `http://127.0.0.1:${(await hub.listen()).port}`;
  }
  t.after(async () => { try { await hub?.shutdown({ abortActive: true }); } finally { store.close(); await rm(root, { recursive: true, force: true }); } });
  await start();
  async function request(path, { method = 'GET', body, authenticated = true, headers = {} } = {}) {
    const response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(3000), headers: { ...(authenticated ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  return { wiki, denied, request, get baseUrl() { return base; }, disable: async () => { await hub.shutdown(); await start(false); } };
}

test('registered Wiki routes compose real HTTP, trusted actor, revisions, diff and disable without affecting chats', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(prefix + '/notes', { method: 'POST', body: { content: 'denied' }, authenticated: false })).status, 401);
  assert.equal((await f.request(prefix + '/notes', { method: 'POST', body: { content: 'denied' }, headers: { origin: 'https://foreign.invalid' } })).status, 403);
  assert.deepEqual(await f.wiki.search({ actor: 'owner', query: '' }), []);
  // Wiki fast RPC does not promise request-ID deduplication; reject rather than imply it.
  assert.equal((await f.request(prefix + '/notes', { method: 'POST', body: { content: 'not-created', requestId: 'explicit-but-unsupported' } })).status, 400);
  assert.deepEqual(await f.wiki.search({ actor: 'owner', query: '' }), []);

  const created = await f.request(prefix + '/notes', { method: 'POST', body: { content: 'first\r\n🙂' } });
  assert.equal(created.status, 201);
  const { id, revision: first } = created.body;
  assert.ok(id && first);
  const notePath = prefix + '/notes/' + id;
  assert.equal((await f.request(notePath)).body.content, 'first\r\n🙂');
  const updated = await f.request(notePath, { method: 'POST', body: { expectedRevision: first, content: 'second\r\n🙂' } });
  assert.equal(updated.status, 200);
  const second = updated.body.revision;
  assert.notEqual(first, second);
  assert.equal((await f.request(notePath, { method: 'POST', body: { expectedRevision: first, content: 'lost' } })).status, 409);
  assert.equal((await f.request(notePath, { method: 'POST', body: { expectedRevision: second, content: 'forged', actor: 'owner' } })).status, 400);
  assert.equal((await f.wiki.read({ actor: 'owner', id })).content, 'second\r\n🙂');

  assert.deepEqual(new Set((await f.request(notePath + '/history')).body.revisions), new Set([first, second]));
  const diff = await f.request(notePath + `/diff?fromRevision=${first}&toRevision=${second}`);
  assert.equal(diff.status, 200);
  const lines = 'first\r\n🙂'.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (const change of diff.body.changes) lines.splice(change.start, change.remove.length, ...change.insert);
  assert.equal(lines.join(''), 'second\r\n🙂');
  assert.equal((await f.request(prefix + '/notes?query=second')).body.notes[0].id, id);
  assert.deepEqual((await f.request(notePath + '/links')).body.links, []);
  assert.equal((await f.request(notePath + '/restore', { method: 'POST', body: { revision: first, expectedRevision: second } })).status, 200);
  assert.equal((await f.request(notePath)).body.content, 'first\r\n🙂');

  f.denied.add(id);
  const denied = await f.request(notePath);
  const missing = await f.request(prefix + '/notes/00000000-0000-0000-0000-000000000000');
  assert.deepEqual(denied, missing);
  assert.equal(denied.status, 404);
  f.denied.delete(id);

  await f.disable();
  assert.equal((await f.request(notePath)).status, 404);
  assert.equal((await f.wiki.read({ actor: 'owner', id })).content, 'first\r\n🙂');
  const card = await f.request('/v1/cards', { method: 'POST', body: { requestId: 'create-chat', id: 'card', canvasId: 'canvas', sessionId: 'session', title: 'Chat survives disabled Wiki', x: 0, y: 0 } });
  assert.equal(card.status, 201);
  assert.equal(card.body.card.sessionId, 'session');
});

test('actual Wiki client uses UUID revisions and agreed routes against real Hub and Wiki', async t => {
  const f = await fixture(t);
  const client = createWikiClient({ hubClient: createHubClient({ baseUrl: f.baseUrl, bearer }) });
  const first = await client.create({ content: 'client-first' });
  assert.equal(typeof first.revision, 'string');
  assert.equal((await client.read(first.id)).content, 'client-first');
  assert.equal((await client.search('client-first')).notes[0].id, first.id);
  const second = await client.update(first.id, { expectedRevision: first.revision, content: 'client-second' });
  assert.notEqual(first.revision, second.revision);
  assert.deepEqual(new Set((await client.history(first.id)).revisions), new Set([first.revision, second.revision]));
  assert.ok((await client.diff(first.id, { fromRevision: first.revision, toRevision: second.revision })).changes.length);
  assert.deepEqual((await client.links(first.id)).links, []);
  await client.restore(first.id, { revision: first.revision, expectedRevision: second.revision });
  assert.equal((await client.read(first.id)).content, 'client-first');
});

test('Wiki controller preserves a conflicting draft through real HTTP reconciliation and refreshes a clean draft', async t => {
  const f = await fixture(t);
  const controller = createWikiController({ client: createWikiClient({ hubClient: createHubClient({ baseUrl: f.baseUrl, bearer }) }) });
  t.after(() => controller.dispose());
  controller.edit('initial draft');
  assert.equal(await controller.save(), true);
  const original = controller.getSnapshot().selected;
  const external = await f.wiki.update({ actor: 'owner', id: original.id, expectedRevision: original.revision, content: 'external revision' });
  controller.edit('my preserved draft');
  assert.equal(await controller.save(), false);
  assert.equal(controller.getSnapshot().conflict, true);
  assert.equal(controller.getSnapshot().draft, 'my preserved draft');
  assert.equal(await controller.reconcile(), true);
  assert.equal(controller.getSnapshot().selected.revision, external.revision);
  assert.equal(controller.getSnapshot().draft, 'my preserved draft');
  assert.equal(controller.getSnapshot().dirty, true);
  assert.equal(await controller.save(), true);
  const saved = controller.getSnapshot().selected;
  assert.equal((await f.wiki.read({ actor: 'owner', id: saved.id })).content, 'my preserved draft');
  await f.wiki.update({ actor: 'owner', id: saved.id, expectedRevision: saved.revision, content: 'new authoritative text' });
  assert.equal(await controller.reconcile(), true);
  assert.equal(controller.getSnapshot().dirty, false);
  assert.equal(controller.getSnapshot().draft, 'new authoritative text');
});
