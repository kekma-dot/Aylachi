import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_TEXT = 16 * 1024;
const MAX_SNAPSHOT_JSON = 48 * 1024;
const MAX_OUTPUT = 64 * 1024;
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const safeId = value => typeof value === "string" && ID.test(value);
const hash = value => createHash("sha256").update(value, "utf8").digest("hex");

function exactKeys(value, allowed, required = []) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !own(value, key))) throw fail(400, "invalid_request");
}

function checkedSource(value) {
  exactKeys(value, ["cardId", "kind", "id", "revision"], ["cardId", "kind", "id"]);
  if (!safeId(value.cardId) || !safeId(value.id) || !["command", "wiki"].includes(value.kind)) {
    throw fail(400, "invalid_request");
  }
  if (value.kind === "wiki") {
    if (!own(value, "revision") || typeof value.revision !== "string" || !UUID.test(value.revision)) {
      throw fail(400, "invalid_request");
    }
    return { cardId: value.cardId, kind: "wiki", id: value.id, revision: value.revision.toLowerCase() };
  }
  if (own(value, "revision")) throw fail(400, "invalid_request");
  return { cardId: value.cardId, kind: "command", id: value.id };
}

function sameSource(a, b) {
  return a.cardId === b.cardId && a.kind === b.kind && a.id === b.id && a.revision === b.revision;
}

function parseRecord(value, actor) {
  if (!plain(value)) throw fail(500, "internal_error");
  // Store get() intentionally returns undefined for both missing and non-owner records.
  if (value.owner !== actor) throw fail(404, "not_found");
  const keys = ["id", "owner", "requestId", "payloadHash", "state", "source", "targetCardId", "snapshot", "createdAt", "acceptedAt"];
  exactKeys(value, keys, keys);
  const source = checkedSource(value.source);
  exactKeys(value.snapshot, ["text", "sha256"], ["text", "sha256"]);
  if (!safeId(value.id) || !safeId(value.owner) || !safeId(value.requestId) ||
      typeof value.payloadHash !== "string" || !HASH.test(value.payloadHash) ||
      !["pending", "accepted"].includes(value.state) || !safeId(value.targetCardId) ||
      source.cardId === value.targetCardId || typeof value.snapshot.text !== "string" ||
      Buffer.byteLength(value.snapshot.text, "utf8") > MAX_TEXT || typeof value.snapshot.sha256 !== "string" ||
      !HASH.test(value.snapshot.sha256) || hash(value.snapshot.text) !== value.snapshot.sha256 ||
      !Number.isSafeInteger(value.createdAt) ||
      (value.state === "pending" ? value.acceptedAt !== null : !Number.isSafeInteger(value.acceptedAt))) {
    throw fail(500, "internal_error");
  }
  const record = {
    id: value.id, owner: value.owner, requestId: value.requestId, payloadHash: value.payloadHash,
    state: value.state, source, targetCardId: value.targetCardId,
    snapshot: { text: value.snapshot.text, sha256: value.snapshot.sha256 },
    createdAt: value.createdAt, acceptedAt: value.acceptedAt,
  };
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_OUTPUT) throw fail(500, "internal_error");
  return record;
}

function mapDependencyError(error) {
  if ([400, 404, 409, 413].includes(error?.status)) {
    const code = ({ 400: "invalid_request", 404: "not_found", 409: "conflict", 413: "too_large" })[error.status];
    return fail(error.status, code);
  }
  switch (error?.code) {
    case "FORBIDDEN": case "NOT_FOUND": case "ENOENT": return fail(404, "not_found");
    case "CONFLICT": case "REQUEST_ID_CONFLICT": case "IDEMPOTENCY_CONFLICT": return fail(409, "conflict");
    case "TOO_LARGE": return fail(413, "too_large");
    case "INVALID_REQUEST": case "INVALID_ID": case "INVALID_SOURCE": return fail(400, "invalid_request");
    default: return fail(500, "internal_error");
  }
}

