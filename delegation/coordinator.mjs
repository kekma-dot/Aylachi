// delegation/coordinator.mjs — USE04 server-owned delegation coordinator (CONTRACT v1).
// Owns NO store/Hub/adapter internals: store (L03 frozen API), hubClient and trusted
// policy hooks are injected. No background work on init; no second scheduler/agent loop.
// This module is NOT proof of budget/model enforcement: all real limits/model/grants
// belong to the trusted injected child runner (composition responsibility).

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TEXT_LIMIT = 16 * 1024; // UTF-8 BYTES, matching the store contract
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message ?? code), { code });

// Plain data object with exactly the expected own value properties: no accessors,
// no exotic prototype, no extra/missing keys. Checked BEFORE any policy/store/HTTP use.
function plainData(value, keys) {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && 'value' in descriptor;
  });
}
function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}
function validText(text) {
  return typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text, 'utf8') <= TEXT_LIMIT;
}
function validSignal(signal) {
  return signal === undefined || signal instanceof AbortSignal;
}
function freezeRecord(record) {
  if (!isRecord(record)) return record;
  return Object.freeze({ ...record, result: isRecord(record.result) ? Object.freeze({ ...record.result }) : record.result });
}
function withRecord(error, record) {
  error.record = freezeRecord(record);
  return error;
}
// Deterministic UTF-8 byte bound that never splits a codepoint.
function boundText(text) {
  if (Buffer.byteLength(text, 'utf8') <= TEXT_LIMIT) return text;
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > TEXT_LIMIT) break;
    out += char;
    bytes += size;
  }
  return out;
}

