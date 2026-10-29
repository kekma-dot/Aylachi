import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../persistence/store.mjs";
import { createHub } from "./server.mjs";

const bearer = "synthetic-test-bearer-value-never-for-production";
const grants = [
  ["allow", "write", "card.create"], ["allow", "read", "card.read"],
  ["allow", "read", "card.list"], ["allow", "read", "snapshot.read"], ["allow", "read", "events.read"],
  ["allow", "write", "session.message"], ["allow", "write", "command.cancel"],
  ["allow", "read", "command.read"], ["allow", "write", "card.update"], ["allow", "write", "card.delete"],
].map(([effect, permission, operation]) => ({ effect, permission, operation, ...(operation === "events.read" ? {} : { projectId: "p1" }) }));

async function fixture(t, runner = async () => ({ ok: true }), grantsForTest = grants, routeHandlers = []) {
  const dir = mkdtempSync(join(tmpdir(), "aylachi-hub-test-"));
  const store = openStore(join(dir, "test.sqlite"));
  const hub = createHub({
    store, bearerSecret: bearer,
    authContext: { principalId: "synthetic-principal", expiresAt: 10_000, revoked: false, grants: grantsForTest },
    now: () => 1_000,
    resolveTarget({ operation, input, card }) {
      if (operation === "card.list") {
        if (input.canvasId === "canvas-a") return { projectId: "p1" };
        if (input.canvasId === "canvas-b") return { projectId: "p2" };
        return {};
      }
      if (card) return { projectId: card.id === "card-cross-project" ? "p2" : "p1", cardId: card.id, sessionId: card.sessionId };
      if (operation === "card.create") {
        if (input.canvasId !== "canvas-a" || input.sessionId !== "session-a") throw Error("unresolved resource");
        return { projectId: "p1", cardId: input.id, sessionId: "session-a" };
      }
      return {};
    },
    runner,
    routeHandlers,
  });
  const address = await hub.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path, options = {}, token = bearer) => fetch(`${base}${path}`, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  t.after(async () => { await hub.shutdown({ abortActive: true }); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { hub, store, request };
}

async function createCard(request) {
  return request("/v1/cards", { method: "POST", body: JSON.stringify({ requestId: "create-1", id: "card-a", canvasId: "canvas-a", sessionId: "session-a", title: "Card", x: 0, y: 0 }) });
}
async function moveCard(request, cardId, body, headers = {}) {
  return request(`/v1/cards/${cardId}/position`, { method: "POST", body: JSON.stringify(body), headers });
}
async function until(fn) {
  for (let i = 0; i < 50; i++) { const value = fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("condition timed out");
}

function moduleRoute(overrides = {}) {
  return {
    method: "GET",
    path: "/v1/modules/example/notes/:id",
    operation: "module.note.read",
    effect: "read",
    target: { projectId: "p1" },
    handle: async ({ actor, params }) => ({ status: 200, body: { actor, id: params.id } }),
    ...overrides,
  };
}

function moduleGrant(operation = "module.note.read", permission = "read") {
  return { effect: "allow", permission, operation, projectId: "p1" };
}

function hubOptions(store) {
  return {
    store,
    bearerSecret: bearer,
    authContext: { principalId: "synthetic-principal", expiresAt: 10_000, revoked: false, grants },
    resolveTarget: () => ({}),
    runner: async () => ({ ok: true }),
    now: () => 1_000,
  };
}

test("loopback only; unauthenticated requests denied", async (t) => {
  const { hub, request } = await fixture(t);
  assert.throws(() => hub.listen(0, "0.0.0.0"), /loopback/);
  assert.equal((await request("/v1/events", {}, null)).status, 401);
  assert.equal((await request("/v1/events", {}, "wrong-token")).status, 401);
});

test("card create retry is ID-keyed and conflicting content returns 409", async (t) => {
  const { request, store } = await fixture(t);
  assert.equal((await createCard(request)).status, 201);
  const before = store.getEvents(0, 100).length;
  const retry = await request("/v1/cards", { method: "POST", body: JSON.stringify({ requestId: "different-request-id", id: "card-a", canvasId: "canvas-a", sessionId: "session-a", title: "Card", x: 0, y: 0 }) });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(store.getEvents(0, 100).length, before);
  const conflict = await request("/v1/cards", { method: "POST", body: JSON.stringify({ requestId: "create-3", id: "card-a", canvasId: "canvas-a", sessionId: "session-a", title: "different", x: 0, y: 0 }) });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "card_id_conflict" });
});

test("card delete requires authorization, matching revision and an idle command plane", async (t) => {
  const { request, store } = await fixture(t);
  assert.equal((await createCard(request)).status, 201);
  store.reserveCommand({ id: "delete-busy", cardId: "card-a", input: { operation: "session.message", text: "running" } });
  const busy = await request("/v1/cards/card-a/delete", { method: "POST", body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(busy.status, 409); assert.deepEqual(await busy.json(), { error: "card_busy" });
  store.completeCommand("delete-busy", { status: "ok", text: "done" });
  const stale = await request("/v1/cards/card-a/delete", { method: "POST", body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(stale.status, 409);
  const deleted = await request("/v1/cards/card-a/delete", { method: "POST", body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { deleted: true });
  assert.equal(store.getCard("card-a"), undefined); assert.equal(store.getCommand("delete-busy"), undefined);
  assert.equal((await request("/v1/cards/card-a/delete", { method: "POST", body: JSON.stringify({ expectedRevision: 1 }) })).status, 404);
});

test("card delete is concealed without its own write grant", async (t) => {
  const { request, store } = await fixture(t, undefined, grants.filter(grant => grant.operation !== "card.delete"));
  assert.equal((await createCard(request)).status, 201);
  const response = await request("/v1/cards/card-a/delete", { method: "POST", body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(response.status, 404); assert.ok(store.getCard("card-a"));
});

test("malformed card/message input rejected before durable reservation", async (t) => {
  const { store, request } = await fixture(t);
  const before = store.getEvents(0, 1000).length;
  const malformed = await request("/v1/cards", { method: "POST", body: JSON.stringify({ requestId: "x", id: "bad card", canvasId: "canvas-a", sessionId: "session-a", title: "x", x: 0, y: 0 }) });
  assert.equal(malformed.status, 400);
  assert.equal(store.getEvents(0, 1000).length, before);
  assert.equal((await createCard(request)).status, 201);
  const badMessage = await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-bad", text: " " }) });
  assert.equal(badMessage.status, 400);
  assert.equal(store.getEvents(0, 1000).filter((event) => event.kind === "command.reserved").length, 0);
});

test("card catalog returns only individually authorized cards from the resolved canvas project", async (t) => {
  let dispatches = 0;
  const cardReadDeny = { effect: "deny", permission: "read", operation: "card.read", projectId: "p1", cardId: "card-hidden", sessionId: "session-a" };
  const { request, store } = await fixture(t, async () => { dispatches++; return { ok: true }; }, [...grants, cardReadDeny]);
  const add = (id, canvasId, title = id) => store.createCard({ id, canvasId, sessionId: "session-a", title, x: 4, y: 7 });
  const visible = add("card-visible", "canvas-a");
  add("card-hidden", "canvas-a");
  add("card-cross-project", "canvas-a");
  add("card-other-canvas", "canvas-b");
  const beforeEvents = store.getEvents(0, 1000);
  const originalList = store.listCards.bind(store);
  const listArgs = [];
  store.listCards = (options) => { listArgs.push(options); return originalList(options); };

  const response = await request("/v1/cards?canvasId=canvas-a");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { cards: [visible] });
  assert.deepEqual(Object.keys(body.cards[0]).sort(), ["canvasId", "id", "revision", "sessionId", "title", "x", "y"]);
  assert.equal(JSON.stringify(body).includes("card-hidden"), false);
  assert.equal(JSON.stringify(body).includes("card-cross-project"), false);
  assert.equal(JSON.stringify(body).includes("card-other-canvas"), false);
  assert.deepEqual(listArgs, [{ canvasId: "canvas-a", limit: 101 }]);
  assert.deepEqual(store.getEvents(0, 1000), beforeEvents);
  assert.equal(dispatches, 0);
});

test("card catalog requires exact query and conceals unresolved or denied canvases before listing", async (t) => {
  const { request, store } = await fixture(t);
  let listCalls = 0;
  const originalList = store.listCards.bind(store);
  store.listCards = (...args) => { listCalls++; return originalList(...args); };
  for (const path of [
    "/v1/cards", "/v1/cards?canvasId=", "/v1/cards?canvasId=bad%20id",
    "/v1/cards?canvasId=canvas-a&canvasId=canvas-a", "/v1/cards?canvasId=canvas-a&extra=1",
  ]) assert.equal((await request(path)).status, 400, path);
  const unresolved = await request("/v1/cards?canvasId=unknown-canvas");
  const denied = await request("/v1/cards?canvasId=canvas-b");
  assert.equal(unresolved.status, 404);
  assert.equal(denied.status, 404);
  const unresolvedBody = await unresolved.json();
  const deniedBody = await denied.json();
  assert.deepEqual(unresolvedBody, deniedBody);
  assert.equal(listCalls, 0);
});

test("card catalog requires an explicit card.list grant", async (t) => {
  const { request, store } = await fixture(t, undefined, grants.filter((grant) => grant.operation !== "card.list"));
  store.createCard({ id: "card-no-list-grant", canvasId: "canvas-a", sessionId: "session-a", title: "private", x: 0, y: 0 });
  let listCalls = 0;
  const originalList = store.listCards.bind(store);
  store.listCards = (...args) => { listCalls++; return originalList(...args); };
  const response = await request("/v1/cards?canvasId=canvas-a");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.equal(listCalls, 0);
});

test("card catalog denies foreign Origin before lookup and keeps bearer/auth behavior", async (t) => {
  let dispatches = 0;
  const { request, store } = await fixture(t, async () => { dispatches++; return { ok: true }; });
  store.createCard({ id: "card-origin", canvasId: "canvas-a", sessionId: "session-a", title: "secret", x: 0, y: 0 });
  let listCalls = 0;
  const originalList = store.listCards.bind(store);
  store.listCards = (...args) => { listCalls++; return originalList(...args); };
  const beforeEvents = store.getEvents(0, 1000);
  const foreign = await request("/v1/cards?canvasId=canvas-a", { headers: { origin: "https://foreign.example" } });
  assert.equal(foreign.status, 403);
  assert.deepEqual(await foreign.json(), { error: "cors_rejected" });
  const unauthenticated = await request("/v1/cards?canvasId=canvas-a", {}, null);
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: "unauthorized" });
  assert.equal(listCalls, 0);
  assert.deepEqual(store.getEvents(0, 1000), beforeEvents);
  assert.equal(dispatches, 0);
});

test("card catalog rejects more than 100 candidates and over-budget output with explicit 413", async (t) => {
  let dispatches = 0;
  const { request, store } = await fixture(t, async () => { dispatches++; return { ok: true }; });
  for (let i = 0; i < 101; i++) store.createCard({ id: `overflow-${String(i).padStart(3, "0")}`, canvasId: "canvas-a", sessionId: "session-a", title: "card", x: i, y: i });
  const beforeOverflowEvents = store.getEvents(0, 1000);
  const overflow = await request("/v1/cards?canvasId=canvas-a");
  assert.equal(overflow.status, 413);
  assert.deepEqual(await overflow.json(), { error: "catalog_too_large" });
  assert.deepEqual(store.getEvents(0, 1000), beforeOverflowEvents);

  const large = await fixture(t, async () => { dispatches++; return { ok: true }; });
  for (let i = 0; i < 20; i++) large.store.createCard({ id: `large-${String(i).padStart(2, "0")}`, canvasId: "canvas-a", sessionId: "session-a", title: "x".repeat(4096), x: 0, y: 0 });
  const beforeLargeEvents = large.store.getEvents(0, 1000);
  const tooManyBytes = await large.request("/v1/cards?canvasId=canvas-a");
  assert.equal(tooManyBytes.status, 413);
  assert.deepEqual(await tooManyBytes.json(), { error: "catalog_too_large" });
  assert.deepEqual(large.store.getEvents(0, 1000), beforeLargeEvents);
  assert.equal(dispatches, 0);
});

test("position FAST RPC persists only coordinates with revision and event; stale revision is conflict", async (t) => {
  let dispatches = 0;
  const { request, store } = await fixture(t, async () => { dispatches++; return { ok: true }; });
  assert.equal((await createCard(request)).status, 201);
  const before = store.getCardEvents("card-a", 0, 100);
  const response = await moveCard(request, "card-a", { expectedRevision: 1, x: 125.5, y: -42 });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.card, { id: "card-a", canvasId: "canvas-a", sessionId: "session-a", title: "Card", x: 125.5, y: -42, revision: 2 });
  assert.deepEqual(Object.keys(body), ["card"]);
  const after = store.getCardEvents("card-a", 0, 100);
  assert.equal(after.length, before.length + 1);
  assert.equal(after.at(-1).kind, "card.updated");
  assert.deepEqual(after.at(-1).payload, { revision: 2, title: "Card", x: 125.5, y: -42 });

  const stale = await moveCard(request, "card-a", { expectedRevision: 1, x: 900, y: 901 });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "revision_conflict" });
  assert.deepEqual(store.getCard("card-a"), body.card);
  assert.deepEqual(store.getCardEvents("card-a", 0, 100), after);
  assert.equal(dispatches, 0);
});

test("position write hides denied existing card like a missing card", async (t) => {
  let dispatches = 0;
  const scopedGrants = grants.filter(grant => grant.operation !== "card.update");
  const { request, store } = await fixture(t, async () => { dispatches++; return { ok: true }; }, scopedGrants);
  await createCard(request);
  const before = store.getCardEvents("card-a", 0, 100);
  const existing = await moveCard(request, "card-a", { expectedRevision: 1, x: 10, y: 20 });
  const missing = await moveCard(request, "absent", { expectedRevision: 1, x: 10, y: 20 });
  assert.equal(existing.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await existing.json(), await missing.json());
  assert.deepEqual(store.getCard("card-a"), { id: "card-a", canvasId: "canvas-a", sessionId: "session-a", title: "Card", x: 0, y: 0, revision: 1 });
  assert.deepEqual(store.getCardEvents("card-a", 0, 100), before);
  assert.equal(dispatches, 0);
});

test("position rejects malformed IDs, extra/invalid fields, extreme coordinates, and foreign Origin without effects", async (t) => {
  let dispatches = 0;
  const { request, store } = await fixture(t, async () => { dispatches++; return { ok: true }; });
  await createCard(request);
  const before = store.getCardEvents("card-a", 0, 100);
  const malformedPath = await moveCard(request, "%E0%A4%A", { expectedRevision: 1, x: 1, y: 2 });
  assert.equal(malformedPath.status, 400);
  for (const body of [
    { expectedRevision: 0, x: 1, y: 2 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1, x: 1, y: 2 },
    { expectedRevision: 1, x: null, y: 2 },
    { expectedRevision: 1, x: 1, y: null },
    { expectedRevision: 1, x: 1_000_001, y: 2 },
    { expectedRevision: 1, x: 1, y: -1_000_001 },
    { expectedRevision: 1, x: 1, y: 2, requestId: "not-supported" },
    { expectedRevision: 1, x: 1, y: 2, title: "forged" },
    { expectedRevision: 1, x: 1 },
  ]) assert.equal((await moveCard(request, "card-a", body)).status, 400);

  const foreign = await moveCard(request, "card-a", { expectedRevision: 1, x: 3, y: 4 }, { origin: "https://foreign.example" });
  assert.equal(foreign.status, 403);
  assert.deepEqual(store.getCard("card-a"), { id: "card-a", canvasId: "canvas-a", sessionId: "session-a", title: "Card", x: 0, y: 0, revision: 1 });
  assert.deepEqual(store.getCardEvents("card-a", 0, 100), before);
  assert.equal(dispatches, 0);
});

test("message reservation is durable and duplicate request dispatches once", async (t) => {
  let dispatches = 0;
  const { store, request } = await fixture(t, async () => { dispatches++; return { text: "synthetic" }; });
  assert.equal((await createCard(request)).status, 201);
  const payload = JSON.stringify({ requestId: "msg-1", text: "hello" });
  const first = await request("/v1/cards/card-a/messages", { method: "POST", body: payload });
  const firstBody = await first.json();
  assert.equal(first.status, 202);
  const retry = await request("/v1/cards/card-a/messages", { method: "POST", body: payload });
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).duplicate, true);
  await until(() => store.getCommand("msg-1")?.state === "COMPLETED");
  assert.equal(dispatches, 1);
  assert.equal(store.getCommand("msg-1").state, "COMPLETED");
  assert.equal(firstBody.command.id, "msg-1");
});

