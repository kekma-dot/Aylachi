import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { bad, exact, id } from './protocol.mjs';

const TEXT_SCHEMA = { type: 'object', additionalProperties: false };
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);

export function createNativeConnector({ root } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('native workspace root required');
  const manifest = { id: 'native-workspace', kind: 'native', version: '1.0.0', tools: [{
    name: 'native.workspace.read', title: 'Read workspace text', sideEffect: false, idempotent: true, requiresApproval: false,
    capabilities: ['workspace.read'],
    inputSchema: { ...TEXT_SCHEMA, properties: { path: { type: 'string' } }, required: ['path'] },
    outputSchema: { ...TEXT_SCHEMA, properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] },
  }] };
  return Object.freeze({ manifest, async execute({ payload }) {
    exact(payload, ['path']);
    if (typeof payload.path !== 'string' || !payload.path || payload.path.length > 1024 || payload.path.includes('\0')) throw bad('INVALID_PATH');
    const trustedRoot = await realpath(root), filename = await realpath(resolve(trustedRoot, payload.path));
    const metadata = await stat(filename);
    if (!inside(trustedRoot, filename) || !metadata.isFile()) throw bad('PATH_DENIED', 403);
    if (metadata.size > 64 * 1024) throw bad('TOO_LARGE', 413);
    const text = await readFile(filename, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw bad('TOO_LARGE', 413);
    return { path: payload.path, text };
  } });
}

export function createHeadlessConnector({ allowedHosts } = {}) {
  if (!Array.isArray(allowedHosts) || !allowedHosts.length || allowedHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host))) throw new TypeError('headless allowed hosts required');
  const hosts = new Set(allowedHosts.map(host => host.toLowerCase()));
  const manifest = { id: 'headless-http', kind: 'headless', version: '1.0.0', tools: [{
    name: 'headless.http.fetch', title: 'Fetch allowlisted HTTP resource', sideEffect: false, idempotent: true, requiresApproval: false,
    capabilities: ['http.fetch'],
    inputSchema: { ...TEXT_SCHEMA, properties: { url: { type: 'string' } }, required: ['url'] },
    outputSchema: { ...TEXT_SCHEMA, properties: { status: { type: 'integer' }, contentType: { type: 'string' }, text: { type: 'string' } }, required: ['status', 'contentType', 'text'] },
  }] };
  return Object.freeze({ manifest, async execute({ payload, signal }) {
    exact(payload, ['url']);
    let url;
    try { url = new URL(payload.url); } catch { throw bad('INVALID_URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || !hosts.has(url.hostname.toLowerCase()) || url.username || url.password) throw bad('URL_DENIED', 403);
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal, headers: { accept: 'text/plain,text/markdown,application/json' } });
    if (Number(response.headers.get('content-length')) > 64 * 1024) { await response.body?.cancel(); throw bad('TOO_LARGE', 413); }
    const reader = response.body?.getReader();
    if (!reader) throw bad('INVALID_RESPONSE');
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); throw bad('TOO_LARGE', 413); }
      chunks.push(value);
    }
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', text: Buffer.concat(chunks).toString('utf8') };
  } });
}

// The extension bridge is an isolated adapter, not a Hub credential boundary.
// It receives only an explicitly granted tab ID and a bounded command.
export function createBrowserExtensionConnector({ bridge } = {}) {
  if (typeof bridge?.extractText !== 'function') throw new TypeError('browser extension bridge required');
  const manifest = { id: 'browser-extension', kind: 'browser-extension', version: '1.0.0', tools: [{
    name: 'browser.page.extract', title: 'Extract granted tab text', sideEffect: false, idempotent: true, requiresApproval: false,
    capabilities: ['browser.read'],
    inputSchema: { ...TEXT_SCHEMA, properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    outputSchema: { ...TEXT_SCHEMA, properties: { tabId: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } }, required: ['tabId', 'title', 'text'] },
  }] };
  return Object.freeze({ manifest, async execute({ payload, commandId, signal }) {
    exact(payload, ['tabId']); id(payload.tabId);
    const result = await bridge.extractText({ tabId: payload.tabId, requestId: commandId, signal });
    exact(result, ['tabId', 'title', 'text']);
    if (result.tabId !== payload.tabId || typeof result.title !== 'string' || result.title.length > 4096 ||
        typeof result.text !== 'string' || Buffer.byteLength(result.text, 'utf8') > 64 * 1024) throw bad('INVALID_EXTENSION_RESULT');
    return result;
  } });
}
