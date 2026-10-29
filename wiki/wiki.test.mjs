import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, rename, unlink, open, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openWiki } from "./wiki.mjs";

async function fixture(t, authorize = async () => true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aylachi-wiki-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, wiki: await openWiki({ root, authorize }) };
}

test("creates Markdown revisions, rejects stale writes, restores and reopens", async t => {
  const { root, wiki } = await fixture(t);
  const original = await wiki.create({ actor: "owner", content: "first" });
  assert.equal((await lstat(path.join(root, original.id, "revisions"))).mode & 0o077, 0, "revision directories must remain private");
  assert.equal(await readFile(path.join(root, original.id, "revisions", `${original.revision}.md`), "utf8"), "first");
  const second = await wiki.update({ actor: "owner", id: original.id, expectedRevision: original.revision, content: "second" });
  await assert.rejects(wiki.update({ actor: "owner", id: original.id, expectedRevision: original.revision, content: "lost" }), { code: "CONFLICT" });
  assert.equal((await wiki.history({ actor: "owner", id: original.id })).length, 2);
  const restored = await wiki.restore({ actor: "owner", id: original.id, revision: original.revision, expectedRevision: second.revision });
  assert.equal((await wiki.read({ actor: "owner", id: original.id })).content, "first");
  const reopened = await openWiki({ root, authorize: async () => true });
  assert.equal((await reopened.read({ actor: "owner", id: original.id, revision: second.revision })).content, "second");
  assert.notEqual(restored.revision, original.revision);
});

test("concurrent updates across handles with same expected revision yield one winner", async t => {
  const { root, wiki } = await fixture(t);
  const other = await openWiki({ root, authorize: async () => true });
  const note = await wiki.create({ actor: "owner", content: "base" });
  const results = await Promise.allSettled([
    wiki.update({ actor: "owner", id: note.id, expectedRevision: note.revision, content: "left" }),
    other.update({ actor: "owner", id: note.id, expectedRevision: note.revision, content: "right" })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "CONFLICT");
});

test("search excludes unauthorized notes and requires literal true authorization", async t => {
  let visibleId;
  const { wiki } = await fixture(t, async ({ actor, action, noteId }) => {
    if (actor === "malformed") return { allowed: true };
    return action !== "read" || noteId === visibleId;
  });
  const visible = await wiki.create({ actor: "owner", content: "shared needle" });
  visibleId = visible.id;
  await wiki.create({ actor: "owner", content: "private needle" });
  assert.deepEqual((await wiki.search({ actor: "owner", query: "needle" })).map(x => x.id), [visible.id]);
  await assert.rejects(wiki.search({ actor: "malformed", query: "needle" }), { code: "FORBIDDEN" });
  await assert.rejects(wiki.create({ actor: "malformed", content: "x" }), { code: "FORBIDDEN" });
});

test("rejects oversized content and query", async t => {
  const { wiki } = await fixture(t), note = await wiki.create({ actor: "a", content: "ok" });
  await assert.rejects(wiki.update({ actor: "a", id: note.id, expectedRevision: note.revision, content: "x".repeat(1_000_001) }), { code: "INVALID_CONTENT" });
  await assert.rejects(wiki.search({ actor: "a", query: "x".repeat(257) }), { code: "INVALID_QUERY" });
});

test("competing process writer lock fails closed and stale lock is never removed", async t => {
  const { root, wiki } = await fixture(t);
  const note = await wiki.create({ actor: "owner", content: "base" });
  const lock = await open(path.join(root, note.id, "WRITE.lock"), "wx", 0o600);
  try {
    await assert.rejects(wiki.update({ actor: "owner", id: note.id, expectedRevision: note.revision, content: "contender" }), { code: "WRITE_BUSY" });
    assert.equal(await readFile(path.join(root, note.id, "CURRENT"), "utf8"), `${note.revision}\n`);
    await readFile(path.join(root, note.id, "WRITE.lock"));
  } finally { await lock.close(); }
});

test("rejects symlink CURRENT and revisions directory", async t => {
  const { root, wiki } = await fixture(t);
  const note = await wiki.create({ actor: "owner", content: "safe" });
  const dir = path.join(root, note.id), outside = await mkdtemp(path.join(os.tmpdir(), "wiki-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rename(path.join(dir, "revisions"), path.join(dir, "revisions.real"));
  await symlink(outside, path.join(dir, "revisions"));
  await assert.rejects(wiki.update({ actor: "owner", id: note.id, expectedRevision: note.revision, content: "escape" }), { code: "UNSAFE_PATH" });
  await unlink(path.join(dir, "CURRENT"));
  await symlink(path.join(outside, "pointer"), path.join(dir, "CURRENT"));
  await assert.rejects(wiki.read({ actor: "owner", id: note.id }), { code: "UNSAFE_PATH" });
});

test("requires authorizer and rejects symlink note paths", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aylachi-wiki-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(openWiki({ root }), { code: "INVALID_CONFIG" });
  const outside = await mkdtemp(path.join(os.tmpdir(), "aylachi-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const wiki = await openWiki({ root, authorize: async () => true });
  const id = "00000000-0000-0000-0000-000000000001";
  await symlink(outside, path.join(root, id));
  await assert.rejects(wiki.read({ actor: "owner", id }), { code: "UNSAFE_PATH" });
});
