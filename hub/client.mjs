// Development transport only: use an explicitly provisioned loopback endpoint.
// No credential persistence, implicit retries, global cursor, or browser CORS bypass.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LIMIT = 64 * 1024;
const states = new Set(['RUNNING', 'COMPLETED', 'NEEDS_RECONCILIATION']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && ID.test(value);
const validSize = (width, height) => Number.isFinite(width) && width >= 320 && width <= 1200 &&
  Number.isFinite(height) && height >= 360 && height <= 1200;
const validModel = value => object(value) && validId(value.provider) && validId(value.modelId) && ['low', 'medium', 'high'].includes(value.reasoning);
const sequence = value => Number.isSafeInteger(value) && value >= 0;
const executionTypes = new Set(['turn.started', 'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.needs_reconciliation',
  'item.started', 'item.completed', 'tool.started', 'tool.completed', 'tool.effect', 'artifact.version', 'theme.proposal', 'text.delta', 'reasoning.delta', 'turn.metrics']);
const validExecutionRecord = value => object(value) && Object.keys(value).length === 3 &&
  ((value.durable === true && Number.isSafeInteger(value.seq) && value.seq >= 1) || (value.durable === false && value.seq === null)) &&
  object(value.event) && value.event.schemaVersion === 1 && executionTypes.has(value.event.type) &&
  ['workspaceId', 'conversationId', 'runId', 'turnId', 'itemId', 'eventId'].every(key => typeof value.event[key] === 'string' && value.event[key].length > 0 && value.event[key].length <= 256) &&
  object(value.event.payload) && JSON.stringify(value.event).length <= LIMIT;
const error = (code, status = 0, unknownOutcome = false) => Object.assign(new Error(code), { code, status, unknownOutcome });
function id(value) { if (!validId(value)) throw new TypeError('INVALID_ID'); return encodeURIComponent(value); }
function command(value, expectedId) { return object(value) && value.id === expectedId && states.has(value.state); }

async function readJson(response) {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw error('INVALID_RESPONSE');
  const reader = response.body?.getReader();
  if (!reader) throw error('INVALID_RESPONSE');
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) { await reader.cancel(); throw error('RESPONSE_TOO_LARGE'); }
      text += decoder.decode(value, { stream: true });
    }
    try { return JSON.parse(text + decoder.decode()); }
    catch { throw error('INVALID_RESPONSE'); }
  } finally { reader.releaseLock(); }
}

