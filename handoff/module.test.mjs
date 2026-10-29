import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../persistence/store.mjs";
import { createHub } from "../hub/server.mjs";
import { openHandoffStore } from "./store.mjs";
import { createHandoffModule } from "./module.mjs";

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const sourceA = { cardId: "source-a", kind: "command", id: "command-a" };
const baseBody = (overrides = {}) => ({ requestId: "send-1", source: sourceA, targetCardId: "target-a", ...overrides });
const raw = ({ actor = "owner", body, params = {}, query = {}, requestId = "transport-1" } = {}) => ({ actor, body, params, query, requestId });
const route = (handlers, operation) => handlers.find(item => item.operation === operation);
async function failure(promise, status, code) {
  await assert.rejects(promise, error => error.status === status && error.code === code);
}

function fixture(t, { now = () => 1_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aylachi-handoff-module-"));
  const store = openHandoffStore(join(dir, "handoff.sqlite"));
  const rights = new Set([
    "read:source-a", "read:source-b", "read:target-a", "write:target-a",
  ]);
  const authorizeCalls = [], resolveCalls = [];
  let text = "safe completed result", authorizeHook, resolveHook;
  const authorizeCard = async input => {
    authorizeCalls.push({ ...input });
    if (authorizeHook) return authorizeHook(input);
    return input.actor === "owner" && rights.has(`${input.action}:${input.cardId}`);
  };
  const resolveSource = async input => {
    resolveCalls.push({ actor: input.actor, source: { ...input.source } });
    if (resolveHook) return resolveHook(input);
    return { source: { ...input.source }, text };
  };
  const handlers = createHandoffModule({ store, projectId: "project", authorizeCard, resolveSource, now });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    store, handlers, rights, authorizeCalls, resolveCalls,
    setText(value) { text = value; },
    setAuthorizeHook(fn) { authorizeHook = fn; },
    setResolveHook(fn) { resolveHook = fn; },
  };
}

async function propose(handlers, body = baseBody(), actor = "owner") {
  return route(handlers, "handoff.propose").handle(raw({ actor, body }));
}

function hubGrants() {
  return [
    ["card.create", "write"], ["session.message", "write"],
    ["handoff.propose", "write"], ["handoff.list", "read"],
    ["handoff.read", "read"], ["handoff.accept", "write"],
  ].map(([operation, permission]) => ({ effect: "allow", permission, operation, projectId: "project" }));
}