test("snapshot watermark and reconnect event offsets do not replay acknowledged events", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await createCard(request)).status, 201);
  const snapshotResponse = await request("/v1/snapshot?cardId=card-a");
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.card.id, "card-a");
  assert.equal(snapshot.eventSequence, 1);
  assert.equal(Object.hasOwn(snapshot, "offset"), false);
  const first = await (await request("/v1/events?cardId=card-a&after=0")).json();
  assert.equal(first.events[0].sequence, snapshot.eventSequence);
  assert.equal(first.nextSequence, snapshot.eventSequence);
  assert.equal(Object.hasOwn(first.events[0], "offset"), false);
  const reconnect = await (await request(`/v1/events?cardId=card-a&after=${snapshot.eventSequence}`)).json();
  assert.deepEqual(reconnect.events, []);
  const repeatedReconnect = await (await request(`/v1/events?cardId=card-a&after=${snapshot.eventSequence}`)).json();
  assert.deepEqual(repeatedReconnect.events, []);
});

test("unknown runner outcome requires reconciliation and is never replayed", async (t) => {
  let dispatches = 0;
  const { store, request } = await fixture(t, async () => { dispatches++; throw Error("synthetic private detail"); });
  await createCard(request);
  const response = await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-error", text: "hello" }) });
  assert.equal(response.status, 202);
  await until(() => store.getCommand("msg-error")?.state === "NEEDS_RECONCILIATION");
  assert.equal(store.getCommand("msg-error").result, null);
  assert.equal(dispatches, 1);
  assert.ok(store.getEvents(0, 100).some((event) => event.kind === "command.needs_reconciliation"));
  const retry = await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-error", text: "hello" }) });
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(dispatches, 1);
});

