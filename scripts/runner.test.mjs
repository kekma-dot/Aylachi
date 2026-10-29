import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('./run-tests.mjs', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const node = process.execPath;

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aylachi-runner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sdk = path.join(dir, 'sdk');
  await mkdir(sdk);
  await writeFile(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0' }));
  return { dir, sdk };
}

test('runner propagates focused test success and failure; default discovery excludes runner', async (t) => {
  const { dir, sdk } = await setup(t);
  const fixture = path.join(dir, 'fixture.test.mjs');
  await writeFile(fixture, 'import test from "node:test"; test("pass", () => {});');
  const cleanEnv = { ...process.env, NODE_TEST_CONTEXT: undefined };
  const run = (args = [], override = sdk) => spawnSync(node, [runner, ...args], {
    cwd: root, env: { ...cleanEnv, AYLACHI_SDK_ROOT: override }, encoding: 'utf8', timeout: 20000,
  });
  const success = run([fixture]);
  assert.equal(success.status, 0, success.stdout + success.stderr);
  const failing = path.join(dir, 'failing.test.mjs');
  await writeFile(failing, 'import test from "node:test"; test("fail", () => { throw new Error("expected failure"); });');
  const failure = run([failing]);
  assert.equal(failure.status, 1, failure.stdout + failure.stderr);
  assert.match(failure.stdout, /expected failure/);
  const discoveryDir = path.join(dir, 'discovery');
  await mkdir(discoveryDir);
  await copyFile(runner, path.join(discoveryDir, 'run-tests.mjs'));
  await writeFile(path.join(discoveryDir, 'smoke.test.mjs'), 'import test from "node:test"; test("discovery", () => {});');
  const defaults = spawnSync(node, ['--test'], {
    cwd: discoveryDir, env: cleanEnv, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(defaults.status, 0, defaults.stdout + defaults.stderr);
  assert.match(defaults.stdout, /discovery/);
  assert.doesNotMatch(defaults.stdout, /run-tests\.mjs/);
});

test('runner rejects relative and mismatched SDK roots; obsolete basename is absent', async (t) => {
  const { dir, sdk } = await setup(t);
  await assert.rejects(stat(fileURLToPath(new URL('./test.mjs', import.meta.url))), { code: 'ENOENT' });
  const run = override => spawnSync(node, [runner], {
    cwd: dir, env: { ...process.env, AYLACHI_SDK_ROOT: override }, encoding: 'utf8', timeout: 10000,
  });
  const cleanEnv = { ...process.env, NODE_TEST_CONTEXT: undefined, AYLACHI_SDK_ROOT: sdk };
  const passFixture = path.join(dir, 'pass.test.mjs');
  await writeFile(passFixture, 'import test from "node:test"; test("pass", () => {});');
  const runOverride = override => spawnSync(node, [runner, passFixture], {
    cwd: dir, env: { ...cleanEnv, AYLACHI_SDK_ROOT: override }, encoding: 'utf8', timeout: 10000,
  });
  assert.notEqual(runOverride('relative/sdk').status, 0);
  const wrong = path.join(dir, 'wrong');
  await mkdir(wrong);
  await writeFile(path.join(wrong, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '9.9.9' }));
  assert.notEqual(runOverride(wrong).status, 0);
  for (const version of ['1.3.0', '1.4.0']) {
    await writeFile(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
    const success = runOverride(sdk);
    assert.equal(success.status, 0, success.stdout + success.stderr);
    assert.ok(success.stdout.includes(`@earendil-works/pi-coding-agent@${version}`));
  }
});
