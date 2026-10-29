import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createHubClient } from './hub-client.mjs';

// SSR + pure-helper coverage only, matching the existing desktop-ui test style.
// Dynamic behavior (ReactDOM clicks/effects) is NOT_PROVEN here; parent runs the
// actual browser/Hub integration separately.

let vite;
let WorkspaceEntry;
let validateCatalog;
let validateCreateReceipt;
let matchesIntentIdentity;
let createIntent;
let createCatalogReads;
before(async () => {
  vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  ({ default: WorkspaceEntry, validateCatalog, validateCreateReceipt, matchesIntentIdentity, createIntent, createCatalogReads } = await vite.ssrLoadModule('/WorkspaceEntry.jsx'));
});
after(async () => { await vite?.close(); });

const canvasId = 'canvas-a';
const card = (id, sessionId, overrides = {}) => ({ id, canvasId, sessionId, title: id, x: 1, y: -2, revision: 1, ...overrides });
const context = { client: {}, canvasId, generation: 0 };

test('WorkspaceEntry SSR shows accessible initial loading without fetching or exposing the bearer', () => {
  let requests = 0;
  const bearer = 'synthetic-workspace-entry-not-a-user-credential';
  const client = createHubClient({ baseUrl: 'http://127.0.0.1:46232', bearer, fetch: async () => {
    requests++;
    throw new Error('UNEXPECTED_SSR_NETWORK');
  } });
  const html = renderToStaticMarkup(React.createElement(WorkspaceEntry, { client, canvasId: 'fixture' }));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Loading cards/);
  assert.doesNotMatch(html, /Refresh cards|New chat|Chat A|Chat B/);
  assert.equal(requests, 0, 'SSR does not run the catalog effect');
  assert.ok(!html.includes(bearer));
});

test('WorkspaceEntry SSR stays safe when the client lacks the create API', () => {
  const html = renderToStaticMarkup(React.createElement(WorkspaceEntry, { client: {}, canvasId: 'fixture' }));
  assert.match(html, /Loading cards/);
  assert.doesNotMatch(html, /New chat/);
});

test('liveness regression: render-time disabled checks use reactive state, never a ref', async () => {
  // Parent browser RED on the original scratch: finishOperation cleared
  // operationRef AFTER setMutation rendered terminal-state controls, and a ref
  // clear triggers no re-render, so Retry same request stayed disabled forever.
  // Guard the fix shape: render must depend on reactive inFlight/busy only.
  const source = await readFile(new URL('./WorkspaceEntry.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('const [inFlight, setInFlight] = React.useState(false);'),
    'operation-in-flight must be mirrored into reactive state');
  const disabledExpressions = source.match(/disabled=\{[^}]+\}/g) ?? [];
  assert.ok(disabledExpressions.length > 0);
  for (const expression of disabledExpressions) {
    assert.ok(!expression.includes('operationRef'),
      `render-time disabled check must not read a non-reactive ref: ${expression}`);
  }
  const canCreate = source.match(/const canCreate =[\s\S]*?;/);
  assert.ok(canCreate && !canCreate[0].includes('operationRef'),
    'canCreate render check must not read a non-reactive ref');
});

test('refresh-liveness regression: same-context catalog reload must not reset the pending intent', async () => {
  // Parent source review: the catalog effect cleanup reset mutationRef to
  // IDLE_MUTATION(generation+1) on EVERY effect rerun (attempt/refreshVersion),
  // desyncing the ref from mutation state — enabled-but-inert recovery controls
  // after a generic Refresh cards / Retry card discovery. The pending intent and
  // its original IDs must survive same-context refreshes; only a real client/
  // canvas change (generation effect) or unmount resets ownership.
  const source = await readFile(new URL('./WorkspaceEntry.jsx', import.meta.url), 'utf8');
  assert.ok(!source.includes('IDLE_MUTATION(expected.generation + 1)'),
    'catalog effect cleanup must not reset mutationRef on same-context refresh');
  const refWrites = source.match(/mutationRef\.current\s*=[\s\S]*?;/g) ?? [];
  assert.deepEqual(refWrites.map(write => write.split('=')[0].trim()), ['mutationRef.current'],
    'mutationRef must be written only through setMutation, keeping ref and state in sync');
  assert.equal(refWrites.length, 1);
  assert.ok(refWrites[0].includes('= next;'),
    'the single mutationRef write must mirror the state update');
});

