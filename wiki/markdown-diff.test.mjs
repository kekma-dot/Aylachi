import test from "node:test";
import assert from "node:assert/strict";
import { diffMarkdown } from "./markdown-diff.mjs";
import { openWiki } from "./wiki.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function apply(before, changes) {
  const lines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (const { start, remove, insert } of changes) lines.splice(start, remove.length, ...insert);
  return lines.join("");
}

test("diff reconstructs empty, identical, insert, delete and replacement", () => {
  for (const [before, after] of [["", "x"], ["x", ""], ["a\nb", "a\nb"], ["a\nb", "a\nc"], ["a\nb", "a\nb\nc"]]) {
    const diff = diffMarkdown(before, after);
    assert.equal(apply(before, diff), after);
    if (before === after) assert.deepEqual(diff, []);
  }
});

test("coalesces disjoint changes into one block", () => {
  const before = "one\ntwo\nthree\nfour\n", after = "ONE\ntwo\nthree\nFOUR\n";
  const diff = diffMarkdown(before, after);
  assert.equal(diff.length, 1);
  assert.equal(apply(before, diff), after);
});

test("preserves CRLF, trailing newline and Unicode", () => {
  for (const [before, after] of [["a\r\nb\r\n", "a\r\nc\r\n"], ["line", "line\n"], ["🙂\n旧", "🙂\n新\n"]]) {
    assert.equal(apply(before, diffMarkdown(before, after)), after);
  }
});

test("rejects non-strings and inputs over the wiki byte limit", () => {
  assert.throws(() => diffMarkdown(null, ""), { code: "INVALID_CONTENT" });
  assert.throws(() => diffMarkdown("x".repeat(1_000_001), ""), { code: "INVALID_CONTENT" });
  assert.throws(() => diffMarkdown("", "🙂".repeat(250_001)), { code: "INVALID_CONTENT" });
});

async function fixture(t, authorize = async () => true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, wiki: await openWiki({ root, authorize }) };
}

test("Wiki diff authorizes both revisions, reconstructs, and does not write; history/restore work", async t => {
  const reads = [];
  const { root, wiki } = await fixture(t, async ({ action, noteId }) => {
    if (action === "read") reads.push(noteId);
    return true;
  });
  const first = await wiki.create({ actor: "owner", content: "before\r\n🙂" });
  const second = await wiki.update({ actor: "owner", id: first.id, expectedRevision: first.revision, content: "after\r\n🙂" });
  const historyBefore = await wiki.history({ actor: "owner", id: first.id });
  const currentBefore = await readFile(path.join(root, first.id, "CURRENT"), "utf8");
  reads.length = 0;
  const changes = await wiki.diff({ actor: "owner", id: first.id, fromRevision: first.revision, toRevision: second.revision });
  assert.deepEqual(reads, [first.id, first.id]);
  assert.deepEqual(apply("before\r\n🙂", changes), "after\r\n🙂");
  assert.deepEqual(await wiki.history({ actor: "owner", id: first.id }), historyBefore);
  assert.equal(await readFile(path.join(root, first.id, "CURRENT"), "utf8"), currentBefore);
  const restored = await wiki.restore({ actor: "owner", id: first.id, revision: first.revision, expectedRevision: second.revision });
  assert.equal((await wiki.read({ actor: "owner", id: first.id })).content, "before\r\n🙂");
  assert.notEqual(restored.revision, second.revision);
});

test("Wiki diff validates note and revision IDs", async t => {
  const { wiki } = await fixture(t);
  await assert.rejects(wiki.diff({ actor: "owner", id: "bad", fromRevision: "bad", toRevision: "bad" }), { code: "INVALID_ID" });
  const first = await wiki.create({ actor: "owner", content: "x" });
  await assert.rejects(wiki.diff({ actor: "owner", id: first.id, fromRevision: "bad", toRevision: first.revision }), { code: "INVALID_REVISION" });
});

test("Wiki diff rejects access denied on its second revision read", async t => {
  let readCount = 0;
  const { wiki } = await fixture(t, async ({ action }) => action !== "read" || ++readCount === 1);
  const first = await wiki.create({ actor: "owner", content: "before" });
  const second = await wiki.update({ actor: "owner", id: first.id, expectedRevision: first.revision, content: "after" });
  readCount = 0;
  await assert.rejects(wiki.diff({ actor: "owner", id: first.id, fromRevision: first.revision, toRevision: second.revision }), { code: "FORBIDDEN" });
  assert.equal(readCount, 2);
});
