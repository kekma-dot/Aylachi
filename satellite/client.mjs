import { randomUUID } from 'node:crypto';
import { bad, code, leaseSnapshot, satelliteManifest } from './protocol.mjs';

// One outbound authenticated client for all connectors hosted by a Satellite.
// Hub and Satellite journals are deliberately separate failure domains.
export function createSatelliteClient({ baseUrl, satelliteId, secret, connectors, executionStore, pollIntervalMs = 20, toolTimeoutMs = 2_000 } = {}) {
  if (typeof baseUrl !== 'string' || typeof secret !== 'string' || secret.length < 32 || !executionStore ||
      !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || !Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1) throw new TypeError('invalid Satellite client config');
  const manifest = satelliteManifest({ protocolVersion: 1, satelliteId, connectors: connectors?.map(connector => connector.manifest) });
  const tools = new Map();
  for (const connector of connectors) {
    if (typeof connector.execute !== 'function') throw new TypeError('connector execute required');
    for (const tool of connector.manifest.tools) tools.set(tool.name, { connector, descriptor: tool });
  }
  let sessionId, timer, running = false, stopped = false, tickPromise = null;
  const active = new Map(), controllers = new Set();
  async function request(action, body) {
    const response = await fetch(`${baseUrl}/v1/satellite/${action}`, {
      method: 'POST', headers: { authorization: ['Bear', 'er ', secret].join(''), 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(toolTimeoutMs),
    });
    const text = await response.text();
    if (text.length > 1024 * 1024) throw bad('RESPONSE_TOO_LARGE');
    let value;
    try { value = text ? JSON.parse(text) : {}; } catch { throw bad('INVALID_HUB_RESPONSE'); }
    if (!response.ok) throw bad(value.error ?? 'HUB_REQUEST_FAILED', response.status);
    return value;
  }
  function serviceBody() {
    if (!sessionId) throw bad('CLIENT_NOT_STARTED');
    return { satelliteId: manifest.satelliteId, sessionId };
  }
  async function report(record) {
    await request('complete', { ...serviceBody(), commandId: record.commandId, leaseId: record.leaseId,
      fencingToken: record.fencingToken, outcome: record.outcome });
    executionStore.markReported(record);
  }
  async function processLease(input) {
    const lease = leaseSnapshot(input);
    if (active.has(lease.commandId)) return active.get(lease.commandId);
    const controller = new AbortController();
    controllers.add(controller);
    const promise = (async () => {
      let previous = executionStore.find(lease.commandId);
      if (previous?.outcome) return report(previous);
      const tool = tools.get(lease.toolName);
      if (!tool) throw bad('TOOL_NOT_REGISTERED');
      let outcome;
      if (previous?.state === 'RUNNING' && lease.descriptor.sideEffect && !lease.descriptor.idempotent) {
        outcome = { state: 'UNKNOWN', reasonCode: 'SATELLITE_RESTARTED' };
      } else {
        await request('ack', { ...serviceBody(), commandId: lease.commandId, leaseId: lease.leaseId, fencingToken: lease.fencingToken });
        previous = executionStore.begin({ lease, now: Date.now() }).record;
        if (previous.outcome) return report(previous);
        const timeout = AbortSignal.timeout(toolTimeoutMs);
        const signal = AbortSignal.any([controller.signal, timeout]);
        try {
          const result = await tool.connector.execute({ payload: lease.payload, commandId: lease.commandId, signal,
            emit: async (type, value) => request('event', { ...serviceBody(), commandId: lease.commandId,
              leaseId: lease.leaseId, fencingToken: lease.fencingToken, eventId: randomUUID(), type, payload: value }) });
          outcome = { state: 'SUCCEEDED', result: result ?? null };
        } catch (error) {
          let reason = 'TOOL_OUTCOME_UNKNOWN';
          try { if (!lease.descriptor.sideEffect || error?.safeNoSideEffect === true) reason = code(error?.code ?? 'TOOL_FAILED'); } catch { reason = 'TOOL_FAILED'; }
          outcome = lease.descriptor.sideEffect && reason === 'TOOL_OUTCOME_UNKNOWN'
            ? { state: 'UNKNOWN', reasonCode: reason }
            : { state: 'FAILED', reasonCode: reason };
        }
      }
      const completed = executionStore.complete({ commandId: lease.commandId, outcome, now: Date.now() });
      await report(completed);
    })().finally(() => { active.delete(lease.commandId); controllers.delete(controller); });
    active.set(lease.commandId, promise);
    return promise;
  }
  async function tick() {
    if (!running || stopped) return;
    try {
      for (const pending of executionStore.pending()) await report(pending);
      await request('heartbeat', { ...serviceBody(), connectors: connectors.map(connector => ({
        id: connector.manifest.id, state: connector.health?.() ?? 'ONLINE',
      })) });
      const { commands } = await request('poll', serviceBody());
      for (const lease of commands) void processLease(lease).catch(() => {});
    } catch { /* reconnect on the next bounded tick */ }
  }
  function schedule() {
    if (!running || stopped) return;
    timer = setTimeout(() => {
      tickPromise = tick().finally(schedule);
    }, pollIntervalMs);
  }
  return Object.freeze({
    async start() {
      if (running) return;
      const result = await request('handshake', manifest);
      sessionId = result.sessionId; stopped = false; running = true;
      for (const pending of executionStore.pending()) await report(pending);
      schedule();
    },
    async runOnce() { await tick(); await Promise.all([...active.values()]); },
    async stop() {
      if (stopped) return;
      stopped = true; running = false; clearTimeout(timer);
      for (const controller of controllers) controller.abort();
      await tickPromise;
      await Promise.allSettled([...active.values()]);
    },
  });
}
