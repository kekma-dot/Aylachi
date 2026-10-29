import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPiHostClient } from '../client.mjs';

const SDK_ROOT = process.env.AYLACHI_SDK_ROOT;
assert.ok(SDK_ROOT, 'set AYLACHI_SDK_ROOT to the pinned Pi SDK package directory');
const FIXTURE = fileURLToPath(new URL('./ipc-fixture.mjs', import.meta.url));
const errorWith = code => failure => failure?.code === code && failure.unknownOutcome === true;

function reply(message, result = { text: 'fixture complete', nativeSessionFile: '/private/session.json' }) {
  return { id: message.id, ok: true, result };
}

class FakeChild extends EventEmitter {
  connected = true;
  exitCode = null;
  signalCode = null;
  sent = [];
  kills = [];
  onSend = () => {};
  sendCallbackFailure = false;
  sendReturnsFalse = false;
  ignoreTerm = false;
  ignoreKill = false;

  send(message, callback) {
    this.sent.push(message);
    this.onSend(message, this);
    callback?.(this.sendCallbackFailure ? new Error('/private/send callback failure') : null);
    return !this.sendReturnsFalse;
  }

  kill(signal) {
    this.kills.push(signal);
    if (signal === 'SIGTERM' && this.ignoreTerm || signal === 'SIGKILL' && this.ignoreKill) return true;
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  receive(message) { this.emit('message', message); }
  disconnect() { this.connected = false; this.emit('disconnect'); }
  exit(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.connected = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function fakeOptions(overrides = {}) {
  return {
    requestTimeoutMs: 100,
    shutdownReplyTimeoutMs: 30,
    shutdownGraceMs: 10,
    termGraceMs: 10,
    killGraceMs: 50,
    ...overrides,
  };
}

function respondAndExit(child, message) {
  child.receive(reply(message, { shutdown: true }));
  child.disconnect();
  child.exit(0, null);
}

async function eventually(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  throw new Error('FIXTURE_READINESS_TIMEOUT');
}

function launchFixture(root) {
  const child = fork(FIXTURE, [], {
    env: { AYLACHI_SDK_ROOT: SDK_ROOT, AYLACHI_TEST_ROOT: root },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return { child, client: createPiHostClient(child, { requestTimeoutMs: 20_000 }) };
}

test('local validation sends nothing; IDs are internal; prompt and cancel replies are strict', async () => {
  const child = new FakeChild();
  child.onSend = (message, self) => {
    if (message.verb === 'prompt') setImmediate(() => self.receive(reply(message)));
    if (message.verb === 'cancel') setImmediate(() => self.receive(reply(message, { cancelled: true })));
    if (message.verb === 'shutdown') respondAndExit(self, message);
  };
  const client = createPiHostClient(child, fakeOptions());
  await assert.rejects(client.prompt('../bad', 'text'), failure => failure.code === 'INVALID_SESSION_ID' && failure.unknownOutcome === false);
  await assert.rejects(client.prompt('session-1', '  '), failure => failure.code === 'INVALID_PROMPT' && failure.unknownOutcome === false);
  await assert.rejects(client.prompt('session-1', 'é'.repeat(40_000)), failure => failure.code === 'MESSAGE_TOO_LARGE' && failure.unknownOutcome === false);
  await assert.rejects(client.cancel('../bad'), failure => failure.code === 'INVALID_SESSION_ID' && failure.unknownOutcome === false);
  assert.equal(child.sent.length, 0);

  const result = await client.prompt('session-1', 'hello');
  assert.equal(result.text, 'fixture complete');
  assert.equal(result.nativeSessionFile, '/private/session.json');
  assert.match(child.sent[0].id, /^ipc_[a-f0-9]{16}_[a-z0-9]+$/);
  assert.equal(await client.cancel('session-1'), true);
  assert.equal(child.sent[1].verb, 'cancel');
  assert.equal(Object.hasOwn(child.sent[1], 'payload'), false);
  assert.deepEqual(await client.shutdown(), { shutdown: true });
  assert.equal(child.exitCode, 0);
});

test('eight prompts are the in-flight ceiling; cancellation remains available', async () => {
  const child = new FakeChild();
  child.onSend = (message, self) => {
    if (message.verb === 'cancel') setImmediate(() => self.receive(reply(message, { cancelled: true })));
    if (message.verb === 'shutdown') respondAndExit(self, message);
  };
  const client = createPiHostClient(child, fakeOptions());
  const prompts = Array.from({ length: 8 }, (_, index) => client.prompt(`session${index}`, 'pending'));
  const rejected = prompts.map(promise => assert.rejects(promise, errorWith('PROMPT_OUTCOME_UNKNOWN')));
  assert.equal(child.sent.filter(message => message.verb === 'prompt').length, 8);
  await assert.rejects(client.prompt('overflow', 'no'), failure => failure.code === 'INFLIGHT_LIMIT' && failure.unknownOutcome === false);
  assert.equal(child.sent.length, 8);
  assert.equal(await client.cancel('session0'), true);
  const stopping = client.shutdown();
  assert.strictEqual(stopping, client.shutdown());
  await Promise.all([...rejected, stopping]);
  assert.equal(child.exitCode, 0);
});

test('server errors and send failures are masked and conservatively unknown, without retries', async () => {
  const serverChild = new FakeChild();
  serverChild.onSend = (message, self) => {
    if (message.verb === 'prompt') setImmediate(() => self.receive({ id: message.id, ok: false, error: 'PROVIDER_FAILED /private/secret' }));
    if (message.verb === 'shutdown') respondAndExit(self, message);
  };
  const serverClient = createPiHostClient(serverChild, fakeOptions());
  await assert.rejects(serverClient.prompt('session1', 'fail'), failure => {
    assert.equal(failure.code, 'PROMPT_OUTCOME_UNKNOWN');
    assert.equal(failure.unknownOutcome, true);
    assert.equal(failure.message.includes('/private/secret'), false);
    assert.equal(failure.message.includes('PROVIDER_FAILED'), false);
    return true;
  });
  assert.equal(serverChild.sent.filter(message => message.verb === 'prompt').length, 1);
  await serverClient.shutdown();

  const sendChild = new FakeChild();
  sendChild.onSend = (_message, _self) => { throw new Error('/private/raw send failure'); };
  const sendClient = createPiHostClient(sendChild, fakeOptions());
  await assert.rejects(sendClient.prompt('session1', 'uncertain'), failure => {
    assert.equal(failure.code, 'PROMPT_OUTCOME_UNKNOWN');
    assert.equal(failure.unknownOutcome, true);
    assert.equal(failure.message.includes('/private'), false);
    return true;
  });
  assert.equal(sendChild.sent.length, 1);
  await assert.rejects(sendClient.shutdown(), failure => failure.code === 'SHUTDOWN_OUTCOME_UNKNOWN' && failure.unknownOutcome === true);
  assert.ok(sendChild.exitCode !== null || sendChild.signalCode !== null);

  const callbackChild = new FakeChild();
  callbackChild.sendCallbackFailure = true;
  const callbackClient = createPiHostClient(callbackChild, fakeOptions());
  await assert.rejects(callbackClient.prompt('session1', 'uncertain'), errorWith('PROMPT_OUTCOME_UNKNOWN'));
  assert.equal(callbackChild.sent.filter(message => message.verb === 'prompt').length, 1);
  await assert.rejects(callbackClient.shutdown(), failure => failure.code === 'SHUTDOWN_OUTCOME_UNKNOWN');
  assert.ok(callbackChild.exitCode !== null || callbackChild.signalCode !== null);

  const queueChild = new FakeChild();
  queueChild.sendReturnsFalse = true;
  const queueClient = createPiHostClient(queueChild, fakeOptions());
  await assert.rejects(queueClient.prompt('session1', 'backpressured'), errorWith('PROMPT_OUTCOME_UNKNOWN'));
  assert.equal(queueChild.sent.filter(message => message.verb === 'prompt').length, 1);
  await assert.rejects(queueClient.shutdown(), failure => failure.code === 'SHUTDOWN_OUTCOME_UNKNOWN');
  assert.ok(queueChild.exitCode !== null || queueChild.signalCode !== null);
});

test('timeout, duplicate and late replies settle once and never trigger automatic replay', async () => {
  const child = new FakeChild();
  child.onSend = (message, self) => { if (message.verb === 'shutdown') respondAndExit(self, message); };
  const client = createPiHostClient(child, fakeOptions({ requestTimeoutMs: 15 }));
  const completed = client.prompt('session1', 'complete');
  const first = child.sent[0];
  child.receive(reply(first));
  assert.equal((await completed).text, 'fixture complete');
  child.receive(reply(first)); // duplicate after settlement is ignored

  const timedOut = client.prompt('session1', 'slow');
  const late = child.sent[1];
  await assert.rejects(timedOut, errorWith('PROMPT_OUTCOME_UNKNOWN'));
  child.receive(reply(late)); // late response cannot settle another request
  const thirdRequest = client.prompt('session1', 'fresh');
  const third = child.sent[2];
  child.receive(reply(third));
  assert.equal((await thirdRequest).text, 'fixture complete');
  assert.equal(child.sent.filter(message => message.verb === 'prompt').length, 3);
  await client.shutdown();
});

test('malformed and oversized replies fail closed and mask protocol data', async () => {
  for (const badResult of [
    { text: 12, nativeSessionFile: '/private/invalid' },
    { text: 'x'.repeat(64 * 1024), nativeSessionFile: '/private/oversized' },
  ]) {
    const child = new FakeChild();
    const client = createPiHostClient(child, fakeOptions());
    const request = client.prompt('session1', 'request');
    const sent = child.sent[0];
    child.receive(reply(sent, badResult));
    await assert.rejects(request, failure => {
      assert.equal(failure.code, 'PROMPT_OUTCOME_UNKNOWN');
      assert.equal(failure.unknownOutcome, true);
      assert.equal(failure.message.includes('/private'), false);
      return true;
    });
    await assert.rejects(client.shutdown(), failure => failure.code === 'SHUTDOWN_OUTCOME_UNKNOWN');
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }

  const malformedChild = new FakeChild();
  const malformedClient = createPiHostClient(malformedChild, fakeOptions());
  const request = malformedClient.prompt('session1', 'request');
  malformedChild.receive({ ...reply(malformedChild.sent[0]), extra: 'unrecognized field' });
  await assert.rejects(request, errorWith('PROMPT_OUTCOME_UNKNOWN'));
  await assert.rejects(malformedClient.shutdown(), failure => failure.code === 'SHUTDOWN_OUTCOME_UNKNOWN');
  assert.ok(malformedChild.exitCode !== null || malformedChild.signalCode !== null);
});

test('disconnect, child error and exit settle pending requests as unknown', async () => {
  for (const end of [
    child => child.disconnect(),
    child => child.emit('error', new Error('/private/child error')),
    child => child.exit(3, null),
  ]) {
    const child = new FakeChild();
    const client = createPiHostClient(child, fakeOptions());
    const pending = client.prompt('session1', 'in flight');
    end(child);
    await assert.rejects(pending, errorWith('PROMPT_OUTCOME_UNKNOWN'));
    await assert.rejects(client.cancel('session1'), failure => failure.code === 'HOST_NOT_CONNECTED' || failure.code === 'HOST_EXITED');
    if (child.exitCode === null && child.signalCode === null) {
      await assert.rejects(client.shutdown(), failure => failure.code === 'SHUTDOWN_OUTCOME_UNKNOWN');
      assert.ok(child.exitCode !== null || child.signalCode !== null);
    } else {
      assert.deepEqual(await client.shutdown(), { shutdown: true });
    }
  }
});

test('shutdown escalates TERM to KILL, reaps child, and reports unresolved shutdown acknowledgement', async () => {
  const child = new FakeChild();
  child.onSend = () => {}; // no shutdown reply
  child.ignoreTerm = true;
  const client = createPiHostClient(child, fakeOptions({ shutdownReplyTimeoutMs: 10, termGraceMs: 10, killGraceMs: 100 }));
  const pending = client.prompt('session1', 'pending');
  const rejected = assert.rejects(pending, errorWith('PROMPT_OUTCOME_UNKNOWN'));
  await assert.rejects(client.shutdown(), failure => failure.code === 'SHUTDOWN_OUTCOME_UNKNOWN' && failure.unknownOutcome === true);
  await rejected;
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('failed reap retains child ownership and only a later explicit shutdown retries', async () => {
  const child = new FakeChild();
  child.onSend = () => {};
  child.ignoreTerm = true;
  child.ignoreKill = true;
  const client = createPiHostClient(child, fakeOptions({ shutdownReplyTimeoutMs: 5, termGraceMs: 5, killGraceMs: 5 }));
  await assert.rejects(client.shutdown(), failure => {
    assert.equal(failure.code, 'HOST_REAP_TIMEOUT');
    assert.equal(failure.childStillOwned, true);
    return true;
  });
  assert.equal(child.exitCode, null);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);

  child.ignoreKill = false;
  await assert.rejects(client.shutdown(), failure => failure.code === 'SHUTDOWN_OUTCOME_UNKNOWN' && !failure.childStillOwned);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(child.sent.filter(message => message.verb === 'shutdown').length, 2);
});

test('actual forked Pi SDK synthetic worker serves prompt, cancellation, masked failure and shutdown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-ipc-client-'));
  const workers = [];
  t.after(async () => {
    for (const worker of workers) {
      try { await worker.client.shutdown(); } catch {}
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGTERM');
        await Promise.race([new Promise(resolvePromise => worker.child.once('exit', resolvePromise)), new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))]);
      }
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
        await Promise.race([new Promise(resolvePromise => worker.child.once('exit', resolvePromise)), new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))]);
      }
    }
    if (workers.every(worker => worker.child.exitCode !== null || worker.child.signalCode !== null)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const normalRoot = join(root, 'normal');
  await mkdir(normalRoot);
  const normal = launchFixture(normalRoot);
  workers.push(normal);
  const result = await normal.client.prompt('sdkSession', 'synthetic IPC marker');
  assert.equal(result.text, 'fixture complete');
  assert.ok(result.nativeSessionFile.startsWith(join(normalRoot, 'state')));
  const persisted = await readFile(result.nativeSessionFile, 'utf8');
  assert.ok(persisted.includes('synthetic IPC marker'));
  assert.ok(persisted.includes('fixture_echo'));
  assert.deepEqual(await normal.client.shutdown(), { shutdown: true });
  assert.equal(normal.child.exitCode, 0);

  const waitingRoot = join(root, 'waiting');
  await mkdir(waitingRoot);
  await writeFile(join(waitingRoot, 'mode'), 'wait');
  const waiting = launchFixture(waitingRoot);
  workers.push(waiting);
  const active = waiting.client.prompt('cancelSession', 'wait for cancel');
  await eventually(async () => {
    try { return (await readFile(join(waitingRoot, 'stream-started'), 'utf8')).trim().length > 0; }
    catch { return false; }
  });
  assert.equal(await waiting.client.cancel('cancelSession'), true);
  await assert.rejects(active, errorWith('PROMPT_OUTCOME_UNKNOWN'));
  assert.deepEqual(await waiting.client.shutdown(), { shutdown: true });
  assert.equal(waiting.child.exitCode, 0);

  const failingRoot = join(root, 'failing');
  await mkdir(failingRoot);
  await writeFile(join(failingRoot, 'mode'), 'fail');
  const failing = launchFixture(failingRoot);
  workers.push(failing);
  await assert.rejects(failing.client.prompt('failureSession', 'synthetic failure'), failure => {
    assert.equal(failure.code, 'PROMPT_OUTCOME_UNKNOWN');
    assert.equal(failure.unknownOutcome, true);
    assert.equal(failure.message.includes('PROVIDER_FAILED'), false);
    return true;
  });
  assert.deepEqual(await failing.client.shutdown(), { shutdown: true });
  assert.equal(failing.child.exitCode, 0);
});