async function httpFixture(t, enabled) {
  const dir = mkdtempSync(join(tmpdir(), "aylachi-handoff-http-"));
  const core = openStore(join(dir, "core.sqlite"));
  const handoffs = openHandoffStore(join(dir, "handoffs.sqlite"));
  const rights = new Set(["read:source-a", "read:target-a", "write:target-a"]);
  const bearer = "synthetic-handoff-test-bearer-never-production";
  let runnerCalls = 0, hub;
  const authContext = { principalId: "owner", expiresAt: Date.now() + 60_000, revoked: false, grants: hubGrants() };
  const handlers = createHandoffModule({
    store: handoffs, projectId: "project",
    authorizeCard: ({ actor, action, cardId }) => actor === "owner" && rights.has(`${action}:${cardId}`),
    resolveSource: async ({ source }) => ({ source: { ...source }, text: "safe completed result" }),
  });
  const start = async routes => {
    hub = createHub({
      store: core, bearerSecret: bearer, authContext, now: Date.now,
      resolveTarget: ({ operation, input, card }) => ({ projectId: "project", cardId: card?.id ?? input?.id, sessionId: card?.sessionId ?? input?.sessionId }),
      runner: async () => { runnerCalls++; return { text: "chat result" }; },
      routeHandlers: routes,
    });
    const address = await hub.listen();
    return `http://127.0.0.1:${address.port}`;
  };
  let base = await start(enabled ? handlers : []);
  const request = async (path, method = "GET", body, token = bearer) => {
    const response = await fetch(base + path, {
      method, redirect: "error", signal: AbortSignal.timeout(3000),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    try { await hub?.shutdown({ abortActive: true }); }
    finally { handoffs.close(); core.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  return {
    request, core, handoffs, rights, get runnerCalls() { return runnerCalls; },
    async disable() { await hub.shutdown(); base = await start([]); },
  };
}

test("descriptors are fixed and client cannot supply trusted identity, effects, snapshot, or hash", async t => {
  const f = fixture(t);
  assert.deepEqual(f.handlers.map(({ method, path, operation, effect, target }) => [method, path, operation, effect, target]), [
    ["POST", "/v1/modules/handoff", "handoff.propose", "write", { projectId: "project" }],
    ["GET", "/v1/modules/handoff", "handoff.list", "read", { projectId: "project" }],
    ["GET", "/v1/modules/handoff/:id", "handoff.read", "read", { projectId: "project" }],
    ["POST", "/v1/modules/handoff/:id/accept", "handoff.accept", "write", { projectId: "project" }],
  ]);
  assert.ok(Object.isFrozen(f.handlers) && f.handlers.every(Object.isFrozen));
  for (const key of ["actor", "effect", "operation", "target", "snapshot", "sha256", "owner", "payloadHash"]) {
    await failure(propose(f.handlers, { ...baseBody(), [key]: "forged" }), 400, "invalid_request");
  }
  assert.deepEqual(f.store.list({ actor: "owner", targetCardId: "target-a" }), []);
  assert.equal(f.resolveCalls.length, 0);
});

test("real SQLite store accepts exact snapshot shape; retries keep the original immutable snapshot", async t => {
  const f = fixture(t);
  const first = await propose(f.handlers);
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false);
  assert.deepEqual(first.body.record.snapshot, { text: "safe completed result", sha256: sha256("safe completed result") });
  const id = first.body.record.id;

  f.setText("later source content");
  const retry = await propose(f.handlers);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.record.id, id);
  assert.equal(retry.body.record.snapshot.text, "safe completed result");
  assert.equal((await route(f.handlers, "handoff.read").handle(raw({ params: { id } }))).body.record.snapshot.text, "safe completed result");

  const accepted = await route(f.handlers, "handoff.accept").handle(raw({ params: { id }, body: { requestId: "accept-1" } }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.record.state, "accepted");
  assert.equal(accepted.body.record.snapshot.text, "safe completed result");
  const duplicateAccept = await route(f.handlers, "handoff.accept").handle(raw({ params: { id }, body: { requestId: "accept-1" } }));
  assert.equal(duplicateAccept.body.duplicate, true);
  await failure(propose(f.handlers, baseBody({ source: { ...sourceA, id: "other-command" } })), 409, "conflict");
  await failure(route(f.handlers, "handoff.accept").handle(raw({ params: { id }, body: { requestId: "send-1" } })), 409, "conflict");
});

test("permissions are literal-true, rechecked after resolution, and checked before persistence", async t => {
  const f = fixture(t);
  f.setAuthorizeHook(input => input.action === "read" && input.cardId === "source-a" ? "true" : true);
  await failure(propose(f.handlers), 404, "not_found");
  assert.equal(f.resolveCalls.length, 0);
  assert.deepEqual(f.store.list({ actor: "owner", targetCardId: "target-a" }), []);

  f.setAuthorizeHook(null);
  f.setResolveHook(async ({ source }) => {
    f.rights.delete("write:target-a");
    return { source: { ...source }, text: "safe completed result" };
  });
  await failure(propose(f.handlers, baseBody({ requestId: "revoked-during-resolve" })), 404, "not_found");
  assert.deepEqual(f.store.list({ actor: "owner", targetCardId: "target-a" }), []);

  await failure(propose(f.handlers, baseBody({ requestId: "self", targetCardId: "source-a" })), 400, "invalid_request");
});

test("resolver identity, strict output, Wiki UUIDs, and snapshot byte bounds fail closed", async t => {
  const f = fixture(t);
  f.setResolveHook(async ({ source }) => ({ source: { ...source, id: "different" }, text: "wrong source" }));
  await failure(propose(f.handlers), 404, "not_found");
  f.setResolveHook(async ({ source }) => ({ source: { ...source }, text: "safe", nativeSessionFile: "/private/session.json" }));
  await failure(propose(f.handlers, baseBody({ requestId: "extra-resolver-field" })), 404, "not_found");
  f.setResolveHook(null);

  const invalidWiki = { cardId: "source-a", kind: "wiki", id: "note-a", revision: "not-a-uuid" };
  await failure(propose(f.handlers, baseBody({ requestId: "bad-revision", source: invalidWiki })), 400, "invalid_request");
  const upperRevision = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
  let resolverRevision;
  f.setResolveHook(async ({ source }) => { resolverRevision = source.revision; return { source: { ...source }, text: "wiki text" }; });
  const wiki = await propose(f.handlers, baseBody({ requestId: "wiki-upper", source: { ...invalidWiki, revision: upperRevision } }));
  assert.equal(resolverRevision, upperRevision.toLowerCase());
  assert.equal(wiki.body.record.source.revision, upperRevision.toLowerCase());
  f.setResolveHook(null);

  f.setResolveHook(async ({ source }) => ({ source: { ...source }, text: "x".repeat(16 * 1024 + 1) }));
  await failure(propose(f.handlers, baseBody({ requestId: "text-too-large" })), 413, "too_large");
  f.setResolveHook(async ({ source }) => ({ source: { ...source }, text: "\0".repeat(9_000) }));
  await failure(propose(f.handlers, baseBody({ requestId: "snapshot-json-too-large" })), 413, "too_large");
  assert.equal(f.store.list({ actor: "owner", targetCardId: "target-a" }).length, 1);
});

test("get/list are owner-bound, recheck current source access, and list hides snapshot text", async t => {
  const f = fixture(t);
  const first = await propose(f.handlers, baseBody({ requestId: "list-a" }));
  const secondSource = { cardId: "source-b", kind: "command", id: "command-b" };
  const second = await propose(f.handlers, baseBody({ requestId: "list-b", source: secondSource }));
  f.rights.delete("read:source-b");

  const denied = route(f.handlers, "handoff.read").handle(raw({ params: { id: second.body.record.id } }));
  const missing = route(f.handlers, "handoff.read").handle(raw({ params: { id: "00000000-0000-4000-8000-000000000000" } }));
  await failure(denied, 404, "not_found");
  await failure(missing, 404, "not_found");
  await failure(route(f.handlers, "handoff.read").handle(raw({ actor: "outsider", params: { id: first.body.record.id } })), 404, "not_found");
  assert.equal(f.store.get({ actor: "outsider", id: first.body.record.id }), undefined);

  const listed = await route(f.handlers, "handoff.list").handle(raw({ query: { targetCardId: "target-a" } }));
  assert.deepEqual(listed.body.items.map(item => item.id), [first.body.record.id]);
  assert.deepEqual(listed.body.items[0].snapshot, { sha256: first.body.record.snapshot.sha256 });
  assert.equal(JSON.stringify(listed.body).includes("safe completed result"), false);
  await failure(route(f.handlers, "handoff.list").handle(raw({ query: { targetCardId: "target-a", limit: "21" } })), 400, "invalid_request");
});

test("accept rechecks permission after resolver and never changes a pending record on denial", async t => {
  const f = fixture(t);
  const proposal = await propose(f.handlers);
  f.setResolveHook(async ({ source }) => {
    f.rights.delete("read:source-a");
    return { source: { ...source }, text: "current public result" };
  });
  await failure(route(f.handlers, "handoff.accept").handle(raw({ params: { id: proposal.body.record.id }, body: { requestId: "accept-denied" } })), 404, "not_found");
  assert.equal(f.store.get({ actor: "owner", id: proposal.body.record.id }).state, "pending");
});

test("real Hub HTTP root route accepts handoff without runner; disabled module leaves chat working", async t => {
  const f = await httpFixture(t, true);
  const prefix = "/v1/modules/handoff";
  const body = baseBody();
  const sent = await f.request(prefix, "POST", body);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.record.snapshot.text, "safe completed result");
  const forged = await f.request(prefix, "POST", { ...body, requestId: "forged", actor: "owner" });
  assert.equal(forged.status, 400);
  const listed = await f.request(`${prefix}?targetCardId=target-a`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 1);
  const accepted = await f.request(`${prefix}/${sent.body.record.id}/accept`, "POST", { requestId: "accept-http" });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.record.state, "accepted");
  assert.equal(f.runnerCalls, 0);

  await f.disable();
  const absent = await f.request(`${prefix}/${sent.body.record.id}`);
  assert.equal(absent.status, 404);
  assert.equal(f.handoffs.get({ actor: "owner", id: sent.body.record.id }).state, "accepted");
  const card = await f.request("/v1/cards", "POST", { requestId: "chat-create", id: "chat-card", canvasId: "canvas", sessionId: "chat-session", title: "Chat", x: 0, y: 0 });
  assert.equal(card.status, 201);
  const message = await f.request("/v1/cards/chat-card/messages", "POST", { requestId: "chat-message", text: "hello" });
  assert.equal(message.status, 202);
  for (let i = 0; i < 50 && f.core.getCommand("chat-message")?.state !== "COMPLETED"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.core.getCommand("chat-message").state, "COMPLETED");
  assert.equal(f.runnerCalls, 1);
});