test("abort request does not misreport a runner success as cancellation", async (t) => {
  const { store, request } = await fixture(t, ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve("ignored"), { once: true })));
  await createCard(request);
  await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-cancel", text: "hello" }) });
  const cancelBody = JSON.stringify({ requestId: "cancel-1" });
  const first = await request("/v1/commands/msg-cancel/cancel", { method: "POST", body: cancelBody });
  assert.equal(first.status, 202);
  await until(() => store.getCommand("msg-cancel")?.state === "COMPLETED");
  assert.equal(store.getCommand("msg-cancel").result.status, "ok");
  const cancelEvents = store.getEvents(0, 100).filter((event) => event.kind === "command.cancel_requested").length;
  const retry = await request("/v1/commands/msg-cancel/cancel", { method: "POST", body: cancelBody });
  assert.equal(retry.status, 409);
  assert.deepEqual(await retry.json(), { error: "already_terminal" });
  assert.equal(store.getEvents(0, 100).filter((event) => event.kind === "command.cancel_requested").length, cancelEvents);
});

test("body size limit rejects oversized payload before reservation", async (t) => {
  const { store, request } = await fixture(t);
  const before = store.getEvents(0, 1000).length;
  const response = await request("/v1/cards", { method: "POST", body: " ".repeat(70 * 1024) });
  assert.equal(response.status, 413);
  assert.equal(store.getEvents(0, 1000).length, before);
});

