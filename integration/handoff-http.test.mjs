import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../hub/server.mjs';
import { authorize } from '../hub/authorization.mjs';
import { openStore } from '../persistence/store.mjs';
import { openWiki } from '../wiki/wiki.mjs';
import { openHandoffStore } from '../handoff/store.mjs';
import { createHandoffModule } from '../handoff/module.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { createHandoffClient } from '../desktop-ui/handoff-client.mjs';
import { createHandoffController } from '../desktop-ui/handoff-controller.mjs';

const bearer = 'a'.repeat(64); // Public synthetic fixture only.
const prefix = '/v1/modules/handoff';
const notFound = () => Object.assign(new Error('not found'), { status: 404, code: 'NOT_FOUND' });

test('real registered handoff module authorizes both cards, persists immutable snapshots and accepts without running an agent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-handoff-http-'));
  const core = openStore(join(root, 'core.sqlite'));
  const handoffs = openHandoffStore(join(root, 'handoffs.sqlite'));
  const deniedRead = new Set(), deniedWrite = new Set();
  let hub, base, runs = 0, revokeTargetOnResolve = false;
  t.after(async () => { try { await hub?.shutdown({ abortActive: true }); } finally { handoffs.close(); core.close(); await rm(root, { recursive: true, force: true }); } });
  for (const id of ['card-a', 'card-b']) core.createCard({ id, canvasId: 'canvas', sessionId: `session-${id}`, title: id, x: 0, y: 0 });
  core.reserveCommand({ id: 'source-command', cardId: 'card-a', input: { operation: 'fixture.result' } });
  core.completeCommand('source-command', { status: 'ok', value: { text: 'a safe completed result' } });
  const wiki = await openWiki({ root: join(root, 'wiki'), authorize: async ({ actor }) => actor === 'owner' });
  const note = await wiki.create({ actor: 'owner', content: 'chosen immutable document' });
  const context = { principalId: 'owner', revoked: false, expiresAt: Date.now() + 60000, grants: [
    ...['propose', 'list', 'read', 'accept'].map(name => ({ effect: 'allow', permission: ['propose', 'accept'].includes(name) ? 'write' : 'read', operation: `handoff.${name}`, projectId: 'project' })),
    ...['card-a', 'card-b'].flatMap(cardId => ['read', 'write'].map(action => ({ effect: 'allow', permission: action, operation: `handoff.card.${action}`, projectId: 'project', cardId, sessionId: `session-${cardId}` }))),
    { effect: 'allow', permission: 'write', operation: 'card.create', projectId: 'project' },
  ] };
  const authorizeCard = ({ actor, action, cardId }) => {
    const card = core.getCard(cardId);
    if (!card || actor !== context.principalId || (action === 'read' ? deniedRead : deniedWrite).has(cardId)) return false;
    const operation = `handoff.card.${action}`;
    return authorize(context, { operation, requestId: 'trusted-handoff-check' }, { operation, effect: action, projectId: 'project', cardId, sessionId: card.sessionId }, Date.now()).allowed;
  };
  const resolveSource = async ({ actor, source }) => {
    if (!authorizeCard({ actor, action: 'read', cardId: source.cardId })) throw notFound();
    if (source.kind === 'wiki') {
      const value = await wiki.read({ actor, id: source.id, revision: source.revision });
      return { source: { ...source, revision: value.revision }, text: value.content };
    }
    const command = core.getCommand(source.id);
    if (!command || command.cardId !== source.cardId || command.state !== 'COMPLETED' || command.result?.status !== 'ok' || typeof command.result.value?.text !== 'string') throw notFound();
    if (revokeTargetOnResolve) { deniedWrite.add('card-b'); revokeTargetOnResolve = false; }
    return { source: { ...source }, text: command.result.value.text };
  };
  async function start(enabled) {
    hub = createHub({ store: core, bearerSecret: bearer, authContext: context, resolveTarget: ({ card, input }) => ({ projectId: 'project', cardId: card?.id ?? input.id, sessionId: card?.sessionId ?? input.sessionId }), runner: async () => { runs++; return { text: 'must not run during handoff' }; }, routeHandlers: enabled ? createHandoffModule({ store: handoffs, projectId: 'project', authorizeCard, resolveSource }) : [] });
    base = `http://127.0.0.1:${(await hub.listen()).port}`;
  }
  async function request(path, body, authenticated = true) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(3000), headers: { ...(authenticated ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  await start(true);
  const proposal = { requestId: 'send-1', source: { cardId: 'card-a', kind: 'command', id: 'source-command' }, targetCardId: 'card-b' };
  assert.equal((await request(prefix, proposal, false)).status, 401);
  deniedRead.add('card-a');
  assert.equal((await request(prefix, proposal)).status, 404);
  deniedRead.clear(); deniedWrite.add('card-b');
  assert.equal((await request(prefix, proposal)).status, 404);
  deniedWrite.clear();
  assert.deepEqual(handoffs.list({ actor: 'owner', targetCardId: 'card-b' }), []);
  assert.equal((await request(prefix, { ...proposal, snapshot: { text: 'forged' } })).status, 400);

  const sent = await request(prefix, proposal);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.duplicate, false);
  const record = sent.body.record;
  assert.equal(record.state, 'pending');
  assert.equal(record.snapshot.text, 'a safe completed result');
  const repeated = await request(prefix, proposal);
  assert.equal(repeated.body.duplicate, true);
  assert.equal(repeated.body.record.id, record.id);
  assert.equal((await request(prefix, { ...proposal, source: { cardId: 'card-a', kind: 'wiki', id: note.id, revision: note.revision } })).status, 409);
  assert.equal((await request(prefix, { ...proposal, requestId: 'invalid-self-transfer', targetCardId: 'card-a' })).status, 400);
  const listed = await request(prefix + '?targetCardId=card-b');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.items.some(item => item.id === record.id));
  assert.ok(!JSON.stringify(listed.body).includes(record.snapshot.text));

  deniedRead.add('card-a');
  const hidden = await request(prefix + '/' + record.id);
  const absent = await request(prefix + '/00000000-0000-4000-8000-000000000000');
  assert.deepEqual(hidden, absent);
  assert.equal(hidden.status, 404);
  assert.equal((await request(prefix + '/' + record.id + '/accept', { requestId: 'accept-denied' })).status, 404);
  assert.equal(handoffs.get({ actor: 'owner', id: record.id }).state, 'pending');
  deniedRead.clear();
  deniedWrite.add('card-b');
  assert.equal((await request(prefix + '/' + record.id + '/accept', { requestId: 'target-denied' })).status, 404);
  assert.equal(handoffs.get({ actor: 'owner', id: record.id }).state, 'pending');
  deniedWrite.clear();
  revokeTargetOnResolve = true;
  assert.equal((await request(prefix + '/' + record.id + '/accept', { requestId: 'target-revoked-during-resolve' })).status, 404);
  assert.equal(handoffs.get({ actor: 'owner', id: record.id }).state, 'pending');
  assert.equal(handoffs.get({ actor: 'owner', id: record.id }).acceptedAt, null);
  deniedWrite.clear();
  const accepted = await request(prefix + '/' + record.id + '/accept', { requestId: 'accept-1' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.record.state, 'accepted');
  assert.equal((await request(prefix + '/' + record.id + '/accept', { requestId: 'accept-1' })).body.record.acceptedAt, accepted.body.record.acceptedAt);
  assert.equal(runs, 0);

  const doc = await request(prefix, { requestId: 'send-document', source: { cardId: 'card-a', kind: 'wiki', id: note.id, revision: note.revision }, targetCardId: 'card-b' });
  assert.equal(doc.status, 200);
  await wiki.update({ actor: 'owner', id: note.id, expectedRevision: note.revision, content: 'later document version' });
  const docRead = await request(prefix + '/' + doc.body.record.id);
  assert.equal(docRead.body.record.snapshot.text, 'chosen immutable document');
  assert.equal(docRead.body.record.source.revision, note.revision);
  assert.equal(handoffs.get({ actor: 'outsider', id: record.id }), undefined);

  const client = createHandoffClient({ hubClient: createHubClient({ baseUrl: base, bearer }) });
  const viaClient = await client.propose({ requestId: 'send-via-client', source: proposal.source, targetCardId: 'card-b' });
  assert.equal(viaClient.duplicate, false);
  assert.equal((await client.read(viaClient.record.id)).record.snapshot.text, 'a safe completed result');
  assert.ok((await client.list('card-b')).items.some(item => item.id === viaClient.record.id));
  const clientAccept = await client.accept(viaClient.record.id, { requestId: 'accept-via-client' });
  assert.equal(clientAccept.record.state, 'accepted');
  assert.equal(clientAccept.record.requestId, 'send-via-client');
  assert.equal((await client.accept(viaClient.record.id, { requestId: 'accept-via-client' })).record.acceptedAt, clientAccept.record.acceptedAt);
  assert.equal(runs, 0);

  const posts = [];
  let dropProposal = true, dropAccept = false, requestNumber = 0;
  const lossyHub = createHubClient({ baseUrl: base, bearer, fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'POST') {
      posts.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
      const loseReceipt = (dropProposal && new URL(url).pathname === prefix) || (dropAccept && new URL(url).pathname.endsWith('/accept'));
      if (loseReceipt) {
        dropProposal = false; dropAccept = false;
        await response.arrayBuffer(); // Actual backend effect completed; only the caller loses its receipt.
        throw new Error('SYNTHETIC_LOST_RECEIPT');
      }
    }
    return response;
  } });
  const controller = createHandoffController({ client: createHandoffClient({ hubClient: lossyHub }), newRequestId: () => `ui-request-${++requestNumber}` });
  t.after(() => controller.dispose());
  await controller.propose({ source: proposal.source, targetCardId: 'card-b' });
  assert.equal(controller.getSnapshot().uncertain, true);
  assert.equal(posts.length, 1, 'lost proposal receipt must not trigger an automatic retry');
  await controller.reconcile();
  assert.equal(controller.getSnapshot().uncertain, false, 'positive persisted proposal read resolves receipt loss');
  const uiRecord = controller.getSnapshot().selected;
  assert.equal(uiRecord.requestId, posts[0].body.requestId);
  assert.equal(posts.length, 1, 'reconciliation must be read-only');
  dropAccept = true;
  await controller.accept(uiRecord.id);
  assert.equal(controller.getSnapshot().uncertain, true);
  assert.equal(handoffs.get({ actor: 'owner', id: uiRecord.id }).state, 'accepted');
  assert.equal(posts.length, 2);
  await controller.reconcile();
  assert.equal(controller.getSnapshot().uncertain, false);
  assert.equal(controller.getSnapshot().selected.state, 'accepted');
  assert.equal(posts.length, 2, 'accepted-state reconciliation must not reissue Accept');

  dropProposal = true;
  const sourceSelection = { ...proposal.source };
  const countBeforeRetry = handoffs.list({ actor: 'owner', targetCardId: 'card-b' }).length;
  await controller.propose({ source: sourceSelection, targetCardId: 'card-b' });
  assert.equal(controller.getSnapshot().uncertain, true);
  sourceSelection.id = 'changed-after-send';
  await controller.retrySameRequest();
  assert.equal(controller.getSnapshot().uncertain, false);
  assert.deepEqual(posts[3], posts[2], 'explicit retry must reuse the original ID and frozen payload');
  assert.equal(handoffs.list({ actor: 'owner', targetCardId: 'card-b' }).length, countBeforeRetry + 1);
  assert.equal(runs, 0);
  await hub.shutdown();
  await start(false);
  assert.equal((await request(prefix + '/' + record.id)).status, 404);
  assert.equal(handoffs.get({ actor: 'owner', id: record.id }).snapshot.text, record.snapshot.text);
  assert.equal((await request('/v1/cards', { requestId: 'chat-still-works', id: 'card-c', canvasId: 'canvas', sessionId: 'session-c', title: 'Independent chat', x: 0, y: 0 })).status, 201);
  assert.equal(runs, 0);
});
