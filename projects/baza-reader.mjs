import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);
const PYTHON = '/usr/bin/python3';
const HELPER = '/home/ayla/.pi/agent/scripts/ayla_pi_baza.py';
const BAZA_ROOT = '10 Проекты/';
const MAX_PATH_BYTES = 1024;
const MAX_READ_BYTES = 128 * 1024;
const MAX_CONTEXT_BYTES = 32 * 1024;
const MAX_NOTES = 3;
const MAX_QUERY_CHARS = 200;
const EXEC_TIMEOUT_MS = 15_000;
const EXEC_MAX_BUFFER = 1024 * 1024;
const ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPTION_KEYS = new Set(['projectId', 'bazaPrefix', 'notePaths', 'enabled', 'execFileForTest']);

function error(code) {
  return new Error(code);
}

function controls(value) {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function readOptions(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error('INVALID_BAZA_READER_CONFIG');
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !OPTION_KEYS.has(key))) throw error('INVALID_BAZA_READER_CONFIG');
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) throw error('INVALID_BAZA_READER_CONFIG');
      result[key] = descriptor.value;
    }
    for (const key of ['projectId', 'bazaPrefix', 'notePaths']) {
      if (!Object.hasOwn(result, key)) throw error('INVALID_BAZA_READER_CONFIG');
    }
    return result;
  } catch (cause) {
    if (cause?.message === 'INVALID_BAZA_READER_CONFIG') throw cause;
    throw error('INVALID_BAZA_READER_CONFIG');
  }
}

function validPrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix.startsWith(BAZA_ROOT) || !prefix.endsWith('/') ||
      prefix.includes('\\') || controls(prefix)) return false;
  const parts = prefix.slice(0, -1).split('/');
  return parts.length === 2 && parts[0] === '10 Проекты' && parts[1] !== '' &&
    parts[1] !== '.' && parts[1] !== '..' && !parts[1].startsWith('.');
}

function validPath(path, prefix) {
  if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES ||
      path.includes('\\') || controls(path) || path.startsWith('/') || !path.startsWith(prefix) ||
      !path.endsWith('.md')) return false;
  const parts = path.split('/');
  return parts.length > 2 && parts.every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'));
}

function readNotePaths(value, prefix) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_NOTES) {
      throw error('INVALID_BAZA_READER_CONFIG');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length') ||
        Array.from({ length: value.length }, (_, index) => String(index)).some(key => !keys.includes(key))) {
      throw error('INVALID_BAZA_READER_CONFIG');
    }
    const paths = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value') || !validPath(descriptor.value, prefix)) {
        throw error('INVALID_BAZA_READER_CONFIG');
      }
      if (paths.includes(descriptor.value)) throw error('INVALID_BAZA_READER_CONFIG');
      paths.push(descriptor.value);
    }
    return Object.freeze(paths);
  } catch (cause) {
    if (cause?.message === 'INVALID_BAZA_READER_CONFIG') throw cause;
    throw error('INVALID_BAZA_READER_CONFIG');
  }
}

function readHelperReply(stdout, expectedPath) {
  let reply;
  try { reply = JSON.parse(stdout); }
  catch { throw error('INVALID_BAZA_RESPONSE'); }
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply) ||
      Object.getPrototypeOf(reply) !== Object.prototype ||
      Reflect.ownKeys(reply).length !== 3 ||
      !['path', 'content', 'sha256'].every(key => Object.hasOwn(reply, key)) ||
      reply.path !== expectedPath || typeof reply.content !== 'string' ||
      typeof reply.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reply.sha256)) {
    throw error('INVALID_BAZA_RESPONSE');
  }
  const contentBytes = Buffer.from(reply.content, 'utf8');
  if (contentBytes.toString('utf8') !== reply.content || contentBytes.byteLength > MAX_READ_BYTES ||
      createHash('sha256').update(contentBytes).digest('hex') !== reply.sha256) {
    throw error('INVALID_BAZA_RESPONSE');
  }
  return { path: expectedPath, text: reply.content };
}

function validQuery(query) {
  return typeof query === 'string' && query.trim().length > 0 && Array.from(query).length <= MAX_QUERY_CHARS;
}

// Reads only an explicitly bound allowlist. Query is advisory, not FTS; add a scoped search RPC if needed.
export function createBazaReader(options) {
  const config = readOptions(options);
  const { projectId, bazaPrefix } = config;
  if (typeof projectId !== 'string' || !ID.test(projectId) || !validPrefix(bazaPrefix)) {
    throw error('INVALID_BAZA_READER_CONFIG');
  }
  const notePaths = readNotePaths(config.notePaths, bazaPrefix);
  const enabled = config.enabled ?? false;
  if (typeof enabled !== 'boolean' ||
      (config.execFileForTest !== undefined && typeof config.execFileForTest !== 'function')) {
    throw error('INVALID_BAZA_READER_CONFIG');
  }
  const run = config.execFileForTest ?? execFile;

  return Object.freeze({
    async readProjectContext(requestedProjectId, query, signal) {
      if (!enabled) throw error('BAZA_READER_DISABLED');
      if (requestedProjectId !== projectId) throw error('PROJECT_SCOPE_MISMATCH');
      if (!validQuery(query)) throw error('INVALID_QUERY');
      if (signal?.aborted === true) throw error('ABORTED');

      const excerpts = [];
      for (const path of notePaths) {
        if (signal?.aborted === true) throw error('ABORTED');
        const encoded = Buffer.from(JSON.stringify({ path }), 'utf8').toString('base64');
        let result;
        try {
          result = await run(PYTHON, [HELPER, 'read', encoded], {
            cwd: '/', env: ENV, encoding: 'utf8', timeout: EXEC_TIMEOUT_MS,
            maxBuffer: EXEC_MAX_BUFFER, signal, shell: false,
          });
        } catch {
          throw error(signal?.aborted === true ? 'ABORTED' : 'BAZA_READ_FAILED');
        }
        if (typeof result?.stdout !== 'string') throw error('INVALID_BAZA_RESPONSE');
        excerpts.push(readHelperReply(result.stdout, path));
      }

      const response = { projectId, excerpts };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_CONTEXT_BYTES) throw error('BAZA_CONTEXT_TOO_LARGE');
      return response;
    },
  });
}
