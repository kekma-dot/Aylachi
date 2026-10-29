import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotLiveLimits, startDevelopmentServer } from './server.mjs';
import { parseWorkerEnvironment } from './pi-worker.mjs';

test('live limits preserve defaults and snapshot only bounded exact owner data', () => {
  assert.deepEqual(snapshotLiveLimits(), { maxSdkCalls: 20, durationMs: 1800000 });
  const original = { maxSdkCalls: 3, durationMs: 300000 }, snapshot = snapshotLiveLimits(original);
  original.maxSdkCalls = 20;
  assert.deepEqual(snapshot, { maxSdkCalls: 3, durationMs: 300000 });
  assert.ok(Object.isFrozen(snapshot));
  let accessed = false;
  for (const bad of [null, {}, { maxSdkCalls: 0, durationMs: 300000 }, { maxSdkCalls: 21, durationMs: 300000 },
    { maxSdkCalls: 3, durationMs: 1800001 }, { maxSdkCalls: 3, durationMs: 9999 },
    { maxSdkCalls: 3, durationMs: 300000, extra: true },
    { get maxSdkCalls() { accessed = true; return 3; }, durationMs: 300000 }]) {
    assert.throws(() => snapshotLiveLimits(bad), { code: 'LIVE_LIMITS_INVALID' });
  }
  assert.equal(accessed, false);
});

test('worker call budget comes only from a bounded numeric environment field; absence compatible', () => {
  const now = Date.now(), env = { AYLACHI_DEV_STATE_ROOT: '/synthetic/state', AYLACHI_SDK_ROOT: '/synthetic/sdk',
    AYLACHI_DEV_AUTH_PATH: '/synthetic/auth', AYLACHI_DEV_DEADLINE_MS: String(now + 300000) };
  assert.equal(Object.hasOwn(parseWorkerEnvironment(env, now), 'maxSdkCalls'), false);
  assert.equal(parseWorkerEnvironment({ ...env, AYLACHI_DEV_MAX_SDK_CALLS: '3' }, now).maxSdkCalls, 3);
  for (const value of ['0', '21', '03', '3.0', '-1', '', 'Infinity', 3]) {
    assert.throws(() => parseWorkerEnvironment({ ...env, AYLACHI_DEV_MAX_SDK_CALLS: value }, now), { code: 'HOST_START_FAILED' });
  }
});

test('bad live limits fail before state creation or auth metadata checks', async t => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'aylachi-live-limit-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'state');
  await assert.rejects(startDevelopmentServer({ stateRoot: root, allowLive: true, sdkRoot: '/nonexistent',
    liveLimits: { maxSdkCalls: 21, durationMs: 300000 } }), { code: 'LIVE_LIMITS_INVALID' });
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  await assert.rejects(startDevelopmentServer({ stateRoot: root, liveLimits: { maxSdkCalls: 3, durationMs: 300000 } }), { code: 'LIVE_FLAGS_INVALID' });
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});
