import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertSdkManifest, assertSdkApi, loadSelectedSdk, loadSelectedMcpSupport } from '../sdk-compat.mjs';

const name = '@earendil-works/pi-coding-agent';
test('SDK qualification accepts only tested identities, never arbitrary semver', () => {
  for (const version of ['1.3.0', '1.4.0']) assert.equal(assertSdkManifest({ name, version }), version);
  for (const value of [null, {}, { name: 'decoy', version: '1.4.0' }, ...['1.2.0', '1.4.1', '1.5.0', '2.0.0', '1.4.0-dev', 'latest'].map(version => ({ name, version }))]) {
    assert.throws(() => assertSdkManifest(value), { code: 'SDK_VERSION_UNSUPPORTED' });
  }
});

test('each mandatory SDK API fails closed before any runtime is created', () => {
  const fn = () => { throw Error('API gate must not invoke SDK functions'); };
  const api = () => ({ ModelRuntime: { create: fn }, SessionManager: { open: fn, continueRecent: fn }, SettingsManager: { inMemory: fn }, DefaultResourceLoader: fn, createAgentSessionFromServices: fn, createAgentSessionRuntime: fn });
  assertSdkApi(api());
  for (const field of ['ModelRuntime.create', 'SessionManager.open', 'SessionManager.continueRecent', 'SettingsManager.inMemory', 'DefaultResourceLoader', 'createAgentSessionFromServices', 'createAgentSessionRuntime']) {
    const broken = api(), parts = field.split('.');
    if (parts.length === 1) broken[field] = undefined; else broken[parts[0]][parts[1]] = undefined;
    assert.throws(() => assertSdkApi(broken), { code: 'SDK_API_UNSUPPORTED' }, field);
  }
});

test('selected real SDK and private MCP shim satisfy the same qualification contract', async () => {
  const { sdk, manifest } = await loadSelectedSdk(process.env.AYLACHI_SDK_ROOT);
  assertSdkApi(sdk);
  const mcp = await loadSelectedMcpSupport(process.env.AYLACHI_SDK_ROOT);
  assert.equal(typeof mcp.StreamableHttpTransport, 'function');
  assert.equal(typeof mcp.createCredentials, 'function');
  console.log(JSON.stringify({ sdk: `${manifest.name}@${manifest.version}`, root: process.env.AYLACHI_SDK_ROOT, node: process.version }));
});

test('MCP shim rejects a qualified but mixed SDK/MCP cohort before importing it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-sdk-cohort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = JSON.parse(await readFile(join(process.env.AYLACHI_SDK_ROOT, 'package.json'), 'utf8'));
  const version = actual.version === '1.3.0' ? '1.4.0' : '1.3.0';
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version, type: 'module' }));
  await symlink(join(process.env.AYLACHI_SDK_ROOT, '../..'), join(root, 'node_modules'), 'dir');
  await assert.rejects(loadSelectedMcpSupport(root), { code: 'SDK_COHORT_UNSUPPORTED' });
});

// Run the production worker entry, not a mock of its version/API checks.
for (const mode of ['version', 'api']) test(`production worker rejects unsupported ${mode} before auth/model execution`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-sdk-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdkRoot = join(root, 'sdk'), marker = join(root, 'sdk-imported');
  await mkdir(join(sdkRoot, 'dist'), { recursive: true });
  await writeFile(join(sdkRoot, 'package.json'), JSON.stringify({ name, version: mode === 'version' ? '2.0.0' : '1.4.0', type: 'module' }));
  await writeFile(join(sdkRoot, 'dist/index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export const ModelRuntime = { create() { writeFileSync(${JSON.stringify(join(root, 'runtime-created'))}, 'unsafe'); throw Error('must not create'); } };`);
  const child = fork(fileURLToPath(new URL('../../runtime/pi-worker.mjs', import.meta.url)), [], {
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), AYLACHI_DEV_STATE_ROOT: root,
      AYLACHI_SDK_ROOT: sdkRoot, AYLACHI_DEV_AUTH_PATH: join(root, 'synthetic-missing-auth'), AYLACHI_DEV_DEADLINE_MS: String(Date.now() + 60_000) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const messages = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('worker timeout')); }, 5000);
    child.on('message', message => messages.push(message));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  assert.deepEqual(messages, [{ type: 'startup_error', code: mode === 'version' ? 'SDK_VERSION_UNSUPPORTED' : 'SDK_API_UNSUPPORTED' }]);
  await assert.rejects(readFile(join(root, 'runtime-created')), { code: 'ENOENT' });
  if (mode === 'version') await assert.rejects(readFile(marker), { code: 'ENOENT' });
  else assert.equal(await readFile(marker, 'utf8'), 'imported');
});
