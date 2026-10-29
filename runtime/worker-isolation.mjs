import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER_PATH = join(REPO_ROOT, 'runtime', 'pi-worker.mjs');
const BWRAP = '/usr/bin/bwrap';
const HOME_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];
const ENV_KEYS = new Set([
  'PATH', ...HOME_KEYS, 'AYLACHI_DEV_STATE_ROOT', 'AYLACHI_SDK_ROOT', 'AYLACHI_DEV_AUTH_PATH',
  'AYLACHI_DEV_DEADLINE_MS', 'AYLACHI_DEV_MAX_SDK_CALLS', 'AYLACHI_DEV_TOOLS',
]);
const ROOT_MODE = 0o700;
const AUTH_MODE = 0o600;
const MAX_WORKER_LIFETIME_MS = 30 * 60_000;

function fail(code = 'WORKER_ISOLATION_INVALID') {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function dataRecord(value, keys, exact = true) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if ((exact && ownKeys.length !== keys.length) || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const result = Object.create(null);
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}

function canonicalAbsolute(value) {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function privateStat(info, uid, mode) {
  return info.uid === uid && (info.mode & 0o7777) === mode;
}

async function checkedRoot(root) {
  if (!canonicalAbsolute(root)) fail();
  let info, canonical;
  try { info = await lstat(root); canonical = await realpath(root); } catch { fail(); }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== root || !privateStat(info, process.getuid(), ROOT_MODE)) fail();
  return root;
}

async function checkedAuth(authPath, root) {
  const home = join(root, 'pi');
  // Do this lexical boundary check before any metadata lookup of authPath.
  if (!canonicalAbsolute(authPath) || !within(home, authPath) || authPath === home) fail();
  let homeInfo, homeCanonical;
  try { homeInfo = await lstat(home); homeCanonical = await realpath(home); } catch { fail(); }
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink() || homeCanonical !== home ||
      !privateStat(homeInfo, process.getuid(), ROOT_MODE)) fail();
  const segments = relative(home, authPath).split(sep);
  let current = home, info;
  try {
    for (let index = 0; index < segments.length; index++) {
      current = join(current, segments[index]);
      info = await lstat(current);
      if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory())) fail();
    }
    if (await realpath(authPath) !== authPath) fail();
  } catch (error) {
    if (error?.code === 'WORKER_ISOLATION_INVALID') throw error;
    fail();
  }
  if (!info.isFile() || !privateStat(info, process.getuid(), AUTH_MODE) || info.nlink !== 1) fail();
  return authPath;
}

async function checkedSdk(sdkRoot, root, repoRoot) {
  if (!canonicalAbsolute(sdkRoot)) fail();
  let info, canonical;
  try { info = await lstat(sdkRoot); canonical = await realpath(sdkRoot); } catch { fail(); }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== sdkRoot) fail();
  const piRoot = join(root, 'pi');
  if (sdkRoot === piRoot || !within(piRoot, sdkRoot)) {
    const repoModules = join(repoRoot, 'node_modules');
    let canonicalModules;
    try { canonicalModules = await realpath(repoModules); } catch { fail(); }
    if (canonicalModules !== repoModules || sdkRoot === repoModules || !within(repoModules, sdkRoot)) fail();
  }
  return sdkRoot;
}

function readStdio(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (value.length !== 4 || keys.length !== 5 || !['0', '1', '2', '3', 'length'].every(key => keys.includes(key))) return null;
    const result = [];
    for (let index = 0; index < 4; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result.push(descriptor.value);
    }
    return result;
  } catch { return null; }
}

function checkedEnvironment(value, { root, sdkRoot, authPath }) {
  const env = dataRecord(value, [...ENV_KEYS], false);
  if (!env || Object.keys(env).some(key => !ENV_KEYS.has(key))) fail();
  const home = join(root, 'pi');
  for (const key of ['PATH', ...HOME_KEYS, 'AYLACHI_DEV_STATE_ROOT', 'AYLACHI_SDK_ROOT', 'AYLACHI_DEV_AUTH_PATH', 'AYLACHI_DEV_DEADLINE_MS']) {
    if (typeof env[key] !== 'string' || env[key].includes('\0')) fail();
  }
  if (!env.PATH.length || env.PATH.length > 4096 || /[\x00-\x1f\x7f]/.test(env.PATH)) fail();
  if (env.HOME !== home || env.XDG_CONFIG_HOME !== home || env.XDG_DATA_HOME !== home ||
      env.AYLACHI_DEV_STATE_ROOT !== root || env.AYLACHI_SDK_ROOT !== sdkRoot || env.AYLACHI_DEV_AUTH_PATH !== authPath) fail();
  if (!/^[1-9]\d{0,15}$/.test(env.AYLACHI_DEV_DEADLINE_MS)) fail();
  const deadline = Number(env.AYLACHI_DEV_DEADLINE_MS);
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + MAX_WORKER_LIFETIME_MS + 5_000) fail();
  if (Object.hasOwn(env, 'AYLACHI_DEV_MAX_SDK_CALLS') &&
      (typeof env.AYLACHI_DEV_MAX_SDK_CALLS !== 'string' || !/^(?:[1-9]|1\d|20)$/.test(env.AYLACHI_DEV_MAX_SDK_CALLS))) fail();
  if (Object.hasOwn(env, 'AYLACHI_DEV_TOOLS') && env.AYLACHI_DEV_TOOLS !== '1') fail();
  return env;
}

