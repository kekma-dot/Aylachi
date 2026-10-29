import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDevelopmentServer } from './server.mjs';
import { snapshotNativeMcpBindings } from './native-mcp-config.mjs';

const binding = () => ({ cardId: 'card-a', sessionId: 'session-a', serverName: 'echo', url: 'http://127.0.0.1:43123/mcp', tools: ['echo'] });
const denied = error => error?.code === 'NATIVE_MCP_CONFIG_INVALID';

test('native MCP bindings are immutable startup snapshots, including empty disabled config', () => {
  const input = [binding()];
  const output = snapshotNativeMcpBindings(input);
  input[0].tools.push('later'); input[0].url = 'http://localhost:43123/mcp';
  assert.deepEqual(output, [binding()]);
  assert.ok(Object.isFrozen(output) && Object.isFrozen(output[0]) && Object.isFrozen(output[0].tools));
  assert.deepEqual(snapshotNativeMcpBindings([]), []);
});

test('native MCP rejects malformed, duplicate, excessive or noncanonical bindings', () => {
  for (const input of [undefined, null, {}, new Array(1), [binding(), binding()],
    [{ ...binding(), serverName: 'echo-server' }], [{ ...binding(), tools: [] }],
    [{ ...binding(), tools: ['echo', 'echo'] }], [{ ...binding(), tools: ['../echo'] }],
    [{ ...binding(), url: 'http://localhost:43123/mcp' }], [{ ...binding(), cardId: '../card' }],
    [{ ...binding(), command: 'shell' }], [{ ...binding(), tools: new Array(1) }],
    Array.from({ length: 4 }, (_, i) => ({ ...binding(), cardId: `card-${i}`, sessionId: `session-${i}` })),
  ]) assert.throws(() => snapshotNativeMcpBindings(input), denied);
});

test('server rejects malformed native MCP startup config before state/auth access', async t => {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'aylachi-native-config-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  let calls = 0;
  const inputs = [null, {}, { bindings: [] }, { bindings: [binding()], extra: true },
    { get bindings() { calls++; return [binding()]; } }];
  for (const [index, nativeMcp] of inputs.entries()) {
    const root = join(scratch, String(index));
    await assert.rejects(startDevelopmentServer({ stateRoot: root, port: 0, allowLive: true, sdkRoot: '/missing-sdk', nativeMcp }), denied);
    await assert.rejects(lstat(root), { code: 'ENOENT' });
  }
  await assert.rejects(startDevelopmentServer({ stateRoot: join(scratch, 'disabled'), nativeMcp: { bindings: [binding()] } }), denied);
  assert.equal(calls, 0);
});

test('native MCP schema does not invoke accessors', () => {
  let calls = 0;
  const input = binding();
  Object.defineProperty(input, 'url', { enumerable: true, get() { calls++; return 'http://127.0.0.1:43123/mcp'; } });
  assert.throws(() => snapshotNativeMcpBindings([input]), denied);
  const array = [binding()];
  Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return binding(); } });
  assert.throws(() => snapshotNativeMcpBindings(array), denied);
  assert.equal(calls, 0);
});
