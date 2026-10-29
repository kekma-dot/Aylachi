import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { snapshotRestoredSessionFiles } from '../agent-host/pi-adapter.mjs';

export const RESTORED_SESSION_FILES_NAME = '.restored-session-files.json';
const MAX_BYTES = 32_768;
const invalid = () => Object.assign(new Error('RESTORED_SESSION_FILES_INVALID'), { code: 'RESTORED_SESSION_FILES_INVALID' });

export async function loadRestoredSessionFiles(root) {
  try {
    if (typeof process.getuid !== 'function' || typeof root !== 'string' || !root.startsWith('/') || resolve(root) !== root) throw invalid();
    const canonical = await realpath(root);
    const rootStat = await lstat(root);
    if (canonical !== root || !rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o777) !== 0o700) throw invalid();
    const path = join(root, RESTORED_SESSION_FILES_NAME);
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > MAX_BYTES) throw invalid();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.nlink !== 1 || opened.uid !== process.getuid() || (opened.mode & 0o777) !== 0o600 || opened.size > MAX_BYTES) throw invalid();
      bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw invalid();
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.nlink !== 1) throw invalid();
    } finally { await handle.close(); }
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'format') || !Object.hasOwn(parsed, 'sessions') || parsed.format !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) throw invalid();
    return snapshotRestoredSessionFiles(parsed.sessions);
  } catch {
    throw invalid();
  }
}
