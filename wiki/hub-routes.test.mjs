import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openWiki } from "./wiki.mjs";
import { createWikiRouteHandlers } from "./hub-routes.mjs";

async function fixture(t, authorize = async () => true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = await openWiki({ root, authorize });
  const handlers = createWikiRouteHandlers({ wiki, projectId: "aylachi" });
  return { root, wiki, handlers };
}

function byOperation(handlers, operation) {
  const handler = handlers.find(item => item.operation === operation);
  assert.ok(handler, `missing ${operation}`);
  return handler;
}

function call(handlers, operation, input = {}) {
  return byOperation(handlers, operation).handle(input);
}

async function failure(promise, status, code) {
  await assert.rejects(promise, error => error.status === status && error.code === code);
}

async function rejected(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail("expected rejection");
}

test("descriptors use fixed base, operation, effect, and trusted project target", async t => {
  const { handlers } = await fixture(t);
  assert.deepEqual(handlers.map(({ method, path, operation, effect }) => [method, path, operation, effect]), [
    ["POST", "/v1/modules/wiki/notes", "wiki.create", "write"],
    ["GET", "/v1/modules/wiki/notes", "wiki.search", "read"],
    ["GET", "/v1/modules/wiki/notes/:id", "wiki.read", "read"],
    ["POST", "/v1/modules/wiki/notes/:id", "wiki.write", "write"],
    ["GET", "/v1/modules/wiki/notes/:id/history", "wiki.history", "read"],
    ["GET", "/v1/modules/wiki/notes/:id/diff", "wiki.diff", "read"],
    ["POST", "/v1/modules/wiki/notes/:id/restore", "wiki.restore", "write"],
    ["GET", "/v1/modules/wiki/notes/:id/links", "wiki.links", "read"],
  ]);
  for (const descriptor of handlers) assert.deepEqual(descriptor.target, { projectId: "aylachi" });
  assert.ok(Object.isFrozen(handlers) && handlers.every(Object.isFrozen));
});

test("direct descriptors cover Wiki CRUD, search, history, diff, restore, and links", async t => {
  const { handlers } = await fixture(t);
  const linked = "11111111-1111-4111-8111-111111111111";
  const created = await call(handlers, "wiki.create", { actor: "principal-1", body: { content: `alpha [[${linked}]]` } });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body).sort(), ["id", "revision"]);
  const { id } = created.body;

  const read = await call(handlers, "wiki.read", { actor: "principal-1", params: { id } });
  assert.deepEqual(read, { status: 200, body: { id, revision: created.body.revision, content: `alpha [[${linked}]]` } });
  await failure(call(handlers, "wiki.read", { actor: "principal-1", params: { id }, query: { revision: "bad" } }), 400, "invalid_request");
  await failure(call(handlers, "wiki.diff", { actor: "principal-1", params: { id }, query: { fromRevision: created.body.revision, toRevision: "bad" } }), 400, "invalid_request");
  const searched = await call(handlers, "wiki.search", { actor: "principal-1", query: { query: "alpha" } });
  assert.deepEqual(searched.body.notes, [{ id, revision: created.body.revision }]);
  assert.deepEqual((await call(handlers, "wiki.links", { actor: "principal-1", params: { id } })).body, { links: [linked] });

  const updated = await call(handlers, "wiki.write", { actor: "principal-1", params: { id }, body: { content: "beta", expectedRevision: created.body.revision } });
  assert.equal(updated.status, 200);
  const history = await call(handlers, "wiki.history", { actor: "principal-1", params: { id } });
  assert.deepEqual(history.body.revisions.slice().sort(), [created.body.revision, updated.body.revision].sort());
  const diff = await call(handlers, "wiki.diff", { actor: "principal-1", params: { id }, query: { fromRevision: created.body.revision, toRevision: updated.body.revision } });
  assert.equal(diff.status, 200);
  assert.equal(diff.body.changes.length, 1);
  assert.deepEqual(diff.body.changes[0].insert, ["beta"]);
  const restored = await call(handlers, "wiki.restore", { actor: "principal-1", params: { id }, body: { revision: created.body.revision, expectedRevision: updated.body.revision } });
  assert.equal(restored.status, 200);
  assert.equal((await call(handlers, "wiki.read", { actor: "principal-1", params: { id } })).body.content, `alpha [[${linked}]]`);
});

