import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROUTE_STATES = new Set(['ACTIVE', 'PAUSED', 'DETACHED']);
const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const valid = value => typeof value === 'string' && ID.test(value);
const text = value => { if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16 * 1024) throw bad('INVALID_CHANNEL_TEXT'); return value; };
const json = value => JSON.stringify(value);
const routeView = row => row && Object.freeze({ id: row.id, channel: row.channel, accountId: row.account_id,
  chatId: row.chat_id, threadId: row.thread_id, conversationId: row.conversation_id, state: row.state,
  revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at });
const inboxView = row => row && Object.freeze({ id: row.id, routeId: row.route_id, externalMessageId: row.external_message_id,
  actingPrincipal: row.acting_principal, text: row.text, commandId: row.command_id, state: row.state,
  handoff: row.handoff_json === null ? null : JSON.parse(row.handoff_json), createdAt: row.created_at });
const outboxView = row => row && Object.freeze({ id: row.id, inboxId: row.inbox_id, routeId: row.route_id, text: row.text,
  state: row.state, receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json), createdAt: row.created_at, updatedAt: row.updated_at });

export function openChannelStore(path, { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS channel_routes(
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(channel,account_id,chat_id,thread_id));
    CREATE TABLE IF NOT EXISTS channel_inbox(
      id TEXT PRIMARY KEY, route_id TEXT NOT NULL REFERENCES channel_routes(id), external_message_id TEXT NOT NULL,
      acting_principal TEXT NOT NULL, text TEXT NOT NULL, command_id TEXT, state TEXT NOT NULL,
      handoff_json TEXT, created_at INTEGER NOT NULL, UNIQUE(route_id,external_message_id));
    CREATE TABLE IF NOT EXISTS channel_outbox(
      id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL UNIQUE REFERENCES channel_inbox(id), route_id TEXT NOT NULL REFERENCES channel_routes(id),
      text TEXT NOT NULL, state TEXT NOT NULL, receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  const getRoute = id => routeView(db.prepare('SELECT * FROM channel_routes WHERE id=?').get(id));
  const getInbox = id => inboxView(db.prepare('SELECT * FROM channel_inbox WHERE id=?').get(id));
  const getOutbox = id => outboxView(db.prepare('SELECT * FROM channel_outbox WHERE id=?').get(id));
  return {
    bind(input) {
      const values = [input?.channel, input?.accountId, input?.chatId, input?.threadId, input?.conversationId];
      if (!values.every(valid)) throw bad('INVALID_CHANNEL_ROUTE');
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM channel_routes WHERE channel=? AND account_id=? AND chat_id=? AND thread_id=?')
          .get(input.channel, input.accountId, input.chatId, input.threadId);
        if (existing) {
          if (existing.conversation_id !== input.conversationId) throw bad('CHANNEL_ROUTE_CONFLICT', 409);
          return { route: routeView(existing), duplicate: true };
        }
        const id = randomUUID(), timestamp = now();
        db.prepare("INSERT INTO channel_routes(id,channel,account_id,chat_id,thread_id,conversation_id,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'ACTIVE',1,?,?)")
          .run(id, ...values, timestamp, timestamp);
        return { route: getRoute(id), duplicate: false };
      });
    },
    updateRoute(id, expectedRevision, action) {
      if (!valid(id) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !['PAUSE', 'RESUME', 'DETACH'].includes(action)) throw bad('INVALID_CHANNEL_UPDATE');
      return transaction(() => {
        const current = getRoute(id); if (!current) throw bad('CHANNEL_ROUTE_NOT_FOUND', 404);
        if (current.revision !== expectedRevision) throw bad('CHANNEL_REVISION_CONFLICT', 409);
        const next = action === 'PAUSE' ? 'PAUSED' : action === 'RESUME' ? 'ACTIVE' : 'DETACHED';
        if (!ROUTE_STATES.has(next) || current.state === 'DETACHED' || current.state === next ||
            (action === 'RESUME' && current.state !== 'PAUSED') || (action === 'PAUSE' && current.state !== 'ACTIVE')) throw bad('CHANNEL_STATE_CONFLICT', 409);
        db.prepare('UPDATE channel_routes SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(next, now(), id, expectedRevision);
        return getRoute(id);
      });
    },
    route(id) { if (!valid(id)) throw bad('INVALID_CHANNEL_ROUTE'); return getRoute(id); },
    routes() { return db.prepare('SELECT * FROM channel_routes ORDER BY created_at,id LIMIT 100').all().map(routeView); },
    receive(routeId, input) {
      if (!valid(routeId) || !valid(input?.externalMessageId) || !valid(input?.actingPrincipal)) throw bad('INVALID_CHANNEL_MESSAGE');
      const body = text(input.text);
      return transaction(() => {
        const route = getRoute(routeId); if (!route) throw bad('CHANNEL_ROUTE_NOT_FOUND', 404);
        const existing = db.prepare('SELECT * FROM channel_inbox WHERE route_id=? AND external_message_id=?').get(routeId, input.externalMessageId);
        if (existing) {
          if (existing.text !== body || existing.acting_principal !== input.actingPrincipal) throw bad('CHANNEL_INBOX_CONFLICT', 409);
          return { message: inboxView(existing), duplicate: true };
        }
        if (route.state !== 'ACTIVE') throw bad(route.state === 'PAUSED' ? 'CHANNEL_ROUTE_PAUSED' : 'CHANNEL_ROUTE_DETACHED', 409);
        const id = randomUUID();
        db.prepare("INSERT INTO channel_inbox(id,route_id,external_message_id,acting_principal,text,state,created_at) VALUES(?,?,?,?,?,'RECEIVED',?)")
          .run(id, routeId, input.externalMessageId, input.actingPrincipal, body, now());
        return { message: getInbox(id), duplicate: false };
      });
    },
    completeInbound(id, { commandId, handoff, responseText }) {
      if (!valid(id) || !valid(commandId) || !handoff || typeof handoff !== 'object' || Array.isArray(handoff) || Buffer.byteLength(json(handoff)) > 32 * 1024) throw bad('INVALID_CHANNEL_COMPLETION');
      return transaction(() => {
        const current = getInbox(id); if (!current) throw bad('CHANNEL_MESSAGE_NOT_FOUND', 404);
        if (current.state === 'DISPATCHED') {
          if (current.commandId !== commandId) throw bad('CHANNEL_INBOX_CONFLICT', 409);
          return current;
        }
        db.prepare("UPDATE channel_inbox SET state='DISPATCHED',command_id=?,handoff_json=? WHERE id=? AND state='RECEIVED'").run(commandId, json(handoff), id);
        if (responseText !== null) {
          text(responseText);
          db.prepare("INSERT INTO channel_outbox(id,inbox_id,route_id,text,state,created_at,updated_at) VALUES(?,?,?,?,'PENDING',?,?)")
            .run(randomUUID(), id, current.routeId, responseText, now(), now());
        }
        return getInbox(id);
      });
    },
    inbox(id) { if (!valid(id)) throw bad('INVALID_CHANNEL_MESSAGE'); return getInbox(id); },
    pendingOutbound() {
      return db.prepare("SELECT o.* FROM channel_outbox o JOIN channel_routes r ON r.id=o.route_id WHERE o.state='PENDING' AND r.state='ACTIVE' ORDER BY o.created_at,o.id LIMIT 100").all().map(outboxView);
    },
    beginOutbound(id) {
      if (!valid(id)) throw bad('INVALID_OUTBOUND_MESSAGE');
      return transaction(() => {
        const current = getOutbox(id); if (!current) throw bad('OUTBOUND_NOT_FOUND', 404);
        if (current.state !== 'PENDING') throw bad('OUTBOUND_NOT_RETRYABLE', 409);
        const route = getRoute(current.routeId);
        if (route.state !== 'ACTIVE') throw bad(route.state === 'PAUSED' ? 'CHANNEL_ROUTE_PAUSED' : 'CHANNEL_ROUTE_DETACHED', 409);
        db.prepare("UPDATE channel_outbox SET state='SENDING',updated_at=? WHERE id=? AND state='PENDING'").run(now(), id);
        return getOutbox(id);
      });
    },
    completeOutbound(id, receipt) {
      if (!valid(id) || !receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Buffer.byteLength(json(receipt)) > 4096) throw bad('INVALID_OUTBOUND_RECEIPT');
      return transaction(() => {
        const current = getOutbox(id); if (!current) throw bad('OUTBOUND_NOT_FOUND', 404);
        if (current.state === 'SUCCEEDED') return current;
        if (current.state !== 'SENDING') throw bad('OUTBOUND_STATE_CONFLICT', 409);
        db.prepare("UPDATE channel_outbox SET state='SUCCEEDED',receipt_json=?,updated_at=? WHERE id=? AND state='SENDING'").run(json(receipt), now(), id);
        return getOutbox(id);
      });
    },
    unknownOutbound(id) {
      if (!valid(id)) throw bad('INVALID_OUTBOUND_MESSAGE');
      return transaction(() => {
        const current = getOutbox(id); if (!current) throw bad('OUTBOUND_NOT_FOUND', 404);
        if (current.state === 'SENDING') db.prepare("UPDATE channel_outbox SET state='UNKNOWN',updated_at=? WHERE id=? AND state='SENDING'").run(now(), id);
        return getOutbox(id);
      });
    },
    recoverOutbound() {
      return transaction(() => {
        const rows = db.prepare("SELECT id FROM channel_outbox WHERE state='SENDING'").all();
        for (const row of rows) db.prepare("UPDATE channel_outbox SET state='UNKNOWN',updated_at=? WHERE id=?").run(now(), row.id);
        return rows.length;
      });
    },
    outbound() { return db.prepare('SELECT * FROM channel_outbox ORDER BY created_at,id LIMIT 100').all().map(outboxView); },
    close() { db.close(); },
  };
}
