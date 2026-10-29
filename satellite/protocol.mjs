import { createHash } from 'node:crypto';

export const SATELLITE_PROTOCOL_VERSION = 1;
export const SATELLITE_STATES = Object.freeze(['PENDING_APPROVAL', 'QUEUED', 'LEASED', 'RUNNING', 'UNKNOWN', 'SUCCEEDED', 'FAILED']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CAPABILITY = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const KINDS = new Set(['native', 'headless', 'browser-extension']);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'UNKNOWN']);
export const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function exact(value, required, optional = []) {
  if (!plain(value)) throw bad('INVALID_REQUEST');
  const keys = Reflect.ownKeys(value), allowed = new Set([...required, ...optional]);
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key))) throw bad('INVALID_REQUEST');
  return value;
}
export function id(value) { if (typeof value !== 'string' || !ID.test(value)) throw bad('INVALID_REQUEST'); return value; }
export function time(value) { if (!Number.isSafeInteger(value) || value < 0) throw bad('INVALID_REQUEST'); return value; }
export function code(value) { if (typeof value !== 'string' || !CODE.test(value)) throw bad('INVALID_REQUEST'); return value; }
export function json(value, limit = 64 * 1024) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw bad('INVALID_REQUEST'); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > limit) throw bad('INVALID_REQUEST');
  return encoded;
}
export function payload(value) {
  if (!plain(value)) throw bad('INVALID_REQUEST');
  return JSON.parse(json(value, 16 * 1024));
}
export function payloadHash(value) { return createHash('sha256').update(json(value, 16 * 1024), 'utf8').digest('hex'); }
function hash(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw bad('INVALID_REQUEST'); return value; }
function capabilities(value) {
  if (!Array.isArray(value) || value.length > 16 || value.some(item => typeof item !== 'string' || !CAPABILITY.test(item)) || new Set(value).size !== value.length) throw bad('INVALID_MANIFEST');
  return Object.freeze([...value]);
}
function schema(value) {
  if (!plain(value)) throw bad('INVALID_MANIFEST');
  return JSON.parse(json(value, 16 * 1024));
}
export function toolDescriptor(value) {
  exact(value, ['name', 'title', 'inputSchema', 'outputSchema', 'sideEffect', 'idempotent', 'requiresApproval', 'capabilities']);
  id(value.name);
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120 ||
      typeof value.sideEffect !== 'boolean' || typeof value.idempotent !== 'boolean' || typeof value.requiresApproval !== 'boolean' ||
      value.requiresApproval && !value.sideEffect) throw bad('INVALID_MANIFEST');
  return Object.freeze({ name: value.name, title: value.title, inputSchema: schema(value.inputSchema), outputSchema: schema(value.outputSchema),
    sideEffect: value.sideEffect, idempotent: value.idempotent, requiresApproval: value.requiresApproval, capabilities: capabilities(value.capabilities) });
}
export function connectorManifest(value) {
  exact(value, ['id', 'kind', 'version', 'tools']);
  id(value.id);
  if (!KINDS.has(value.kind) || typeof value.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.version) ||
      !Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 32) throw bad('INVALID_MANIFEST');
  const tools = value.tools.map(toolDescriptor);
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw bad('INVALID_MANIFEST');
  return Object.freeze({ id: value.id, kind: value.kind, version: value.version, tools: Object.freeze(tools) });
}
export function satelliteManifest(value) {
  exact(value, ['protocolVersion', 'satelliteId', 'connectors']);
  id(value.satelliteId);
  if (value.protocolVersion !== SATELLITE_PROTOCOL_VERSION || !Array.isArray(value.connectors) || value.connectors.length < 1 || value.connectors.length > 16) throw bad('INVALID_MANIFEST');
  const connectors = value.connectors.map(connectorManifest), tools = connectors.flatMap(connector => connector.tools);
  if (new Set(connectors.map(connector => connector.id)).size !== connectors.length || new Set(tools.map(tool => tool.name)).size !== tools.length) throw bad('INVALID_MANIFEST');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024) throw bad('INVALID_MANIFEST', 413);
  return Object.freeze({ protocolVersion: SATELLITE_PROTOCOL_VERSION, satelliteId: value.satelliteId, connectors: Object.freeze(connectors) });
}
export function leaseSnapshot(value) {
  exact(value, ['commandId', 'leaseId', 'fencingToken', 'toolName', 'payload', 'idempotencyKey', 'descriptor']);
  for (const key of ['commandId', 'leaseId', 'toolName', 'idempotencyKey']) id(value[key]);
  if (!Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) throw bad('INVALID_REQUEST');
  return Object.freeze({ commandId: value.commandId, leaseId: value.leaseId, fencingToken: value.fencingToken,
    toolName: value.toolName, payload: payload(value.payload), idempotencyKey: value.idempotencyKey, descriptor: toolDescriptor(value.descriptor) });
}
export function outcomeSnapshot(value) {
  exact(value, ['state'], ['result', 'reasonCode']);
  if (!TERMINAL.has(value.state)) throw bad('INVALID_REQUEST');
  if (value.state === 'SUCCEEDED') return Object.freeze({ state: value.state, result: JSON.parse(json(value.result, 64 * 1024)) });
  code(value.reasonCode);
  if (value.result !== undefined) throw bad('INVALID_REQUEST');
  return Object.freeze({ state: value.state, reasonCode: value.reasonCode });
}
export function publicCommand(row) {
  if (!row) return null;
  return Object.freeze({ id: row.id, actor: row.actor, requestId: row.request_id, connectorId: row.connector_id,
    toolName: row.tool_name, payload: JSON.parse(row.payload_json), payloadHash: row.payload_hash, state: row.state,
    attempt: row.attempt, result: row.result_json === null ? null : JSON.parse(row.result_json), reasonCode: row.reason_code,
    createdAt: row.created_at, updatedAt: row.updated_at });
}
export function requireHash(value) { return hash(value); }
