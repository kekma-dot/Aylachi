import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { authorize } from "./authorization.mjs";
import { evaluateCors } from "./cors.mjs";
import { createExecutionPlane } from "./execution-plane.mjs";
import { compileRouteHandlers, matchModuleRoute, moduleQuery } from "./module-routes.mjs";

const BODY_LIMIT = 64 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const RESULT_TEXT_LIMIT = 8 * 1024;
const MAX_CARD_COORDINATE = 1_000_000;
const validCardSize = (width, height) => Number.isFinite(width) && width >= 320 && width <= 1200 &&
  Number.isFinite(height) && height >= 360 && height <= 1200;
const validCardModel = card => ["modelProvider", "modelId", "reasoning"].every(key => Object.hasOwn(card, key)) &&
  safeId(card.modelProvider) && safeId(card.modelId) && ["low", "medium", "high"].includes(card.reasoning);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const MODULE_ERRORS = new Map([[400, "invalid_request"], [404, "not_found"], [409, "conflict"], [413, "payload_too_large"]]);
const bad = (status, code) => Object.assign(new Error(code), { status, code });
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const hash = (s) => createHash("sha256").update(s).digest();

function tokenMatches(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const candidate = header.slice(7);
  if (!candidate || candidate.length > 4096) return false;
  return timingSafeEqual(hash(candidate), hash(expected));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => { if (!done) { done = true; reject(err); } };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { fail(bad(413, "body_too_large")); return; }
      if (!done) chunks.push(chunk);
    });
    req.on("aborted", () => fail(bad(400, "request_aborted")));
    req.on("error", () => fail(bad(400, "request_aborted")));
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!isObject(value)) throw bad(400, "invalid_json_object");
        resolve(value);
      } catch (err) { reject(err.status ? err : bad(400, "invalid_json")); }
    });
  });
}

function respond(res, status, payload) {
  if (res.writableEnded) return;
  let body;
  try { body = Buffer.from(JSON.stringify(payload)); }
  catch { status = 500; body = Buffer.from('{"error":"internal_error"}'); }
  if (body.length > OUTPUT_LIMIT) {
    status = 500;
    body = Buffer.from('{"error":"response_too_large"}');
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": body.length,
  });
  res.end(body);
}

function exactKeys(value, allowed, required) {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) throw bad(400, "invalid_request");
}
function safeId(value) { return typeof value === "string" && ID.test(value); }
function decodeId(value, code) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw bad(400, code); }
  if (!safeId(decoded)) throw bad(400, code);
  return decoded;
}

function commandView(command) {
  let result = null;
  if (command.state === "NEEDS_RECONCILIATION") result = { status: "needs_reconciliation" };
  else if (command.result?.status === "ok") {
    const value = command.result.value;
    const text = typeof value?.text === "string" ? value.text : typeof command.result.text === "string" ? command.result.text : null;
    result = { status: "ok", ...(text === null ? {} : { text: text.slice(0, RESULT_TEXT_LIMIT), ...(text.length > RESULT_TEXT_LIMIT ? { truncated: true } : {}) }) };
  } else if (command.result?.status === "error" && /^[A-Z][A-Z0-9_]{0,63}$/.test(command.result.code ?? "")) result = { status: "error", code: command.result.code };
  else if (command.result?.status === "cancelled" || command.result?.status === "accepted") result = { status: command.result.status };
  const text = command.input?.operation === "session.message" && typeof command.input.text === "string" ? command.input.text : null;
  const message = text === null ? undefined : { role: "user", text: text.slice(0, 16 * 1024) };
  return { id: command.id, state: command.state, result, ...(message ? { message } : {}), ...(command.input?.model ? { model: command.input.model } : {}) };
}

