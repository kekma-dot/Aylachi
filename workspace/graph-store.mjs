import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const KINDS = new Set(['chat', 'wiki', 'artifact', 'browser', 'theme', 'plugin']);
const SCOPES = new Set(['node', 'branch', 'all']);
const STATES = new Set(['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']);
const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const object = value => value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const id = value => { if (typeof value !== 'string' || !ID.test(value)) throw bad('INVALID_ID'); return value; };
const finite = value => { if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) throw bad('INVALID_LAYOUT'); return value; };
const size = (width, height) => { if (!Number.isFinite(width) || width < 320 || width > 1200 || !Number.isFinite(height) || height < 360 || height > 1200) throw bad('INVALID_LAYOUT'); };
const title = value => { if (typeof value !== 'string' || !value.trim() || value.length > 120) throw bad('INVALID_TITLE'); return value.trim(); };
const content = value => { if (typeof value !== 'string' || Buffer.byteLength(value) > 64 * 1024) throw bad('INVALID_CONTENT'); return value; };
function pluginSettings(value, refId) {
  if (!object(value) || Object.keys(value).some(key => !['toolName', 'input', 'ports'].includes(key)) ||
      value.toolName !== refId || !object(value.input) || Buffer.byteLength(JSON.stringify(value.input)) > 64 * 1024) throw bad('INVALID_NODE_SETTINGS');
  const ports = value.ports ?? [{ id: 'input', direction: 'input', dataType: 'json' }, { id: 'output', direction: 'output', dataType: 'json' }];
  if (!Array.isArray(ports) || !ports.length || ports.length > 16) throw bad('INVALID_NODE_SETTINGS');
  const seen = new Set();
  for (const port of ports) {
    if (!object(port) || Object.keys(port).length !== 3 || !ID.test(port.id ?? '') || !['input', 'output'].includes(port.direction) ||
        !ID.test(port.dataType ?? '') || seen.has(port.id)) throw bad('INVALID_NODE_SETTINGS');
    seen.add(port.id);
  }
  return { toolName: value.toolName, input: value.input, ports };
}
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const nodeView = row => row && ({ id: row.id, canvasId: row.canvas_id, kind: row.kind, refId: row.ref_id, title: row.title,
  x: row.x, y: row.y, width: row.width, height: row.height, revision: row.revision, settings: parse(row.settings) });
const edgeView = row => row && ({ id: row.id, canvasId: row.canvas_id, sourceNodeId: row.source_node_id, targetNodeId: row.target_node_id, kind: row.kind,
  ...(row.source_port_id === null ? {} : { sourcePortId: row.source_port_id, targetPortId: row.target_port_id, dataType: row.data_type }) });
const runView = row => row && ({ id: row.id, canvasId: row.canvas_id, rootNodeId: row.root_node_id, scope: row.scope, status: row.status, createdAt: row.created_at, completedAt: row.completed_at });
const artifactView = (row, includeContent = false) => row && ({ id: row.id, runId: row.run_id, nodeId: row.node_id, attempt: row.attempt,
  kind: row.kind, refId: row.ref_id, revision: row.revision, state: row.state, metadata: parse(row.metadata), createdAt: row.created_at,
  ...(includeContent ? { content: row.content } : {}) });

export function requiredSubgraph(nodes, edges, targetId, scope) {
  if (!SCOPES.has(scope)) throw bad('INVALID_RUN_SCOPE');
  const ids = new Set(nodes.map(node => node.id));
  if (scope !== 'all' && !ids.has(targetId)) throw bad('NODE_NOT_FOUND', 404);
  if (scope === 'all') return nodes.map(node => node.id);
  if (scope === 'node') return [targetId];
  const incoming = new Map();
  for (const edge of edges) {
    if (!incoming.has(edge.targetNodeId)) incoming.set(edge.targetNodeId, []);
    incoming.get(edge.targetNodeId).push(edge.sourceNodeId);
  }
  const result = new Set(), queue = [targetId];
  while (queue.length) {
    const current = queue.shift();
    if (result.has(current)) continue;
    result.add(current);
    queue.push(...(incoming.get(current) ?? []));
  }
  return nodes.filter(node => result.has(node.id)).map(node => node.id);
}