test("denied and missing reads are identical; forged actor and invalid input do not write", async t => {
  const seenActors = [];
  const { root, wiki, handlers } = await fixture(t, async ({ actor }) => { seenActors.push(actor); return actor !== "denied"; });
  const created = await call(handlers, "wiki.create", { actor: "principal-1", body: { content: "safe" } });
  const denied = await rejected(call(handlers, "wiki.read", { actor: "denied", params: { id: created.body.id } }));
  const missing = await rejected(call(handlers, "wiki.read", { actor: "principal-1", params: { id: "22222222-2222-4222-8222-222222222222" } }));
  assert.deepEqual([denied.status, denied.code], [404, "not_found"]);
  assert.deepEqual([missing.status, missing.code], [404, "not_found"]);

  const historyBefore = await wiki.history({ actor: "principal-1", id: created.body.id });
  const currentBefore = await readFile(path.join(root, created.body.id, "CURRENT"), "utf8");
  await failure(call(handlers, "wiki.create", { actor: "principal-1", body: { content: "bad", actor: "forged" } }), 400, "invalid_request");
  await failure(call(handlers, "wiki.write", { actor: "principal-1", params: { id: "bad" }, body: { content: "bad", expectedRevision: created.body.revision } }), 400, "invalid_request");
  await failure(call(handlers, "wiki.write", { actor: "principal-1", params: { id: created.body.id }, body: { content: "bad", expectedRevision: "stale", extra: true } }), 400, "invalid_request");
  assert.ok(!seenActors.includes("forged"));
  assert.deepEqual(await wiki.history({ actor: "principal-1", id: created.body.id }), historyBefore);
  assert.equal(await readFile(path.join(root, created.body.id, "CURRENT"), "utf8"), currentBefore);
});

test("conflicts, busy locks, strict query bounds, and oversized responses use safe errors", async t => {
  const { root, wiki, handlers } = await fixture(t);
  const created = await call(handlers, "wiki.create", { actor: "owner", body: { content: "base" } });
  const id = created.body.id;
  const updated = await call(handlers, "wiki.write", { actor: "owner", params: { id }, body: { content: "next", expectedRevision: created.body.revision } });
  const historyBeforeInvalid = await wiki.history({ actor: "owner", id });
  const currentBeforeInvalid = await readFile(path.join(root, id, "CURRENT"), "utf8");
  await failure(call(handlers, "wiki.write", { actor: "owner", params: { id }, body: { content: "bad", expectedRevision: "malformed" } }), 400, "invalid_request");
  assert.deepEqual(await wiki.history({ actor: "owner", id }), historyBeforeInvalid);
  assert.equal(await readFile(path.join(root, id, "CURRENT"), "utf8"), currentBeforeInvalid);
  await failure(call(handlers, "wiki.write", { actor: "owner", params: { id }, body: { content: "stale", expectedRevision: created.body.revision } }), 409, "conflict");
  const lock = await open(path.join(root, id, "WRITE.lock"), "wx", 0o600);
  try {
    await failure(call(handlers, "wiki.write", { actor: "owner", params: { id }, body: { content: "busy", expectedRevision: updated.body.revision } }), 409, "conflict");
    await readFile(path.join(root, id, "WRITE.lock"));
  } finally { await lock.close(); await rm(path.join(root, id, "WRITE.lock"), { force: true }); }
  await failure(call(handlers, "wiki.search", { actor: "owner", query: { query: "x", extra: "y" } }), 400, "invalid_request");
  await failure(call(handlers, "wiki.search", { actor: "owner", query: { query: "x".repeat(513) } }), 400, "invalid_request");
  const large = await wiki.create({ actor: "owner", content: "x".repeat(70_000) });
  await failure(call(handlers, "wiki.read", { actor: "owner", params: { id: large.id } }), 413, "too_large");
});
