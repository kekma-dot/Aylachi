const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TEXT_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const TASK_STATES = new Set(['RESERVED', 'DISPATCHED', 'NEEDS_RECONCILIATION', 'COMPLETED']);
const EFFECT_STATES = new Set(['PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'UNKNOWN', 'SUCCEEDED', 'FAILED']);
const EFFECT_KEYS = ['id', 'requestId', 'parentCommandId', 'parentCardId', 'canvasId', 'toolName', 'payloadHash', 'attempt', 'state', 'reasonCode', 'receipt'];
const RECORD_KEYS = ['id', 'requestId', 'parentCommandId', 'parentCardId', 'canvasId', 'childCardId', 'childSessionId', 'childCommandId', 'state', 'result'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && ID.test(value);
const utf8Size = value => new TextEncoder().encode(value).byteLength;

function fail(code, properties = {}) {
  return Object.assign(new Error(code), { code }, properties);
}

function plainData(value, keys) {
  try {
    if (!isObject(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || !keys.every(key => own.includes(key))) return false;
    return keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
  } catch { return false; }
}

function checkedSignalOptions(options) {
  if (options === undefined) return undefined;
  if (!plainData(options, ['signal'])) throw new TypeError('INVALID_OPTIONS');
  const { signal } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('INVALID_SIGNAL');
  return signal;
}

function checkedRecord(value, { parentCommandId, id, requestId } = {}) {
  if (!plainData(value, RECORD_KEYS) ||
      !['id', 'requestId', 'parentCommandId', 'parentCardId', 'canvasId', 'childCardId', 'childSessionId', 'childCommandId'].every(key => isId(value[key])) ||
      !TASK_STATES.has(value.state) || value.parentCommandId !== parentCommandId ||
      (id !== undefined && value.id !== id) || (requestId !== undefined && value.requestId !== requestId)) return null;
  let result = null;
  if (value.state === 'COMPLETED') {
    if (!isObject(value.result)) return null;
    const status = Object.getOwnPropertyDescriptor(value.result, 'status');
    if (!status?.enumerable || !Object.hasOwn(status, 'value')) return null;
    if (status.value === 'ok' && plainData(value.result, ['status', 'text']) && typeof value.result.text === 'string' && utf8Size(value.result.text) <= TEXT_LIMIT) {
      result = Object.freeze({ status: 'ok', text: value.result.text });
    } else if (status.value === 'cancelled' && plainData(value.result, ['status'])) {
      result = Object.freeze({ status: 'cancelled' });
    } else if (status.value === 'error' && plainData(value.result, ['status', 'code']) && typeof value.result.code === 'string' && CODE.test(value.result.code)) {
      result = Object.freeze({ status: 'error', code: value.result.code });
    } else return null;
  } else if (value.result !== null) return null;
  return Object.freeze({
    id: value.id, requestId: value.requestId, parentCommandId: value.parentCommandId,
    parentCardId: value.parentCardId, canvasId: value.canvasId, childCardId: value.childCardId,
    childSessionId: value.childSessionId, childCommandId: value.childCommandId, state: value.state, result,
  });
}

function checkedBaseUrl(input) {
  if (typeof input !== 'string') throw new TypeError('LOOPBACK_ORIGIN_REQUIRED');
  let url;
  try { url = new URL(input); } catch { throw new TypeError('LOOPBACK_ORIGIN_REQUIRED'); }
  const origin = url.origin;
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      ![origin, `${origin}/`].includes(input)) throw new TypeError('LOOPBACK_ORIGIN_REQUIRED');
  return new URL(`${origin}/`);
}

async function readJson(response, onReader, signal) {
  if (!response.headers?.get?.('content-type')?.toLowerCase().startsWith('application/json')) throw fail('INVALID_RESPONSE');
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > RESPONSE_LIMIT) throw fail('RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader?.();
  if (!reader) throw fail('INVALID_RESPONSE');
  onReader(reader);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  try {
    while (true) {
      if (signal.aborted) throw fail('ABORTED');
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw fail('INVALID_RESPONSE');
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw fail('RESPONSE_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
    try { return JSON.parse(text + decoder.decode()); }
    catch { throw fail('INVALID_RESPONSE'); }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export function createDelegationClient({ baseUrl, bearer, parentCommandId, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000, waitTimeoutMs = 600000, pollIntervalMs = 250 } = {}) {
  const base = checkedBaseUrl(baseUrl);
  if (typeof bearer !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(bearer)) throw new TypeError('INVALID_BEARER');
  if (!isId(parentCommandId)) throw new TypeError('INVALID_PARENT_COMMAND_ID');
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      !Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 600000 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60000) throw new TypeError('INVALID_CLIENT_OPTIONS');

  async function request(method, path, body, signal, requestTimeoutMs = timeoutMs) {
    if (signal?.aborted) throw fail('ABORTED');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded !== undefined && utf8Size(encoded) > RESPONSE_LIMIT) throw fail('REQUEST_TOO_LARGE');
    const controller = new AbortController();
    let timer, reader;
    let rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const stop = code => {
      if (controller.signal.aborted) return;
      controller.abort();
      try { void reader?.cancel().catch(() => {}); } catch {}
      rejectStop(fail(code));
    };
    const onAbort = () => stop('ABORTED');
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('REQUEST_TIMEOUT'), requestTimeoutMs);
    const operation = (async () => {
      try {
        const response = await fetchImpl(new URL(path, base), {
          method, redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: { Authorization: `Bearer ${bearer}`, ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(encoded === undefined ? {} : { body: encoded }), signal: controller.signal,
        });
        if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) throw fail('INVALID_RESPONSE');
        if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
          try { void response.body?.cancel().catch(() => {}); } catch {}
          return { response, payload: null };
        }
        return { response, payload: await readJson(response, value => { reader = value; }, controller.signal) };
      } catch (cause) {
        const code = cause?.code;
        if (['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'ABORTED'].includes(code)) throw fail(code);
        throw fail(controller.signal.aborted ? (signal?.aborted ? 'ABORTED' : 'REQUEST_TIMEOUT') : 'CONNECTION_FAILED');
      }
    })();
    try {
      return await Promise.race([operation, stopped]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function responseFailure(method, status) {
    if (method === 'POST') {
      if (status === 400) return fail('INVALID_REQUEST', { status });
      if (status === 404) return fail('NOT_FOUND', { status });
      if (status === 409) return fail('CONFLICT', { status });
      if (status === 413) return fail('TOO_LARGE', { status });
      return fail('DELEGATE_OUTCOME_UNKNOWN', { status });
    }
    if (status === 400) return fail('INVALID_REQUEST', { status });
    if (status === 404) return fail('NOT_FOUND', { status });
    if (status === 409) return fail('CONFLICT', { status });
    if (status === 413) return fail('TOO_LARGE', { status });
    return fail('CONNECTION_FAILED', { status });
  }

  function checkedEffect(value, requestId) {
    if (!plainData(value, EFFECT_KEYS) || !['id', 'requestId', 'parentCommandId', 'parentCardId', 'canvasId', 'toolName'].every(key => isId(value[key])) ||
        value.parentCommandId !== parentCommandId || value.requestId !== requestId || typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadHash) ||
        !Number.isSafeInteger(value.attempt) || value.attempt < 1 || !EFFECT_STATES.has(value.state) ||
        !(value.reasonCode === null || (typeof value.reasonCode === 'string' && CODE.test(value.reasonCode)))) return null;
    let taskReceipt = null;
    if (value.state === 'SUCCEEDED') {
      taskReceipt = checkedRecord(value.receipt, { parentCommandId, requestId });
      if (!taskReceipt) return null;
    } else if (value.receipt !== null) return null;
    return Object.freeze({ ...value, receipt: taskReceipt });
  }

  async function waitEffect(effectId, requestId, signal) {
    const deadline = performance.now() + waitTimeoutMs;
    for (;;) {
      if (signal?.aborted) throw fail('ABORTED');
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw fail('APPROVAL_WAIT_TIMEOUT');
      const response = await request('GET', `/v1/modules/delegation-effects/${encodeURIComponent(effectId)}`, undefined, signal, Math.min(timeoutMs, remaining));
      if (response.response.status !== 200) throw responseFailure('GET', response.response.status);
      if (!plainData(response.payload, ['effect'])) throw fail('INVALID_RESPONSE');
      const effect = checkedEffect(response.payload.effect, requestId);
      if (!effect || effect.id !== effectId) throw fail('INVALID_RESPONSE');
      if (effect.state === 'SUCCEEDED') return Object.freeze({ record: effect.receipt, duplicate: true });
      if (effect.state === 'FAILED') throw fail('EFFECT_FAILED', { effect });
      if (effect.state === 'UNKNOWN') throw fail('DELEGATE_OUTCOME_UNKNOWN', { effect });
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - performance.now())), signal);
    }
  }

  async function delegate(input, options) {
    if (!plainData(input, ['requestId', 'text']) || !isId(input.requestId) || typeof input.text !== 'string' ||
        !input.text.trim() || utf8Size(input.text) > TEXT_LIMIT) throw new TypeError('INVALID_INPUT');
    const signal = checkedSignalOptions(options);
    if (signal?.aborted) throw fail('ABORTED');
    let response, payload;
    try {
      const result = await request('POST', '/v1/modules/delegation', {
        parentCommandId, requestId: input.requestId, text: input.text,
      }, signal);
      response = result.response;
      payload = result.payload;
    } catch (cause) {
      if (cause?.code === 'ABORTED') throw fail('DELEGATE_OUTCOME_UNKNOWN');
      if (cause?.code === 'REQUEST_TIMEOUT' || cause?.code === 'CONNECTION_FAILED' || cause?.code === 'INVALID_RESPONSE' ||
          cause?.code === 'RESPONSE_TOO_LARGE' || cause?.code === 'REQUEST_TOO_LARGE') throw fail('DELEGATE_OUTCOME_UNKNOWN');
      throw cause;
    }
    if (![200, 201, 202].includes(response.status)) throw responseFailure('POST', response.status);
    if (!isObject(payload)) throw fail('DELEGATE_OUTCOME_UNKNOWN');
    if (response.status === 202) {
      if (!plainData(payload, ['effect', 'outcome']) || !['approval_required', 'running', 'unknown'].includes(payload.outcome)) throw fail('DELEGATE_OUTCOME_UNKNOWN');
      const effect = checkedEffect(payload.effect, input.requestId);
      if (!effect) throw fail('DELEGATE_OUTCOME_UNKNOWN');
      return waitEffect(effect.id, input.requestId, signal);
    }
    if (response.status === 200 && plainData(payload, ['record', 'duplicate', 'outcome']) && payload.duplicate === false && payload.outcome === 'unknown') {
      const record = checkedRecord(payload.record, { parentCommandId, requestId: input.requestId });
      if (!record) throw fail('DELEGATE_OUTCOME_UNKNOWN');
      throw fail('DELEGATE_OUTCOME_UNKNOWN', { record });
    }
    const shape = plainData(payload, ['record', 'duplicate']);
    const record = shape && checkedRecord(payload.record, { parentCommandId, requestId: input.requestId });
    if (!record || typeof payload.duplicate !== 'boolean' ||
        (response.status === 201 && payload.duplicate !== false) || (response.status === 200 && payload.duplicate !== true)) {
      throw fail('DELEGATE_OUTCOME_UNKNOWN');
    }
    return Object.freeze({ record, duplicate: payload.duplicate });
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(fail('ABORTED')); return; }
      const timer = setTimeout(done, ms);
      const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(fail('ABORTED')); };
      function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function wait(taskId, options) {
    if (!isId(taskId)) throw new TypeError('INVALID_ID');
    const signal = checkedSignalOptions(options);
    if (signal?.aborted) throw fail('ABORTED');
    const deadline = performance.now() + waitTimeoutMs;
    for (;;) {
      if (signal?.aborted) throw fail('ABORTED');
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw fail('WAIT_TIMEOUT');
      let response;
      try { response = await request('GET', `/v1/modules/delegation/${encodeURIComponent(taskId)}`, undefined, signal, Math.min(timeoutMs, remaining)); }
      catch (cause) {
        if (cause?.code === 'REQUEST_TIMEOUT') throw fail('WAIT_TIMEOUT');
        throw cause;
      }
      if (response.response.status !== 200) throw responseFailure('GET', response.response.status);
      if (!plainData(response.payload, ['record'])) throw fail('INVALID_RESPONSE');
      const record = checkedRecord(response.payload.record, { parentCommandId, id: taskId });
      if (!record) throw fail('INVALID_RESPONSE');
      if (record.state === 'COMPLETED') return record;
      const afterRead = deadline - performance.now();
      if (afterRead <= 0) throw fail('WAIT_TIMEOUT');
      await sleep(Math.min(pollIntervalMs, afterRead), signal);
    }
  }

  return Object.freeze({ delegate, wait });
}