export function createHubClient({ baseUrl, bearer, timeoutMs = 10000, fetch: fetchImpl = globalThis.fetch } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname) ||
      !base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new TypeError('LOOPBACK_ORIGIN_REQUIRED');
  }
  if (typeof bearer !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(bearer)) throw new TypeError('INVALID_BEARER');
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('INVALID_CLIENT_OPTIONS');

  async function request(method, path, body, statuses, validate, signal) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && new TextEncoder().encode(encoded).byteLength > LIMIT) throw new TypeError('REQUEST_TOO_LARGE');
    if (signal?.aborted) throw error('ABORTED'); // No request sent: no uncertain mutation.
    let response;
    try {
      response = await fetchImpl(new URL(path, base), {
        method, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Authorization: `Bearer ${bearer}`, ...(encoded ? { 'Content-Type': 'application/json' } : {}) },
        body: encoded,
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
      if (!statuses.includes(response.status)) {
        await response.body?.cancel();
        throw error('HTTP_ERROR', response.status, method === 'POST' && !(response.status >= 400 && response.status < 500));
      }
      const payload = await readJson(response);
      if (!object(payload) || !validate(payload)) throw error('INVALID_RESPONSE');
      return payload;
    } catch (cause) {
      // Never surface fetch URLs, raw response bodies, headers or credential-bearing causes.
      if (cause?.code === 'HTTP_ERROR') throw cause;
      const code = ['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(cause?.code) ? cause.code : signal?.aborted ? 'ABORTED' : 'CONNECTION_FAILED';
      throw error(code, response?.status ?? 0, method === 'POST');
    }
  }

  return {
    moduleRequest({ method, path, body, signal } = {}) {
      const match = typeof path === 'string' && path.match(/^(\/v1\/modules\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)(\?[^#]*)?$/);
      if (!['GET', 'POST'].includes(method) || !match || match[1].split('/').some(part => part === '.' || part === '..')) throw new TypeError('INVALID_MODULE_REQUEST');
      if (method === 'GET' && body !== undefined) throw new TypeError('INVALID_MODULE_REQUEST');
      const target = new URL(path, base);
      if (target.origin !== base.origin || target.hash || target.pathname !== match[1]) throw new TypeError('INVALID_MODULE_REQUEST');
      if (new TextEncoder().encode(path).byteLength > LIMIT) throw new TypeError('REQUEST_TOO_LARGE');
      return request(method, `${target.pathname}${target.search}`, body, method === 'GET' ? [200] : [200, 201, 202], object, signal);
    },
    createCard(card, requestId, signal) {
      id(requestId);
      if (!object(card) || !['id', 'canvasId', 'sessionId'].every(key => validId(card[key])) ||
          typeof card.title !== 'string' || !card.title.length || card.title.length > 4096 ||
          !Number.isFinite(card.x) || !Number.isFinite(card.y) ||
          Object.keys(card).some(key => !['id', 'canvasId', 'sessionId', 'title', 'x', 'y', 'backendId'].includes(key)) ||
          (card.backendId !== undefined && !validId(card.backendId))) throw new TypeError('INVALID_CARD');
      return request('POST', '/v1/cards', { ...card, requestId }, [200, 201], p => p.card?.id === card.id && typeof p.duplicate === 'boolean', signal);
    },
    deleteCard(cardId, expectedRevision, signal) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('INVALID_REVISION');
      return request('POST', `/v1/cards/${id(cardId)}/delete`, { expectedRevision }, [200], p =>
        Object.keys(p).length === 1 && p.deleted === true, signal);
    },
    listCards(canvasId, signal) {
      const requestedCanvasId = id(canvasId);
      return request('GET', `/v1/cards?canvasId=${requestedCanvasId}`, undefined, [200], payload => {
        if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'cards') ||
            !Array.isArray(payload.cards) || payload.cards.length > 100) return false;
        const ids = new Set();
        return payload.cards.every(card => {
          const keys = ['id', 'canvasId', 'sessionId', 'title', 'x', 'y', 'revision'];
          if (!object(card) || ![keys.length, keys.length + 2, keys.length + 3, keys.length + 5].includes(Object.keys(card).length) || keys.some(key => !Object.hasOwn(card, key)) ||
              Object.keys(card).some(key => ![...keys, 'width', 'height', 'modelProvider', 'modelId', 'reasoning'].includes(key)) ||
              Object.hasOwn(card, 'width') !== Object.hasOwn(card, 'height') ||
              ['modelProvider', 'modelId', 'reasoning'].some(key => Object.hasOwn(card, key)) !== Object.hasOwn(card, 'modelProvider') ||
              !validId(card.id) || ids.has(card.id) || card.canvasId !== canvasId || !validId(card.canvasId) ||
              !validId(card.sessionId) || typeof card.title !== 'string' || !card.title.length || card.title.length > 4096 ||
              !Number.isFinite(card.x) || !Number.isFinite(card.y) ||
              !Number.isSafeInteger(card.revision) || card.revision < 1 ||
              (Object.hasOwn(card, 'width') && !validSize(card.width, card.height)) ||
              (Object.hasOwn(card, 'modelProvider') && (!validId(card.modelProvider) || !validId(card.modelId) || !['low', 'medium', 'high'].includes(card.reasoning)))) return false;
          ids.add(card.id);
          return true;
        });
      }, signal);
    },
    moveCard(cardId, position, signal) {
      const path = `/v1/cards/${id(cardId)}/position`;
      const keys = object(position) ? Reflect.ownKeys(position) : [];
      if (keys.length !== 3 || keys.some(key => !['expectedRevision', 'x', 'y'].includes(key)) ||
          !Number.isSafeInteger(position.expectedRevision) || position.expectedRevision < 1 ||
          !Number.isFinite(position.x) || Math.abs(position.x) > 1_000_000 ||
          !Number.isFinite(position.y) || Math.abs(position.y) > 1_000_000) throw new TypeError('INVALID_POSITION');
      const { expectedRevision, x, y } = position;
      return request('POST', path, { expectedRevision, x, y }, [200], p => {
        const card = p.card;
        return object(card) && card.id === cardId && validId(card.canvasId) && validId(card.sessionId) &&
          typeof card.title === 'string' && card.title.length > 0 && card.title.length <= 4096 &&
          Number.isFinite(card.x) && Number.isFinite(card.y) && card.x === x && card.y === y &&
          card.revision === expectedRevision + 1;
      }, signal);
    },
    modelCatalog(signal) {
      return request('GET', '/v1/modules/models/catalog', undefined, [200], p => Array.isArray(p.models) && p.models.length > 0 &&
        p.models.every(model => object(model) && validId(model.provider) && validId(model.id) && typeof model.name === 'string') && validModel(p.default), signal);
    },
    updateModelSettings(cardId, update, signal) {
      const keys = object(update) ? Reflect.ownKeys(update) : [];
      if (keys.length !== 4 || keys.some(key => !['expectedRevision', 'provider', 'modelId', 'reasoning'].includes(key)) ||
          !Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 1 || !validModel(update)) throw new TypeError('INVALID_MODEL_SETTINGS');
      const { expectedRevision, provider, modelId, reasoning } = update;
      return request('POST', `/v1/modules/models/cards/${id(cardId)}/settings`, { expectedRevision, provider, modelId, reasoning }, [200], p =>
        object(p.card) && p.card.id === cardId && p.card.modelProvider === provider && p.card.modelId === modelId &&
        p.card.reasoning === reasoning && p.card.revision === expectedRevision + 1 && validModel(p.selection) &&
        p.selection.provider === provider && p.selection.modelId === modelId && p.selection.reasoning === reasoning, signal);
    },
    updateLayout(cardId, layout, signal) {
      const keys = object(layout) ? Reflect.ownKeys(layout) : [];
      if (keys.length !== 5 || keys.some(key => !['expectedRevision', 'x', 'y', 'width', 'height'].includes(key)) ||
          !Number.isSafeInteger(layout.expectedRevision) || layout.expectedRevision < 1 ||
          !Number.isFinite(layout.x) || Math.abs(layout.x) > 1_000_000 || !Number.isFinite(layout.y) || Math.abs(layout.y) > 1_000_000 ||
          !validSize(layout.width, layout.height)) throw new TypeError('INVALID_LAYOUT');
      const { expectedRevision, x, y, width, height } = layout;
      return request('POST', `/v1/cards/${id(cardId)}/layout`, { expectedRevision, x, y, width, height }, [200], p => {
        const card = p.card;
        return object(card) && card.id === cardId && validId(card.canvasId) && validId(card.sessionId) &&
          typeof card.title === 'string' && card.title.length > 0 && card.title.length <= 4096 &&
          card.x === x && card.y === y && card.width === width && card.height === height && card.revision === expectedRevision + 1;
      }, signal);
    },
    renameCard(cardId, update, signal) {
      const keys = object(update) ? Reflect.ownKeys(update) : [];
      if (keys.length !== 2 || keys.some(key => !['expectedRevision', 'title'].includes(key)) ||
          !Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 1 ||
          typeof update.title !== 'string' || !update.title.trim() || update.title.length > 120) throw new TypeError('INVALID_TITLE');
      const { expectedRevision, title } = update;
      return request('POST', `/v1/cards/${id(cardId)}/title`, { expectedRevision, title }, [200], p => {
        const card = p.card;
        return object(card) && card.id === cardId && validId(card.canvasId) && validId(card.sessionId) &&
          card.title === title && card.revision === expectedRevision + 1;
      }, signal);
    },
    sendMessage(cardId, text, requestId, signal) {
      const path = `/v1/cards/${id(cardId)}/messages`; id(requestId);
      if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).byteLength > 16 * 1024) throw new TypeError('INVALID_MESSAGE');
      return request('POST', path, { requestId, text }, [202], p => command(p.command, requestId) && typeof p.duplicate === 'boolean', signal);
    },
    readCommand(commandId, signal) {
      return request('GET', `/v1/commands/${id(commandId)}`, undefined, [200], p => command(p.command, commandId), signal);
    },
    cancelCommand(commandId, requestId, signal) {
      const path = `/v1/commands/${id(commandId)}/cancel`; id(requestId);
      return request('POST', path, { requestId }, [202], p => command(p.command, requestId) && typeof p.duplicate === 'boolean', signal);
    },
    snapshot(cardId, signal) {
      return request('GET', `/v1/snapshot?cardId=${id(cardId)}`, undefined, [200], p => p.card?.id === cardId && sequence(p.eventSequence), signal);
    },
    events(cardId, after = 0, limit = 100, signal) {
      id(cardId);
      if (!sequence(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('INVALID_EVENT_RANGE');
      return request('GET', `/v1/events?cardId=${id(cardId)}&after=${after}&limit=${limit}`, undefined, [200], p =>
        Array.isArray(p.events) && p.events.length <= limit && p.events.every((event, index) => object(event) && event.sequence === after + index + 1 && typeof event.kind === 'string') &&
        p.nextSequence === (p.events.at(-1)?.sequence ?? after), signal);
    },
    async streamEvents({ cardId, afterSeq = 0, onEvent, onReady, signal } = {}) {
      id(cardId);
      if (!sequence(afterSeq) || typeof onEvent !== 'function' || (onReady !== undefined && typeof onReady !== 'function')) throw new TypeError('INVALID_EVENT_STREAM');
      if (signal?.aborted) throw error('ABORTED');
      let response;
      try {
        response = await fetchImpl(new URL(`/v1/events/stream?cardId=${id(cardId)}&after_seq=${afterSeq}`, base), {
          method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: { Authorization: `Bearer ${bearer}`, Accept: 'text/event-stream' }, signal,
        });
        if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
          await response.body?.cancel(); throw error('INVALID_RESPONSE', response.status);
        }
        const reader = response.body?.getReader();
        if (!reader) throw error('INVALID_RESPONSE');
        const decoder = new TextDecoder();
        let buffer = '', cursor = afterSeq;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 2 * LIMIT) { await reader.cancel(); throw error('RESPONSE_TOO_LARGE'); }
            let boundary;
            while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
              const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
              const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + separator.length);
              let name = 'message';
              const data = [];
              for (const line of block.split(/\r?\n/)) {
                if (line.startsWith('event:')) name = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
              }
              if (!data.length) continue;
              let payload;
              try { payload = JSON.parse(data.join('\n')); } catch { throw error('INVALID_RESPONSE'); }
              if (name === 'ready') {
                if (!object(payload) || Object.keys(payload).length !== 1 || !sequence(payload.seq)) throw error('INVALID_RESPONSE');
                cursor = payload.seq; onReady?.(payload.seq);
              } else if (name === 'execution') {
                if (!validExecutionRecord(payload)) throw error('INVALID_RESPONSE');
                if (payload.durable) cursor = payload.seq;
                onEvent(payload);
              }
            }
          }
          return { nextSequence: cursor };
        } finally { reader.releaseLock(); }
      } catch (cause) {
        if (['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(cause?.code)) throw cause;
        throw error(signal?.aborted ? 'ABORTED' : 'CONNECTION_FAILED', response?.status ?? 0);
      }
    },
  };
}
