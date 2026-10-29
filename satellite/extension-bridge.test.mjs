import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { createNativeMessagingBridge } from './extension-bridge.mjs';

function frame(value) {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
}
function fixture() {
  const input = new PassThrough(), output = new PassThrough();
  const bridge = createNativeMessagingBridge({ input, output, timeoutMs: 1000 });
  return { input, output, bridge, close() { bridge.close(); input.end(); output.end(); } };
}

test('native messaging bridge correlates only an explicit request and ignores unsolicited results', async () => {
  const f = fixture();
  try {
    const resultPromise = f.bridge.extractText({ tabId: 'tab-1', requestId: 'connector-1' });
    const chunk = await once(f.output, 'data'), message = JSON.parse(chunk[0].subarray(4).toString('utf8'));
    assert.deepEqual(message, { type: 'extract', requestId: 'connector-1', tabId: 'tab-1' });
    f.input.write(frame({ type: 'result', requestId: 'unsolicited', ok: true, result: {} }));
    f.input.write(frame({ type: 'result', requestId: 'connector-1', ok: true, result: { tabId: 'tab-1', title: 'Page', text: 'text' } }));
    assert.equal((await resultPromise).text, 'text');
  } finally { f.close(); }
});

test('native messaging bridge rejects malformed frames and disconnects pending operations', async () => {
  const f = fixture();
  try {
    const pending = f.bridge.extractText({ tabId: 'tab-1', requestId: 'connector-1' });
    const invalid = Buffer.alloc(4); invalid.writeUInt32LE(96 * 1024 + 1);
    f.input.write(invalid);
    await assert.rejects(pending, /INVALID_EXTENSION_FRAME/);
  } finally { f.close(); }
});
