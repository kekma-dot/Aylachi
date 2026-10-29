import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDevelopmentServer } from './server.mjs';

test('invalid offline isolation rejects before SDK/auth or state creation without invoking accessors', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'aylachi-isolation-config-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  let getters = 0;
  const accessor = Object.defineProperty({}, 'profile', { enumerable: true, get() { getters++; throw Error('GETTER_INVOKED'); } });
  const cases = [null, false, '', 'bubblewrap', 1, {}, [], accessor].map(workerIsolation => ({ workerIsolation, allowLive: true, sdkRoot: '/missing-sdk-do-not-access' }));
  cases.push({ workerIsolation: 'bubblewrap-offline', allowLive: false });
  for (const key of ['workerDependencies', 'delegation', 'projectContext', 'nativeMcp']) {
    cases.push({ workerIsolation: 'bubblewrap-offline', allowLive: true, sdkRoot: '/missing-sdk-do-not-access', [key]: {} });
  }
  for (const [index, options] of cases.entries()) {
    const stateRoot = join(parent, `state-${index}`);
    await assert.rejects(startDevelopmentServer({ stateRoot, port: 0, ...options }), { code: 'WORKER_ISOLATION_INVALID' });
    await assert.rejects(lstat(stateRoot), { code: 'ENOENT' });
  }
  assert.equal(getters, 0);
});

test('offline isolation requires an explicit auth path before touching SDK or state', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'aylachi-isolation-auth-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const previous = process.env.AYLACHI_DEV_AUTH_PATH;
  const stateRoot = join(parent, 'absent-state');
  try {
    delete process.env.AYLACHI_DEV_AUTH_PATH;
    await assert.rejects(startDevelopmentServer({
      stateRoot, port: 0, allowLive: true, sdkRoot: '/missing-sdk-do-not-access',
      workerIsolation: 'bubblewrap-offline',
    }), { code: 'WORKER_ISOLATION_INVALID' });
    await assert.rejects(lstat(stateRoot), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.AYLACHI_DEV_AUTH_PATH;
    else process.env.AYLACHI_DEV_AUTH_PATH = previous;
  }
});
