const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const FAILURE_CODE = 'NATIVE_MCP_FETCH_FAILED';

function failure() {
  return Object.assign(new Error(FAILURE_CODE), { code: FAILURE_CODE });
}

function exactOptions(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw failure();
  const keys = Reflect.ownKeys(value);
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw failure();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure();
    result[key] = descriptor.value;
  }
  if (label === 'factory' && !Object.hasOwn(result, 'url')) throw failure();
  return result;
}

function validateUrl(value) {
  if (typeof value !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})(?:\/[^?#]*)$/.test(value)) throw failure();
  const match = value.match(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})(?:\/[^?#]*)$/);
  const port = Number(match[1]);
  if (port < 1 || port > 65535 || String(port) !== match[1]) throw failure();
  let url;
  try { url = new URL(value); } catch { throw failure(); }
  if (url.href !== value || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.port !== String(port) || url.username || url.password || url.search || url.hash) throw failure();
  return value;
}

function requestHeadersVersion(headers) {
  if (headers === undefined) return undefined;
  let version;
  if (headers instanceof Headers) {
    if (Headers.prototype.has.call(headers, 'Mcp-Session-Id')) throw failure();
    version = Headers.prototype.get.call(headers, 'MCP-Protocol-Version') ?? undefined;
  } else {
    const entries = [];
    if (Array.isArray(headers)) {
      if (Object.getPrototypeOf(headers) !== Array.prototype) throw failure();
      const length = Object.getOwnPropertyDescriptor(headers, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(headers).length !== length + 1) throw failure();
      for (let index = 0; index < length; index++) {
        const item = Object.getOwnPropertyDescriptor(headers, String(index));
        if (!item?.enumerable || !Object.hasOwn(item, 'value') || !Array.isArray(item.value) || Object.getPrototypeOf(item.value) !== Array.prototype ||
            Reflect.ownKeys(item.value).length !== 3 || Object.getOwnPropertyDescriptor(item.value, 'length')?.value !== 2) throw failure();
        const name = Object.getOwnPropertyDescriptor(item.value, '0'), value = Object.getOwnPropertyDescriptor(item.value, '1');
        if (!name?.enumerable || !Object.hasOwn(name, 'value') || !value?.enumerable || !Object.hasOwn(value, 'value') ||
            typeof name.value !== 'string' || typeof value.value !== 'string') throw failure();
        entries.push([name.value, value.value]);
      }
    } else {
      if (headers === null || typeof headers !== 'object') throw failure();
      const prototype = Object.getPrototypeOf(headers);
      if (prototype !== Object.prototype && prototype !== null) throw failure();
      for (const key of Reflect.ownKeys(headers)) {
        if (typeof key !== 'string') throw failure();
        const descriptor = Object.getOwnPropertyDescriptor(headers, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') throw failure();
        entries.push([key, descriptor.value]);
      }
    }
    const seen = new Set();
    for (const [key, value] of entries) {
      if (key.toLowerCase() === 'mcp-session-id') throw failure();
      if (key.toLowerCase() === 'mcp-protocol-version') {
        if (seen.has('mcp-protocol-version')) throw failure();
        seen.add('mcp-protocol-version');
        version = value;
      }
    }
  }
  if (version !== undefined && version !== MCP_PROTOCOL_VERSION) throw failure();
  return version;
}

function snapshotRequest(input, init, url) {
  let target;
  if (typeof input === 'string') target = input;
  else if (input instanceof URL) target = input.href;
  else throw failure();
  if (target !== url) throw failure();
  const options = exactOptions(init ?? {}, ['method', 'headers', 'body', 'signal'], 'request');
  if (options.method !== 'POST' || typeof options.body !== 'string' || Buffer.byteLength(options.body, 'utf8') > MAX_BODY_BYTES) throw failure();
  try { JSON.parse(options.body); } catch { throw failure(); }
  const version = requestHeadersVersion(options.headers);
  const signal = options.signal;
  if (signal !== undefined && signal !== null && (!(signal instanceof AbortSignal) || typeof signal.aborted !== 'boolean')) throw failure();
  if (signal?.aborted) throw failure();
  const headers = new Headers({
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  });
  if (version !== undefined) headers.set('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
  return { body: options.body, callerSignal: signal ?? undefined, headers };
}

function cancelBody(response, reader) {
  try {
    const cancellation = reader ? reader.cancel() : response?.body?.cancel();
    cancellation?.catch?.(() => {});
  } catch {}
}

function raceAbort(promise, abortPromise) {
  return Promise.race([promise, abortPromise]);
}

async function readBoundedBody(response, abortPromise, controller) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await raceAbort(reader.read(), abortPromise);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw failure();
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw failure();
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    cancelBody(response, reader);
    if (controller.signal.aborted) throw failure();
    throw error;
  }
}

function applicationJson(response) {
  const contentType = response.headers.get('content-type');
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw failure();
}

export function createNativeMcpFetch(options) {
  let url, fetchImpl;
  try {
    const config = exactOptions(options, ['url', 'fetchImpl'], 'factory');
    url = validateUrl(config.url);
    fetchImpl = config.fetchImpl === undefined ? globalThis.fetch : config.fetchImpl;
    if (typeof fetchImpl !== 'function' || typeof AbortController !== 'function' || typeof Response !== 'function') throw failure();
  } catch { throw failure(); }
  let failed = false;

  return async function nativeMcpFetch(input, init) {
    if (failed) throw failure();
    let response;
    let controller;
    let timer;
    let callerSignal;
    let callerAbort;
    let abortListener;
    try {
      const request = snapshotRequest(input, init, url);
      callerSignal = request.callerSignal;
      controller = new AbortController();
      let rejectAbort;
      const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
      abortPromise.catch(() => {});
      abortListener = () => rejectAbort(failure());
      controller.signal.addEventListener('abort', abortListener, { once: true });
      if (callerSignal) {
        callerAbort = () => controller.abort();
        callerSignal.addEventListener('abort', callerAbort, { once: true });
      }
      timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      if (callerSignal?.aborted) controller.abort();
      const pendingResponse = Promise.resolve(fetchImpl(url, {
        method: 'POST', headers: request.headers, body: request.body, signal: controller.signal,
        credentials: 'omit', redirect: 'error',
      })).then(result => {
        if (controller.signal.aborted) cancelBody(result);
        return result;
      });
      response = await raceAbort(pendingResponse, abortPromise);
      if (!(response instanceof Response) || response.redirected || (response.status >= 300 && response.status < 400) || response.headers.has('mcp-session-id')) throw failure();
      if (response.status === 202) {
        const contentType = response.headers.get('content-type');
        if (contentType !== null && contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw failure();
        const empty = await readBoundedBody(response, abortPromise, controller);
        if (empty.byteLength !== 0) throw failure();
        return new Response(null, { status: 202 });
      }
      if (!response.ok) throw failure();
      applicationJson(response);
      const bytes = await readBoundedBody(response, abortPromise, controller);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); JSON.parse(text); }
      catch { throw failure(); }
      return new Response(bytes, { status: response.status, headers: { 'Content-Type': 'application/json' } });
    } catch {
      failed = true;
      cancelBody(response);
      throw failure();
    } finally {
      clearTimeout(timer);
      if (callerSignal && callerAbort) callerSignal.removeEventListener('abort', callerAbort);
      if (controller && abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
  };
}
