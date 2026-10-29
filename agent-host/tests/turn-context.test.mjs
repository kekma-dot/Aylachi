import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPiHostClient } from '../client.mjs';
import { attachPiAdapterIpc } from '../ipc.mjs';

const FIXTURE = fileURLToPath(new URL('./turn-context-fixture.mjs', import.meta.url));

class FakeClientChild extends EventEmitter {
  connected = true;
  exitCode = null;
  signalCode = null;
  sent = [];

  send(message, callback) {
    this.sent.push(message);
    callback?.(null);
    setImmediate(() => {
      this.emit('message', { id: message.id, ok: true, result: message.verb === 'shutdown' ? { shutdown: true } : { text: 'ok' } });
      if (message.verb === 'shutdown') {
        this.connected = false;
        this.exitCode = 0;
        this.emit('disconnect');
        this.emit('exit', 0, null);
      }
    });
    return true;
  }

  kill(signal) {
    this.connected = false;
    this.signalCode = signal;
    setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
}

class FakeAdapterChannel extends EventEmitter {
  connected = true;
  replies = [];
  send(message, callback) { this.replies.push(message); callback?.(null); return true; }
}

function promptMessage(id, payload) { return { id, verb: 'prompt', sessionId: 'session-1', payload }; }

async function deliver(channel, message) {
  channel.emit('message', message);
  await new Promise(resolve => setImmediate(resolve));
}

test('legacy prompt wire stays exact; optional turn context validates without invoking getters', async () => {
  const child = new FakeClientChild();
  const client = createPiHostClient(child, { requestTimeoutMs: 100, shutdownReplyTimeoutMs: 50, shutdownGraceMs: 20, termGraceMs: 20, killGraceMs: 50 });
  await client.prompt('session-legacy', 'legacy text');
  await client.prompt('session-context', 'context text', { turnId: 'Turn_1:segment.v2-x' });
  assert.deepEqual(child.sent[0].payload, { text: 'legacy text' });
  assert.deepEqual(child.sent[1].payload, { text: 'context text', turnId: 'Turn_1:segment.v2-x' });

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'turnId', { enumerable: true, get() { getterCalls++; return 'turn-accessor'; } });
  const hidden = {};
  Object.defineProperty(hidden, 'turnId', { value: 'turn-hidden', enumerable: false });
  const hiddenExtra = { turnId: 'turn-valid' };
  Object.defineProperty(hiddenExtra, 'secret', { value: true, enumerable: false });
  const symbolExtra = { turnId: 'turn-valid', [Symbol('extra')]: true };
  const nullPrototype = Object.assign(Object.create(null), { turnId: 'turn-valid' });
  const invalid = [null, {}, [], hidden, hiddenExtra, symbolExtra, nullPrototype, { turnId: '' }, { turnId: 'bad value' }, { turnId: 'x'.repeat(129) }, { turnId: 'turn-valid', extra: true }, accessor,
    new Proxy({ turnId: 'turn-valid' }, { getOwnPropertyDescriptor() { throw new Error('trap'); } })];
  const sentBefore = child.sent.length;
  for (const options of invalid) {
    await assert.rejects(client.prompt('session-invalid', 'must not send', options), error => error.code === 'INVALID_TURN_CONTEXT' && error.unknownOutcome === false);
  }
  assert.equal(getterCalls, 0);
  assert.equal(child.sent.length, sentBefore);
  await client.shutdown();
});

test('IPC accepts only exact prompt payloads and passes a frozen turn context as adapter argument three', async () => {
  const channel = new FakeAdapterChannel();
  const calls = [];
  const adapter = {
    async prompt(...args) { calls.push(args); return { text: 'ok' }; },
    async cancel() { return true; },
    async shutdown() {},
  };
  const service = attachPiAdapterIpc(adapter, channel);
  const legacy = promptMessage('legacy-1', { text: 'legacy' });
  await deliver(channel, legacy);
  assert.equal(calls[0].length, 2);

  const context = promptMessage('context-1', { text: 'with context', turnId: 'turn-42' });
  await deliver(channel, context);
  assert.equal(calls[1].length, 3);
  assert.deepEqual(calls[1][2], { turnId: 'turn-42' });
  assert.equal(Object.isFrozen(calls[1][2]), true);

  let getterCalls = 0;
  const accessorPayload = {};
  Object.defineProperty(accessorPayload, 'text', { enumerable: true, get() { getterCalls++; return 'must not execute'; } });
  const hiddenExtra = { text: 'x', turnId: 'turn-1' };
  Object.defineProperty(hiddenExtra, 'extra', { value: 'hidden', enumerable: false });
  const symbolExtra = { text: 'x', turnId: 'turn-1', [Symbol('extra')]: true };
  const badMessages = [
    promptMessage('bad-extra', { text: 'x', turnId: 'turn-1', extra: 'no' }),
    promptMessage('bad-turn', { text: 'x', turnId: 'bad value' }),
    promptMessage('bad-accessor', accessorPayload),
    promptMessage('bad-hidden', hiddenExtra),
    promptMessage('bad-symbol', symbolExtra),
    { ...promptMessage('bad-envelope', { text: 'x' }), extra: true },
  ];
  for (const message of badMessages) {
    const before = channel.replies.length;
    await deliver(channel, message);
    assert.equal(channel.replies.length, before + 1);
    assert.deepEqual(channel.replies.at(-1), { id: message.id, ok: false, error: 'INVALID_PAYLOAD' });
  }
  assert.equal(getterCalls, 0);
  assert.equal(calls.length, 2);
  service.detach();
});

test('actual forked IPC framing isolates concurrent contexts and keeps legacy calls two-argument', { timeout: 10_000 }, async t => {
  const child = fork(FIXTURE, [], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const client = createPiHostClient(child, { requestTimeoutMs: 2_000 });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { await client.shutdown(); } catch { child.kill('SIGKILL'); }
    }
  });

  const slow = client.prompt('session-slow', 'slow', { turnId: 'turn-slow' });
  const fast = client.prompt('session-fast', 'fast', { turnId: 'turn-fast' });
  const legacy = client.prompt('session-legacy', 'legacy');
  const [fastResult, legacyResult, slowResult] = await Promise.all([fast, legacy, slow]);
  assert.deepEqual(JSON.parse(fastResult.text), {
    sessionId: 'session-fast', text: 'fast', arity: 3, context: { turnId: 'turn-fast' }, frozen: true,
  });
  assert.deepEqual(JSON.parse(legacyResult.text), {
    sessionId: 'session-legacy', text: 'legacy', arity: 2, context: null, frozen: false,
  });
  assert.deepEqual(JSON.parse(slowResult.text), {
    sessionId: 'session-slow', text: 'slow', arity: 3, context: { turnId: 'turn-slow' }, frozen: true,
  });
  assert.deepEqual(await client.shutdown(), { shutdown: true });
  assert.equal(child.exitCode, 0);
});
