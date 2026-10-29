import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRemoteReadOnlyAdapter, createLocalInteractiveAdapter } from './adapters.mjs';
import { createBrowserPlane } from './plane.mjs';
import { openBrowserStore } from './store.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = openBrowserStore(join(root, 'browser.sqlite'));
  t.after(() => store.close());
  return { store, ...options };
}

test('remote read-only navigation is bounded, idempotent and persists a safe text snapshot', async t => {
  let calls = 0;
  const remoteReadOnly = createRemoteReadOnlyAdapter({ fetch: async (_url, init) => {
    calls++;
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    return new Response('<html><head><title>Example</title><style>bad</style></head><body><script>alert(1)</script><h1>Safe page</h1><a href="https://example.com/docs">Docs</a><a href="javascript:bad()">Bad</a></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } });
  } });
  const { store } = await fixture(t);
  const plane = createBrowserPlane({ store, remoteReadOnly });
  const created = plane.create({ sessionId: 'session', canvasId: 'fixture', mode: 'remote-read-only', allowedHosts: ['example.com'], idempotencyKey: 'create' });
  assert.equal(created.session.activeTabId, 'tab-session');
  assert.equal(calls, 0);
  const navigated = await plane.navigate({ sessionId: 'session', expectedRevision: 1, url: 'https://example.com/start', idempotencyKey: 'navigate' });
  assert.equal(navigated.snapshot.title, 'Example');
  assert.equal(navigated.snapshot.text, 'Example Safe page Docs Bad');
  assert.deepEqual(navigated.snapshot.links, [{ href: 'https://example.com/docs', text: 'Docs' }]);
  assert.equal(calls, 1);
  const replay = await plane.navigate({ sessionId: 'session', expectedRevision: 1, url: 'https://example.com/start', idempotencyKey: 'navigate' });
  assert.equal(replay.idempotent, true);
  assert.equal(calls, 1);
  await assert.rejects(plane.navigate({ sessionId: 'session', expectedRevision: 1, url: 'https://example.com/other', idempotencyKey: 'navigate' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(calls, 1);
  assert.equal(store.read('session').snapshots.length, 1);
});

test('concurrent identical navigation shares one external read and one durable result', async t => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const remoteReadOnly = createRemoteReadOnlyAdapter({ fetch: async () => {
    calls++;
    await gate;
    return new Response('<title>Shared</title><p>One read</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  } });
  const { store } = await fixture(t);
  const plane = createBrowserPlane({ store, remoteReadOnly });
  plane.create({ sessionId: 'session', canvasId: 'fixture', mode: 'remote-read-only', allowedHosts: ['example.com'], idempotencyKey: 'create' });
  const input = { sessionId: 'session', expectedRevision: 1, url: 'https://example.com/shared', idempotencyKey: 'shared-navigation' };
  const requests = Promise.all([plane.navigate(input), plane.navigate(input)]);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(plane.navigate({ ...input, url: 'https://example.com/conflict' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  const controller = new AbortController();
  const joined = plane.navigate({ ...input, signal: controller.signal });
  controller.abort(Object.assign(new Error('ABORTED'), { code: 'ABORTED' }));
  const observedCalls = calls;
  release();
  const [first, second] = await requests;
  await assert.rejects(joined, error => error.code === 'ABORTED');
  assert.equal(observedCalls, 1, 'idempotency must cover the in-flight external effect, not only the committed row');
  assert.equal(first.snapshot.id, second.snapshot.id);
  assert.equal(store.read('session').snapshots.length, 1);
});

test('create and activate cannot steal an in-flight idempotency key', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const remoteReadOnly = createRemoteReadOnlyAdapter({ fetch: async () => {
    await gate;
    return new Response('<title>Shared</title><p>One read</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  } });
  const { store } = await fixture(t);
  const plane = createBrowserPlane({ store, remoteReadOnly });
  plane.create({ sessionId: 'session', canvasId: 'fixture', mode: 'remote-read-only', allowedHosts: ['example.com'], idempotencyKey: 'create' });
  const navigation = plane.navigate({ sessionId: 'session', expectedRevision: 1, url: 'https://example.com/shared', idempotencyKey: 'shared-navigation' });
  await new Promise(resolve => setImmediate(resolve));
  const activation = await Promise.resolve().then(() => plane.activate({ sessionId: 'session', tabId: 'tab-session', expectedRevision: 1, idempotencyKey: 'shared-navigation' })).then(() => null, error => error);
  let creation;
  try { plane.create({ sessionId: 'other', canvasId: 'fixture', mode: 'remote-read-only', allowedHosts: ['example.com'], idempotencyKey: 'shared-navigation' }); }
  catch (error) { creation = error; }
  release();
  await navigation;
  assert.equal(activation?.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(creation?.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(store.read('session').snapshots.length, 1);
});

test('redirect targets and stale CAS fail before a durable navigation commit', async t => {
  let calls = 0;
  const remoteReadOnly = createRemoteReadOnlyAdapter({ fetch: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://denied.example/' } });
  } });
  const { store } = await fixture(t);
  const plane = createBrowserPlane({ store, remoteReadOnly });
  plane.create({ sessionId: 'session', canvasId: 'fixture', mode: 'remote-read-only', allowedHosts: ['example.com'], idempotencyKey: 'create' });
  await assert.rejects(plane.navigate({ sessionId: 'session', expectedRevision: 1, url: 'https://example.com/', idempotencyKey: 'redirect' }), error => error.code === 'BROWSER_URL_DENIED');
  assert.equal(store.read('session').snapshots.length, 0);
  await assert.rejects(plane.navigate({ sessionId: 'session', expectedRevision: 99, url: 'https://example.com/', idempotencyKey: 'stale' }), error => error.code === 'REVISION_CONFLICT');
  assert.equal(calls, 1);
  assert.throws(() => plane.create({ sessionId: 'other', canvasId: 'fixture', mode: 'remote-read-only', allowedHosts: [], idempotencyKey: 'bad' }), error => error.code === 'INVALID_BROWSER_POLICY');
});

test('local interactive accepts only trusted snapshots and never navigates through Core', async t => {
  let snapshots = 0;
  const localInteractive = createLocalInteractiveAdapter({ snapshot: async ({ sessionId }) => {
    snapshots++;
    return { url: 'https://local.example/current', title: `Local ${sessionId}`, text: 'Human controlled page', links: [] };
  } });
  const { store } = await fixture(t);
  const plane = createBrowserPlane({ store, localInteractive });
  plane.create({ sessionId: 'local', canvasId: 'fixture', mode: 'local-interactive', allowedHosts: [], idempotencyKey: 'create-local' });
  await assert.rejects(plane.navigate({ sessionId: 'local', expectedRevision: 1, url: 'https://local.example/', idempotencyKey: 'navigate-local' }), error => error.code === 'LOCAL_BROWSER_CONTROLS_NAVIGATION');
  assert.equal(snapshots, 0);
  const result = await plane.refresh({ sessionId: 'local', expectedRevision: 1, idempotencyKey: 'refresh-local' });
  assert.equal(result.snapshot.text, 'Human controlled page');
  assert.equal(snapshots, 1);
  await plane.refresh({ sessionId: 'local', expectedRevision: 1, idempotencyKey: 'refresh-local' });
  assert.equal(snapshots, 1);
  assert.deepEqual(plane.health(), { 'remote-read-only': { state: 'UNAVAILABLE' }, 'local-interactive': { state: 'READY', transport: 'trusted-local-snapshot' } });
});