function context(raw, { params = [], query = [], body = [] } = {}) {
  exactKeys(raw, ["actor", "params", "query", "body", "requestId"], ["actor", "requestId"]);
  if (!safeId(raw.actor) || !safeId(raw.requestId)) throw fail(400, "invalid_request");
  const checkedParams = raw.params ?? {};
  const checkedQuery = raw.query ?? {};
  exactKeys(checkedParams, params);
  exactKeys(checkedQuery, query);
  if (Object.keys(checkedQuery).length > 16 || Object.entries(checkedQuery).some(([key, value]) =>
    Buffer.byteLength(key, "utf8") > 512 || typeof value !== "string" || Buffer.byteLength(value, "utf8") > 512)) {
    throw fail(400, "invalid_request");
  }
  if (raw.body !== undefined) exactKeys(raw.body, body);
  else if (body.length) throw fail(400, "invalid_request");
  return { actor: raw.actor, requestId: raw.requestId, params: checkedParams, query: checkedQuery, body: raw.body ?? {} };
}

function parseRange(query) {
  const parse = (value, fallback, max) => {
    if (value === undefined) return fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw fail(400, "invalid_request");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > max) throw fail(400, "invalid_request");
    return number;
  };
  const limit = parse(query.limit, 20, 20);
  const offset = parse(query.offset, 0, 100_000);
  if (limit < 1) throw fail(400, "invalid_request");
  return { limit, offset };
}

function resultRecord(value, actor) {
  exactKeys(value, ["record", "duplicate"], ["record", "duplicate"]);
  if (typeof value.duplicate !== "boolean") throw fail(500, "internal_error");
  return parseRecord(value.record, actor);
}

function assertOutput(body) {
  let size;
  try { size = Buffer.byteLength(JSON.stringify(body), "utf8"); }
  catch { throw fail(500, "internal_error"); }
  if (size > MAX_OUTPUT) throw fail(413, "too_large");
  return { status: 200, body };
}

