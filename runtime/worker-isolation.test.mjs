import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOfflineWorkerSpawn, snapshotWorkerIsolation } from './worker-isolation.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workerPath = join(repoRoot, 'runtime', 'pi-worker.mjs');
const invalid = { code: 'WORKER_ISOLATION_INVALID' };

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'aylachi-isolation-unit-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'state'), home = join(root, 'pi');
  const sdkRoot = join(home, 'synthetic-sdk'), authPath = join(home, 'synthetic-auth.json');
  await mkdir(root, { mode: 0o700 }); await chmod(root, 0o700);
  await mkdir(home, { mode: 0o700 }); await chmod(home, 0o700); await mkdir(sdkRoot, { mode: 0o700 });
  await writeFile(authPath, 'synthetic only', { mode: 0o600 }); await chmod(authPath, 0o600);
  return { parent, root, home, sdkRoot, authPath };
}

function onlyPaths(paths) {
  return { root: paths.root, sdkRoot: paths.sdkRoot, authPath: paths.authPath };
}

function launchOptions(paths, envOverrides = {}) {
  const home = join(paths.root, 'pi');
  return {
    cwd: join(paths.root, 'workspace'),
    env: {
      PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
      AYLACHI_DEV_STATE_ROOT: paths.root, AYLACHI_SDK_ROOT: paths.sdkRoot, AYLACHI_DEV_AUTH_PATH: paths.authPath,
      AYLACHI_DEV_DEADLINE_MS: String(Date.now() + 60_000), AYLACHI_DEV_MAX_SDK_CALLS: '4', ...envOverrides,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  };
}

async function makeSpawner(paths) {
  return prepareOfflineWorkerSpawn(onlyPaths(paths), () => ({ mocked: true }));
}

test('snapshotWorkerIsolation accepts only the opt-in literal', () => {
  assert.equal(snapshotWorkerIsolation(undefined), undefined);
  assert.equal(snapshotWorkerIsolation('bubblewrap-offline'), 'bubblewrap-offline');
  for (const value of [null, false, 0, '', 'bubblewrap', [], {}]) assert.throws(() => snapshotWorkerIsolation(value), invalid);
  let reads = 0;
  const accessor = Object.defineProperty({}, 'mode', { get() { reads++; return 'bubblewrap-offline'; } });
  assert.throws(() => snapshotWorkerIsolation(accessor), invalid);
  assert.equal(reads, 0);
});

test('rejects malformed preparation objects without invoking accessors', async t => {
  const paths = await fixture(t);
  let reads = 0;
  const accessor = Object.defineProperty({ sdkRoot: paths.sdkRoot, authPath: paths.authPath }, 'root', { get() { reads++; return paths.root; } });
  await assert.rejects(prepareOfflineWorkerSpawn(accessor), invalid);
  await assert.rejects(prepareOfflineWorkerSpawn({ ...onlyPaths(paths), extra: true }), invalid);
  await assert.rejects(prepareOfflineWorkerSpawn(Object.assign(Object.create({ inherited: true }), onlyPaths(paths))), invalid);
  assert.equal(reads, 0);
});

test('enforces canonical roots, auth lexical boundary, and SDK roots', { skip: process.platform !== 'linux' }, async t => {
  const paths = await fixture(t);
  await assert.rejects(makeSpawner({ ...paths, root: `${paths.root}/../state` }), invalid);
  await assert.rejects(makeSpawner({ ...paths, authPath: join(paths.parent, 'missing-auth') }), invalid);
  const outsideSdk = join(paths.parent, 'outside-sdk');
  await mkdir(outsideSdk);
  await assert.rejects(makeSpawner({ ...paths, sdkRoot: outsideSdk }), invalid);
  await assert.rejects(makeSpawner({ ...paths, root: repoRoot }), invalid);
});

test('rejects symlinked roots, SDKs, and auth paths', { skip: process.platform !== 'linux' }, async t => {
  const paths = await fixture(t);
  const rootLink = join(paths.parent, 'root-link');
  await symlink(paths.root, rootLink);
  await assert.rejects(makeSpawner({ ...paths, root: rootLink }), invalid);
  const sdkLink = join(paths.home, 'sdk-link');
  await symlink(paths.sdkRoot, sdkLink);
  await assert.rejects(makeSpawner({ ...paths, sdkRoot: sdkLink }), invalid);
  const authLink = join(paths.home, 'auth-link');
  await symlink(paths.authPath, authLink);
  await assert.rejects(makeSpawner({ ...paths, authPath: authLink }), invalid);

  const homePaths = await fixture(t), externalHome = join(homePaths.parent, 'external-home');
  await mkdir(externalHome, { mode: 0o700 });
  await rm(homePaths.home, { recursive: true, force: true });
  await symlink(externalHome, homePaths.home);
  await assert.rejects(makeSpawner(homePaths), invalid);
});

test('requires private owned state and a private single-link synthetic auth file', { skip: process.platform !== 'linux' }, async t => {
  const paths = await fixture(t);
  await chmod(paths.root, 0o755);
  await assert.rejects(makeSpawner(paths), invalid);
  await chmod(paths.root, 0o700);
  await chmod(paths.authPath, 0o644);
  await assert.rejects(makeSpawner(paths), invalid);
  await chmod(paths.authPath, 0o600);
  await chmod(paths.authPath, 0o700);
  await assert.rejects(makeSpawner(paths), invalid);
  await chmod(paths.authPath, 0o600);
  const hardlink = join(paths.home, 'auth-hardlink');
  await link(paths.authPath, hardlink);
  await assert.rejects(makeSpawner({ ...paths, authPath: hardlink }), invalid);
  assert.equal((await lstat(paths.authPath)).nlink, 2);
});

test('spawn wrapper validates exact worker invocation and environment', { skip: process.platform !== 'linux' }, async t => {
  const paths = await fixture(t);
  try { await lstat('/usr/bin/bwrap'); } catch {
    await assert.rejects(prepareOfflineWorkerSpawn(onlyPaths(paths), () => assert.fail('must not fall back')), { code: 'WORKER_ISOLATION_UNAVAILABLE' });
    return;
  }
  let captured;
  const child = { mocked: true };
  let spawnCalls = 0;
  const options = launchOptions(paths, { AYLACHI_DEV_TOOLS: '1' });
  const preparedSpawn = (...args) => { spawnCalls++; captured = args; return child; };
  const realSpawner = await prepareOfflineWorkerSpawn(onlyPaths(paths), preparedSpawn);
  assert.equal(realSpawner(process.execPath, [workerPath], options), child);
  assert.equal(spawnCalls, 1);
  const [command, args, spawnOptions] = captured;
  assert.equal(command, '/usr/bin/bwrap');
  assert.equal(spawnOptions.cwd, '/');
  assert.deepEqual(spawnOptions.env, {});
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(spawnOptions.windowsHide, true);
  for (const flag of ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '--dev', '--tmpfs', '--bind', '--ro-bind', '--chdir', '--clearenv']) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(args.includes('--preserve-fds'), false);
  const setenv = [];
  for (let index = 0; index < args.length; index++) if (args[index] === '--setenv') setenv.push([args[index + 1], args[index + 2]]);
  for (const [key, value] of Object.entries(options.env)) assert.ok(setenv.some(pair => pair[0] === key && pair[1] === value), `preserved ${key}`);
  assert.deepEqual(setenv.filter(([key]) => key === 'PATH').at(-1), ['PATH', '/usr/bin:/bin']);
  assert.ok(setenv.some(([key, value]) => key === 'NODE_CHANNEL_FD' && value === '3'));
  assert.ok(setenv.some(([key, value]) => key === 'NODE_CHANNEL_SERIALIZATION_MODE' && value === 'json'));
  assert.ok(!setenv.some(([key]) => key === 'AYLACHI_DEV_DELEGATION'));
  for (const path of [paths.root, paths.sdkRoot, paths.authPath, repoRoot, '/usr', '/lib', '/lib64']) assert.ok(args.includes(path));
  assert.ok(!args.includes(process.env.HOME), 'host HOME is never mounted');
  const tmpfsIndex = args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === '/tmp');
  const rwRootIndex = args.findIndex((value, index) => value === '--bind' && args[index + 2] === paths.root);
  assert.ok(rwRootIndex > tmpfsIndex && args.indexOf(paths.sdkRoot) > rwRootIndex && args.indexOf(paths.authPath) > rwRootIndex,
    'state root is mounted after private tmp and SDK/auth read-only overlays follow it');
  assert.equal(args.includes('/run/aylachi-state-root-source'), false, 'bind sources resolve from the host; no intermediate namespace path');

  const badCases = [
    ['wrong-node', [workerPath], options],
    [process.execPath, [workerPath, '--extra'], options],
    [process.execPath, [workerPath], { ...options, cwd: paths.parent }],
    [process.execPath, [workerPath], { ...options, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] }],
    [process.execPath, [workerPath], { ...options, env: { ...options.env, AYLACHI_DEV_DELEGATION: '1' } }],
    [process.execPath, [workerPath], { ...options, env: { ...options.env, NODE_OPTIONS: '' } }],
    [process.execPath, [workerPath], { ...options, env: Object.assign(Object.create({ inherited: 'x' }), options.env) }],
    [process.execPath, [workerPath], { ...options, env: { ...options.env, AYLACHI_DEV_TOOLS: 'true' } }],
    [process.execPath, [workerPath], { ...options, env: { ...options.env, AYLACHI_DEV_MAX_SDK_CALLS: '21' } }],
    [process.execPath, [workerPath], { ...options, env: { ...options.env, AYLACHI_DEV_DEADLINE_MS: '0' } }],
  ];
  for (const args of badCases) assert.throws(() => realSpawner(...args), invalid);
  let getterReads = 0;
  const getterEnv = { ...options.env };
  delete getterEnv.PATH;
  Object.defineProperty(getterEnv, 'PATH', { get() { getterReads++; return '/usr/bin'; }, enumerable: true });
  assert.throws(() => realSpawner(process.execPath, [workerPath], { ...options, env: getterEnv }), invalid);
  assert.equal(getterReads, 0);
  assert.equal(spawnCalls, 1, 'invalid invocations never spawn');
  const getterOptions = Object.defineProperty({ ...options }, 'cwd', { get() { getterReads++; return options.cwd; } });
  assert.throws(() => realSpawner(process.execPath, [workerPath], getterOptions), invalid);
  assert.equal(getterReads, 0);
});