test("event output is capped instead of emitting an oversized response", async (t) => {
  const { store, request } = await fixture(t);
  await createCard(request);
  for (let i = 0; i < 100; i++) store.appendEvent("card-a", "synthetic", { text: "x".repeat(1000) });
  const response = await request("/v1/events?cardId=card-a&after=0&limit=100");
  assert.equal(response.status, 500);
  assert.ok(Number(response.headers.get("content-length")) < 100);
  assert.deepEqual(await response.json(), { error: "response_too_large" });
});


test("explicit runner cancellation proof is the only cancelled outcome", async (t) => {
  const { store, request } = await fixture(t, async () => ({ status: "CANCELLED", text: "must not leak" }));
  await createCard(request);
  await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-proof", text: "hello" }) });
  await until(() => store.getCommand("msg-proof")?.state === "COMPLETED");
  assert.deepEqual(store.getCommand("msg-proof").result, { status: "cancelled" });
});

test("command read is scoped and projects text without native session paths", async (t) => {
  const secretPath = "/private/test/native-session.json";
  const { request, store } = await fixture(t, async () => ({ text: "visible answer", nativeSessionFile: secretPath }));
  await createCard(request);
  const accepted = await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-view", text: "hello" }) });
  assert.equal(accepted.status, 202);
  await until(() => store.getCommand("msg-view")?.state === "COMPLETED");
  const response = await request("/v1/commands/msg-view");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.command, { id: "msg-view", state: "COMPLETED", result: { status: "ok", text: "visible answer" }, message: { role: "user", text: "hello" } });
  assert.equal(Object.hasOwn(body.command, "input"), false);
  assert.equal(JSON.stringify(body).includes(secretPath), false);
  const duplicate = await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-view", text: "hello" }) });
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.command.result.text, "visible answer");
  assert.equal(JSON.stringify(duplicateBody).includes(secretPath), false);
  assert.equal((await request("/v1/commands/missing")).status, 404);
});

