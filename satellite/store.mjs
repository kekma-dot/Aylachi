import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { bad, code, exact, id, json, payloadHash, publicCommand, requireHash, time } from './protocol.mjs';

const ACTIVE = new Set(['PENDING_APPROVAL', 'QUEUED', 'LEASED', 'RUNNING']);
const LEASED = new Set(['LEASED', 'RUNNING']);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'UNKNOWN']);
const safeError = error => error?.code ? error : bad('STORE_FAILED', 500);

function event(row) {
  return row && Object.freeze({ sequence: row.sequence, commandId: row.command_id, eventId: row.event_id,
    type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at });
}

export function openSatelliteStore(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new TypeError('satellite database path required');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS satellites (
      id TEXT PRIMARY KEY, session_id TEXT, state TEXT NOT NULL, last_seen INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT NOT NULL, satellite_id TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL,
      health TEXT NOT NULL DEFAULT 'ONLINE', updated_at INTEGER NOT NULL, PRIMARY KEY(id,satellite_id)
    );
    CREATE TABLE IF NOT EXISTS connector_tools (
      name TEXT PRIMARY KEY, connector_id TEXT NOT NULL, satellite_id TEXT NOT NULL,
      descriptor_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS satellite_commands (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, request_id TEXT NOT NULL,
      satellite_id TEXT NOT NULL, connector_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, descriptor_json TEXT NOT NULL,
      side_effect INTEGER NOT NULL, idempotent INTEGER NOT NULL,
      state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
      lease_id TEXT, fencing_token INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER,
      result_json TEXT, reason_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(actor,request_id)
    );
    CREATE INDEX IF NOT EXISTS satellite_commands_dispatch ON satellite_commands(satellite_id,state,created_at);
    CREATE TABLE IF NOT EXISTS satellite_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL, event_id TEXT NOT NULL,
      type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(command_id,event_id)
    );`);
  let closed = false;
  function transaction(fn) {
    if (closed) throw bad('STORE_CLOSED', 409);
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw safeError(error); }
  }
  const commandRow = (actor, commandId) => db.prepare('SELECT * FROM satellite_commands WHERE actor=? AND id=?').get(actor, commandId);
  function current(actor, commandId) { const row = commandRow(actor, commandId); if (!row) throw bad('NOT_FOUND', 404); return row; }
  function appendEvent(commandId, eventId, type, value, createdAt) {
    const encoded = json(value, 16 * 1024);
    db.prepare('INSERT OR IGNORE INTO satellite_events(command_id,event_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(commandId, eventId, type, encoded, createdAt);
  }
  function transition(row, state, now, reasonCode = null, resultJson = null) {
    db.prepare('UPDATE satellite_commands SET state=?,reason_code=?,result_json=?,updated_at=? WHERE id=?')
      .run(state, reasonCode, resultJson, now, row.id);
    appendEvent(row.id, `${row.id}:${row.fencing_token}:${state}`, state === 'SUCCEEDED' || state === 'FAILED' || state === 'UNKNOWN' ? 'command.terminal' : 'command.state',
      { commandId: row.id, toolName: row.tool_name, state, ...(reasonCode ? { reasonCode } : {}) }, now);
  }
  function leaseView(row) {
    return Object.freeze({ commandId: row.id, leaseId: row.lease_id, fencingToken: row.fencing_token,
      toolName: row.tool_name, payload: JSON.parse(row.payload_json), idempotencyKey: row.id,
      descriptor: JSON.parse(row.descriptor_json) });
  }
  function expireLeases(now) {
    const rows = db.prepare("SELECT * FROM satellite_commands WHERE state IN ('LEASED','RUNNING') AND lease_expires_at<=?").all(now);
    for (const row of rows) {
      if (row.idempotent) {
        db.prepare("UPDATE satellite_commands SET state='QUEUED',lease_id=NULL,lease_expires_at=NULL,reason_code='LEASE_EXPIRED',updated_at=? WHERE id=? AND state IN ('LEASED','RUNNING')").run(now, row.id);
        appendEvent(row.id, `${row.id}:${row.fencing_token}:LEASE_EXPIRED`, 'command.state', { commandId: row.id, state: 'QUEUED', reasonCode: 'LEASE_EXPIRED' }, now);
      } else transition(row, 'UNKNOWN', now, 'LEASE_EXPIRED');
    }
  }
  return Object.freeze({
    expire({ now }) { time(now); return transaction(() => { expireLeases(now); }); },
    handshake({ satelliteId, connectors, now }) {
      id(satelliteId); time(now);
      if (!Array.isArray(connectors)) throw bad('INVALID_MANIFEST');
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM satellites WHERE id=?').get(satelliteId);
        if (existing?.state === 'REVOKED') throw bad('SATELLITE_REVOKED', 403);
        const sessionId = randomUUID(), timestamp = now;
        if (existing) db.prepare("UPDATE satellites SET session_id=?,state='ONLINE',last_seen=?,updated_at=? WHERE id=?").run(sessionId, timestamp, timestamp, satelliteId);
        else db.prepare("INSERT INTO satellites(id,session_id,state,last_seen,created_at,updated_at) VALUES(?,?,'ONLINE',?,?,?)").run(satelliteId, sessionId, timestamp, timestamp, timestamp);
        db.prepare('DELETE FROM connector_tools WHERE satellite_id=?').run(satelliteId);
        db.prepare('DELETE FROM connectors WHERE satellite_id=?').run(satelliteId);
        const connectorStatement = db.prepare('INSERT INTO connectors(id,satellite_id,kind,version,updated_at) VALUES(?,?,?,?,?)');
        const toolStatement = db.prepare('INSERT INTO connector_tools(name,connector_id,satellite_id,descriptor_json,updated_at) VALUES(?,?,?,?,?)');
        for (const connector of connectors) {
          connectorStatement.run(connector.id, satelliteId, connector.kind, connector.version, timestamp);
          for (const descriptor of connector.tools) {
            const conflict = db.prepare('SELECT satellite_id FROM connector_tools WHERE name=?').get(descriptor.name);
            if (conflict && conflict.satellite_id !== satelliteId) throw bad('TOOL_ALREADY_REGISTERED', 409);
            toolStatement.run(descriptor.name, connector.id, satelliteId, JSON.stringify(descriptor), timestamp);
          }
        }
        return Object.freeze({ sessionId, protocolOffset: db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM satellite_events').get().value });
      });
    },
    heartbeat({ satelliteId, sessionId, connectors = [], now }) {
      exact({ satelliteId, sessionId, now }, ['satelliteId', 'sessionId', 'now']); id(satelliteId); id(sessionId); time(now);
      return transaction(() => {
        const row = db.prepare('SELECT * FROM satellites WHERE id=?').get(satelliteId);
        if (!row || row.session_id !== sessionId) throw bad('SESSION_STALE', 409);
        if (row.state === 'REVOKED') throw bad('SATELLITE_REVOKED', 403);
        db.prepare("UPDATE satellites SET state='ONLINE',last_seen=?,updated_at=? WHERE id=?").run(now, now, satelliteId);
        for (const connector of connectors) {
          const updated = db.prepare('UPDATE connectors SET health=?,updated_at=? WHERE satellite_id=? AND id=?').run(connector.state, now, satelliteId, connector.id);
          if (!updated.changes) throw bad('INVALID_REQUEST');
        }
        return { ok: true };
      });
    },
    tool(name) {
      id(name);
      const row = db.prepare('SELECT t.*,s.state AS satellite_state FROM connector_tools t JOIN satellites s ON s.id=t.satellite_id WHERE t.name=?').get(name);
      return row && Object.freeze({ name: row.name, connectorId: row.connector_id, satelliteId: row.satellite_id,
        satelliteState: row.satellite_state, descriptor: JSON.parse(row.descriptor_json) });
    },
    reserve({ actor, requestId, tool, payload, now }) {
      id(actor); id(requestId); id(tool.satelliteId); id(tool.connectorId); id(tool.name); time(now);
      const encoded = json(payload, 16 * 1024), hash = payloadHash(payload), descriptor = tool.descriptor;
      const commandId = `connector-${randomUUID()}`;
      return transaction(() => {
        const previous = db.prepare('SELECT * FROM satellite_commands WHERE actor=? AND request_id=?').get(actor, requestId);
        if (previous) {
          if (previous.tool_name !== tool.name || previous.payload_hash !== hash) throw bad('REQUEST_ID_CONFLICT', 409);
          return { command: publicCommand(previous), duplicate: true };
        }
        if (tool.satelliteState !== 'ONLINE') throw bad('SATELLITE_OFFLINE', 409);
        const state = descriptor.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED';
        db.prepare(`INSERT INTO satellite_commands(id,actor,request_id,satellite_id,connector_id,tool_name,payload_json,payload_hash,descriptor_json,
          side_effect,idempotent,state,attempt,fencing_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)`)
          .run(commandId, actor, requestId, tool.satelliteId, tool.connectorId, tool.name, encoded, hash, JSON.stringify(descriptor),
            descriptor.sideEffect ? 1 : 0, descriptor.idempotent ? 1 : 0, state, now, now);
        const row = commandRow(actor, commandId);
        appendEvent(commandId, `${commandId}:0:${state}`, 'command.state', { commandId, toolName: tool.name, state }, now);
        return { command: publicCommand(row), duplicate: false };
      });
    },
    get({ actor, commandId }) { id(actor); id(commandId); return publicCommand(commandRow(actor, commandId)); },
    list({ actor, limit = 100 }) {
      id(actor); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('INVALID_REQUEST');
      return db.prepare('SELECT * FROM satellite_commands WHERE actor=? ORDER BY created_at DESC,id DESC LIMIT ?').all(actor, limit).map(publicCommand);
    },
    approve({ actor, commandId, expectedPayloadHash, action, now }) {
      id(actor); id(commandId); requireHash(expectedPayloadHash); time(now);
      if (!['approve', 'reject'].includes(action)) throw bad('INVALID_REQUEST');
      return transaction(() => {
        const row = current(actor, commandId);
        if (row.payload_hash !== expectedPayloadHash) throw bad('EFFECT_CONFLICT', 409);
        if (row.state !== 'PENDING_APPROVAL') throw bad('EFFECT_CONFLICT', 409);
        const state = action === 'approve' ? 'QUEUED' : 'FAILED', reason = action === 'approve' ? null : 'APPROVAL_REJECTED';
        transition(row, state, now, reason);
        return publicCommand(commandRow(actor, commandId));
      });
    },
    poll({ satelliteId, sessionId, now, leaseMs }) {
      id(satelliteId); id(sessionId); time(now);
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 60_000) throw bad('INVALID_REQUEST');
      return transaction(() => {
        const satellite = db.prepare('SELECT * FROM satellites WHERE id=?').get(satelliteId);
        if (!satellite || satellite.session_id !== sessionId) throw bad('SESSION_STALE', 409);
        if (satellite.state === 'REVOKED') throw bad('SATELLITE_REVOKED', 403);
        db.prepare("UPDATE satellites SET state='ONLINE',last_seen=?,updated_at=? WHERE id=?").run(now, now, satelliteId);
        expireLeases(now);
        const queued = db.prepare("SELECT * FROM satellite_commands WHERE satellite_id=? AND state='QUEUED' ORDER BY created_at,id LIMIT 16").all(satelliteId);
        for (const row of queued) {
          const leaseId = randomUUID(), fencing = row.fencing_token + 1;
          db.prepare("UPDATE satellite_commands SET state='LEASED',lease_id=?,fencing_token=?,lease_expires_at=?,reason_code=NULL,updated_at=? WHERE id=? AND state='QUEUED'")
            .run(leaseId, fencing, now + leaseMs, now, row.id);
          appendEvent(row.id, `${row.id}:${fencing}:LEASED`, 'command.state', { commandId: row.id, state: 'LEASED', fencingToken: fencing }, now);
        }
        // Unacknowledged leases may be redelivered; Satellite idempotency makes this safe.
        return db.prepare("SELECT * FROM satellite_commands WHERE satellite_id=? AND state='LEASED' ORDER BY created_at,id LIMIT 16").all(satelliteId).map(leaseView);
      });
    },
    ack({ satelliteId, sessionId, commandId, leaseId, fencingToken, now }) {
      for (const value of [satelliteId, sessionId, commandId, leaseId]) id(value);
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw bad('INVALID_REQUEST'); time(now);
      return transaction(() => {
        const satellite = db.prepare('SELECT state FROM satellites WHERE id=?').get(satelliteId);
        if (!satellite || satellite.state === 'REVOKED') throw bad('SATELLITE_REVOKED', 403);
        const currentSession = db.prepare('SELECT session_id FROM satellites WHERE id=?').get(satelliteId).session_id;
        if (currentSession !== sessionId) throw bad('SESSION_STALE', 409);
        const row = db.prepare('SELECT * FROM satellite_commands WHERE id=? AND satellite_id=?').get(commandId, satelliteId);
        if (!row || row.lease_id !== leaseId || row.fencing_token !== fencingToken) throw bad('LEASE_CONFLICT', 409);
        if (row.state === 'RUNNING') return { duplicate: true };
        if (row.state !== 'LEASED') throw bad('LEASE_CONFLICT', 409);
        db.prepare("UPDATE satellite_commands SET state='RUNNING',updated_at=? WHERE id=?").run(now, commandId);
        appendEvent(commandId, `${commandId}:${fencingToken}:RUNNING`, 'command.state', { commandId, state: 'RUNNING', fencingToken }, now);
        return { duplicate: false };
      });
    },
    complete({ satelliteId, sessionId, commandId, leaseId, fencingToken, outcome, now }) {
      for (const value of [satelliteId, sessionId, commandId, leaseId]) id(value);
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw bad('INVALID_REQUEST'); time(now);
      return transaction(() => {
        const satellite = db.prepare('SELECT * FROM satellites WHERE id=?').get(satelliteId);
        if (!satellite || satellite.state === 'REVOKED') throw bad('SATELLITE_REVOKED', 403);
        if (satellite.session_id !== sessionId) throw bad('SESSION_STALE', 409);
        const row = db.prepare('SELECT * FROM satellite_commands WHERE id=? AND satellite_id=?').get(commandId, satelliteId);
        if (!row || row.lease_id !== leaseId || row.fencing_token !== fencingToken) throw bad('LEASE_CONFLICT', 409);
        const resultJson = outcome.state === 'SUCCEEDED' ? json(outcome.result, 64 * 1024) : null;
        const reason = outcome.state === 'SUCCEEDED' ? null : outcome.reasonCode;
        if (TERMINAL.has(row.state)) {
          if (row.state === outcome.state && row.result_json === resultJson && row.reason_code === reason) return { command: publicCommand(row), duplicate: true };
          if (row.state === 'UNKNOWN' && outcome.state !== 'UNKNOWN') {
            transition(row, outcome.state, now, reason, resultJson);
            return { command: publicCommand(commandRow(row.actor, commandId)), duplicate: false };
          }
          throw bad('LEASE_CONFLICT', 409);
        }
        if (!LEASED.has(row.state)) throw bad('LEASE_CONFLICT', 409);
        transition(row, outcome.state, now, reason, resultJson);
        return { command: publicCommand(commandRow(row.actor, commandId)), duplicate: false };
      });
    },
    appendEvent({ satelliteId, sessionId, commandId, leaseId, fencingToken, eventId, type, payload, now }) {
      for (const value of [satelliteId, sessionId, commandId, leaseId, eventId]) id(value);
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 1 || typeof type !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(type)) throw bad('INVALID_REQUEST');
      time(now); const encoded = json(payload, 16 * 1024);
      return transaction(() => {
        const satellite = db.prepare('SELECT * FROM satellites WHERE id=?').get(satelliteId);
        if (!satellite || satellite.state === 'REVOKED') throw bad('SATELLITE_REVOKED', 403);
        if (satellite.session_id !== sessionId) throw bad('SESSION_STALE', 409);
        const row = db.prepare('SELECT * FROM satellite_commands WHERE id=? AND satellite_id=?').get(commandId, satelliteId);
        if (!row || row.lease_id !== leaseId || row.fencing_token !== fencingToken || !LEASED.has(row.state)) throw bad('LEASE_CONFLICT', 409);
        db.prepare('INSERT OR IGNORE INTO satellite_events(command_id,event_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').run(commandId, eventId, type, encoded, now);
        return { ok: true };
      });
    },
    events({ actor, after = 0, limit = 100 }) {
      id(actor); if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('INVALID_REQUEST');
      return db.prepare('SELECT e.* FROM satellite_events e JOIN satellite_commands c ON c.id=e.command_id WHERE c.actor=? AND e.sequence>? ORDER BY e.sequence LIMIT ?')
        .all(actor, after, limit).map(event);
    },
    revoke({ satelliteId, now }) {
      id(satelliteId); time(now);
      return transaction(() => {
        const satellite = db.prepare('SELECT * FROM satellites WHERE id=?').get(satelliteId);
        if (!satellite) throw bad('NOT_FOUND', 404);
        if (satellite.state !== 'REVOKED') db.prepare("UPDATE satellites SET state='REVOKED',updated_at=? WHERE id=?").run(now, satelliteId);
        const rows = db.prepare('SELECT * FROM satellite_commands WHERE satellite_id=?').all(satelliteId);
        for (const row of rows) {
          if (['PENDING_APPROVAL', 'QUEUED'].includes(row.state)) transition(row, 'FAILED', now, 'SATELLITE_REVOKED');
          else if (LEASED.has(row.state)) transition(row, 'UNKNOWN', now, 'SATELLITE_REVOKED');
        }
        return { id: satelliteId, state: 'REVOKED' };
      });
    },
    catalog({ staleAfter = 30_000, now = Date.now() } = {}) {
      if (!Number.isSafeInteger(staleAfter) || staleAfter < 1 || !Number.isSafeInteger(now)) throw bad('INVALID_REQUEST');
      const satellites = db.prepare('SELECT * FROM satellites ORDER BY id').all().map(row => Object.freeze({ id: row.id,
        state: row.state === 'REVOKED' ? 'REVOKED' : now - row.last_seen > staleAfter ? 'STALE' : row.state,
        lastSeen: row.last_seen }));
      const connectors = db.prepare('SELECT * FROM connectors ORDER BY satellite_id,id').all().map(row => Object.freeze({ id: row.id,
        satelliteId: row.satellite_id, kind: row.kind, version: row.version, health: row.health,
        tools: db.prepare('SELECT descriptor_json FROM connector_tools WHERE satellite_id=? AND connector_id=? ORDER BY name').all(row.satellite_id, row.id).map(tool => JSON.parse(tool.descriptor_json)) }));
      return { satellites, connectors };
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}