export function createHub({ store, graph, bearerSecret, authContext, resolveTarget, runner, backends, routeHandlers = [], now = Date.now, allowedOrigin = "tauri://localhost" } = {}) {
  if (!store || typeof store.getCard !== "function" || typeof store.createCard !== "function" ||
      typeof store.reserveCommand !== "function" || typeof store.getCommand !== "function" ||
      typeof store.completeCommand !== "function" || typeof store.markNeedsReconciliation !== "function" ||
      typeof store.getCardEvents !== "function" || typeof store.getCardSnapshot !== "function" || typeof store.appendEvent !== "function") throw new TypeError("createHub: compatible store required");
  if (typeof bearerSecret !== "string" || bearerSecret.length < 32) throw new TypeError("createHub: bearerSecret must be injected and at least 32 characters");
  if (!authContext || typeof authContext !== "object" || typeof resolveTarget !== "function" || typeof runner !== "function") {
    throw new TypeError("createHub: server auth context, trusted target resolver, and runner required");
  }

  if (!evaluateCors({ method: "GET" }, allowedOrigin).allowed) throw new TypeError("createHub: exact allowedOrigin required");
  const moduleRoutes = compileRouteHandlers(routeHandlers);

  const executions = createExecutionPlane({ store, graph, runner: backends ? input => backends.run(input) : runner });
  let closePromise = null;
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (res.headersSent) { res.end(); return; }
      respond(res, Number.isInteger(err?.status) ? err.status : 500,
        { error: Number.isInteger(err?.status) ? err.code : "internal_error" });
    });
  });

  function authorized(req, operation, requestId, effect, target, conceal = false) {
    const descriptor = { operation, effect, ...target };
    const input = { operation, requestId };
    const result = authorize(authContext, input, descriptor, now());
    if (!result.allowed) throw bad(conceal ? 404 : 403, conceal ? "not_found" : "forbidden");
    return result;
  }

  function trustedTarget(operation, input, card) {
    const target = resolveTarget({ operation, input, card, store });
    if (!isObject(target)) throw bad(404, "resource_not_found");
    for (const [key, value] of Object.entries(target)) {
      if (!["projectId", "cardId", "sessionId"].includes(key) || !safeId(value)) throw bad(500, "resolver_invalid");
    }
    if (card && (target.cardId !== card.id || target.sessionId !== card.sessionId)) throw bad(500, "resolver_mismatch");
    return target;
  }

  async function handle(req, res) {
    const host = req.headers.host;
    let hostname;
    try { hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, ""); } catch { throw bad(400, "bad_host"); }
    if (!LOOPBACK.has(hostname)) throw bad(403, "forbidden_host");
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/v1/")) {
      const cors = evaluateCors({
        origin: req.headers.origin,
        method: req.method,
        requestedMethod: req.headers["access-control-request-method"],
        requestedHeaders: req.headers["access-control-request-headers"],
      }, allowedOrigin);
      if (!cors.allowed) throw bad(403, "cors_rejected");
      for (const [name, value] of Object.entries(cors.headers)) res.setHeader(name, value);
      if (cors.preflight) {
        res.writeHead(204, { "Cache-Control": "no-store", "Content-Length": "0" });
        res.end();
        return;
      }
    }
    if (!tokenMatches(req.headers.authorization, bearerSecret)) throw bad(401, "unauthorized");

    if (url.pathname.startsWith("/v1/modules/")) {
      const matched = matchModuleRoute(moduleRoutes, req.method, url.pathname);
      if (!matched) throw bad(404, "not_found");
      let body;
      if (matched.route.method === "GET") {
        if (req.headers["transfer-encoding"] !== undefined || (req.headers["content-length"] !== undefined && Number(req.headers["content-length"]) > 0)) throw bad(400, "module_body_not_allowed");
      } else {
        body = await readJson(req);
        if (Object.hasOwn(body, "requestId") && !safeId(body.requestId)) throw bad(400, "invalid_request_id");
      }
      const query = moduleQuery(url);
      const requestId = body && Object.hasOwn(body, "requestId") ? body.requestId : randomUUID();
      authorized(req, matched.route.operation, requestId, matched.route.effect, matched.route.target, true);
      let result;
      try {
        const handleRoute = matched.route.handle;
        result = await handleRoute({ actor: authContext.principalId, params: matched.params, query, body, requestId });
      } catch (err) {
        const mapped = MODULE_ERRORS.get(err?.status);
        if (mapped && /^[A-Z][A-Z0-9_]{0,63}$/i.test(err?.code ?? "")) {
          const status = err.status;
          respond(res, status, { error: mapped });
          return;
        }
        throw bad(500, "internal_error");
      }
      if (!isObject(result) || Object.keys(result).some((key) => !["status", "body"].includes(key)) ||
          !Object.hasOwn(result, "status") || !Object.hasOwn(result, "body") || ![200, 201].includes(result.status)) throw bad(500, "internal_error");
      respond(res, result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/cards") {
      const body = await readJson(req);
      exactKeys(body, ["requestId", "id", "canvasId", "sessionId", "title", "x", "y", "backendId"], ["requestId", "id", "canvasId", "sessionId", "title", "x", "y"]);
      if (!safeId(body.requestId) || !safeId(body.id) || !safeId(body.canvasId) || !safeId(body.sessionId) ||
          typeof body.title !== "string" || body.title.length < 1 || body.title.length > 4096 ||
          !Number.isFinite(body.x) || !Number.isFinite(body.y)) throw bad(400, "invalid_card");
      if (body.backendId !== undefined) {
        if (!backends || !safeId(body.backendId)) throw bad(400, "invalid_card");
        try { backends.validate(body.backendId); } catch { throw bad(400, "invalid_card"); }
      }
      const target = trustedTarget("card.create", body, null);
      authorized(req, "card.create", body.requestId, "write", target);
      const bindBackend = card => {
        try { return backends?.bind(card, body.backendId); }
        catch (error) { if (error?.code === 'BACKEND_BINDING_CONFLICT') throw bad(409, 'card_id_conflict'); throw error; }
      };
      const existing = store.getCard(body.id);
      if (existing) {
        const existingTarget = trustedTarget("card.create", body, existing);
        const sameTarget = Object.keys(target).length === Object.keys(existingTarget).length && Object.entries(target).every(([key, value]) => existingTarget[key] === value);
        const sameCard = existing.canvasId === body.canvasId && existing.sessionId === body.sessionId && existing.title === body.title && existing.x === body.x && existing.y === body.y;
        if (!sameTarget || !sameCard) throw bad(409, "card_id_conflict");
        const bound = backends?.conversation(existing.id);
        const backend = body.backendId !== undefined || !bound ? bindBackend(existing) : bound;
        respond(res, 200, { card: existing, duplicate: true, ...(backend ? { backend } : {}) });
        return;
      }
      const card = store.createCard({ id: body.id, canvasId: body.canvasId, sessionId: body.sessionId, title: body.title, x: body.x, y: body.y });
      const backend = bindBackend(card);
      respond(res, 201, { card, duplicate: false, ...(backend ? { backend } : {}) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/cards") {
      const query = [...url.searchParams];
      if (query.length !== 1 || query[0][0] !== "canvasId" || !safeId(query[0][1])) throw bad(400, "invalid_card_query");
      const canvasId = query[0][1];
      let collectionTarget;
      try { collectionTarget = trustedTarget("card.list", { canvasId }, null); }
      catch (err) { if (err.status === 404) throw bad(404, "not_found"); throw err; }
      if (!safeId(collectionTarget.projectId)) throw bad(404, "not_found");
      const projectId = collectionTarget.projectId;
      authorized(req, "card.list", randomUUID(), "read", { projectId }, true);
      if (typeof store.listCards !== "function") throw bad(500, "catalog_unavailable");
      const candidates = store.listCards({ canvasId, limit: 101 });
      if (!Array.isArray(candidates)) throw bad(500, "catalog_invalid");
      if (candidates.length > 100) throw bad(413, "catalog_too_large");
      const cards = [];
      for (const card of candidates) {
        if (!isObject(card) || !safeId(card.id) || !safeId(card.canvasId) || card.canvasId !== canvasId ||
            !safeId(card.sessionId) || typeof card.title !== "string" || card.title.length > 4096 ||
            !Number.isFinite(card.x) || !Number.isFinite(card.y) || !Number.isSafeInteger(card.revision) || card.revision < 1 ||
            (Object.hasOwn(card, "width") !== Object.hasOwn(card, "height")) ||
            (Object.hasOwn(card, "width") && !validCardSize(card.width, card.height)) ||
            (Object.hasOwn(card, "modelProvider") && !validCardModel(card)) ||
            ["modelProvider", "modelId", "reasoning"].some(key => Object.hasOwn(card, key)) !== Object.hasOwn(card, "modelProvider")) {
          throw bad(500, "catalog_invalid");
        }
        let target;
        try { target = trustedTarget("card.read", null, card); }
        catch (err) { if (err.status === 404) continue; throw err; }
        if (target.projectId !== projectId) continue;
        try { authorized(req, "card.read", randomUUID(), "read", target, true); }
        catch (err) { if (err.status === 404) continue; throw err; }
        cards.push({ id: card.id, canvasId: card.canvasId, sessionId: card.sessionId, title: card.title, x: card.x, y: card.y, revision: card.revision,
          ...(Object.hasOwn(card, "width") ? { width: card.width, height: card.height } : {}),
          ...(Object.hasOwn(card, "modelProvider") ? { modelProvider: card.modelProvider, modelId: card.modelId, reasoning: card.reasoning } : {}) });
      }
      const result = { cards };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > OUTPUT_LIMIT) throw bad(413, "catalog_too_large");
      respond(res, 200, result);
      return;
    }

    const cardMatch = url.pathname.match(/^\/v1\/cards\/([^/]+)$/);
    if (req.method === "GET" && cardMatch) {
      const cardId = decodeId(cardMatch[1], "invalid_card_id");
      const card = store.getCard(cardId);
      if (!card) throw bad(404, "not_found");
      const target = trustedTarget("card.read", null, card);
      authorized(req, "card.read", `read-${cardId}`, "read", target, true);
      respond(res, 200, { card });
      return;
    }

    const deleteMatch = url.pathname.match(/^\/v1\/cards\/([^/]+)\/delete$/);
    if (req.method === "POST" && deleteMatch) {
      const cardId = decodeId(deleteMatch[1], "invalid_card_id");
      const body = await readJson(req);
      exactKeys(body, ["expectedRevision"], ["expectedRevision"]);
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) throw bad(400, "invalid_revision");
      const card = store.getCard(cardId);
      if (!card) throw bad(404, "not_found");
      const target = trustedTarget("card.delete", body, card);
      authorized(req, "card.delete", randomUUID(), "write", target, true);
      if (typeof store.deleteCard !== "function") throw bad(500, "internal_error");
      try { store.deleteCard(cardId, body.expectedRevision); }
      catch (err) {
        if (err.message === "REVISION_CONFLICT") throw bad(409, "revision_conflict");
        if (err.message === "CARD_BUSY") throw bad(409, "card_busy");
        throw err;
      }
      respond(res, 200, { deleted: true });
      return;
    }

    const positionMatch = url.pathname.match(/^\/v1\/cards\/([^/]+)\/position$/);
    if (req.method === "POST" && positionMatch) {
      const cardId = decodeId(positionMatch[1], "invalid_card_id");
      const body = await readJson(req);
      exactKeys(body, ["expectedRevision", "x", "y"], ["expectedRevision", "x", "y"]);
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 ||
          !Number.isFinite(body.x) || Math.abs(body.x) > MAX_CARD_COORDINATE ||
          !Number.isFinite(body.y) || Math.abs(body.y) > MAX_CARD_COORDINATE) throw bad(400, "invalid_position");
      const card = store.getCard(cardId);
      if (!card) throw bad(404, "not_found");
      const target = trustedTarget("card.update", body, card);
      authorized(req, "card.update", randomUUID(), "write", target, true);
      if (typeof store.updateCard !== "function") throw bad(500, "internal_error");
      let updated;
      try { updated = store.updateCard(cardId, body.expectedRevision, { x: body.x, y: body.y }); }
      catch (err) { if (err.message === "REVISION_CONFLICT") throw bad(409, "revision_conflict"); throw err; }
      if (!updated) throw bad(404, "not_found");
      respond(res, 200, { card: updated });
      return;
    }

    const layoutMatch = url.pathname.match(/^\/v1\/cards\/([^/]+)\/layout$/);
    if (req.method === "POST" && layoutMatch) {
      const cardId = decodeId(layoutMatch[1], "invalid_card_id");
      const body = await readJson(req);
      exactKeys(body, ["expectedRevision", "x", "y", "width", "height"], ["expectedRevision", "x", "y", "width", "height"]);
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 ||
          !Number.isFinite(body.x) || Math.abs(body.x) > MAX_CARD_COORDINATE ||
          !Number.isFinite(body.y) || Math.abs(body.y) > MAX_CARD_COORDINATE || !validCardSize(body.width, body.height)) throw bad(400, "invalid_layout");
      const card = store.getCard(cardId);
      if (!card) throw bad(404, "not_found");
      const target = trustedTarget("card.update", body, card);
      authorized(req, "card.update", randomUUID(), "write", target, true);
      let updated;
      try { updated = store.updateCard(cardId, body.expectedRevision, { x: body.x, y: body.y, width: body.width, height: body.height }); }
      catch (err) { if (err.message === "REVISION_CONFLICT") throw bad(409, "revision_conflict"); throw err; }
      if (!updated) throw bad(404, "not_found");
      respond(res, 200, { card: updated });
      return;
    }

    const titleMatch = url.pathname.match(/^\/v1\/cards\/([^/]+)\/title$/);
    if (req.method === "POST" && titleMatch) {
      const cardId = decodeId(titleMatch[1], "invalid_card_id");
      const body = await readJson(req);
      exactKeys(body, ["expectedRevision", "title"], ["expectedRevision", "title"]);
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 ||
          typeof body.title !== "string" || !body.title.trim() || body.title.length > 120) throw bad(400, "invalid_title");
      const card = store.getCard(cardId);
      if (!card) throw bad(404, "not_found");
      const target = trustedTarget("card.update", body, card);
      authorized(req, "card.update", randomUUID(), "write", target, true);
      let updated;
      try { updated = store.updateCard(cardId, body.expectedRevision, { title: body.title }); }
      catch (err) { if (err.message === "REVISION_CONFLICT") throw bad(409, "revision_conflict"); throw err; }
      if (!updated) throw bad(404, "not_found");
      respond(res, 200, { card: updated });
      return;
    }

    const messageMatch = url.pathname.match(/^\/v1\/cards\/([^/]+)\/messages$/);
    if (req.method === "POST" && messageMatch) {
      const cardId = decodeId(messageMatch[1], "invalid_card_id");
      const card = store.getCard(cardId);
      if (!card) throw bad(404, "not_found");
      const body = await readJson(req);
      exactKeys(body, ["requestId", "text"], ["requestId", "text"]);
      if (!safeId(body.requestId) || typeof body.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text) > 16 * 1024) throw bad(400, "invalid_message");
      const target = trustedTarget("session.message", body, card);
      authorized(req, "session.message", body.requestId, "write", target, true);
      const model = card.modelProvider === undefined ? undefined : { provider: card.modelProvider, modelId: card.modelId, reasoning: card.reasoning };
      let reservation;
      try { reservation = store.reserveCommand({ id: body.requestId, cardId, input: { operation: "session.message", text: body.text, ...(model ? { model } : {}) } }); }
      catch (err) { if (err.message === "COMMAND_ID_CONFLICT") throw bad(409, "request_id_conflict"); throw bad(400, "command_rejected"); }
      if (reservation.created) executions.dispatch(reservation.command, card);
      respond(res, 202, { command: commandView(reservation.command), duplicate: !reservation.created });
      return;
    }

    const cancelMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const commandId = decodeId(cancelMatch[1], "invalid_command_id");
      const command = store.getCommand(commandId);
      if (!command) throw bad(404, "not_found");
      const card = store.getCard(command.cardId);
      const body = await readJson(req);
      exactKeys(body, ["requestId"], ["requestId"]);
      if (!safeId(body.requestId)) throw bad(400, "invalid_request_id");
      const target = trustedTarget("command.cancel", body, card);
      authorized(req, "command.cancel", body.requestId, "write", target, true);
      const current = store.getCommand(commandId);
      if (!current || current.cardId !== command.cardId) throw bad(404, "not_found");
      if (current.state !== "RUNNING") throw bad(409, "already_terminal");
      let reservation;
      try { reservation = store.reserveCommand({ id: body.requestId, cardId: command.cardId, input: { operation: "command.cancel", targetId: commandId } }); }
      catch (err) { if (err.message === "COMMAND_ID_CONFLICT") throw bad(409, "request_id_conflict"); throw bad(400, "cancel_rejected"); }
      if (reservation.created) {
        executions.abort(commandId);
        store.appendEvent(command.cardId, "command.cancel_requested", { id: commandId });
        store.completeCommand(body.requestId, { status: "accepted", targetId: commandId });
      }
      respond(res, 202, { command: commandView(reservation.command), duplicate: !reservation.created });
      return;
    }

    const commandMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)$/);
    if (req.method === "GET" && commandMatch) {
      const commandId = decodeId(commandMatch[1], "invalid_command_id");
      const command = store.getCommand(commandId);
      if (!command) throw bad(404, "not_found");
      const card = store.getCard(command.cardId);
      if (!card) throw bad(404, "not_found");
      const target = trustedTarget("command.read", null, card);
      authorized(req, "command.read", commandId, "read", target, true);
      respond(res, 200, { command: commandView(command) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/events/stream") {
      const query = [...url.searchParams];
      if (query.some(([key]) => !["cardId", "after_seq"].includes(key)) || new Set(query.map(([key]) => key)).size !== query.length) throw bad(400, "invalid_event_range");
      const cardId = url.searchParams.get("cardId");
      const after = Number(url.searchParams.get("after_seq") ?? "0");
      if (!safeId(cardId) || !Number.isSafeInteger(after) || after < 0) throw bad(400, "invalid_event_range");
      const card = store.getCard(cardId);
      if (!card) throw bad(404, "not_found");
      const target = trustedTarget("events.read", null, card);
      authorized(req, "events.read", "stream-events", "read", target, true);
      executions.stream(req, res, cardId, after);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/events") {
      const cardId = url.searchParams.get("cardId");
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      if (!safeId(cardId) || !Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw bad(400, "invalid_event_range");
      const card = store.getCard(cardId);
      if (!card) throw bad(404, "not_found");
      const target = trustedTarget("events.read", null, card);
      authorized(req, "events.read", "get-events", "read", target, true);
      const events = store.getCardEvents(cardId, after, limit);
      respond(res, 200, { events, nextSequence: events.at(-1)?.sequence ?? after });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/snapshot") {
      const cardId = url.searchParams.get("cardId");
      if (!safeId(cardId)) throw bad(400, "invalid_card_id");
      let snapshot;
      try { snapshot = store.getCardSnapshot(cardId); }
      catch (err) { if (err.message === "unknown cardId") throw bad(404, "not_found"); throw err; }
      const { card, eventSequence } = snapshot;
      const target = trustedTarget("snapshot.read", null, card);
      authorized(req, "snapshot.read", `snapshot-${cardId}`, "read", target, true);
      respond(res, 200, { card, eventSequence });
      return;
    }
    throw bad(404, "not_found");
  }

  function close() {
    if (closePromise) return closePromise;
    void executions.close();
    if (!server.listening) return Promise.resolve();
    closePromise = new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    return closePromise;
  }

  async function shutdown({ abortActive = false } = {}) {
    await close();
    await executions.shutdown({ abortActive });
  }

  // Trusted channel composition only; HTTP callers cannot supply an acting principal.
  async function dispatchChannelMessage({ cardId, requestId, text, actingPrincipal } = {}) {
    if (!safeId(cardId) || !safeId(requestId) || !safeId(actingPrincipal) || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16 * 1024) throw bad(400, 'invalid_message');
    const card = store.getCard(cardId);
    if (!card) throw bad(404, 'not_found');
    trustedTarget('session.message', { requestId, text }, card);
    const model = card.modelProvider === undefined ? undefined : { provider: card.modelProvider, modelId: card.modelId, reasoning: card.reasoning };
    let reservation;
    try { reservation = store.reserveCommand({ id: requestId, cardId, input: { operation: 'session.message', text, actingPrincipal, ...(model ? { model } : {}) } }); }
    catch (err) { if (err.message === 'COMMAND_ID_CONFLICT') throw bad(409, 'request_id_conflict'); throw bad(400, 'command_rejected'); }
    if (reservation.created) await executions.dispatch(reservation.command, card);
    else await executions.wait(requestId);
    return store.getCommand(requestId);
  }

  return {
    listen(port = 0, host = "127.0.0.1") {
      if (!LOOPBACK.has(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("loopback host and valid port required");
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.removeListener("error", reject); resolve(server.address()); });
      });
    },
    close,
    shutdown,
    dispatchChannelMessage,
    appendModuleExecution: executions.appendModule,
  };
}
