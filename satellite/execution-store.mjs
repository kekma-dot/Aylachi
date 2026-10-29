import { DatabaseSync } from 'node:sqlite';
import { bad, exact, id, json, outcomeSnapshot, payloadHash } from './protocol.mjs';

function rowView(row) {
  return row && { commandId: row.command_id, leaseId: row.lease_id, fencingToken: row.fencing_token,
    toolName: row.tool_name, payloadHash: row.payload_hash, state: row.state,
    outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json), reported: Boolean(row.reported) };
}

// Local Satellite inbox/result journal. A terminal outcome is durable before
// the first completion response is attempted, so reconnect never needs to
// repeat an effect merely because the Hub response was lost.
export function openSatelliteExecutionStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS satellite_inbox (
      command_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, fencing_token INTEGER NOT NULL,
      tool_name TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL,
      outcome_json TEXT, reported INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`);
  let closed = false;
  function transaction(fn) {
    if (closed) throw bad('STORE_CLOSED', 409);
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  const get = commandId => rowView(db.prepare('SELECT * FROM satellite_inbox WHERE command_id=?').get(commandId));
  return Object.freeze({
    find(commandId) { return get(id(commandId)); },
    begin({ lease, now }) {
      const commandId = id(lease.commandId), hash = payloadHash(lease.payload);
      return transaction(() => {
        const previous = get(commandId);
        if (previous) {
          if (previous.payloadHash !== hash || previous.toolName !== lease.toolName) throw bad('IDEMPOTENCY_CONFLICT', 409);
          if (previous.leaseId !== lease.leaseId || previous.fencingToken !== lease.fencingToken) {
            if (previous.state !== 'RUNNING' || previous.outcome) throw bad('LEASE_CONFLICT', 409);
            db.prepare('UPDATE satellite_inbox SET lease_id=?,fencing_token=?,reported=0,updated_at=? WHERE command_id=?')
              .run(lease.leaseId, lease.fencingToken, now, commandId);
          }
          return { record: get(commandId), duplicate: true };
        }
        db.prepare("INSERT INTO satellite_inbox(command_id,lease_id,fencing_token,tool_name,payload_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,'RUNNING',?,?)")
          .run(commandId, lease.leaseId, lease.fencingToken, lease.toolName, hash, now, now);
        return { record: get(commandId), duplicate: false };
      });
    },
    complete({ commandId, outcome, now }) {
      id(commandId); const value = outcomeSnapshot(outcome);
      return transaction(() => {
        const previous = get(commandId);
        if (!previous || previous.state !== 'RUNNING') throw bad('LEASE_CONFLICT', 409);
        db.prepare("UPDATE satellite_inbox SET state='TERMINAL',outcome_json=?,reported=0,updated_at=? WHERE command_id=?")
          .run(JSON.stringify(value), now, commandId);
        return get(commandId);
      });
    },
    pending() { return db.prepare("SELECT * FROM satellite_inbox WHERE state='TERMINAL' AND reported=0 ORDER BY created_at").all().map(rowView); },
    markReported({ commandId, leaseId, fencingToken }) {
      id(commandId); id(leaseId);
      return transaction(() => {
        const row = get(commandId);
        if (!row || row.leaseId !== leaseId || row.fencingToken !== fencingToken || row.state !== 'TERMINAL') throw bad('LEASE_CONFLICT', 409);
        db.prepare('UPDATE satellite_inbox SET reported=1 WHERE command_id=?').run(commandId);
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}