export function createDelegationCoordinator({ store, hubClient, getParentContext, approve, now = Date.now, pollIntervalMs, waitTimeoutMs } = {}) {
  // Fail closed: absent trusted store/client/policy/timing configuration => no coordinator.
  for (const fn of ['reserve', 'get', 'findRequest', 'transition', 'close']) {
    if (typeof store?.[fn] !== 'function') throw fail('POLICY_UNAVAILABLE', 'delegation store with frozen API required');
  }
  for (const fn of ['createCard', 'sendMessage', 'readCommand', 'cancelCommand']) {
    if (typeof hubClient?.[fn] !== 'function') throw fail('POLICY_UNAVAILABLE', 'hub client with frozen API required');
  }
  if (typeof getParentContext !== 'function') throw fail('POLICY_UNAVAILABLE', 'trusted getParentContext required');
  if (typeof approve !== 'function') throw fail('POLICY_UNAVAILABLE', 'trusted approve policy required');
  if (typeof now !== 'function') throw fail('INVALID_CONFIG', 'now must be a function');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000) throw fail('INVALID_CONFIG', 'explicit bounded pollIntervalMs required');
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 600_000) throw fail('INVALID_CONFIG', 'explicit bounded waitTimeoutMs required');

  // Process-local in-flight dedupe only; durable identity lives in the store.
  // Collision-free tuple key; the full frozen parent identity + payload is compared before sharing.
  const inFlight = new Map(); // JSON.stringify([actor, requestId]) -> { parentCommandId, parentCardId, canvasId, text, promise }

  function parent() {
    const context = getParentContext();
    if (!plainData(context, ['actor', 'parentCardId', 'parentCommandId', 'canvasId']) ||
        !isSafeId(context.actor) || !isSafeId(context.parentCardId) ||
        !isSafeId(context.parentCommandId) || !isSafeId(context.canvasId)) {
      throw fail('PARENT_CONTEXT_INVALID', 'trusted parent context must identify actor/card/command/canvas as primitive strings');
    }
    return Object.freeze({ ...context });
  }
  function mustApprove(action, parentContext, extra = {}) {
    // approve must return EXACT true and runs BEFORE any store mutation or HTTP;
    // a denied policy leaves zero state and zero requests.
    if (approve({ action, parent: parentContext, ...extra }) !== true) throw fail('POLICY_DENIED', `approve denied ${action}`);
  }
  function owned(parentContext, taskId) {
    if (!isSafeId(taskId)) throw fail('INVALID_INPUT', 'invalid task id');
    const record = store.get({ actor: parentContext.actor, id: taskId });
    if (!record || record.parentCommandId !== parentContext.parentCommandId ||
        record.parentCardId !== parentContext.parentCardId || record.canvasId !== parentContext.canvasId) {
      throw fail('NOT_FOUND', 'unknown delegation task'); // wrong owner is indistinguishable from absent
    }
    return record;
  }

  // Bounded mapping of a Hub command view -> coordinator transition. Receipt/client metadata
  // and IDs never overwrite task identity; only a safe bounded terminal result may be stored.
  function mapChild(command) {
    if (!isRecord(command)) return null;
    if (command.state === 'RUNNING') return { next: 'DISPATCHED' };
    if (command.state === 'NEEDS_RECONCILIATION') return { next: 'NEEDS_RECONCILIATION' };
    if (command.state !== 'COMPLETED' || !isRecord(command.result)) return null;
    const result = command.result;
    if (result.status === 'cancelled') return { next: 'COMPLETED', result: { status: 'cancelled' } };
    if (result.status === 'ok') {
      // No fabricated empty text: a missing/non-string text means unknown, not success.
      if (typeof result.text !== 'string') return null;
      return { next: 'COMPLETED', result: { status: 'ok', text: boundText(result.text) } };
    }
    if (result.status === 'error' && typeof result.code === 'string' && SAFE_CODE.test(result.code)) {
      return { next: 'COMPLETED', result: { status: 'error', code: result.code } };
    }
    return null; // unknown result shape => outcome stays unknown, no mutation
  }

  function cas(actor, record, mapping) {
    if (record.state === 'COMPLETED') return record; // terminal is immutable, never downgrade
    if (mapping.next === record.state && mapping.result === undefined) return record;
    try {
      return store.transition({
        actor, id: record.id, expectedState: record.state, nextState: mapping.next,
        ...(mapping.result !== undefined ? { result: mapping.result } : {}), now: now(),
      });
    } catch (error) {
      // Only an expected-state CAS race resolves by authoritative re-read. Store
      // validation errors (illegal transition, bad result) are NEVER swallowed.
      const race = ['CONFLICT', 'CAS_CONFLICT', 'REVISION_CONFLICT'].includes(error?.code);
      if (!race) throw error;
      const current = store.get({ actor, id: record.id });
      return current ?? record;
    }
  }

  function applyMapping(actor, record, mapping) {
    let current = record;
    if (current.state === 'COMPLETED') return current;
    // RESERVED may not jump to a terminal state: walk the legal path through an
    // intermediate non-terminal state first (child command was observed running/existing).
    if (current.state === 'RESERVED' && mapping.next === 'COMPLETED') {
      current = cas(actor, current, { next: 'DISPATCHED' });
      if (current.state !== 'DISPATCHED' && current.state !== 'NEEDS_RECONCILIATION') return current;
    }
    return cas(actor, current, mapping);
  }

  async function readChildMapping(record, signal, timeoutMs = waitTimeoutMs) {
    // Bound even an injected read that ignores its signal. Losing promises are
    // observed but never apply late mappings or issue mutation requests.
    if (signal?.aborted) throw fail('ABORTED');
    const reads = new AbortController();
    let timer, onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => { reads.abort(); reject(fail('ABORTED')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { reads.abort(); reject(fail('WAIT_TIMEOUT')); }, Math.max(1, timeoutMs));
    });
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => hubClient.readCommand(record.childCommandId, reads.signal)), stopped,
      ]);
      const command = response?.command;
      if (!isRecord(command) || command.id !== record.childCommandId) return null;
      return mapChild(command);
    } catch (error) {
      if (signal?.aborted) throw fail('ABORTED');
      if (error?.code === 'WAIT_TIMEOUT') throw error;
      return null; // failed read remains unknown; no POST replay
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(fail('ABORTED')); return; }
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { cleanup(); reject(fail('ABORTED', 'wait aborted; child left running, no replay/cancel attempted')); };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function delegate(input, { signal } = {}) {
    if (!plainData(input, ['requestId', 'text']) || !isSafeId(input.requestId) || !validText(input.text)) {
      throw fail('INVALID_INPUT', 'delegate requires exactly {requestId, text} as primitive values');
    }
    if (!validSignal(signal)) throw fail('INVALID_INPUT', 'invalid signal');
    const parentContext = parent();
    mustApprove('delegate', parentContext, { request: Object.freeze({ requestId: input.requestId, text: input.text }) });
    const key = JSON.stringify([parentContext.actor, input.requestId]);
    const pending = inFlight.get(key);
    if (pending) {
      // Never share another parent's pending record: the full frozen identity + payload must match.
      const sameTask = pending.text === input.text &&
        pending.parentCommandId === parentContext.parentCommandId &&
        pending.parentCardId === parentContext.parentCardId &&
        pending.canvasId === parentContext.canvasId;
      if (!sameTask) throw fail('CONFLICT', 'requestId already in flight with a different parent scope or payload');
      // One owner per in-flight task: share the single POST sequence, no second create/send.
      const shared = await pending.promise;
      return Object.freeze({ record: freezeRecord(shared.record), duplicate: true });
    }
    const promise = (async () => {
      const { record, duplicate } = store.reserve({
        actor: parentContext.actor, requestId: input.requestId,
        parentCommandId: parentContext.parentCommandId, parentCardId: parentContext.parentCardId,
        canvasId: parentContext.canvasId, text: input.text, now: now(),
      });
      if (duplicate) {
        // Already reserved (restart/unknown outcome): reconcile by READ only, never replay create/send.
        if (record.state === 'COMPLETED') return { record, duplicate: true };
        const mapping = await readChildMapping(record, signal);
        if (mapping) return { record: applyMapping(parentContext.actor, record, mapping), duplicate: true };
        // Reserved but dispatch outcome unknown (e.g. crash before/within POSTs).
        return { record: record.state === 'RESERVED' ? cas(parentContext.actor, record, { next: 'NEEDS_RECONCILIATION' }) : record, duplicate: true };
      }
      try {
        const created = await hubClient.createCard(
          { id: record.childCardId, canvasId: record.canvasId, sessionId: record.childSessionId, title: 'Delegated task', x: 0, y: 0 },
          record.leaseId, signal,
        );
        if (!isRecord(created?.card) || typeof created.duplicate !== 'boolean' ||
            created.card.id !== record.childCardId || created.card.canvasId !== record.canvasId ||
            created.card.sessionId !== record.childSessionId) throw fail('INVALID_CHILD_RECEIPT');
        const ack = await hubClient.sendMessage(record.childCardId, record.text, record.childCommandId, signal);
        // Only a known Hub receipt can establish dispatch; missing metadata is unknown.
        if (!isRecord(ack?.command) || ack.command.id !== record.childCommandId ||
            !['RUNNING', 'COMPLETED', 'NEEDS_RECONCILIATION'].includes(ack.command.state) || typeof ack.duplicate !== 'boolean') {
          const updated = cas(parentContext.actor, record, { next: 'NEEDS_RECONCILIATION' });
          throw withRecord(fail('DELEGATE_OUTCOME_UNKNOWN', 'child command receipt did not match the reserved command id'), updated);
        }
        // Accepted receipt observed.
        return { record: cas(parentContext.actor, record, { next: 'DISPATCHED' }), duplicate: false };
      } catch (error) {
        if (error?.code === 'DELEGATE_OUTCOME_UNKNOWN') throw error;
        // Unknown POST result (incl. abort): mark, then report — never auto repeat create/send/cancel.
        const updated = cas(parentContext.actor, record, { next: 'NEEDS_RECONCILIATION' });
        const code = signal?.aborted === true ? 'ABORTED' : 'DELEGATE_OUTCOME_UNKNOWN';
        throw withRecord(fail(code, 'child dispatch outcome unknown; task kept for read-only reconciliation'), updated);
      }
    })();
    inFlight.set(key, {
      text: input.text,
      parentCommandId: parentContext.parentCommandId,
      parentCardId: parentContext.parentCardId,
      canvasId: parentContext.canvasId,
      promise,
    });
    try {
      const outcome = await promise;
      return Object.freeze({ record: freezeRecord(outcome.record), duplicate: outcome.duplicate });
    }
    finally { inFlight.delete(key); }
  }

  async function reconcile(taskId) {
    const parentContext = parent();
    const record = owned(parentContext, taskId);
    mustApprove('reconcile', parentContext, { record: freezeRecord(record) });
    if (record.state === 'COMPLETED') return freezeRecord(record);
    const mapping = await readChildMapping(record);
    if (!mapping) return freezeRecord(record); // stays unknown; READ-only, no mutation request
    return freezeRecord(applyMapping(parentContext.actor, record, mapping));
  }

  async function wait(taskId, { signal } = {}) {
    if (!validSignal(signal)) throw fail('INVALID_INPUT', 'invalid signal');
    const parentContext = parent();
    let record = owned(parentContext, taskId);
    mustApprove('wait', parentContext, { record: freezeRecord(record) });
    if (record.state === 'COMPLETED') return freezeRecord(record);
    const deadline = performance.now() + waitTimeoutMs;
    for (;;) {
      if (signal?.aborted) throw withRecord(fail('ABORTED', 'wait aborted; child left running, no replay/cancel attempted'), record);
      const readRemaining = deadline - performance.now();
      if (readRemaining <= 0) throw withRecord(fail('WAIT_TIMEOUT'), record);
      let mapping;
      try { mapping = await readChildMapping(record, signal, readRemaining); }
      catch (error) { throw withRecord(error, record); }
      if (mapping) record = applyMapping(parentContext.actor, record, mapping);
      if (record.state === 'COMPLETED') return freezeRecord(record);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw withRecord(fail('WAIT_TIMEOUT', 'wait timed out; outcome unknown, no replay/cancel attempted'), record);
      try { await sleep(Math.min(pollIntervalMs, remaining), signal); }
      catch (error) { throw withRecord(error, record); }
    }
  }

  async function cancel(taskId, { signal } = {}) {
    if (!validSignal(signal)) throw fail('INVALID_INPUT', 'invalid signal');
    const parentContext = parent();
    const record = owned(parentContext, taskId);
    mustApprove('cancel', parentContext, { record: freezeRecord(record) });
    if (record.state === 'COMPLETED') return Object.freeze({ record: freezeRecord(record), cancelRequested: false }); // terminal: nothing to cancel
    // Explicit cancellation REQUEST with the stable stored cancelRequestId.
    let ack;
    try { ack = await hubClient.cancelCommand(record.childCommandId, record.cancelRequestId, signal); }
    catch {
      // Static safe error: no raw client message/code/URL/token leakage; frozen record attached.
      throw withRecord(fail('CANCEL_OUTCOME_UNKNOWN', 'cancel request outcome unknown'), record);
    }
    // cancelRequested=true ONLY on a known Hub cancellation receipt for our stored
    // cancelRequestId; it never claims the child task itself is cancelled.
    const known = isRecord(ack?.command) && ack.command.id === record.cancelRequestId &&
      isRecord(ack.command.result) && ack.command.result.status === 'accepted';
    const current = store.get({ actor: parentContext.actor, id: record.id }) ?? record;
    return Object.freeze({ record: freezeRecord(current), cancelRequested: known });
  }

  return Object.freeze({ delegate, wait, reconcile, cancel });
}
