import assert from 'node:assert/strict';
import test from 'node:test';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
const bearer = 'synthetic-origin-contract-not-a-user-credential';
const browser = 'http://127.0.0.1:1429';
function setup(t, options = {}) {
  const store = openStore(':memory:');
  let runnerCalls = 0;
  const config = {
    store, bearerSecret: bearer,
    authContext: { principalId: 'origin-test', expiresAt: Date.now() + 60000, revoked: false,
      grants: ['card.list', 'card.create'].map(operation => ({ effect: 'allow', permission: operation === 'card.create' ? 'write' : 'read', operation, projectId: 'origin-project' })) },
    resolveTarget({ operation, input }) {
      if (input?.canvasId !== 'fixture') return null;
      if (operation === 'card.list') return { projectId: 'origin-project' };
      return { projectId: 'origin-project', cardId: input.id, sessionId: input.sessionId };
    },
    runner: async () => { runnerCalls++; throw Error('UNEXPECTED_RUNNER'); },
    ...options,
  };
  let hub;
  t.after(async () => { if (hub) await hub.shutdown(); assert.equal(runnerCalls, 0); store.close(); });
  return { store, config, start() { hub = createHub(config); return hub.listen(); } };
}
const preflight = origin => ({ method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type' } });
async function consume(response, status, origin) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  await response.arrayBuffer();
}
test('default server origin remains native-only and keeps bearer authentication', async t => {
  const fixture = setup(t); const address = await fixture.start(); const base = `http://127.0.0.1:${address.port}`;
  await consume(await fetch(`${base}/v1/cards?canvasId=fixture`, preflight('tauri://localhost')), 204, 'tauri://localhost');
  await consume(await fetch(`${base}/v1/cards?canvasId=fixture`, preflight(browser)), 403, null);
  await consume(await fetch(`${base}/v1/cards?canvasId=fixture`, { headers: { Origin: 'tauri://localhost' } }), 401, 'tauri://localhost');
  const response = await fetch(`${base}/v1/cards?canvasId=fixture`, { headers: { Origin: 'tauri://localhost', Authorization: `Bearer ${bearer}` } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { cards: [] });
});
test('trusted explicit exact origin enables only that origin without bypassing auth', async t => {
  const fixture = setup(t, { allowedOrigin: browser }); const address = await fixture.start(); const base = `http://127.0.0.1:${address.port}`;
  await consume(await fetch(`${base}/v1/cards`, preflight(browser)), 204, browser);
  await consume(await fetch(`${base}/v1/cards?canvasId=fixture`, { headers: { Origin: browser } }), 401, browser);
  const payload = { id: 'origin-card', canvasId: 'fixture', sessionId: 'origin-session', title: 'Origin test', x: 0, y: 0, requestId: 'origin-request' };
  const response = await fetch(`${base}/v1/cards`, { method: 'POST', headers: { Origin: browser, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 201); assert.equal(response.headers.get('access-control-allow-origin'), browser);
  assert.equal((await response.json()).card.id, payload.id);
  assert.equal(fixture.store.getEvents(0, 100).length, 1);
  for (const origin of ['tauri://localhost', 'http://127.0.0.1:1430', 'http://127.0.0.1:1429.evil', 'null']) {
    await consume(await fetch(`${base}/v1/cards?canvasId=fixture`, { headers: { Origin: origin, Authorization: `Bearer ${bearer}` } }), 403, null);
  }
  await consume(await fetch(`${base}/v1/cards`, { method: 'POST', headers: { Origin: browser, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, id: 'denied-card', sessionId: 'denied-session', requestId: 'denied-request' }) }), 401, browser);
  assert.equal(fixture.store.getEvents(0, 100).length, 1);
  assert.equal(fixture.store.getCard('denied-card'), undefined);
});
test('invalid server-supplied origins are rejected before listening', t => {
  const fixture = setup(t);
  for (const allowedOrigin of ['*', 'null', '', browser + '/', 'http://user:password@127.0.0.1:1429', browser + '?x=1', browser + '#fragment', {}, []]) {
    assert.throws(() => createHub({ ...fixture.config, allowedOrigin }), TypeError);
  }
});