/** Trusted resolver authorizes source resources and returns only safe public text: command sources must be completed results, never native paths or raw input. */
export function createHandoffModule({ store, projectId, authorizeCard, resolveSource, now = Date.now } = {}) {
  if (!store || ["propose", "accept", "get", "list", "close"].some(name => typeof store[name] !== "function") ||
      !safeId(projectId) || typeof authorizeCard !== "function" || typeof resolveSource !== "function" || typeof now !== "function") {
    throw new TypeError("store, projectId, authorizeCard, resolveSource, and now are required");
  }
  const target = Object.freeze({ projectId });

  async function permit(actor, action, cardId) {
    let allowed = false;
    try { allowed = await authorizeCard({ actor, action, cardId }); } catch { /* fail closed and conceal the resource */ }
    if (allowed !== true) throw fail(404, "not_found");
  }

  async function resolve(actor, source) {
    let value;
    try { value = await resolveSource({ actor, source: { ...source } }); }
    catch (error) { throw mapDependencyError(error); }
    if (!plain(value) || Object.keys(value).length !== 2 || !own(value, "source") || !own(value, "text") ||
        typeof value.text !== "string") throw fail(404, "not_found");
    if (Buffer.byteLength(value.text, "utf8") > MAX_TEXT) throw fail(413, "too_large");
    let resolved;
    try { resolved = checkedSource(value.source); } catch { throw fail(404, "not_found"); }
    if (!sameSource(resolved, source)) throw fail(404, "not_found");
    return value.text;
  }

  async function checkCurrent(actor, action, targetCardId, source) {
    await permit(actor, action, targetCardId);
    await permit(actor, "read", source.cardId);
    await resolve(actor, source);
    // Re-check after the asynchronous resolver so a stale allow cannot authorize the store operation.
    await permit(actor, action, targetCardId);
    await permit(actor, "read", source.cardId);
  }

  async function callStore(method, input) {
    try { return await store[method](input); }
    catch (error) { throw mapDependencyError(error); }
  }

  async function propose(raw) {
    const { actor, body } = context(raw, { body: ["requestId", "source", "targetCardId"] });
    exactKeys(body, ["requestId", "source", "targetCardId"], ["requestId", "source", "targetCardId"]);
    if (!safeId(body.requestId) || !safeId(body.targetCardId)) throw fail(400, "invalid_request");
    const source = checkedSource(body.source);
    if (source.cardId === body.targetCardId) throw fail(400, "invalid_request");
    await permit(actor, "read", source.cardId);
    await permit(actor, "write", body.targetCardId);
    const text = await resolve(actor, source);
    const snapshot = { text };
    const snapshotHash = hash(text);
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_JSON) throw fail(413, "too_large");
    // Resolver is asynchronous; revalidate both permissions immediately before durable proposal.
    await permit(actor, "read", source.cardId);
    await permit(actor, "write", body.targetCardId);
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp)) throw fail(500, "internal_error");
    const value = await callStore("propose", {
      actor, requestId: body.requestId, source, targetCardId: body.targetCardId, snapshot, now: timestamp,
    });
    const record = resultRecord(value, actor);
    if (record.requestId !== body.requestId || !sameSource(record.source, source) || record.targetCardId !== body.targetCardId ||
        (!value.duplicate && (record.snapshot.text !== text || record.snapshot.sha256 !== snapshotHash))) throw fail(409, "conflict");
    return assertOutput({ record, duplicate: value.duplicate });
  }

  async function get(raw) {
    const { actor, params } = context(raw, { params: ["id"] });
    if (!safeId(params.id)) throw fail(400, "invalid_request");
    const found = await callStore("get", { actor, id: params.id });
    if (found === null || found === undefined) throw fail(404, "not_found");
    const record = parseRecord(found, actor);
    await checkCurrent(actor, "read", record.targetCardId, record.source);
    return assertOutput({ record });
  }

  async function list(raw) {
    const { actor, query } = context(raw, { query: ["targetCardId", "limit", "offset"] });
    if (!safeId(query.targetCardId)) throw fail(400, "invalid_request");
    const { limit, offset } = parseRange(query);
    await permit(actor, "read", query.targetCardId);
    const values = await callStore("list", { actor, targetCardId: query.targetCardId, limit, offset });
    if (!Array.isArray(values)) throw fail(500, "internal_error");
    const items = [];
    for (const value of values) {
      const record = parseRecord(value, actor);
      if (record.targetCardId !== query.targetCardId) throw fail(500, "internal_error");
      try { await checkCurrent(actor, "read", record.targetCardId, record.source); }
      catch (error) { if (error.status === 404) continue; throw error; }
      items.push({
        id: record.id, owner: record.owner, requestId: record.requestId, payloadHash: record.payloadHash,
        state: record.state, source: record.source, targetCardId: record.targetCardId,
        snapshot: { sha256: record.snapshot.sha256 }, createdAt: record.createdAt, acceptedAt: record.acceptedAt,
      });
    }
    await permit(actor, "read", query.targetCardId);
    return assertOutput({ items });
  }

  async function accept(raw) {
    const { actor, params, body } = context(raw, { params: ["id"], body: ["requestId"] });
    exactKeys(body, ["requestId"], ["requestId"]);
    if (!safeId(params.id) || !safeId(body.requestId)) throw fail(400, "invalid_request");
    const found = await callStore("get", { actor, id: params.id });
    if (found === null || found === undefined) throw fail(404, "not_found");
    const before = parseRecord(found, actor);
    await checkCurrent(actor, "write", before.targetCardId, before.source);
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp)) throw fail(500, "internal_error");
    const value = await callStore("accept", { actor, id: params.id, requestId: body.requestId, now: timestamp });
    const record = resultRecord(value, actor);
    const immutable = ["id", "owner", "requestId", "payloadHash", "targetCardId", "createdAt"];
    if (immutable.some(key => record[key] !== before[key]) || !sameSource(record.source, before.source) ||
        record.snapshot.text !== before.snapshot.text || record.snapshot.sha256 !== before.snapshot.sha256 || record.state !== "accepted") {
      throw fail(500, "internal_error");
    }
    return assertOutput({ record, duplicate: value.duplicate });
  }

  const route = (method, path, operation, effect, handle) => Object.freeze({ method, path, operation, effect, target, handle });
  return Object.freeze([
    route("POST", "/v1/modules/handoff", "handoff.propose", "write", propose),
    route("GET", "/v1/modules/handoff", "handoff.list", "read", list),
    route("GET", "/v1/modules/handoff/:id", "handoff.read", "read", get),
    route("POST", "/v1/modules/handoff/:id/accept", "handoff.accept", "write", accept),
  ]);
}
