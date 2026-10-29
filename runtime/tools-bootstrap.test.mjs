import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { snapshotToolsBootstrap } from './tools-bootstrap.mjs';
import { readToolsBootstrap } from './pi-worker.mjs';

const binding = { projectId: 'alpha', cardId: 'card-alpha', sessionId: 'session-alpha', bazaPrefix: '10 Проекты/Alpha/' };
const frame = () => ({ type: 'tools_bootstrap', connection: { baseUrl: 'http://127.0.0.1:12345', bearer: 'a'.repeat(64) }, delegationSessionIds: [], projectBindings: [{ ...binding }] });
const channel = () => Object.assign(new EventEmitter(), { connected: true });
const env = { AYLACHI_DEV_TOOLS: '1' };

test('combined private bootstrap snapshots both capabilities; disabled reader touches no IPC', async () => {
  const ipc = channel();
  assert.equal(readToolsBootstrap(ipc, {}), undefined);
  assert.equal(ipc.listenerCount('message'), 0);
  const original = frame(); original.delegationSessionIds.push(binding.sessionId);
  const pending = readToolsBootstrap(ipc, env);
  ipc.emit('message', original);
  const result = await pending;
  assert.deepEqual(result, original);
  assert.ok(Object.isFrozen(result.projectBindings[0]));
  assert.ok(Object.isFrozen(result.delegationSessionIds));
  original.projectBindings[0].projectId = 'changed'; original.delegationSessionIds.length = 0;
  assert.equal(result.projectBindings[0].projectId, 'alpha');
  assert.deepEqual(result.delegationSessionIds, [binding.sessionId]);
  for (const event of ['message', 'error', 'disconnect']) assert.equal(ipc.listenerCount(event), 0);
});

test('malformed capability frames and mutually exclusive flags fail without getter effects', async () => {
  let accesses = 0;
  const accessor = frame(); Object.defineProperty(accessor.projectBindings[0], 'projectId', { enumerable: true, get() { accesses++; return 'alpha'; } });
  const bad = [null, { ...frame(), extra: true }, { ...frame(), projectBindings: [] }, accessor,
    { ...frame(), delegationSessionIds: ['same', 'same'] }, { ...frame(), delegationSessionIds: new Array(1) },
    { ...frame(), connection: { ...frame().connection, baseUrl: 'https://example.com/' } },
    { ...frame(), projectBindings: [{ ...binding, bazaPrefix: `10 Проекты/${'x'.repeat(33000)}/` }] }];
  for (const value of bad) {
    assert.throws(() => snapshotToolsBootstrap(value), { code: 'TOOLS_BOOTSTRAP_INVALID' });
    const ipc = channel(), pending = readToolsBootstrap(ipc, env);
    ipc.emit('message', value);
    await assert.rejects(pending, { code: 'HOST_START_FAILED' });
    for (const event of ['message', 'error', 'disconnect']) assert.equal(ipc.listenerCount(event), 0);
  }
  assert.equal(accesses, 0);
  assert.throws(() => readToolsBootstrap(channel(), { ...env, AYLACHI_DEV_DELEGATION: '1' }), { code: 'HOST_START_FAILED' });
  assert.throws(() => readToolsBootstrap(channel(), { AYLACHI_DEV_TOOLS: '0' }), { code: 'HOST_START_FAILED' });
});

test('native MCP-only bootstrap needs no fabricated project or delegation binding', () => {
  const native = { cardId: 'card-mcp', sessionId: 'session-mcp', serverName: 'echo', url: 'http://127.0.0.1:43123/mcp', tools: ['echo'] };
  const original = { ...frame(), projectBindings: [], nativeMcpBindings: [native] };
  const result = snapshotToolsBootstrap(original);
  native.tools.push('later');
  assert.deepEqual(result.projectBindings, []);
  assert.deepEqual(result.delegationSessionIds, []);
  assert.deepEqual(result.nativeMcpBindings[0].tools, ['echo']);
  assert.ok(Object.isFrozen(result.nativeMcpBindings[0]));
  assert.throws(() => snapshotToolsBootstrap({ ...original, nativeMcpBindings: [] }), { code: 'TOOLS_BOOTSTRAP_INVALID' });
  assert.throws(() => snapshotToolsBootstrap({ ...original, nativeMcpBindings: undefined }), { code: 'TOOLS_BOOTSTRAP_INVALID' });
});

test('native skills-only private bootstrap snapshots content without fabricated project grants', () => {
  const original = { ...frame(), projectBindings: [], nativeSkillBindings: [{ cardId: 'skill-card', sessionId: 'skill-session', skills: [{ name: 'fixture', description: 'Synthetic skill', content: '# Inert\n' }] }] };
  const snapshot = snapshotToolsBootstrap(original);
  original.nativeSkillBindings[0].skills[0].content = 'changed';
  assert.equal(snapshot.nativeSkillBindings[0].skills[0].content, '# Inert\n');
  assert.ok(Object.isFrozen(snapshot.nativeSkillBindings[0].skills[0]));
  assert.deepEqual(snapshot.projectBindings, []);
  assert.deepEqual(snapshot.delegationSessionIds, []);
  assert.throws(() => snapshotToolsBootstrap({ ...original, nativeSkillBindings: [] }), { code: 'TOOLS_BOOTSTRAP_INVALID' });
});

test('private tools bootstrap timeout/disconnect fails closed and removes listeners', async () => {
  for (const disconnect of [false, true]) {
    const ipc = channel(), pending = readToolsBootstrap(ipc, env, { timeoutMs: 10 });
    if (disconnect) ipc.emit('disconnect');
    await assert.rejects(pending, { code: 'HOST_START_FAILED' });
    for (const event of ['message', 'error', 'disconnect']) assert.equal(ipc.listenerCount(event), 0);
  }
});
