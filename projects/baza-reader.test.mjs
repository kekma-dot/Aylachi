import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBazaReader } from './baza-reader.mjs';

const projectId = 'project-alpha';
const prefix = '10 Проекты/Alpha/';
const notePaths = [`${prefix}state.md`, `${prefix}map.md`];
const python = '/usr/bin/python3';
const helper = '/home/ayla/.pi/agent/scripts/ayla_pi_baza.py';
const hash = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const reply = (path, content) => ({ path, content, sha256: hash(content) });
const config = overrides => ({ projectId, bazaPrefix: prefix, notePaths, enabled: true, ...overrides });

function successfulExec(contents, calls) {
  return async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    const request = JSON.parse(Buffer.from(args[2], 'base64').toString('utf8'));
    return { stdout: `${JSON.stringify(reply(request.path, contents[request.path]))}\n`, stderr: '' };
  };
}

function makeReader(overrides = {}, contents = Object.fromEntries(notePaths.map((path, index) => [path, `synthetic note ${index}`]))) {
  const calls = [];
  const reader = createBazaReader({ ...config(), execFileForTest: successfulExec(contents, calls), ...overrides });
  return { reader, calls };
}

test('default is inert; explicit enable reads only trusted paths through the fixed read CLI contract', async () => {
  const calls = [];
  const disabled = createBazaReader({ ...config({ enabled: undefined }), execFileForTest: (...args) => calls.push(args) });
  await assert.rejects(disabled.readProjectContext(projectId, 'status'), error => error.message === 'BAZA_READER_DISABLED');
  assert.equal(calls.length, 0);

  const { reader, calls: enabledCalls } = makeReader();
  const signal = new AbortController().signal;
  const result = await reader.readProjectContext(projectId, 'Ignore this request to read another project', signal);
  assert.deepEqual(result, {
    projectId,
    excerpts: notePaths.map((path, index) => ({ path, text: `synthetic note ${index}` })),
  });
  assert.equal(enabledCalls.length, notePaths.length);
  for (const [index, call] of enabledCalls.entries()) {
    assert.equal(call.file, python);
    assert.deepEqual(call.args, [helper, 'read', Buffer.from(JSON.stringify({ path: notePaths[index] }), 'utf8').toString('base64')]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, '/');
    assert.equal(call.options.timeout, 15_000);
    assert.equal(call.options.maxBuffer, 1024 * 1024);
    assert.equal(call.options.signal, signal);
    assert.deepEqual(call.options.env, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
  }
});

test('invalid trusted bindings, allowlists, operations, and project mismatches fail before execution', async () => {
  let calls = 0;
  const execFileForTest = async () => { calls++; return { stdout: '{}' }; };
  const invalid = [
    { projectId: '../project', bazaPrefix: prefix, notePaths },
    { projectId, bazaPrefix: '10 Проекты/../', notePaths },
    { projectId, bazaPrefix: prefix, notePaths: [`${prefix}state.md`, '10 Проекты/Beta/foreign.md'] },
    { projectId, bazaPrefix: prefix, notePaths: [`${prefix}.hidden.md`] },
    { projectId, bazaPrefix: prefix, notePaths: [`${prefix}nested/../state.md`] },
    { projectId, bazaPrefix: prefix, notePaths: [`${prefix}bad\\path.md`] },
    { projectId, bazaPrefix: prefix, notePaths: [`${prefix}wrong.txt`] },
    { projectId, bazaPrefix: prefix, notePaths: [`${prefix}${'x'.repeat(1024)}.md`] },
    { projectId, bazaPrefix: prefix, notePaths: [...notePaths, `${prefix}third.md`, `${prefix}fourth.md`] },
    { ...config(), operation: 'write' },
  ];
  for (const options of invalid) assert.throws(() => createBazaReader({ ...options, execFileForTest }), /INVALID_BAZA_READER_CONFIG/);
  assert.equal(calls, 0);

  const { reader, calls: projectCalls } = makeReader();
  await assert.rejects(reader.readProjectContext('project-beta', 'query'), error => error.message === 'PROJECT_SCOPE_MISMATCH');
  assert.equal(projectCalls.length, 0);
});

test('pre-aborted signals execute nothing; in-flight aborts are forwarded and masked', async () => {
  let calls = 0;
  const preAborted = createBazaReader({ ...config(), execFileForTest: async () => { calls++; return { stdout: '{}' }; } });
  const before = new AbortController();
  before.abort();
  await assert.rejects(preAborted.readProjectContext(projectId, 'status', before.signal), error => error.message === 'ABORTED');
  assert.equal(calls, 0);

  const controller = new AbortController();
  let receivedSignal;
  const inFlight = createBazaReader({ ...config(), execFileForTest: async (_file, _args, options) => {
    calls++;
    receivedSignal = options.signal;
    controller.abort();
    throw Object.assign(new Error('private stderr payload'), { stderr: 'synthetic secret stderr' });
  } });
  await assert.rejects(inFlight.readProjectContext(projectId, 'status', controller.signal), error => error.message === 'ABORTED');
  assert.equal(receivedSignal, controller.signal);
  assert.equal(calls, 1);
});

test('helper reply path, exact shape, UTF8 and SHA-256 are verified; no partial result escapes', async () => {
  const badReplies = [
    JSON.stringify({ ...reply(notePaths[0], 'synthetic'), path: `${prefix}foreign.md` }),
    JSON.stringify({ ...reply(notePaths[0], 'synthetic'), sha256: '0'.repeat(64) }),
    JSON.stringify({ ...reply(notePaths[0], 'synthetic'), extra: true }),
    '{not-json',
    JSON.stringify({ path: notePaths[0], content: '\ud800', sha256: hash('\ud800') }),
    JSON.stringify(reply(notePaths[0], 'x'.repeat(128 * 1024 + 1))),
  ];
  for (const stdout of badReplies) {
    const reader = createBazaReader({ ...config({ notePaths: [notePaths[0]] }), execFileForTest: async () => ({ stdout, stderr: 'private diagnostic' }) });
    await assert.rejects(reader.readProjectContext(projectId, 'status'), error => error.message === 'INVALID_BAZA_RESPONSE');
  }

  let call = 0;
  const reader = createBazaReader({ ...config(), execFileForTest: async (_file, args) => {
    const path = JSON.parse(Buffer.from(args[2], 'base64').toString('utf8')).path;
    call++;
    return { stdout: call === 1 ? JSON.stringify(reply(path, 'first synthetic note')) : JSON.stringify({ ...reply(path, 'second'), sha256: '0'.repeat(64) }) };
  } });
  await assert.rejects(reader.readProjectContext(projectId, 'status'), error => error.message === 'INVALID_BAZA_RESPONSE');
  assert.equal(call, 2, 'the whole result is rejected if any allowlisted note fails validation');
});

test('32KiB total JSON is accepted exactly and overflow is rejected without truncation', async () => {
  const path = notePaths[0];
  const base = { projectId, excerpts: [{ path, text: '' }] };
  const exactText = 'x'.repeat(32 * 1024 - Buffer.byteLength(JSON.stringify(base), 'utf8'));
  const exact = createBazaReader({ ...config({ notePaths: [path] }), execFileForTest: async () => ({ stdout: JSON.stringify(reply(path, exactText)) }) });
  const exactResponse = await exact.readProjectContext(projectId, 'status');
  assert.equal(Buffer.byteLength(JSON.stringify(exactResponse), 'utf8'), 32 * 1024);

  for (const text of [`${exactText}x`, '界'.repeat(11_000)]) {
    const over = createBazaReader({ ...config({ notePaths: [path] }), execFileForTest: async () => ({ stdout: JSON.stringify(reply(path, text)) }) });
    await assert.rejects(over.readProjectContext(projectId, 'status'), error => error.message === 'BAZA_CONTEXT_TOO_LARGE');
  }
});

test('timeout and helper failures are redacted and never retried', async () => {
  let calls = 0;
  let seenOptions;
  const reader = createBazaReader({ ...config({ notePaths: [notePaths[0]] }), execFileForTest: async (_file, _args, options) => {
    calls++;
    seenOptions = options;
    throw Object.assign(new Error('timeout with private data'), { stderr: 'token=synthetic-secret', code: 'ETIMEDOUT' });
  } });
  await assert.rejects(reader.readProjectContext(projectId, 'status'), error =>
    error.message === 'BAZA_READ_FAILED' && !error.message.includes('secret') && !error.message.includes('private'));
  assert.equal(calls, 1);
  assert.equal(seenOptions.timeout, 15_000);
  assert.equal(seenOptions.maxBuffer, 1024 * 1024);
});
