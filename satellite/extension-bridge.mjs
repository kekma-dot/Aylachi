import { bad, id } from './protocol.mjs';

const FRAME_LIMIT = 96 * 1024;

// Chromium native-messaging framing: uint32 LE byte length + UTF-8 JSON.
// stdout is exclusively protocol; diagnostics must use stderr.
export function createNativeMessagingBridge({ input, output, timeoutMs = 2_000 } = {}) {
  if (!input || !output || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('native messaging streams required');
  const pending = new Map();
  let buffer = Buffer.alloc(0), closed = false;
  function rejectAll(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  input.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > FRAME_LIMIT + 4) { closed = true; rejectAll(bad('EXTENSION_FRAME_TOO_LARGE')); return; }
    while (!closed && buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length < 2 || length > FRAME_LIMIT) { closed = true; rejectAll(bad('INVALID_EXTENSION_FRAME')); return; }
      if (buffer.length < length + 4) return;
      const frame = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4);
      let message;
      try { message = JSON.parse(frame.toString('utf8')); } catch { continue; }
      if (!message || message.type !== 'result' || typeof message.requestId !== 'string' || !pending.has(message.requestId)) continue;
      const item = pending.get(message.requestId); pending.delete(message.requestId); clearTimeout(item.timer);
      if (message.ok === true) item.resolve(message.result); else item.reject(bad('EXTENSION_OPERATION_FAILED'));
    }
  });
  input.once('end', () => { closed = true; rejectAll(bad('EXTENSION_DISCONNECTED')); });
  input.once('error', () => { closed = true; rejectAll(bad('EXTENSION_DISCONNECTED')); });
  function send(message) {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > FRAME_LIMIT) throw bad('EXTENSION_FRAME_TOO_LARGE');
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    output.write(Buffer.concat([header, body]));
  }
  return Object.freeze({
    async extractText({ tabId, requestId, signal }) {
      id(tabId); id(requestId);
      if (closed || pending.has(requestId)) throw bad('EXTENSION_DISCONNECTED');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(bad('EXTENSION_TIMEOUT')); }, timeoutMs);
        const onAbort = () => { clearTimeout(timer); pending.delete(requestId); reject(signal.reason ?? bad('ABORTED')); };
        pending.set(requestId, { resolve, reject, timer });
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try { send({ type: 'extract', requestId, tabId }); }
        catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
      });
    },
    close() { closed = true; rejectAll(bad('EXTENSION_DISCONNECTED')); },
  });
}
