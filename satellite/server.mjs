import http from 'node:http';
import { isIPv4 } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { bad, exact, id, plain } from './protocol.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const isTailscaleIPv4 = host => {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
};
const hash = value => createHash('sha256').update(value).digest();
function credentialMatches(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const candidate = header.slice(7);
  return candidate.length > 0 && candidate.length <= 4096 && timingSafeEqual(hash(candidate), hash(expected));
}
function readBody(req, limit = 96 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    const fail = error => { if (!done) { done = true; reject(error); } };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) return fail(bad('BODY_TOO_LARGE', 413));
      if (!done) chunks.push(chunk);
    });
    req.on('aborted', () => fail(bad('REQUEST_ABORTED')));
    req.on('error', () => fail(bad('REQUEST_ABORTED')));
    req.on('end', () => {
      if (done) return; done = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!plain(value)) throw bad('INVALID_REQUEST');
        resolve(value);
      } catch (error) { reject(error?.status ? error : bad('INVALID_JSON')); }
    });
  });
}
function respond(res, status, value) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-length': body.length });
  res.end(body);
}
function publicError(error) {
  if (error?.code === 'UNAUTHORIZED') return { status: 401, error: 'UNAUTHORIZED' };
  if (['SATELLITE_REVOKED', 'CONNECTOR_NOT_APPROVED', 'ORIGIN_REJECTED', 'FORBIDDEN_HOST'].includes(error?.code)) return { status: 403, error: error.code };
  if (['SESSION_STALE', 'LEASE_CONFLICT', 'TOOL_ALREADY_REGISTERED', 'SATELLITE_OFFLINE', 'REQUEST_ID_CONFLICT', 'EFFECT_CONFLICT'].includes(error?.code)) return { status: 409, error: error.code };
  if (['NOT_FOUND', 'SATELLITE_NOT_FOUND'].includes(error?.code)) return { status: 404, error: 'NOT_FOUND' };
  if (error?.status === 413 || error?.code === 'BODY_TOO_LARGE') return { status: 413, error: 'TOO_LARGE' };
  if (error?.status === 400 || ['INVALID_REQUEST', 'INVALID_JSON', 'INVALID_MANIFEST', 'BAD_HOST'].includes(error?.code)) return { status: 400, error: error.code === 'INVALID_MANIFEST' ? 'INVALID_MANIFEST' : 'INVALID_REQUEST' };
  return { status: 500, error: 'INTERNAL_ERROR' };
}

// Separate service credential and HTTP surface: a Satellite never receives the
// user/Desktop bearer or module-route authority.
export function createSatelliteServer({ plane, registrations } = {}) {
  if (!plane || !Array.isArray(registrations) || !registrations.length) throw new TypeError('satellite plane and registrations required');
  const identities = new Map();
  for (const registration of registrations) {
    exact(registration, ['id', 'secret', 'tools', 'capabilities']); id(registration.id);
    if (typeof registration.secret !== 'string' || registration.secret.length < 32 || registration.secret.length > 4096 || identities.has(registration.id)) throw new TypeError('invalid satellite credential');
    identities.set(registration.id, registration.secret);
  }
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(error => { const mapped = publicError(error); respond(res, mapped.status, { error: mapped.error }); });
  });
  let closePromise, acceptedHost;
  async function handle(req, res) {
    if (req.method !== 'POST') throw bad('INVALID_REQUEST');
    if (req.headers.origin !== undefined) throw bad('ORIGIN_REJECTED', 403);
    let hostname;
    try { hostname = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, ''); } catch { throw bad('BAD_HOST'); }
    if (!LOOPBACK.has(hostname) && hostname !== acceptedHost) throw bad('FORBIDDEN_HOST', 403);
    const match = req.url.match(/^\/v1\/satellite\/(handshake|heartbeat|poll|ack|complete|event)$/);
    if (!match) throw bad('NOT_FOUND', 404);
    const body = await readBody(req);
    if (typeof body.satelliteId !== 'string' || !identities.has(body.satelliteId)) throw bad('UNAUTHORIZED', 401);
    if (!credentialMatches(req.headers.authorization, identities.get(body.satelliteId))) throw bad('UNAUTHORIZED', 401);
    const action = match[1];
    const result = action === 'handshake' ? plane.handshake(body)
      : action === 'heartbeat' ? plane.heartbeat(body)
      : action === 'poll' ? plane.poll(body)
      : action === 'ack' ? plane.ack(body)
      : action === 'complete' ? plane.complete(body)
      : plane.appendEvent(body);
    respond(res, 200, result ?? { ok: true });
  }
  return Object.freeze({
    listen(port = 0, host = '127.0.0.1', { allowRemote = false } = {}) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('valid port required');
      if (!LOOPBACK.has(host)) {
        if (!allowRemote) throw new TypeError('REMOTE_BIND_DISABLED');
        if (!isTailscaleIPv4(host)) throw new TypeError('REMOTE_BIND_REQUIRES_TAILSCALE_IPV4');
      }
      acceptedHost = host;
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
      });
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closePromise;
    },
  });
}
