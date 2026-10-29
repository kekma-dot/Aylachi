import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPiAdapter } from '../agent-host/pi-adapter.mjs';
import { sdk, Type, model, runtime } from '../agent-host/tests/fixture-runtime.mjs';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';

test('real HTTP Hub to actual SDK tool persists result; reconnect cannot dispatch it again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-hub-sdk-'));
  let store, adapter, hub;
  try {
    const cwd = join(root, 'workspace'); await mkdir(cwd);
    store = openStore(join(root, 'hub.sqlite'));
    const card = store.createCard({ id: 'card', canvasId: 'canvas', sessionId: 'session', title: 'test', x: 0, y: 0 });
    let effects = 0;
    adapter = createPiAdapter({ sdk, modelRuntime: runtime(), model, root: join(root, 'pi'), cwd, toolDefinitions: [{ name: 'fixture_echo', label: 'Fixture echo', description: 'Safe fixture', parameters: Type.Object({ text: Type.String() }), execute: async () => { effects++; return { content: [{ type: 'text', text: 'safe effect' }] }; } }] });
    const secret = 'synthetic-bearer-for-loopback-test-only';
    const options = {
      store, bearerSecret: secret, authContext: { principalId: 'fixture-owner', expiresAt: 2000, revoked: false, grants: ['session.message', 'events.read', 'snapshot.read', 'command.read'].map(operation => ({ effect: 'allow', permission: operation === 'session.message' ? 'write' : 'read', operation, projectId: 'project' })) }, now: () => 1,
      resolveTarget: ({ card: target }) => ({ projectId: 'project', cardId: target.id, sessionId: target.sessionId }),
      runner: async ({ card: target, input, signal }) => {
        const abort = () => { void adapter.cancel(target.sessionId); };
        signal.addEventListener('abort', abort, { once: true });
        try { return await adapter.prompt(target.sessionId, input.text); }
        finally { signal.removeEventListener('abort', abort); }
      },
    };
    hub = createHub(options);
    let address = await hub.listen();
    const post = () => fetch(`http://127.0.0.1:${address.port}/v1/cards/${card.id}/messages`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'one-logical-command', text: 'Use the safe fixture tool.' }) });
    assert.equal((await post()).status, 202);
    for (let attempts = 0; store.getCommand('one-logical-command').state !== 'COMPLETED' && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(store.getCommand('one-logical-command').state, 'COMPLETED');
    assert.equal(store.getCommand('one-logical-command').result.value.text, 'fixture complete');
    assert.equal(effects, 1);
    await hub.close(); hub = createHub(options); address = await hub.listen();
    const retry = await post(); assert.equal(retry.status, 202); assert.equal((await retry.json()).duplicate, true);
    assert.equal(effects, 1);
    assert.equal(store.getCard(card.id).sessionId, card.sessionId);
  } finally {
    if (hub) await hub.close();
    if (adapter) await adapter.shutdown();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
