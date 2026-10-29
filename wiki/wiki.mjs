import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, lstat, link, unlink } from "node:fs/promises";
import path from "node:path";
import { diffMarkdown } from "./markdown-diff.mjs";

const fail = (code, message) => Object.assign(new Error(message), { code });
const validId = value => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
const safeQuery = value => typeof value === "string" && Buffer.byteLength(value, "utf8") <= 256;
const locks = new Map();
const limits = { contentBytes: 1_000_000, queryBytes: 256 };
async function withLock(key, fn) {
  const prior = locks.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = prior.then(() => gate);
  locks.set(key, tail);
  await prior;
  try { return await fn(); }
  finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}

// Markdown originals are authoritative. Trust the Wiki root against hostile external filesystem races.
export async function openWiki({ root, authorize } = {}) {
  if (!root || typeof authorize !== "function") throw fail("INVALID_CONFIG", "root and authorize callback required");
  const base = path.resolve(root);
  await mkdir(base, { recursive: true, mode: 0o700 });
  if ((await lstat(base)).isSymbolicLink()) throw fail("UNSAFE_PATH", "Wiki root cannot be symlink");
  const permit = async (actor, action, noteId) => {
    if (await authorize({ actor, action, noteId }) !== true) throw fail("FORBIDDEN", "Wiki access denied");
  };
  const checkedDir = async dir => {
    if ((await lstat(dir)).isSymbolicLink()) throw fail("UNSAFE_PATH", "Directory symlink rejected");
  };
  const noteDir = async id => {
    if (!validId(id)) throw fail("INVALID_ID", "Invalid note ID");
    const dir = path.join(base, id);
    try { await checkedDir(dir); } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    return dir;
  };
  const openRegular = async file => {
    const st = await lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) throw fail("UNSAFE_PATH", "Expected regular file");
    return open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  };
  const current = async dir => {
    await checkedDir(dir);
    const file = path.join(dir, "CURRENT"), handle = await openRegular(file);
    let text;
    try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
    const revision = text.trim();
    if (!validId(revision)) throw fail("CORRUPT", "Invalid revision pointer");
    return revision;
  };
  const readRevision = async (dir, revision) => {
    if (!validId(revision)) throw fail("INVALID_REVISION", "Invalid revision ID");
    await checkedDir(dir);
    const revisions = path.join(dir, "revisions");
    await checkedDir(revisions);
    const handle = await openRegular(path.join(revisions, `${revision}.md`));
    try { return await handle.readFile("utf8"); } finally { await handle.close(); }
  };
  const syncDir = async dir => {
    if (process.platform !== "linux") throw fail("UNSUPPORTED_DURABILITY", "Directory fsync is only qualified on Linux");
    const handle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const writeRevision = async (dir, content) => {
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > limits.contentBytes) throw fail("INVALID_CONTENT", "Markdown content exceeds size limit");
    await checkedDir(dir);
    const revisions = path.join(dir, "revisions");
    await mkdir(revisions, { recursive: true, mode: 0o700 });
    await checkedDir(revisions);
    const revision = randomUUID(), handle = await open(path.join(revisions, `${revision}.md`), "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await syncDir(revisions);
    return revision;
  };
  const setCurrent = async (dir, revision, creating = false) => {
    await checkedDir(dir);
    const temp = path.join(dir, `.CURRENT-${randomUUID()}`), handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(`${revision}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    try {
      if (creating) await link(temp, path.join(dir, "CURRENT"));
      else await rename(temp, path.join(dir, "CURRENT"));
      await syncDir(dir);
    } finally { await unlink(temp).catch(() => {}); }
  };
  const updateLock = async (dir, fn) => {
    const lockPath = path.join(dir, "WRITE.lock"), token = randomUUID();
    let handle;
    try { handle = await open(lockPath, "wx", 0o600); }
    catch (cause) {
      if (cause.code === "EEXIST") throw fail("WRITE_BUSY", "Writer lock exists; explicit reconciliation required");
      throw cause;
    }
    let owned = true;
    try {
      await handle.writeFile(`${process.pid} ${token}\n`, "utf8");
      await handle.sync();
      await syncDir(dir);
      return await fn();
    } finally {
      await handle.close();
      if (owned) {
        const currentLock = await openRegular(lockPath);
        let lockText;
        try { lockText = await currentLock.readFile("utf8"); } finally { await currentLock.close(); }
        if (lockText !== `${process.pid} ${token}\n`) throw fail("LOCK_OWNERSHIP", "Writer lock ownership changed; lock retained");
        await unlink(lockPath);
        await syncDir(dir);
      }
    }
  };

  async function create({ actor, content }) {
    await permit(actor, "create", null);
    const id = randomUUID(), dir = await noteDir(id);
    await mkdir(dir, { mode: 0o700 });
    const revision = await writeRevision(dir, content);
    await setCurrent(dir, revision, true);
    return { id, revision };
  }
  async function read({ actor, id, revision }) {
    await permit(actor, "read", id);
    const dir = await noteDir(id), selected = revision ?? await current(dir);
    return { id, revision: selected, content: await readRevision(dir, selected) };
  }
  async function update({ actor, id, expectedRevision, content }) {
    await permit(actor, "write", id);
    return withLock(`${base}:${id}`, async () => {
      const dir = await noteDir(id);
      return updateLock(dir, async () => {
        const previous = await current(dir);
        if (previous !== expectedRevision) throw fail("CONFLICT", "Revision conflict");
        const revision = await writeRevision(dir, content);
        await setCurrent(dir, revision);
        return { id, revision };
      });
    });
  }
  async function diff({ actor, id, fromRevision, toRevision }) {
    const from = await read({ actor, id, revision: fromRevision });
    const to = await read({ actor, id, revision: toRevision });
    return diffMarkdown(from.content, to.content);
  }
  async function history({ actor, id }) {
    await permit(actor, "read", id);
    const dir = await noteDir(id);
    await checkedDir(path.join(dir, "revisions"));
    return (await readdir(path.join(dir, "revisions"))).filter(name => /^[a-f0-9-]{36}\.md$/i.test(name)).map(name => name.slice(0, -3));
  }
  async function restore({ actor, id, revision, expectedRevision }) {
    const selected = await read({ actor, id, revision });
    return update({ actor, id, expectedRevision, content: selected.content });
  }
  async function search({ actor, query = "" }) {
    await permit(actor, "search", null);
    if (!safeQuery(query)) throw fail("INVALID_QUERY", "Query exceeds size limit");
    const found = [];
    for (const id of await readdir(base)) {
      if (!validId(id)) continue;
      try { await permit(actor, "read", id); } catch (cause) { if (cause.code === "FORBIDDEN") continue; throw cause; }
      const dir = await noteDir(id);
      let revision;
      try { revision = await current(dir); } catch (cause) { if (cause.code === "ENOENT") continue; throw cause; }
      const content = await readRevision(dir, revision);
      if (content.toLocaleLowerCase().includes(query.toLocaleLowerCase())) found.push({ id, revision });
    }
    return found;
  }
  async function links({ actor, id }) {
    const note = await read({ actor, id });
    return [...new Set([...note.content.matchAll(/\[\[([a-f0-9-]{36})\]\]/gi)].map(match => match[1]))];
  }
  return Object.freeze({ create, read, update, history, restore, search, links, diff });
}
