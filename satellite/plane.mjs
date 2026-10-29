import { bad, exact, id, outcomeSnapshot, payload, satelliteManifest, time } from './protocol.mjs';

function approval(value) {
  exact(value, ['id', 'tools', 'capabilities'], ['secret']);
  id(value.id);
  if (!Array.isArray(value.tools) || !value.tools.length || value.tools.some(item => typeof item !== 'string') ||
      !Array.isArray(value.capabilities) || value.capabilities.some(item => typeof item !== 'string')) throw new TypeError('invalid satellite registration');
  return Object.freeze({ id: value.id, tools: new Set(value.tools), capabilities: new Set(value.capabilities) });
}

// Hub-authoritative connector control plane. Delivery is at least once; the
// store and Satellite idempotency journal decide whether an effect may retry.
export function createSatellitePlane({ store, registrations, now = Date.now, leaseMs = 5_000 } = {}) {
  if (!store || !Array.isArray(registrations) || !registrations.length) throw new TypeError('satellite store and registrations required');
  if (typeof now !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 60_000) throw new TypeError('invalid satellite timings');
  const approved = new Map(registrations.map(approval).map(item => [item.id, item]));
  function identity(satelliteId) {
    id(satelliteId);
    const registration = approved.get(satelliteId);
    if (!registration) throw bad('SATELLITE_NOT_FOUND', 404);
    return registration;
  }
  function session(input) {
    if (!input || typeof input !== 'object') throw bad('INVALID_REQUEST');
    identity(input.satelliteId); id(input.sessionId);
    return input;
  }
  return Object.freeze({
    handshake(input) {
      const manifest = satelliteManifest(input), registration = identity(manifest.satelliteId);
      for (const connector of manifest.connectors) for (const tool of connector.tools) {
        if (!registration.tools.has(tool.name) || tool.capabilities.some(capability => !registration.capabilities.has(capability))) throw bad('CONNECTOR_NOT_APPROVED', 403);
      }
      return store.handshake({ satelliteId: manifest.satelliteId, connectors: manifest.connectors, now: time(now()) });
    },
    heartbeat(input) {
      const value = session(input);
      exact(input, ['satelliteId', 'sessionId'], ['connectors']);
      const connectors = input.connectors ?? [];
      if (!Array.isArray(connectors) || connectors.length > 16 || connectors.some(connector => {
        try { exact(connector, ['id', 'state']); id(connector.id); return !['ONLINE', 'DEGRADED', 'OFFLINE'].includes(connector.state); }
        catch { return true; }
      })) throw bad('INVALID_REQUEST');
      return store.heartbeat({ satelliteId: value.satelliteId, sessionId: value.sessionId, connectors, now: time(now()) });
    },
    poll(input) {
      const value = session(input);
      return { commands: store.poll({ satelliteId: value.satelliteId, sessionId: value.sessionId, now: time(now()), leaseMs }) };
    },
    ack(input) {
      const value = session(input);
      exact(input, ['satelliteId', 'sessionId', 'commandId', 'leaseId', 'fencingToken']);
      return store.ack({ ...value, now: time(now()) });
    },
    complete(input) {
      const value = session(input);
      exact(input, ['satelliteId', 'sessionId', 'commandId', 'leaseId', 'fencingToken', 'outcome']);
      return store.complete({ ...value, outcome: outcomeSnapshot(input.outcome), now: time(now()) });
    },
    appendEvent(input) {
      const value = session(input);
      exact(input, ['satelliteId', 'sessionId', 'commandId', 'leaseId', 'fencingToken', 'eventId', 'type', 'payload']);
      return store.appendEvent({ ...value, payload: payload(input.payload), now: time(now()) });
    },
    invoke({ actor, requestId, toolName, payload: input }) {
      id(actor); id(requestId); id(toolName);
      const tool = store.tool(toolName);
      if (!tool) throw bad('NOT_FOUND', 404);
      const registration = identity(tool.satelliteId);
      if (!registration.tools.has(toolName) || tool.descriptor.capabilities.some(capability => !registration.capabilities.has(capability))) throw bad('CONNECTOR_NOT_APPROVED', 403);
      return store.reserve({ actor, requestId, tool, payload: payload(input), now: time(now()) });
    },
    approve({ actor, commandId, expectedPayloadHash, action }) {
      id(actor); id(commandId);
      return store.approve({ actor, commandId, expectedPayloadHash, action, now: time(now()) });
    },
    get({ actor, commandId }) {
      id(actor); id(commandId); store.expire({ now: time(now()) });
      const command = store.get({ actor, commandId });
      if (!command) throw bad('NOT_FOUND', 404);
      return command;
    },
    list({ actor, limit }) { id(actor); store.expire({ now: time(now()) }); return store.list({ actor, limit }); },
    events({ actor, after, limit }) { id(actor); store.expire({ now: time(now()) }); return store.events({ actor, after, limit }); },
    revoke({ satelliteId }) { identity(satelliteId); return store.revoke({ satelliteId, now: time(now()) }); },
    catalog() { const timestamp = time(now()); store.expire({ now: timestamp }); return store.catalog({ now: timestamp }); },
  });
}
