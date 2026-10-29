import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
import { openWiki } from '../wiki/wiki.mjs';
import { createWikiRouteHandlers } from '../wiki/hub-routes.mjs';
import { openHandoffStore } from '../handoff/store.mjs';
import { createHandoffModule } from '../handoff/module.mjs';

const bearer = 'b'.repeat(64); // Public synthetic credential; no user configuration.
const wp = '/v1/modules/wiki/notes';
const hp = '/v1/modules/handoff';
const sha = value => createHash('sha256').update(value).digest('hex');

async function files(root, dir = root) {
  const out = {};
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    assert.equal(item.isSymbolicLink(), false);
    if (item.isDirectory()) Object.assign(out, await files(root, path));
    else out[relative(root, path)] = sha(await readFile(path));
  }
  return out;
}

test('module disable, independent re-enable and handler replacement retain reopened stores and chat history', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-module-reopen-'));
  const corePath = join(root, 'core.sqlite'), handoffPath = join(root, 'handoffs.sqlite'), wikiRoot = join(root, 'wiki');
  let core, handoffs, wiki, hub, base, runs = 0, resolverCalls = 0, wrapperCalls = 0;
  const commands = [];
  const grants = [
    ...['create', 'read', 'search', 'write', 'history', 'diff', 'restore', 'links'].map(name => ({ operation: `wiki.${name}`, permission: ['create', 'write', 'restore'].includes(name) ? 'write' : 'read' })),
    ...['propose', 'list', 'read', 'accept'].map(name => ({ operation: `handoff.${name}`, permission: ['propose', 'accept'].includes(name) ? 'write' : 'read' })),
    ...['card.read', 'command.read', 'snapshot.read', 'events.read'].map(operation => ({ operation, permission: 'read' })),
    { operation: 'session.message', permission: 'write' },
  ].map(grant => ({ ...grant, effect: 'allow', projectId: 'project' }));
  const authContext = { principalId: 'owner', revoked: false, expiresAt: Date.now() + 60000, grants };
  async function open() {
    core = openStore(corePath);
    handoffs = openHandoffStore(handoffPath);
    wiki = await openWiki({ root: wikiRoot, authorize: async ({ actor }) => actor === 'owner' });
  }
  async function close() {
    await hub?.shutdown({ abortActive: true }); hub = undefined;
    handoffs?.close(); handoffs = undefined;
    core?.close(); core = undefined;
  }
  t.after(async () => { try { await close(); } finally { await rm(root, { recursive: true, force: true }); } });
  async function start({ wikiEnabled = false, handoffEnabled = false, replace = false } = {}) {
    const handlers = [
      ...(wikiEnabled ? createWikiRouteHandlers({ wiki, projectId: 'project' }) : []),
      ...(handoffEnabled ? createHandoffModule({
        store: handoffs, projectId: 'project',
        authorizeCard: ({ actor, cardId }) => actor === 'owner' && Boolean(core.getCard(cardId)),
        resolveSource: async ({ actor, source }) => {
          resolverCalls++;
          assert.equal(source.kind, 'wiki');
          const note = await wiki.read({ actor, id: source.id, revision: source.revision });
          return { source: { ...source, revision: note.revision }, text: note.content };
        },
      }) : []),
    ];
    hub = createHub({
      store: core, bearerSecret: bearer, authContext,
      resolveTarget: ({ card }) => ({ projectId: 'project', ...(card ? { cardId: card.id, sessionId: card.sessionId } : {}) }),
      runner: async ({ input }) => { runs++; return { text: `echo:${input.text}` }; },
      routeHandlers: replace ? handlers.map(route => ({ ...route, handle: async input => { wrapperCalls++; return route.handle(input); } })) : handlers,
    });
    base = `http://127.0.0.1:${(await hub.listen()).port}`;
  }
  async function request(path, body) {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
      headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  }
  async function chat(id) {
    const text = `message-${id}`;
    assert.equal((await request('/v1/cards/card-a/messages', { requestId: id, text })).status, 202);
    let receipt;
    for (let n = 0; n < 50; n++) {
      receipt = await request(`/v1/commands/${id}`);
      assert.equal(receipt.status, 200);
      if (receipt.body.command.state === 'COMPLETED') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(receipt.body.command.state, 'COMPLETED');
    assert.deepEqual(receipt.body.command.result, { status: 'ok', text: `echo:${text}` });
    commands.push(id);
    for (const previous of commands) assert.equal((await request(`/v1/commands/${previous}`)).body.command.state, 'COMPLETED');
  }

  await open();
  for (const id of ['a', 'b']) core.createCard({ id: `card-${id}`, canvasId: 'canvas', sessionId: `session-${id}`, title: id, x: 0, y: 0 });
  await start({ wikiEnabled: true, handoffEnabled: true });
  const created = await request(wp, { content: 'original 🙂\n' });
  assert.equal(created.status, 201);
  const note = created.body, notePath = `${wp}/${note.id}`;
  const proposal = { requestId: 'propose-once', source: { cardId: 'card-a', kind: 'wiki', id: note.id, revision: note.revision }, targetCardId: 'card-b' };
  const sent = await request(hp, proposal);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.duplicate, false);
  const record = sent.body.record, recordPath = `${hp}/${record.id}`;
  assert.equal((await request(notePath, { expectedRevision: note.revision, content: 'new head\n' })).status, 200);
  const head = (await request(notePath)).body;
  const originalFiles = await files(wikiRoot);
  await chat('both-enabled');
  const storedProposal = handoffs.get({ actor: 'owner', id: record.id });
  await close(); // All database handles closed, not merely HTTP unregistration.

  await open();
  await start();
  const disabledEvents = core.getEvents(), disabledRuns = runs, disabledResolverCalls = resolverCalls;
  assert.equal((await request(notePath)).status, 404);
  assert.equal((await request(wp, { content: 'must-not-create' })).status, 404);
  assert.equal((await request(recordPath)).status, 404);
  assert.equal((await request(hp, proposal)).status, 404);
  assert.equal((await request(`${recordPath}/accept`, { requestId: 'disabled-accept' })).status, 404);
  assert.deepEqual(core.getEvents(), disabledEvents);
  assert.equal(runs, disabledRuns);
  assert.equal(resolverCalls, disabledResolverCalls);
  assert.deepEqual(await files(wikiRoot), originalFiles);
  assert.deepEqual(handoffs.get({ actor: 'owner', id: record.id }), storedProposal);
  await chat('both-disabled');
  await close();

  await open();
  await start({ handoffEnabled: true });
  assert.equal((await request(notePath)).status, 404);
  assert.deepEqual((await request(recordPath)).body.record, storedProposal);
  const accepted = await request(`${recordPath}/accept`, { requestId: 'accept-once' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.record.state, 'accepted');
  assert.equal(accepted.body.record.snapshot.text, 'original 🙂\n');
  assert.equal(accepted.body.record.snapshot.sha256, sha('original 🙂\n'));
  await chat('handoff-only');
  await close();

  await open();
  await start({ wikiEnabled: true });
  assert.equal((await request(recordPath)).status, 404);
  assert.deepEqual((await request(notePath)).body, head);
  assert.deepEqual(new Set((await request(`${notePath}/history`)).body.revisions), new Set([note.revision, head.revision]));
  await chat('wiki-only');
  await close();

  await open();
  await start({ wikiEnabled: true, handoffEnabled: true, replace: true });
  assert.deepEqual((await request(notePath)).body, head);
  const duplicate = await request(hp, proposal);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.record.id, record.id);
  assert.equal(duplicate.body.record.state, 'accepted');
  const duplicateAccept = await request(`${recordPath}/accept`, { requestId: 'accept-once' });
  assert.equal(duplicateAccept.status, 200);
  assert.equal(duplicateAccept.body.duplicate, true);
  assert.equal(duplicateAccept.body.record.acceptedAt, accepted.body.record.acceptedAt);
  assert.equal(handoffs.list({ actor: 'owner', targetCardId: 'card-b' }).length, 1);
  assert.deepEqual(await files(wikiRoot), originalFiles);
  assert.ok(wrapperCalls >= 3);
  await chat('replacement-handlers');
  assert.equal(runs, 5, 'only five explicit synthetic chat POSTs may dispatch the runner');
  for (const id of commands) {
    assert.equal(core.getCommand(id).cardId, 'card-a');
    assert.equal(core.getCommand(id).input.text, `message-${id}`);
  }
  assert.equal(core.getCard('card-a').sessionId, 'session-a');
  assert.equal(core.getCard('card-b').sessionId, 'session-b');
  await close();
  for (const path of [corePath, handoffPath]) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  }
  t.diagnostic('five full store reopen phases; one immutable handoff; unchanged Wiki files; five explicit synthetic chat executions; no SDK/model/native calls');
});
