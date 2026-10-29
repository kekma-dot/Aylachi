import { randomUUID } from 'node:crypto';
import { graphContentHash, requiredSubgraph } from './graph-store.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = (status, code) => Object.assign(new Error(code), { status, code });
const object = value => value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exact(value, allowed, required = []) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw bad(400, 'invalid_request');
}
function noQuery(query) { exact(query ?? {}, []); }
function publicError(error) {
  if (error?.status) return error;
  if (['REVISION_CONFLICT', 'GRAPH_CYCLE', 'EDGE_EXISTS', 'RUN_STATE_CONFLICT', 'CHAT_LAYOUT_OWNED_BY_CARD'].includes(error?.code)) return bad(409, 'conflict');
  if (['NODE_NOT_FOUND', 'RUN_NOT_FOUND', 'ARTIFACT_NOT_FOUND', 'ENOENT', 'FORBIDDEN'].includes(error?.code)) return bad(404, 'not_found');
  return bad(400, 'invalid_request');
}

export function createWorkspaceGraphRoutes({ graph, wiki, core, artifacts, browsers, connectors, projectId, canvasId, ownerId } = {}) {
  if (!graph || !core || typeof core.listCards !== 'function' || !ID.test(projectId ?? '') || !ID.test(canvasId ?? '') || !ID.test(ownerId ?? '')) throw new TypeError('graph routes require trusted stores and identity');
  const target = Object.freeze({ projectId });
  const route = (method, path, operation, effect, handle) => Object.freeze({ method, path, operation, effect, target, handle: async input => {
    try { return await handle(input); } catch (error) { throw publicError(error); }
  } });
  const sync = () => { graph.syncChatCards(core.listCards({ canvasId, limit: 101 })); };
  function activitySnapshot(actor) {
    const snapshot = graph.snapshot(canvasId);
    if (!connectors) return snapshot;
    const commands = connectors.list({ actor });
    const byRequest = new Map(commands.map(command => [command.requestId, command]));
    let changed = false;
    for (const run of snapshot.runs) {
      const command = byRequest.get(run.id);
      if (run.status === 'RUNNING' && command && ['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(command.state)) {
        graph.completeRun(run.id, command.state); changed = true;
      }
    }
    const current = changed ? graph.snapshot(canvasId) : snapshot;
    const runIds = new Set(current.runs.map(run => run.id));
    const activities = commands.filter(command => runIds.has(command.requestId)).map(command => ({ runId: command.requestId,
      nodeId: current.runs.find(run => run.id === command.requestId)?.rootNodeId,
      commandId: command.id, toolName: command.toolName, state: command.state, result: command.result, reasonCode: command.reasonCode, payloadHash: command.payloadHash }));
    return { ...current, activities };
  }
  return [
    route('GET', '/v1/modules/workspace/graph', 'workspace.graph.read', 'read', async ({ actor, query, body }) => {
      noQuery(query); exact(body ?? {}, []); sync();
      return { status: 200, body: activitySnapshot(actor) };
    }),
    route('GET', '/v1/modules/workspace/graph/nodes/:id', 'workspace.graph.read', 'read', async ({ params, query, body }) => {
      noQuery(query); exact(body ?? {}, []);
      const node = graph.getNode(params.id); if (!node || node.canvasId !== canvasId) throw bad(404, 'not_found');
      if (node.kind === 'artifact' && artifacts) {
        const current = artifacts.current(node);
        return { status: 200, body: { node: { ...node, title: current.version.title,
          settings: { ...node.settings, format: current.version.format, content: current.version.content } }, artifact: current.artifact, version: current.version } };
      }
      if (node.kind === 'browser' && browsers) {
        const current = browsers.current(node);
        return { status: 200, body: { ...current, node: { ...node, settings: { ...node.settings, mode: current.session.mode, backendId: current.session.backendId } } } };
      }
      return { status: 200, body: { node } };
    }),
    route('GET', '/v1/modules/workspace/graph/artifacts/:id', 'workspace.graph.read', 'read', async ({ params, query, body }) => {
      noQuery(query); exact(body ?? {}, []);
      const artifact = graph.getArtifact(params.id);
      const node = graph.getNode(artifact.nodeId); if (!node || node.canvasId !== canvasId) throw bad(404, 'not_found');
      return { status: 200, body: { artifact } };
    }),
    route('POST', '/v1/modules/workspace/graph/nodes', 'workspace.graph.write', 'write', async ({ actor, query, body }) => {
      noQuery(query); exact(body, ['kind', 'title', 'x', 'y', 'content', 'format', 'mode', 'allowedHosts', 'toolName', 'input', 'ports'], ['kind', 'title', 'x', 'y']);
      if (actor !== ownerId || !['wiki', 'artifact', 'browser', 'theme', 'plugin'].includes(body.kind) || typeof body.content !== 'string' && body.content !== undefined) throw bad(400, 'invalid_request');
      const initialContent = body.content ?? (body.kind === 'wiki' ? `# ${body.title}\n` : '# New artifact\n');
      if (body.kind === 'wiki') {
        if (!wiki) throw bad(404, 'not_found');
        const note = await wiki.create({ actor, content: initialContent });
        const node = graph.createNode({ id: randomUUID(), canvasId, kind: 'wiki', refId: note.id, title: body.title, x: body.x, y: body.y, settings: {} });
        return { status: 201, body: { node } };
      }
      if (body.kind === 'browser') {
        if (!browsers) throw bad(404, 'not_found');
        const sessionId = randomUUID();
        const result = browsers.create({ sessionId, canvasId, mode: body.mode ?? 'remote-read-only', allowedHosts: body.allowedHosts ?? ['example.com'],
          idempotencyKey: `graph-create:${sessionId}`, layout: { x: body.x, y: body.y } });
        return { status: 201, body: result };
      }
      if (body.kind === 'theme') {
        const node = graph.createNode({ id: randomUUID(), canvasId, kind: 'theme', refId: canvasId, title: body.title, x: body.x, y: body.y, settings: {} });
        return { status: 201, body: { node } };
      }
      if (body.kind === 'plugin') {
        if (!connectors || !ID.test(body.toolName ?? '') || !object(body.input ?? {})) throw bad(400, 'invalid_request');
        const toolName = body.toolName;
        const node = graph.createNode({ id: randomUUID(), canvasId, kind: 'plugin', refId: toolName, title: body.title, x: body.x, y: body.y,
          settings: { toolName, input: body.input ?? {}, ...(body.ports === undefined ? {} : { ports: body.ports }) } });
        return { status: 201, body: { node } };
      }
      if (artifacts) {
        const artifactId = randomUUID();
        const result = artifacts.create({ artifactId, idempotencyKey: `graph-create:${artifactId}`, title: body.title,
          format: body.format ?? 'markdown', content: initialContent, sources: [], origin: { kind: 'aylachi' },
          layout: { x: body.x, y: body.y } });
        return { status: 201, body: result };
      }
      const refId = randomUUID();
      const node = graph.createNode({ id: randomUUID(), canvasId, kind: 'artifact', refId, title: body.title, x: body.x, y: body.y,
        settings: { content: initialContent, format: body.format ?? 'markdown' } });
      return { status: 201, body: { node } };
    }),
    route('POST', '/v1/modules/workspace/graph/nodes/:id/layout', 'workspace.graph.write', 'write', async ({ params, query, body }) => {
      noQuery(query); exact(body, ['expectedRevision', 'x', 'y', 'width', 'height'], ['expectedRevision', 'x', 'y', 'width', 'height']);
      return { status: 200, body: { node: graph.updateLayout(params.id, body.expectedRevision, body) } };
    }),
    route('POST', '/v1/modules/workspace/graph/nodes/:id/settings', 'workspace.graph.write', 'write', async ({ params, query, body }) => {
      noQuery(query); exact(body, ['expectedRevision', 'title', 'content'], ['expectedRevision', 'title', 'content']);
      if (artifacts) {
        const node = graph.getNode(params.id); if (!node || node.canvasId !== canvasId) throw bad(404, 'not_found');
        return { status: 200, body: artifacts.update(node, body.expectedRevision, body.title, body.content) };
      }
      return { status: 200, body: { node: graph.updateArtifact(params.id, body.expectedRevision, body.title, body.content) } };
    }),
    route('POST', '/v1/modules/workspace/graph/edges', 'workspace.graph.write', 'write', async ({ query, body }) => {
      noQuery(query); exact(body, ['sourceNodeId', 'targetNodeId', 'kind', 'sourcePortId', 'targetPortId', 'dataType'], ['sourceNodeId', 'targetNodeId']);
      const edge = graph.createEdge({ canvasId, sourceNodeId: body.sourceNodeId, targetNodeId: body.targetNodeId, kind: body.kind ?? 'context',
        sourcePortId: body.sourcePortId, targetPortId: body.targetPortId, dataType: body.dataType });
      return { status: 201, body: { edge } };
    }),
    route('POST', '/v1/modules/workspace/graph/triggers', 'workspace.graph.trigger', 'write', async ({ actor, query, body }) => {
      noQuery(query); exact(body, ['requestId', 'nodeId', 'input'], ['requestId', 'nodeId']);
      if (actor !== ownerId || !ID.test(body.requestId) || !ID.test(body.nodeId) || !connectors) throw bad(400, 'invalid_request');
      const node = graph.getNode(body.nodeId);
      if (!node || node.canvasId !== canvasId || node.kind !== 'plugin') throw bad(404, 'not_found');
      const payload = body.input ?? node.settings.input;
      if (!object(payload)) throw bad(400, 'invalid_request');
      const created = !graph.getRun(body.requestId);
      const run = graph.startRun({ runId: body.requestId, canvasId, rootNodeId: node.id, scope: 'node',
        items: [{ nodeId: node.id, inputHash: graphContentHash(JSON.stringify(payload)) }] });
      let result;
      try { result = connectors.invoke({ actor, requestId: body.requestId, toolName: node.settings.toolName, payload }); }
      catch (error) { if (created && run.status === 'RUNNING') graph.completeRun(run.id, 'FAILED'); throw error; }
      if (run.status === 'RUNNING' && ['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(result.command.state)) graph.completeRun(run.id, result.command.state);
      const current = graph.snapshot(canvasId).runs.find(item => item.id === run.id);
      return { status: result.duplicate ? 200 : 201, body: { run: current, command: result.command } };
    }),
    route('POST', '/v1/modules/workspace/graph/runs', 'workspace.graph.run', 'write', async ({ actor, query, body }) => {
      noQuery(query); exact(body, ['scope', 'nodeId'], ['scope']);
      if (actor !== ownerId || !['node', 'branch', 'all'].includes(body.scope) || body.scope !== 'all' && !ID.test(body.nodeId ?? '')) throw bad(400, 'invalid_request');
      sync();
      const snapshot = graph.snapshot(canvasId);
      const required = requiredSubgraph(snapshot.nodes, snapshot.edges, body.nodeId, body.scope);
      if (body.scope === 'node' && snapshot.nodes.find(node => node.id === body.nodeId)?.kind === 'chat') throw bad(409, 'side_effect_requires_explicit_command');
      const selected = snapshot.nodes.filter(node => required.includes(node.id) && ['wiki', 'artifact'].includes(node.kind));
      if (!selected.length) throw bad(400, 'no_pure_nodes');
      const items = [];
      for (const node of selected) {
        let definition, refId, revision, artifactContent, kind;
        if (node.kind === 'wiki') {
          const note = await wiki.read({ actor, id: node.refId });
          definition = note.content; refId = note.id; revision = note.revision; artifactContent = note.content; kind = 'wiki-preview';
        } else {
          const current = artifacts ? artifacts.current(node) : { version: { content: graph.getNode(node.id).settings.content ?? '', version: graphContentHash(graph.getNode(node.id).settings.content ?? '') } };
          definition = current.version.content; refId = node.refId; revision = String(current.version.version); artifactContent = definition; kind = 'artifact-preview';
        }
        const inputHash = graphContentHash(definition);
        items.push({ nodeId: node.id, inputHash, artifact: { id: randomUUID(), kind, refId, revision, content: artifactContent,
          metadata: { contentHash: inputHash, definitionRevision: node.revision, format: node.kind === 'artifact' ? node.settings.format ?? 'markdown' : 'markdown' } } });
      }
      const run = graph.startRun({ canvasId, rootNodeId: body.scope === 'all' ? null : body.nodeId, scope: body.scope, items });
      graph.completeRun(run.id, 'SUCCEEDED');
      return { status: 201, body: { run: graph.snapshot(canvasId).runs.find(item => item.id === run.id),
        artifacts: items.map(item => { const { content: omitted, ...artifact } = graph.getArtifact(item.artifact.id); return artifact; }) } };
    }),
  ];
}