test("close disconnects HTTP only; explicit shutdown aborts and awaits jobs", async (t) => {
  let started = false;
  let aborted = false;
  const { hub, store, request } = await fixture(t, ({ signal }) => new Promise((resolve) => {
    started = true;
    signal.addEventListener("abort", () => { aborted = true; resolve({ status: "CANCELLED" }); }, { once: true });
  }));
  await createCard(request);
  await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-shutdown", text: "hello" }) });
  await until(() => started);
  await hub.close();
  assert.equal(aborted, false);
  await hub.shutdown({ abortActive: true });
  assert.equal(aborted, true);
  assert.equal(store.getCommand("msg-shutdown").result.status, "cancelled");
});


test("known side-effect-free runner rejection is a structured failure", async (t) => {
  const { store, request } = await fixture(t, async () => { throw Object.assign(new Error("private detail"), { safeNoSideEffect: true, code: "INVALID_INPUT" }); });
  await createCard(request);
  await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-safe-fail", text: "hello" }) });
  await until(() => store.getCommand("msg-safe-fail")?.state === "COMPLETED");
  assert.deepEqual(store.getCommand("msg-safe-fail").result, { status: "error", code: "INVALID_INPUT" });
});

test("command read hides commands outside the trusted authorization scope", async (t) => {
  const scopedGrants = grants.filter((grant) => grant.operation !== "command.read");
  const { request } = await fixture(t, async () => ({ text: "private" }), scopedGrants);
  await createCard(request);
  await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-private", text: "hello" }) });
  assert.equal((await request("/v1/commands/msg-private")).status, 404);
  assert.equal((await request("/v1/commands/not-present")).status, 404);
});


test("resource-specific authorization denials conceal existing resources", async (t) => {
  const denied = new Set(["card.read", "events.read", "snapshot.read", "command.cancel"]);
  const scopedGrants = grants.filter((grant) => !denied.has(grant.operation));
  const { request } = await fixture(t, async () => ({ text: "done" }), scopedGrants);
  await createCard(request);
  await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-oracle", text: "hello" }) });
  const sameNotFound = async (existing, missing) => {
    const a = await existing;
    const b = await missing;
    assert.equal(a.status, 404);
    assert.equal(b.status, 404);
    assert.deepEqual(await a.json(), await b.json());
  };
  await sameNotFound(request("/v1/cards/card-a"), request("/v1/cards/absent"));
  await sameNotFound(request("/v1/events?cardId=card-a"), request("/v1/events?cardId=absent"));
  await sameNotFound(request("/v1/snapshot?cardId=card-a"), request("/v1/snapshot?cardId=absent"));
  const cancel = (id) => request(`/v1/commands/${id}/cancel`, { method: "POST", body: JSON.stringify({ requestId: `cancel-${id}` }) });
  await sameNotFound(cancel("msg-oracle"), cancel("absent"));
});

test("malformed percent-encoded path IDs return structured 400", async (t) => {
  const { request } = await fixture(t);
  for (const path of [
    "/v1/cards/%E0%A4%A",
    "/v1/cards/%E0%A4%A/messages",
    "/v1/commands/%E0%A4%A/cancel",
    "/v1/commands/%E0%A4%A",
  ]) {
    const post = path.endsWith("/cancel") || path.endsWith("/messages");
    const response = await request(path, { method: post ? "POST" : "GET", ...(post ? { body: JSON.stringify({ requestId: "cancel-bad", text: "x" }) } : {}) });
    assert.equal(response.status, 400, path);
    assert.match((await response.json()).error, /^invalid_(card|command)_id$/);
  }
});