test('catalog read race: a delayed older read may not publish over a newer authoritative catalog', () => {
  // Parent Chromium race FAIL5/6: refresh list#2 captured the old one-card
  // snapshot and returned late; reconcile list#3 had already published the
  // accepted two-card catalog. The stale response overwrote it. The freshness
  // ticket must invalidate any read begun before the latest one, on both the
  // success and error paths, while the newest read stays publishable.
  const reads = createCatalogReads();
  const staleRefresh = reads.begin();          // list#2 starts (slow)
  assert.equal(reads.fresh(staleRefresh), true, 'latest read may publish');
  const reconcile = reads.begin();             // list#3 starts later
  assert.equal(reads.fresh(staleRefresh), false,
    'delayed older read must be discarded, not roll back the accepted catalog');
  assert.equal(reads.fresh(reconcile), true, 'the newest read remains authoritative');
  const laterRefresh = reads.begin();
  assert.equal(reads.fresh(reconcile), false);
  assert.equal(reads.fresh(laterRefresh), true);
});

test('catalog validation allows only bounded, well-formed additive updates', () => {
  const first = card('card-a', 'session-a');
  const prior = [first];
  const updated = { ...first, title: 'Renamed', x: 1e100, y: -1e100, revision: 2 };
  const added = card('card-b', 'session-b');
  assert.deepEqual(validateCatalog({ cards: [updated, added] }, canvasId, prior), [updated, added]);
  assert.deepEqual(validateCatalog({ cards: [] }, canvasId), []);
  const modelOnly = { ...first, modelProvider: 'openai-codex', modelId: 'gpt-6-luna', reasoning: 'low' };
  assert.deepEqual(validateCatalog({ cards: [modelOnly] }, canvasId), [modelOnly]);

  const tooMany = Array.from({ length: 101 }, (_, i) => card(`card-${i}`, `session-${i}`));
  assert.throws(() => validateCatalog({ cards: tooMany }, canvasId), { code: 'INVALID_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [first, { ...first, sessionId: 'session-b' }] }, canvasId), { code: 'INVALID_SESSION_MAPPING' });
  assert.throws(() => validateCatalog({ cards: [first, card('card-b', 'session-a')] }, canvasId), { code: 'INVALID_SESSION_MAPPING' });
  assert.throws(() => validateCatalog({ cards: [{ ...first, title: '' }] }, canvasId), { code: 'INVALID_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [{ ...first, title: 'x'.repeat(4097) }] }, canvasId), { code: 'INVALID_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [{ ...first, x: Infinity }] }, canvasId), { code: 'INVALID_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [{ ...first, y: NaN }] }, canvasId), { code: 'INVALID_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [{ ...first, revision: 0 }] }, canvasId), { code: 'INVALID_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [{ ...first, revision: Number.MAX_SAFE_INTEGER + 1 }] }, canvasId), { code: 'INVALID_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [{ ...first, extra: true }] }, canvasId), { code: 'INVALID_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [first] }, canvasId, [first, added]), { code: 'NON_ADDITIVE_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [] }, canvasId, prior), { code: 'INVALID_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [{ ...first, sessionId: 'session-remapped' }] }, canvasId, prior), { code: 'NON_ADDITIVE_CATALOG' });
  assert.throws(() => validateCatalog({ cards: [{ ...first, canvasId: 'canvas-other' }] }, canvasId, prior), { code: 'INVALID_SESSION_MAPPING' });
  assert.throws(() => validateCatalog({ cards: [first], extra: true }, canvasId), { code: 'INVALID_CATALOG' });
});

