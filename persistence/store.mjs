import { DatabaseSync } from "node:sqlite";

const MAX_TEXT = 64 * 1024;
const MAX_ID = 256;
const MAX_EVENTS = 1000;
const badKeys = new Set(["__proto__", "prototype", "constructor"]);

function fail(message) { throw new TypeError(message); }
function text(value, name, max = MAX_TEXT) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) fail(`invalid ${name}`);
  return value;
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid ${name}`);
  for (const key of Object.keys(value)) if (badKeys.has(key)) fail(`invalid key in ${name}`);
  return value;
}
function jsonValue(value, name) {
  const seen = new Set();
  function normalize(v, depth = 0) {
    if (depth > 64) fail(`${name} too deep`);
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isFinite(v)) fail(`invalid ${name}`); return v; }
    if (typeof v !== "object" || seen.has(v)) fail(`invalid ${name}`);
    seen.add(v);
    let out;
    if (Array.isArray(v)) out = v.map(item => normalize(item, depth + 1));
    else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail(`invalid ${name}`);
      out = {};
      for (const key of Object.keys(v).sort()) {
        if (badKeys.has(key)) fail(`invalid key in ${name}`);
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (!descriptor || !("value" in descriptor)) fail(`invalid ${name}`);
        out[key] = normalize(descriptor.value, depth + 1);
      }
    }
    seen.delete(v);
    return out;
  }
  const json = JSON.stringify(normalize(value));
  if (Buffer.byteLength(json) > MAX_TEXT) fail(`${name} too large`);
  return json;
}
function finite(value, name) { if (!Number.isFinite(value)) fail(`invalid ${name}`); return value; }
function dimension(value, name) { finite(value, name); if (value <= 0 || value > 2000) fail(`invalid ${name}`); return value; }

export function openStore(path) {
  text(path, "path", 4096);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), input TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('RUNNING', 'COMPLETED', 'NEEDS_RECONCILIATION')), result TEXT);
    CREATE TABLE IF NOT EXISTS events(offset INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES cards(id), kind TEXT NOT NULL, payload TEXT NOT NULL);`);
  const columns = new Set(db.prepare("PRAGMA table_info(cards)").all().map(column => column.name));
  for (const [column, type] of [["width", "REAL"], ["height", "REAL"], ["model_provider", "TEXT"], ["model_id", "TEXT"], ["reasoning", "TEXT"]]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE cards ADD COLUMN ${column} ${type}`);
  }
  const run = db.prepare("INSERT INTO events(card_id,kind,payload) VALUES(?,?,?)");
  function transaction(fn) { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } }
  function readTransaction(fn) { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } }
  function card(row) { return row && { id: row.id, canvasId: row.canvas_id, sessionId: row.session_id, title: row.title, x: row.x, y: row.y, revision: row.revision,
    ...(row.width === null ? {} : { width: row.width, height: row.height }),
    ...(row.model_provider === null ? {} : { modelProvider: row.model_provider, modelId: row.model_id, reasoning: row.reasoning }) }; }
  function command(row) { return row && { id: row.id, cardId: row.card_id, input: JSON.parse(row.input), state: row.state, result: row.result === null ? null : JSON.parse(row.result) }; }
  return {
    createCard(input) {
      object(input, "card");
      const { id, canvasId, sessionId, title, x, y } = input;
      text(id,"id",MAX_ID); text(canvasId,"canvasId",MAX_ID); text(sessionId,"sessionId",MAX_ID); text(title,"title",4096); finite(x,"x"); finite(y,"y");
      return transaction(() => { db.prepare("INSERT INTO cards(id,canvas_id,session_id,title,x,y) VALUES(?,?,?,?,?,?)").run(id,canvasId,sessionId,title,x,y); run.run(id,"card.created",jsonValue({canvasId,sessionId,title,x,y},"card")); return card(db.prepare("SELECT * FROM cards WHERE id=?").get(id)); });
    },
    listCards(options) {
      object(options, "options");
      if (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null) fail("invalid options");
      const keys = Reflect.ownKeys(options);
      if (keys.some(key => typeof key !== "string" || !["canvasId", "limit"].includes(key) || badKeys.has(key))) fail("invalid options");
      const canvasDescriptor = Object.getOwnPropertyDescriptor(options, "canvasId");
      const limitDescriptor = Object.getOwnPropertyDescriptor(options, "limit");
      if (!canvasDescriptor || !("value" in canvasDescriptor) || (limitDescriptor && !("value" in limitDescriptor))) fail("invalid options");
      const canvasId = text(canvasDescriptor.value, "canvasId", MAX_ID);
      const limit = !limitDescriptor || limitDescriptor.value === undefined ? 101 : limitDescriptor.value;
      if (!Number.isInteger(limit) || limit < 1 || limit > 101) fail("invalid limit");
      return db.prepare("SELECT * FROM cards WHERE canvas_id=? ORDER BY id COLLATE BINARY LIMIT ?")
        .all(canvasId, limit).map(card);
    },
    getCard(id) { text(id,"id",MAX_ID); return card(db.prepare("SELECT * FROM cards WHERE id=?").get(id)); },
    getCardSnapshot(id) {
      text(id,"cardId",MAX_ID);
      return readTransaction(() => {
        const row=db.prepare("SELECT * FROM cards WHERE id=?").get(id);
        if (!row) fail("unknown cardId");
        const eventSequence=db.prepare("SELECT COUNT(*) AS sequence FROM events WHERE card_id=?").get(id).sequence;
        return {card:card(row),eventSequence};
      });
    },
    getCardEvents(id,afterCardSequence=0,limit=100) {
      text(id,"cardId",MAX_ID);
      if (!Number.isSafeInteger(afterCardSequence) || afterCardSequence<0 || !Number.isInteger(limit) || limit<1 || limit>MAX_EVENTS) fail("invalid event range");
      if (!db.prepare("SELECT 1 FROM cards WHERE id=?").get(id)) fail("unknown cardId");
      return db.prepare(`WITH card_events AS (
        SELECT ROW_NUMBER() OVER (ORDER BY offset) AS sequence,kind,payload FROM events WHERE card_id=?
      ) SELECT sequence,kind,payload FROM card_events WHERE sequence>? ORDER BY sequence LIMIT ?`)
        .all(id,afterCardSequence,limit).map(e=>({sequence:e.sequence,kind:e.kind,payload:JSON.parse(e.payload)}));
    },
    updateCard(id, expectedRevision, patch) {
      text(id,"id",MAX_ID); if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail("invalid expectedRevision"); object(patch,"patch");
      const allowed = new Set(["title","x","y","width","height","modelProvider","modelId","reasoning"]); for (const key of Object.keys(patch)) if (!allowed.has(key)) fail(`unsupported patch key: ${key}`);
      if (!Object.keys(patch).length) fail("empty patch");
      if ("title" in patch) text(patch.title,"title",4096); if ("x" in patch) finite(patch.x,"x"); if ("y" in patch) finite(patch.y,"y");
      if (("width" in patch) !== ("height" in patch)) fail("width and height must be updated together");
      if ("width" in patch) { dimension(patch.width,"width"); dimension(patch.height,"height"); }
      const modelKeys = ["modelProvider", "modelId", "reasoning"];
      const modelPatch = modelKeys.some(key => key in patch);
      if (modelPatch && !modelKeys.every(key => key in patch)) fail("model settings must be updated together");
      if (modelPatch) { text(patch.modelProvider,"modelProvider",128); text(patch.modelId,"modelId",128); text(patch.reasoning,"reasoning",32); }
      return transaction(() => { const current = db.prepare("SELECT * FROM cards WHERE id=?").get(id); if (!current) return null; if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
        if (modelPatch && db.prepare("SELECT 1 AS busy FROM commands WHERE card_id=? AND state='RUNNING' LIMIT 1").get(id)) throw new Error("MODEL_SETTINGS_BUSY");
        const next = { title: patch.title ?? current.title, x: patch.x ?? current.x, y: patch.y ?? current.y,
          width: patch.width ?? current.width, height: patch.height ?? current.height,
          modelProvider: patch.modelProvider ?? current.model_provider, modelId: patch.modelId ?? current.model_id, reasoning: patch.reasoning ?? current.reasoning };
        db.prepare("UPDATE cards SET title=?,x=?,y=?,width=?,height=?,model_provider=?,model_id=?,reasoning=?,revision=revision+1 WHERE id=? AND revision=?").run(
          next.title,next.x,next.y,next.width,next.height,next.modelProvider,next.modelId,next.reasoning,id,expectedRevision);
        const event = { revision: expectedRevision + 1, ...next };
        if (event.width === null) { delete event.width; delete event.height; }
        if (event.modelProvider === null) { delete event.modelProvider; delete event.modelId; delete event.reasoning; }
        run.run(id,"card.updated",jsonValue(event,"patch")); return card(db.prepare("SELECT * FROM cards WHERE id=?").get(id)); });
    },
    deleteCard(id, expectedRevision) {
      text(id,"id",MAX_ID);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail("invalid expectedRevision");
      return transaction(() => {
        const current = db.prepare("SELECT * FROM cards WHERE id=?").get(id);
        if (!current) return null;
        if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
        if (db.prepare("SELECT 1 AS busy FROM commands WHERE card_id=? AND state='RUNNING' LIMIT 1").get(id)) throw new Error("CARD_BUSY");
        db.prepare("DELETE FROM events WHERE card_id=?").run(id);
        db.prepare("DELETE FROM commands WHERE card_id=?").run(id);
        db.prepare("DELETE FROM cards WHERE id=? AND revision=?").run(id, expectedRevision);
        return card(current);
      });
    },
    reserveCommand(input) {
      object(input,"command"); const { id, cardId, input: payload } = input; text(id,"command id",MAX_ID); text(cardId,"cardId",MAX_ID); const encoded=jsonValue(payload,"command input");
      return transaction(() => { const prior=db.prepare("SELECT * FROM commands WHERE id=?").get(id); if(prior){ if(prior.card_id!==cardId || prior.input!==encoded) throw new Error("COMMAND_ID_CONFLICT"); return {created:false,command:command(prior)}; }
        if (!db.prepare("SELECT 1 FROM cards WHERE id=?").get(cardId)) fail("unknown cardId"); db.prepare("INSERT INTO commands(id,card_id,input,state) VALUES(?,?,?,?)").run(id,cardId,encoded,"RUNNING"); run.run(cardId,"command.reserved",jsonValue({id},"event")); return {created:true,command:command(db.prepare("SELECT * FROM commands WHERE id=?").get(id))}; });
    },
    completeCommand(id,result) { text(id,"command id",MAX_ID); const encoded=jsonValue(result,"result"); return transaction(()=>{ const row=db.prepare("SELECT * FROM commands WHERE id=?").get(id); if(!row) return null; if(row.state!=="RUNNING") { if(row.state==="COMPLETED" && row.result===encoded) return command(row); throw new Error("COMMAND_NOT_RUNNING"); } db.prepare("UPDATE commands SET state=?,result=? WHERE id=? AND state='RUNNING'").run("COMPLETED",encoded,id); run.run(row.card_id,"command.completed",jsonValue({id},"event")); return command(db.prepare("SELECT * FROM commands WHERE id=?").get(id)); }); },
    markNeedsReconciliation(id, reasonCode) {
      text(id,"command id",MAX_ID); text(reasonCode,"reasonCode",64);
      if (!/^[A-Z][A-Z0-9_]*$/.test(reasonCode)) fail("invalid reasonCode");
      return transaction(() => {
        const row = db.prepare("SELECT * FROM commands WHERE id=?").get(id);
        if (!row) return null;
        if (row.state !== "RUNNING") return command(row);
        db.prepare("UPDATE commands SET state=? WHERE id=? AND state='RUNNING'").run("NEEDS_RECONCILIATION", id);
        run.run(row.card_id, "command.needs_reconciliation", jsonValue({ id, reasonCode }, "event"));
        return command(db.prepare("SELECT * FROM commands WHERE id=?").get(id));
      });
    },
    getCommand(id) { text(id,"command id",MAX_ID); return command(db.prepare("SELECT * FROM commands WHERE id=?").get(id)); },
    appendEvent(cardId,kind,payload) { text(cardId,"cardId",MAX_ID); text(kind,"kind",256); const encoded=jsonValue(payload,"payload"); return transaction(()=>{ if(!db.prepare("SELECT 1 FROM cards WHERE id=?").get(cardId)) fail("unknown cardId"); run.run(cardId,kind,encoded); return db.prepare("SELECT last_insert_rowid() AS offset").get().offset; }); },
    appendExecutionEvent(cardId,event) {
      text(cardId,"cardId",MAX_ID); const encoded=jsonValue(event,"execution event");
      return transaction(()=>{
        if(!db.prepare("SELECT 1 FROM cards WHERE id=?").get(cardId)) fail("unknown cardId");
        run.run(cardId,"execution.event",encoded);
        const sequence=db.prepare("SELECT COUNT(*) AS sequence FROM events WHERE card_id=?").get(cardId).sequence;
        return {sequence,event:JSON.parse(encoded)};
      });
    },
    getEvents(afterOffset=0,limit=100) { if(!Number.isSafeInteger(afterOffset)||afterOffset<0||!Number.isInteger(limit)||limit<1||limit>MAX_EVENTS) fail("invalid event range"); return db.prepare("SELECT offset,card_id AS cardId,kind,payload FROM events WHERE offset>? ORDER BY offset LIMIT ?").all(afterOffset,limit).map(e=>({...e,payload:JSON.parse(e.payload)})); },
    recoverInterrupted() { return transaction(()=>{ const rows=db.prepare("SELECT id,card_id FROM commands WHERE state='RUNNING'").all(); const update=db.prepare("UPDATE commands SET state=? WHERE id=? AND state='RUNNING'"); for(const row of rows){ update.run("NEEDS_RECONCILIATION",row.id); run.run(row.card_id,"command.needs_reconciliation",jsonValue({id:row.id},"event")); } return rows.length; }); },
    close() { db.close(); }
  };
}