test("message writes conceal unauthorized card existence", async (t) => {
  const scopedGrants = grants.filter((grant) => grant.operation !== "session.message");
  const { request } = await fixture(t, async () => ({ text: "unused" }), scopedGrants);
  await createCard(request);
  const post = (cardId) => request(`/v1/cards/${cardId}/messages`, { method: "POST", body: JSON.stringify({ requestId: `msg-${cardId}`, text: "hello" }) });
  const existing = await post("card-a");
  const missing = await post("absent");
  assert.equal(existing.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await existing.json(), await missing.json());
});


test("cancel rejects completed target without recording a cancel command or event", async (t) => {
  const { store, request } = await fixture(t, async () => ({ text: "done" }));
  await createCard(request);
  await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-done", text: "hello" }) });
  await until(() => store.getCommand("msg-done")?.state === "COMPLETED");
  const before = store.getEvents(0, 1000).filter((event) => event.kind === "command.cancel_requested").length;
  const response = await request("/v1/commands/msg-done/cancel", { method: "POST", body: JSON.stringify({ requestId: "cancel-done" }) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "already_terminal" });
  assert.equal(store.getCommand("cancel-done"), undefined);
  assert.equal(store.getEvents(0, 1000).filter((event) => event.kind === "command.cancel_requested").length, before);
});

test("cancel rejects reconciliation target without recording a cancel command or event", async (t) => {
  const { store, request } = await fixture(t, async () => { throw Error("unknown outcome"); });
  await createCard(request);
  await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-unknown", text: "hello" }) });
  await until(() => store.getCommand("msg-unknown")?.state === "NEEDS_RECONCILIATION");
  const before = store.getEvents(0, 1000).filter((event) => event.kind === "command.cancel_requested").length;
  const response = await request("/v1/commands/msg-unknown/cancel", { method: "POST", body: JSON.stringify({ requestId: "cancel-unknown" }) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "already_terminal" });
  assert.equal(store.getCommand("cancel-unknown"), undefined);
  assert.equal(store.getEvents(0, 1000).filter((event) => event.kind === "command.cancel_requested").length, before);
});

test("cancel rechecks target after body wait and authorization", async (t) => {
  let finishRunner;
  const { store, request } = await fixture(t, () => new Promise((resolve) => { finishRunner = resolve; }));
  await createCard(request);
  await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "msg-race", text: "hello" }) });
  await until(() => finishRunner);

  const originalGet = store.getCommand.bind(store);
  let armed = false;
  let lookupSeen;
  const didLookup = new Promise((resolve) => { lookupSeen = resolve; });
  store.getCommand = (id) => {
    if (armed && id === "msg-race") { armed = false; lookupSeen(); }
    return originalGet(id);
  };
  let releaseBody;
  let markBodyStarted;
  const bodyStarted = new Promise((resolve) => { markBodyStarted = resolve; });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"requestId":"cancel-race"'));
      releaseBody = () => { controller.enqueue(new TextEncoder().encode("}")); controller.close(); };
      markBodyStarted();
    },
  });
  armed = true;
  const pending = request("/v1/commands/msg-race/cancel", { method: "POST", body: stream, duplex: "half" });
  await bodyStarted;
  await didLookup;
  finishRunner({ text: "completed during cancel body" });
  await until(() => store.getCommand("msg-race")?.state === "COMPLETED");
  releaseBody();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "already_terminal" });
  assert.equal(store.getCommand("cancel-race"), undefined);
  assert.equal(store.getEvents(0, 1000).some((event) => event.kind === "command.cancel_requested"), false);
});


test("card-local events and snapshot watermark are unchanged by another card's writes", async (t) => {
  const { request, store } = await fixture(t);
  await createCard(request);
  const createB = await request("/v1/cards", { method: "POST", body: JSON.stringify({ requestId: "create-b", id: "card-b", canvasId: "canvas-a", sessionId: "session-a", title: "Card B", x: 1, y: 1 }) });
  assert.equal(createB.status, 201);
  const snapshotBefore = await (await request("/v1/snapshot?cardId=card-a")).json();
  const eventsBefore = await (await request("/v1/events?cardId=card-a&after=0")).json();
  for (let i = 0; i < 8; i++) {
    const write = await request("/v1/cards/card-b/messages", { method: "POST", body: JSON.stringify({ requestId: `msg-b-${i}`, text: `private B activity ${i}` }) });
    assert.equal(write.status, 202);
    await until(() => store.getCommand(`msg-b-${i}`)?.state === "COMPLETED");
  }
  const snapshotAfter = await (await request("/v1/snapshot?cardId=card-a")).json();
  const eventsAfter = await (await request("/v1/events?cardId=card-a&after=0")).json();
  assert.deepEqual(snapshotAfter, snapshotBefore);
  assert.deepEqual(eventsAfter, eventsBefore);
  assert.deepEqual(Object.keys(snapshotAfter).sort(), ["card", "eventSequence"]);
  assert.deepEqual(Object.keys(eventsAfter).sort(), ["events", "nextSequence"]);
  assert.equal(snapshotAfter.eventSequence, 1);
  assert.equal(eventsAfter.nextSequence, 1);
  assert.equal(JSON.stringify(eventsAfter).includes("private B activity"), false);
  assert.equal(JSON.stringify(snapshotAfter).includes("offset"), false);
});

