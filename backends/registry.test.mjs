import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackendRegistry } from './registry.mjs';
import { openBackendStore } from './store.mjs';

test('backend registry pins running conversations and isolates backend-owned scopes', async () => {
  const store = openBackendStore(':memory:');
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const makeAdapter = (id, root) => ({ id, revision: 1, capabilities: ['chat', 'events'],
    async health() { return { state: id === 'pi' ? 'READY' : 'DEGRADED' }; },
    async run(input) { calls.push({ id, root, cardId: input.card.id, sessionId: input.card.sessionId, backend: input.backend }); if (id === 'pi') await gate; return { text: `${id}:${input.card.sessionId}` }; },
    async dispose() { calls.push({ id, disposed: true }); } });
  const registry = createBackendRegistry({ store, adapters: [makeAdapter('pi', '/state/pi'), makeAdapter('synthetic', '/state/synthetic')] });
  const a = { id: 'card-a', sessionId: 'session-a' }, b = { id: 'card-b', sessionId: 'session-b' };
  registry.bind(a); registry.bind(b, 'synthetic');
  const running = registry.run({ card: a, input: { text: 'A' } });
  registry.setDefault('synthetic');
  release();
  assert.equal((await running).text, 'pi:session-a');
  assert.equal((await registry.run({ card: b, input: { text: 'B' } })).text, 'synthetic:session-b');
  assert.equal((await registry.run({ card: { id: 'card-c', sessionId: 'session-c' }, input: {} })).text, 'synthetic:session-c');
  assert.equal(calls[0].backend.backendId, 'pi');
  assert.equal(calls[0].root, '/state/pi');
  assert.equal(calls[1].root, '/state/synthetic');
  assert.equal(calls.filter(call => call.sessionId).length, 3);
  const { setDefault } = registry;
  assert.equal(setDefault('pi').defaultBackendId, 'pi');
  assert.throws(() => registry.bind({ ...a, sessionId: 'other' }), { code: 'BACKEND_BINDING_CONFLICT' });
  assert.deepEqual((await registry.health()).map(item => item.health.state), ['READY', 'DEGRADED']);
  await registry.shutdown(); await registry.shutdown();
  assert.equal(calls.filter(call => call.disposed).length, 2);
  await assert.rejects(() => registry.run({ card: b, input: {} }), { code: 'BACKEND_REGISTRY_CLOSED' });
  store.close();
});

test('incompatible backend descriptors are rejected before activation', () => {
  const store = openBackendStore(':memory:');
  assert.throws(() => createBackendRegistry({ store, adapters: [{ id: 'bad', revision: 1, capabilities: [], run() {} }] }), { code: 'INVALID_BACKEND_ADAPTER' });
  assert.throws(() => createBackendRegistry({ store, adapters: [{ id: 'pi', revision: 1, capabilities: ['chat'], run() {} }], defaultBackendId: 'missing' }), { code: 'DEFAULT_BACKEND_UNAVAILABLE' });
  store.close();
});