export function openWorkspaceGraphStore(path, { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS nodes(
      id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
      title TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
      revision INTEGER NOT NULL, settings TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS edges(
      id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, source_node_id TEXT NOT NULL REFERENCES nodes(id),
      target_node_id TEXT NOT NULL REFERENCES nodes(id), kind TEXT NOT NULL,
      UNIQUE(source_node_id,target_node_id,kind));
    CREATE TABLE IF NOT EXISTS runs(
      id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, root_node_id TEXT, scope TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER);
    CREATE TABLE IF NOT EXISTS run_nodes(
      run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL REFERENCES nodes(id), attempt INTEGER NOT NULL,
      status TEXT NOT NULL, input_hash TEXT NOT NULL, PRIMARY KEY(run_id,node_id));
    CREATE TABLE IF NOT EXISTS artifacts(
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL REFERENCES nodes(id),
      attempt INTEGER NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, revision TEXT, content TEXT,
      state TEXT NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  const edgeColumns = new Set(db.prepare('PRAGMA table_info(edges)').all().map(column => column.name));
  for (const column of ['source_port_id', 'target_port_id', 'data_type']) if (!edgeColumns.has(column)) db.exec(`ALTER TABLE edges ADD COLUMN ${column} TEXT`);
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  const getNode = nodeId => nodeView(db.prepare('SELECT * FROM nodes WHERE id=?').get(id(nodeId)));
  const listNodes = canvasId => db.prepare('SELECT * FROM nodes WHERE canvas_id=? ORDER BY rowid').all(id(canvasId)).map(nodeView);
  function createNode(input) {
    if (!object(input)) throw bad('INVALID_NODE');
    const nodeId = id(input.id ?? randomUUID()), canvasId = id(input.canvasId), kind = input.kind;
    if (!KINDS.has(kind) || (kind === 'wiki' && !UUID.test(input.refId)) || (kind !== 'wiki' && !ID.test(input.refId ?? ''))) throw bad('INVALID_NODE');
    let settings = input.settings ?? {};
    if (kind === 'plugin') settings = pluginSettings(settings, input.refId);
    else {
      if (!object(settings) || Object.keys(settings).some(key => !['content', 'format'].includes(key)) ||
          (settings.format !== undefined && !['markdown', 'mermaid', 'html'].includes(settings.format))) throw bad('INVALID_NODE_SETTINGS');
      if (settings.content !== undefined) content(settings.content);
    }
    const width = input.width ?? (kind === 'chat' ? 460 : 520), height = input.height ?? 520;
    finite(input.x); finite(input.y); size(width, height);
    return transaction(() => {
      db.prepare('INSERT INTO nodes(id,canvas_id,kind,ref_id,title,x,y,width,height,revision,settings) VALUES(?,?,?,?,?,?,?,?,?,1,?)')
        .run(nodeId, canvasId, kind, input.refId, title(input.title), input.x, input.y, width, height, json(settings));
      return getNode(nodeId);
    });
  }
  function startRun({ runId = randomUUID(), canvasId, rootNodeId = null, scope, items }) {
    id(runId); id(canvasId); if (rootNodeId !== null) id(rootNodeId);
    if (!SCOPES.has(scope) || !Array.isArray(items) || !items.length || items.length > 100) throw bad('INVALID_RUN');
    return transaction(() => {
      const existing = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
      if (existing) return runView(existing);
      const timestamp = now();
      db.prepare('INSERT INTO runs(id,canvas_id,root_node_id,scope,status,created_at) VALUES(?,?,?,?,?,?)')
        .run(runId, canvasId, rootNodeId, scope, 'RUNNING', timestamp);
      const seen = new Set();
      for (const item of items) {
        if (!object(item) || seen.has(item.nodeId)) throw bad('INVALID_RUN_NODE');
        seen.add(item.nodeId);
        const node = getNode(item.nodeId);
        if (!node || node.canvasId !== canvasId) throw bad('NODE_NOT_FOUND', 404);
        const inputHash = typeof item.inputHash === 'string' && /^[a-f0-9]{64}$/.test(item.inputHash) ? item.inputHash : hash(item.nodeId);
        const attempt = db.prepare('SELECT COALESCE(MAX(attempt),0)+1 AS attempt FROM run_nodes WHERE node_id=?').get(node.id).attempt;
        db.prepare('INSERT INTO run_nodes(run_id,node_id,attempt,status,input_hash) VALUES(?,?,?,?,?)')
          .run(runId, node.id, attempt, 'RUNNING', inputHash);
        if (item.artifact) {
          const artifact = item.artifact;
          if (!object(artifact) || !ID.test(artifact.id ?? '') || !ID.test(artifact.kind ?? '') || !ID.test(artifact.refId ?? '') ||
              !object(artifact.metadata) || Buffer.byteLength(json(artifact.metadata)) > 4096) throw bad('INVALID_ARTIFACT');
          db.prepare('INSERT INTO artifacts(id,run_id,node_id,attempt,kind,ref_id,revision,content,state,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
            .run(artifact.id, runId, node.id, attempt, artifact.kind, artifact.refId, artifact.revision ?? null,
              artifact.content === undefined ? null : content(artifact.content), 'RUNNING', json(artifact.metadata), timestamp);
        }
      }
      return runView(db.prepare('SELECT * FROM runs WHERE id=?').get(runId));
    });
  }
  return {
    createNode,
    getNode,
    getRun(runId) { id(runId); return runView(db.prepare('SELECT * FROM runs WHERE id=?').get(runId)); },
    listNodes,
    syncChatCards(cards) {
      if (!Array.isArray(cards) || cards.length > 100) throw bad('INVALID_CARDS');
      return transaction(() => {
        for (const card of cards) {
          const existing = db.prepare('SELECT * FROM nodes WHERE id=?').get(card.id);
          const settings = '{}';
          if (!existing) db.prepare('INSERT INTO nodes(id,canvas_id,kind,ref_id,title,x,y,width,height,revision,settings) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
            .run(card.id, card.canvasId, 'chat', card.id, card.title, card.x, card.y, card.width ?? 460, card.height ?? 520, card.revision, settings);
          else if (existing.kind !== 'chat' || existing.ref_id !== card.id) throw bad('NODE_ID_CONFLICT', 409);
          else if (existing.title !== card.title || existing.x !== card.x || existing.y !== card.y || existing.width !== (card.width ?? 460) ||
              existing.height !== (card.height ?? 520) || existing.revision !== card.revision) {
            db.prepare('UPDATE nodes SET title=?,x=?,y=?,width=?,height=?,revision=? WHERE id=?')
              .run(card.title, card.x, card.y, card.width ?? 460, card.height ?? 520, card.revision, card.id);
          }
        }
      });
    },
    createEdge({ edgeId = randomUUID(), canvasId, sourceNodeId, targetNodeId, kind = 'context', sourcePortId, targetPortId, dataType }) {
      id(edgeId); id(canvasId); id(sourceNodeId); id(targetNodeId);
      if (sourceNodeId === targetNodeId || !['context', 'artifact', 'pipe'].includes(kind)) throw bad('INVALID_EDGE');
      if (kind === 'pipe') { id(sourcePortId); id(targetPortId); id(dataType); }
      else if (sourcePortId !== undefined || targetPortId !== undefined || dataType !== undefined) throw bad('INVALID_EDGE');
      return transaction(() => {
        const source = getNode(sourceNodeId), target = getNode(targetNodeId);
        if (!source || !target || source.canvasId !== canvasId || target.canvasId !== canvasId) throw bad('NODE_NOT_FOUND', 404);
        if (kind === 'pipe') {
          const output = source.settings.ports?.find(port => port.id === sourcePortId && port.direction === 'output');
          const input = target.settings.ports?.find(port => port.id === targetPortId && port.direction === 'input');
          if (!output || !input) throw bad('PIPE_PORT_NOT_FOUND', 409);
          if (output.dataType !== input.dataType || output.dataType !== dataType) throw bad('PIPE_TYPE_MISMATCH', 409);
        }
        const all = db.prepare('SELECT * FROM edges WHERE canvas_id=?').all(canvasId).map(edgeView);
        if (requiredSubgraph(listNodes(canvasId), all, sourceNodeId, 'branch').includes(targetNodeId)) throw bad('GRAPH_CYCLE', 409);
        try { db.prepare('INSERT INTO edges(id,canvas_id,source_node_id,target_node_id,kind,source_port_id,target_port_id,data_type) VALUES(?,?,?,?,?,?,?,?)')
          .run(edgeId, canvasId, sourceNodeId, targetNodeId, kind, sourcePortId ?? null, targetPortId ?? null, dataType ?? null); }
        catch (error) { if (String(error.message).includes('UNIQUE')) throw bad('EDGE_EXISTS', 409); throw error; }
        return edgeView(db.prepare('SELECT * FROM edges WHERE id=?').get(edgeId));
      });
    },
    updateLayout(nodeId, expectedRevision, patch) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !object(patch)) throw bad('INVALID_LAYOUT');
      finite(patch.x); finite(patch.y); size(patch.width, patch.height);
      return transaction(() => {
        const current = getNode(nodeId); if (!current) throw bad('NODE_NOT_FOUND', 404);
        if (current.kind === 'chat') throw bad('CHAT_LAYOUT_OWNED_BY_CARD', 409);
        if (current.revision !== expectedRevision) throw bad('REVISION_CONFLICT', 409);
        db.prepare('UPDATE nodes SET x=?,y=?,width=?,height=?,revision=revision+1 WHERE id=?').run(patch.x, patch.y, patch.width, patch.height, nodeId);
        return getNode(nodeId);
      });
    },
    updateArtifact(nodeId, expectedRevision, nextTitle, nextContent) {
      title(nextTitle); content(nextContent);
      return transaction(() => {
        const current = getNode(nodeId); if (!current) throw bad('NODE_NOT_FOUND', 404);
        if (current.kind !== 'artifact') throw bad('NOT_ARTIFACT_NODE');
        if (current.revision !== expectedRevision) throw bad('REVISION_CONFLICT', 409);
        const settings = { ...current.settings, content: nextContent };
        db.prepare('UPDATE nodes SET title=?,settings=?,revision=revision+1 WHERE id=?').run(nextTitle, json(settings), nodeId);
        return getNode(nodeId);
      });
    },
    startRun,
    beginChatRun(command, card) {
      this.syncChatCards([card]);
      return startRun({ runId: command.id, canvasId: card.canvasId, rootNodeId: card.id, scope: 'node', items: [{
        nodeId: card.id, inputHash: hash(command.input.text ?? ''),
        artifact: { id: `message:${command.id}`, kind: 'message', refId: command.id, metadata: { inputHash: hash(command.input.text ?? '') } },
      }] });
    },
    completeRun(runId, status) {
      id(runId); if (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(status)) throw bad('INVALID_RUN_STATE');
      return transaction(() => {
        const current = db.prepare('SELECT * FROM runs WHERE id=?').get(runId); if (!current) throw bad('RUN_NOT_FOUND', 404);
        if (current.status !== 'RUNNING') { if (current.status === status) return runView(current); throw bad('RUN_STATE_CONFLICT', 409); }
        db.prepare('UPDATE runs SET status=?,completed_at=? WHERE id=?').run(status, now(), runId);
        db.prepare('UPDATE run_nodes SET status=? WHERE run_id=?').run(status, runId);
        db.prepare('UPDATE artifacts SET state=? WHERE run_id=?').run(status, runId);
        return runView(db.prepare('SELECT * FROM runs WHERE id=?').get(runId));
      });
    },
    recoverRunning() {
      return transaction(() => {
        const rows = db.prepare("SELECT id FROM runs WHERE status='RUNNING'").all();
        for (const row of rows) {
          db.prepare("UPDATE runs SET status='UNKNOWN',completed_at=? WHERE id=?").run(now(), row.id);
          db.prepare("UPDATE run_nodes SET status='UNKNOWN' WHERE run_id=?").run(row.id);
          db.prepare("UPDATE artifacts SET state='UNKNOWN' WHERE run_id=?").run(row.id);
        }
        return rows.length;
      });
    },
    getArtifact(artifactId) {
      id(artifactId);
      const row = db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactId);
      if (!row) throw bad('ARTIFACT_NOT_FOUND', 404);
      return artifactView(row, true);
    },
    snapshot(canvasId) {
      id(canvasId);
      const nodes = listNodes(canvasId).map(node => node.kind === 'artifact' ? { ...node, settings: Object.fromEntries(Object.entries(node.settings).filter(([key]) => key !== 'content')) } : node);
      const edges = db.prepare('SELECT * FROM edges WHERE canvas_id=? ORDER BY rowid').all(canvasId).map(edgeView);
      const runs = db.prepare('SELECT * FROM runs WHERE canvas_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(canvasId).map(runView);
      const runNodes = db.prepare('SELECT run_id,node_id,attempt,status,input_hash FROM run_nodes WHERE run_id IN (SELECT id FROM runs WHERE canvas_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20)').all(canvasId);
      const attempts = new Map();
      for (const row of runNodes) {
        if (!attempts.has(row.run_id)) attempts.set(row.run_id, []);
        attempts.get(row.run_id).push({ nodeId: row.node_id, attempt: row.attempt, status: row.status, inputHash: row.input_hash });
      }
      for (const run of runs) run.nodes = attempts.get(run.id) ?? [];
      const artifacts = db.prepare('SELECT * FROM artifacts WHERE run_id IN (SELECT id FROM runs WHERE canvas_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20) ORDER BY created_at DESC,rowid DESC LIMIT 40').all(canvasId).map(row => artifactView(row));
      return { nodes, edges, runs, artifacts };
    },
    close() { db.close(); },
  };
}

export const graphContentHash = hash;