test("trusted-origin preflight bypasses bearer and private store lookups", async (t) => {
  const { store, request } = await fixture(t);
  let storeCalls = 0;
  for (const name of ["getCard", "getCommand", "getEvents", "getCardEvents", "getCardSnapshot", "createCard", "reserveCommand", "appendEvent", "completeCommand", "markNeedsReconciliation"]) {
    const original = store[name].bind(store);
    store[name] = (...args) => { storeCalls++; return original(...args); };
  }
  const response = await request("/v1/cards", {
    method: "OPTIONS",
    headers: {
      origin: "tauri://localhost",
      "access-control-request-method": "POST",
      "access-control-request-headers": "Authorization, Content-Type",
    },
  }, null);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(storeCalls, 0);
  assert.equal(response.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST");
  assert.equal(response.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

test("foreign and null Origins are denied before reservation; trusted Origin still requires bearer", async (t) => {
  let dispatches = 0;
  const { store, request } = await fixture(t, async () => { dispatches++; return { text: "synthetic" }; });
  assert.equal((await createCard(request)).status, 201); // Missing Origin remains usable by authenticated Node clients.
  const before = store.getEvents(0, 1000).length;
  for (const [origin, requestId] of [["https://evil.example", "msg-foreign"], ["null", "msg-null"]]) {
    const denied = await request("/v1/cards/card-a/messages", {
      method: "POST",
      body: JSON.stringify({ requestId, text: "must not reserve" }),
      headers: { origin },
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "cors_rejected" });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(store.getEvents(0, 1000).length, before);
  assert.equal(dispatches, 0);

  const payload = JSON.stringify({ requestId: "msg-trusted", text: "hello" });
  const unauthenticated = await request("/v1/cards/card-a/messages", {
    method: "POST", body: payload, headers: { origin: "tauri://localhost" },
  }, null);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.equal(unauthenticated.headers.get("vary"), "Origin");
  assert.equal(unauthenticated.headers.get("access-control-allow-credentials"), null);
  assert.equal(store.getEvents(0, 1000).length, before);
  assert.equal(dispatches, 0);

  const authorized = await request("/v1/cards/card-a/messages", {
    method: "POST", body: payload, headers: { origin: "tauri://localhost" },
  });
  assert.equal(authorized.status, 202);
  assert.equal(authorized.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.equal(authorized.headers.get("vary"), "Origin");
  assert.equal(authorized.headers.get("access-control-allow-credentials"), null);
  await until(() => store.getCommand("msg-trusted")?.state === "COMPLETED");
  assert.equal(dispatches, 1);
});

test("unregistered module route is absent; existing chat routes still work", async (t) => {
  let disabledCalls = 0, dispatches = 0;
  const disabled = moduleRoute({ handle: async () => { disabledCalls++; return { status: 200, body: {} }; } });
  const { request, store } = await fixture(t, async () => { dispatches++; return { text: "ok" }; });
  assert.equal((await request("/v1/modules/example/notes/note-a")).status, 404);
  assert.equal(disabledCalls, 0);
  assert.equal((await createCard(request)).status, 201);
  const message = await request("/v1/cards/card-a/messages", { method: "POST", body: JSON.stringify({ requestId: "chat-still-works", text: "hello" }) });
  assert.equal(message.status, 202);
  await until(() => store.getCommand("chat-still-works")?.state === "COMPLETED");
  assert.equal(dispatches, 1);
  assert.equal(disabledCalls, 0);
  void disabled;
});

test("registered module root route is allowed; module collection and malformed names are rejected", async (t) => {
  const root = moduleRoute({ path: "/v1/modules/example", handle: async ({ actor }) => ({ status: 200, body: { actor } }) });
  const { request, store } = await fixture(t, undefined, [...grants, moduleGrant()], [root]);
  const response = await request("/v1/modules/example");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { actor: "synthetic-principal" });
  for (const path of ["/v1/modules", "/v1/modules/Bad", "/v1/modules//bad"]) {
    assert.throws(() => createHub({ ...hubOptions(store), routeHandlers: [moduleRoute({ path })] }), TypeError, path);
  }
});

test("module route runs only after bearer and exact-origin CORS gates", async (t) => {
  let calls = 0;
  const route = moduleRoute({ handle: async () => { calls++; return { status: 200, body: {} }; } });
  const { request } = await fixture(t, undefined, [...grants, moduleGrant()], [route]);
  const path = "/v1/modules/example/notes/note-a";
  assert.equal((await request(path, {}, null)).status, 401);
  assert.equal((await request(path, { headers: { origin: "https://foreign.example" } })).status, 403);
  assert.equal(calls, 0);
});

test("module authorization denial conceals resource identity and skips handler", async (t) => {
  let calls = 0;
  const route = moduleRoute({ handle: async () => { calls++; return { status: 200, body: {} }; } });
  const { request } = await fixture(t, undefined, grants, [route]);
  const existing = await request("/v1/modules/example/notes/existing");
  const missing = await request("/v1/modules/example/notes/missing");
  assert.equal(existing.status, 404);
  assert.deepEqual(await existing.json(), await missing.json());
  assert.equal(calls, 0);
});

test("trusted module grants fix actor, effect, and target outside request body", async (t) => {
  let seen;
  const route = moduleRoute({
    method: "POST", operation: "module.note.write", effect: "write",
    handle: async function (context) {
      assert.equal(this, undefined);
      seen = context;
      return { status: 201, body: { actor: context.actor, id: context.params.id, requestId: context.requestId, bodyActor: context.body.actor } };
    },
  });
  const grantsForTest = [...grants, moduleGrant("module.note.write", "write")];
  const { request } = await fixture(t, undefined, grantsForTest, [route]);
  const response = await request("/v1/modules/example/notes/note-a", {
    method: "POST",
    body: JSON.stringify({ actor: "forged-actor", effect: "read", operation: "module.note.read", target: { projectId: "p2" } }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    actor: "synthetic-principal", id: "note-a", requestId: seen.requestId, bodyActor: "forged-actor",
  });
  assert.match(seen.requestId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  assert.deepEqual(Object.keys(seen).sort(), ["actor", "body", "params", "query", "requestId"]);
  assert.equal(seen.body.effect, "read");
});

test("duplicate, overlapping, or invalid module descriptors fail construction", async (t) => {
  const { store } = await fixture(t);
  const base = moduleRoute();
  const overlapping = moduleRoute({ path: "/v1/modules/example/notes/fixed" });
  for (const handlers of [
    [base, { ...base }],
    [base, overlapping],
    [{ ...base, method: "DELETE" }],
    [{ ...base, path: "/v1/cards/:id" }],
    [{ ...base, effect: "admin" }],
    [{ ...base, target: { projectId: "" } }],
    [{ ...base, extra: true }],
  ]) assert.throws(() => createHub({ ...hubOptions(store), routeHandlers: handlers }), TypeError);
});

test("module params and bounded plain query reject malformed, duplicate, and oversized values", async (t) => {
  let calls = 0;
  const route = moduleRoute({
    handle: async ({ params, query, body }) => {
      calls++;
      return { status: 200, body: { params, query, plainQuery: Object.getPrototypeOf(query) === Object.prototype, bodyIsUndefined: body === undefined } };
    },
  });
  const unrelated = moduleRoute({ path: "/v1/modules/example/notes/:id/fixed", handle: async () => { calls++; return { status: 200, body: {} }; } });
  const { request } = await fixture(t, undefined, [...grants, moduleGrant()], [route, unrelated]);
  const base = "/v1/modules/example/notes/";
  assert.equal((await request(`${base}%E0%A4%A/unrelated`)).status, 404);
  for (const path of [
    `${base}%E0%A4%A`,
    `${base}note%2Fother`,
    `${base}note-a?x=1&x=2`,
    `${base}note-a?${Array.from({ length: 17 }, (_, i) => `k${i}=v`).join("&")}`,
    `${base}note-a?q=${"x".repeat(513)}`,
  ]) assert.equal((await request(path)).status, 400);
  assert.equal(calls, 0);
  const valid = await request(`${base}note%2Da?q=ok`);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { params: { id: "note-a" }, query: { q: "ok" }, plainQuery: true, bodyIsUndefined: true });
  assert.equal(calls, 1);
});

test("module body and result stay bounded; invalid requestId never reaches handler", async (t) => {
  let calls = 0;
  const route = moduleRoute({ method: "POST", operation: "module.note.write", effect: "write", handle: async () => { calls++; return { status: 200, body: { ok: true } }; } });
  const { request } = await fixture(t, undefined, [...grants, moduleGrant("module.note.write", "write")], [route]);
  const path = "/v1/modules/example/notes/note-a";
  const invalidId = await request(path, { method: "POST", body: JSON.stringify({ requestId: "not a safe id" }) });
  assert.equal(invalidId.status, 400);
  const oversized = await request(path, { method: "POST", body: "x".repeat(65 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);
});

test("module handler errors map to safe statuses; unexpected errors and returned failures stay generic", async (t) => {
  const route = moduleRoute({
    handle: async ({ params }) => {
      if (params.id === "returned") return { status: 409, body: { error: "private-return" } };
      if (params.id === "unexpected") throw Error("private exception detail");
      const [status, code] = ({
        invalid: [400, "invalid_request"], denied: [404, "not_found"], missing: [404, "not_found"],
        conflict: [409, "conflict"], large: [413, "too_large"], strange: [418, "private_module_code"],
      })[params.id];
      throw Object.assign(new Error("private module detail"), { status, code });
    },
  });
  const { request } = await fixture(t, undefined, [...grants, moduleGrant()], [route]);
  const expected = [
    ["invalid", 400, "invalid_request"], ["denied", 404, "not_found"], ["missing", 404, "not_found"],
    ["conflict", 409, "conflict"], ["large", 413, "payload_too_large"], ["strange", 500, "internal_error"],
    ["unexpected", 500, "internal_error"], ["returned", 500, "internal_error"],
  ];
  for (const [id, status, code] of expected) {
    const response = await request(`/v1/modules/example/notes/${id}`);
    assert.equal(response.status, status, id);
    const body = await response.json();
    assert.deepEqual(body, { error: code }, id);
    assert.equal(JSON.stringify(body).includes("PRIVATE_MODULE_CODE"), false);
    assert.equal(JSON.stringify(body).includes("private"), false);
  }
});
