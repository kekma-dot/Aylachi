import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { openSatelliteStore } from './store.mjs';
import { createSatellitePlane } from './plane.mjs';
import { createSatelliteServer } from './server.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const secret = 'process-satellite-secret-0123456789abcdef';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Satellite runs as a separate OS process and closes without leaking service credentials', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-satellite-process-')), workspace = join(root, 'workspace');
  await writeFile(join(root, 'note.txt'), 'child process payload');
  const store = openSatelliteStore(join(root, 'hub.sqlite'));
  const registration = { id: 'sat-process', secret, tools: ['native.workspace.read'], capabilities: ['workspace.read'] };
  const plane = createSatellitePlane({ store, registrations: [registration] });
  const server = createSatelliteServer({ plane, registrations: [registration] });
  const address = await server.listen();
  const moduleDir = resolve(MODULE_DIR);
  const childCode = `
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const load = name => import(pathToFileURL(join(process.env.TEST_MODULE_DIR, name)).href);
    const { createSatelliteClient } = await load('client.mjs');
    const { createNativeConnector } = await load('connectors.mjs');
    const { openSatelliteExecutionStore } = await load('execution-store.mjs');
    const executionStore = openSatelliteExecutionStore(join(process.env.TEST_ROOT, 'child.sqlite'));
    const client = createSatelliteClient({ baseUrl: process.env.TEST_BASE_URL, satelliteId: 'sat-process',
      secret: process.env.TEST_SECRET, executionStore, pollIntervalMs: 5,
      connectors: [createNativeConnector({ root: process.env.TEST_ROOT })] });
    await client.start();
    process.stdout.write('READY\\n');
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await client.stop(); executionStore.close(); process.stdout.write('STOPPED\\n'); process.exit(0); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, TEST_MODULE_DIR: moduleDir,
      TEST_BASE_URL: `http://127.0.0.1:${address.port}`, TEST_SECRET: secret, TEST_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const exit = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  try {
    for (let index = 0; index < 300 && !output.includes('READY\n'); index++) await sleep(10);
    assert.ok(output.includes('READY\n'), errors);
    const { command } = plane.invoke({ actor: 'owner', requestId: 'process-native', toolName: 'native.workspace.read', payload: { path: 'note.txt' } });
    let result;
    for (let index = 0; index < 300; index++) {
      result = plane.get({ actor: 'owner', commandId: command.id });
      if (result.state === 'SUCCEEDED') break;
      await sleep(10);
    }
    assert.equal(result.state, 'SUCCEEDED'); assert.equal(result.result.text, 'child process payload');
    child.kill('SIGTERM');
    assert.deepEqual(await exit, { code: 0, signal: null });
    assert.ok(output.includes('STOPPED\n'));
    assert.equal(output.includes(secret), false); assert.equal(errors.includes(secret), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await server.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});
