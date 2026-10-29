import { graphContentHash } from '../workspace/graph-store.mjs';

const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });

export function createAylachiBrowserAdapter({ plane, graph, canvasId } = {}) {
  if (!plane || !graph || typeof canvasId !== 'string') throw new TypeError('browser graph adapter requires plane, graph and canvas');
  const nodeIdFor = sessionId => `browser-node-${sessionId}`;
  function correlate(result) {
    if (!result.snapshot) return result;
    const { session, snapshot } = result;
    const runId = `browser-${session.id}-snapshot-${snapshot.id}`;
    graph.startRun({ runId, canvasId, rootNodeId: nodeIdFor(session.id), scope: 'node', items: [{
      nodeId: nodeIdFor(session.id), inputHash: graphContentHash(JSON.stringify([snapshot.url, snapshot.text])),
      artifact: { id: `${runId}-output`, kind: 'browser-snapshot', refId: snapshot.id, revision: String(session.revision),
        content: JSON.stringify({ url: snapshot.url, title: snapshot.title, text: snapshot.text, links: snapshot.links }),
        metadata: { mode: session.mode, backendId: session.backendId, url: snapshot.url, title: snapshot.title, linkCount: snapshot.links.length } },
    }] });
    const run = graph.snapshot(canvasId).runs.find(item => item.id === runId);
    if (run?.status === 'RUNNING') graph.completeRun(runId, 'SUCCEEDED');
    return result;
  }
  function ensureNode(result, layout = {}) {
    const { session } = result;
    const id = nodeIdFor(session.id);
    let node = graph.getNode(id);
    if (node) {
      if (node.kind !== 'browser' || node.refId !== session.id || node.canvasId !== canvasId) throw bad('BROWSER_NODE_CONFLICT', 409);
    } else {
      node = graph.createNode({ id, canvasId, kind: 'browser', refId: session.id, title: session.mode === 'local-interactive' ? 'Local Browser' : 'Remote Browser',
        x: layout.x ?? 0, y: layout.y ?? 0, settings: {} });
    }
    correlate(result);
    return { ...result, node };
  }
  return Object.freeze({
    create(input) { return ensureNode(plane.create(input), input.layout); },
    current(node) { if (!node || node.kind !== 'browser') throw bad('NOT_BROWSER_NODE'); return plane.read(node.refId); },
    async openTab(input) { return correlate(await plane.openTab(input)); },
    async navigate(input) { return correlate(await plane.navigate(input)); },
    async refresh(input) { return correlate(await plane.refresh(input)); },
    activate(input) { return plane.activate(input); },
    health() { return plane.health(); },
    nodeIdFor,
  });
}