test('createIntent mints stable distinct ids and an immutable first-card payload', () => {
  const used = new Set();
  const intent = createIntent(context, [], used);
  assert.equal(intent.canvasId, canvasId);
  assert.equal(intent.generation, 0);
  for (const value of [intent.payload.id, intent.payload.sessionId, intent.requestId]) {
    assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  }
  assert.notEqual(intent.payload.id, intent.payload.sessionId);
  assert.notEqual(intent.payload.id, intent.requestId);
  assert.notEqual(intent.payload.sessionId, intent.requestId);
  assert.deepEqual(
    { canvasId: intent.payload.canvasId, title: intent.payload.title, x: intent.payload.x, y: intent.payload.y },
    { canvasId, title: 'New chat', x: 80, y: 80 },
    'first card on an empty canvas lands at the fixed origin',
  );
  assert.ok(Object.isFrozen(intent.payload) && Object.isFrozen(intent), 'intent and payload are immutable');
  assert.equal(used.size, 3, 'all minted ids are registered against reuse');
  const later = createIntent(context, [card('card-a', 'session-a'), card('card-b', 'session-b')], new Set());
  assert.deepEqual({ x: later.payload.x, y: later.payload.y }, { x: 80 + 2 * 520, y: 80 });
  const fourth = createIntent(context, ['a', 'b', 'c'].map((id, index) => card(id, `session-${index}`)), new Set());
  assert.deepEqual({ x: fourth.payload.x, y: fourth.payload.y }, { x: 80, y: 80 + 560 },
    'the fourth chat starts a non-overlapping second row');
});

test('createIntent never reuses catalog ids and fails closed when ids collide', () => {
  const existing = card('card-a', 'session-a');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => 'card-a' }, configurable: true });
  try {
    assert.throws(() => createIntent(context, [existing], new Set()), { code: 'ID_GENERATION_FAILED' });
  } finally {
    Object.defineProperty(globalThis, 'crypto', original);
  }
});

test('matchesIntentIdentity matches only immutable card/canvas/session identity', () => {
  const intent = createIntent(context, [], new Set());
  const evolved = {
    ...intent.payload, revision: 7,
    title: 'Renamed by the authoritative catalog', x: -5000, y: 9000,
  };
  assert.equal(matchesIntentIdentity(evolved, intent.payload), true,
    'legitimate title/position/revision changes must not trap the intent');
  assert.equal(matchesIntentIdentity({ ...evolved, sessionId: 'session-other' }, intent.payload), false);
  assert.equal(matchesIntentIdentity({ ...evolved, canvasId: 'canvas-other' }, intent.payload), false);
  assert.equal(matchesIntentIdentity({ ...evolved, id: 'card-other' }, intent.payload), false);
});

test('validateCreateReceipt requires an exact echoed ack with a duplicate boolean', () => {
  const intent = createIntent(context, [], new Set());
  const echoed = { ...intent.payload, revision: 1 };
  assert.deepEqual(validateCreateReceipt({ card: echoed, duplicate: false }, intent), echoed);
  assert.deepEqual(validateCreateReceipt({ card: echoed, duplicate: true }, intent), echoed,
    'same-request retry acknowledged as duplicate is a valid receipt');

  const bad = [
    {},
    { card: echoed },
    { card: echoed, duplicate: 'yes' },
    { card: echoed, duplicate: false, extra: true },
    { card: { ...echoed, sessionId: 'session-other' }, duplicate: false },
    { card: { ...echoed, title: 'Different title' }, duplicate: false },
    { card: { ...echoed, x: echoed.x + 1 }, duplicate: false },
    { card: { ...echoed, revision: 0 }, duplicate: false },
    { card: { ...echoed, extra: true }, duplicate: false },
    { card: 'card', duplicate: false },
  ];
  for (const receipt of bad) {
    assert.throws(() => validateCreateReceipt(receipt, intent), failure => {
      assert.equal(failure.code, 'INVALID_RESPONSE');
      assert.equal(failure.unknownOutcome, true, 'a mismatched ack is an unknown outcome, never a dispatch');
      return true;
    });
  }
});