function noOverlap(left, right) {
  return !within(left, right) && !within(right, left);
}

export function snapshotWorkerIsolation(value) {
  if (value === undefined) return undefined;
  if (value === 'bubblewrap-offline') return value;
  fail();
}

export async function prepareOfflineWorkerSpawn(options, spawnImpl = spawn) {
  const fields = dataRecord(options, ['root', 'sdkRoot', 'authPath']);
  if (!fields || typeof spawnImpl !== 'function') fail();
  if (process.platform !== 'linux') fail('WORKER_ISOLATION_UNAVAILABLE');
  const root = await checkedRoot(fields.root);
  const repoRoot = await realpath(REPO_ROOT);
  if (!noOverlap(root, repoRoot)) fail();
  const authPath = await checkedAuth(fields.authPath, root);
  const sdkRoot = await checkedSdk(fields.sdkRoot, root, repoRoot);

  let bwrapInfo;
  try { bwrapInfo = await lstat(BWRAP); } catch { fail('WORKER_ISOLATION_UNAVAILABLE'); }
  if (!bwrapInfo.isFile() || bwrapInfo.isSymbolicLink() || bwrapInfo.uid !== 0 ||
      (bwrapInfo.mode & 0o022) !== 0 || !(bwrapInfo.mode & 0o111)) fail('WORKER_ISOLATION_UNAVAILABLE');

  const nodeExecutable = await realpath(process.execPath);
  if (nodeExecutable !== process.execPath) fail('WORKER_ISOLATION_UNAVAILABLE');
  const nodeInstall = dirname(dirname(nodeExecutable));
  if (nodeInstall === '/') fail('WORKER_ISOLATION_UNAVAILABLE');
  const roSystemPaths = ['/usr', '/lib', '/lib64'];
  for (const path of roSystemPaths) {
    try { await lstat(path); } catch { fail('WORKER_ISOLATION_UNAVAILABLE'); }
  }
  const workspace = join(root, 'workspace');
  const nodeCovered = path => roSystemPaths.some(systemRoot => within(systemRoot, path));
  const fixedRoPaths = [
    ...roSystemPaths,
    ...(!nodeCovered(nodeExecutable) ? [nodeInstall] : []),
    repoRoot,
  ];
  if (fixedRoPaths.some(path => !noOverlap(root, path))) fail();

  // The second argument exists only for unit tests; application callers use the real spawn default.
  return function spawnOfflineWorker(command, args, options) {
    const incoming = dataRecord(options, ['cwd', 'env', 'stdio', 'windowsHide']);
    let argv = false;
    try {
      argv = Array.isArray(args) && Object.getPrototypeOf(args) === Array.prototype && args.length === 1 &&
        Object.getOwnPropertyDescriptor(args, '0')?.value === WORKER_PATH && Reflect.ownKeys(args).length === 2;
    } catch { fail(); }
    if (command !== process.execPath || !argv || !incoming || incoming.cwd !== workspace || incoming.windowsHide !== true ||
        JSON.stringify(readStdio(incoming.stdio)) !== JSON.stringify(['ignore', 'ignore', 'ignore', 'ipc'])) fail();
    const env = checkedEnvironment(incoming.env, { root, sdkRoot, authPath });
    // Keep /tmp-backed source state available while replacing /tmp with a private tmpfs.
    const bwrapArgs = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev',
      '--tmpfs', '/tmp', '--bind', root, root];
    for (const source of fixedRoPaths) bwrapArgs.push('--ro-bind', source, source);
    // Overlay SDK and synthetic auth read-only after the single trusted writable state root.
    bwrapArgs.push('--ro-bind', sdkRoot, sdkRoot, '--ro-bind', authPath, authPath, '--chdir', workspace, '--clearenv');
    for (const [key, value] of Object.entries(env)) bwrapArgs.push('--setenv', key, value);
    bwrapArgs.push('--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'NODE_CHANNEL_FD', '3',
      '--setenv', 'NODE_CHANNEL_SERIALIZATION_MODE', 'json', '--', command, WORKER_PATH);
    // The whole owned state root is one trust domain; this is not session/tenant isolation, tool safety, or activation.
    return spawnImpl(BWRAP, bwrapArgs, {
      cwd: '/', env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
  };
}
