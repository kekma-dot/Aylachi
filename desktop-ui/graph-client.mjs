const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => { if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('INVALID_ID'); return encodeURIComponent(value); };
const invalid = () => Object.assign(new Error('INVALID_GRAPH_RESPONSE'), { code: 'INVALID_GRAPH_RESPONSE' });
const validNode = node => object(node) && ID.test(node.id ?? '') && ID.test(node.canvasId ?? '') && ID.test(node.refId ?? '') &&
  ['chat', 'wiki', 'artifact', 'browser', 'theme', 'plugin'].includes(node.kind) && typeof node.title === 'string' && Number.isFinite(node.x) && Number.isFinite(node.y) &&
  Number.isFinite(node.width) && Number.isFinite(node.height) && Number.isSafeInteger(node.revision) && node.revision >= 1 && object(node.settings);
const validArtifact = artifact => object(artifact) && ID.test(artifact.id ?? '') && ID.test(artifact.runId ?? '') && ID.test(artifact.nodeId ?? '') &&
  Number.isSafeInteger(artifact.attempt) && artifact.attempt >= 1 && ID.test(artifact.kind ?? '') && ID.test(artifact.refId ?? '') && object(artifact.metadata);
const validSnapshot = value => object(value) && ['nodes', 'edges', 'runs', 'artifacts'].every(key => Array.isArray(value[key])) &&
  value.nodes.length <= 100 && value.nodes.every(validNode) && value.artifacts.every(validArtifact) &&
  value.edges.every(edge => object(edge) && ID.test(edge.id ?? '') && ID.test(edge.sourceNodeId ?? '') && ID.test(edge.targetNodeId ?? '')) &&
  value.runs.every(run => object(run) && ID.test(run.id ?? '') && Array.isArray(run.nodes)) &&
  (value.activities === undefined || Array.isArray(value.activities) && value.activities.every(activity => object(activity) &&
    ID.test(activity.runId ?? '') && ID.test(activity.nodeId ?? '') && ID.test(activity.commandId ?? '') && ID.test(activity.toolName ?? '') &&
    ['PENDING_APPROVAL', 'QUEUED', 'LEASED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(activity.state)));

export function createGraphClient({ hubClient } = {}) {
  if (!hubClient || typeof hubClient.moduleRequest !== 'function') throw new TypeError('INVALID_HUB_CLIENT');
  async function call(method, path, body, signal, validate) {
    const result = await hubClient.moduleRequest({ method, path, body, signal });
    if (!validate(result)) throw invalid();
    return result;
  }
  return {
    snapshot(signal) { return call('GET', '/v1/modules/workspace/graph', undefined, signal, validSnapshot); },
    node(nodeId, signal) { return call('GET', `/v1/modules/workspace/graph/nodes/${id(nodeId)}`, undefined, signal, value => validNode(value.node)); },
    artifact(artifactId, signal) { return call('GET', `/v1/modules/workspace/graph/artifacts/${id(artifactId)}`, undefined, signal, value => validArtifact(value.artifact) && (typeof value.artifact.content === 'string' || value.artifact.content === null)); },
    createNode(input, signal) {
      if (!object(input) || !['wiki', 'artifact', 'browser', 'theme', 'plugin'].includes(input.kind)) throw new TypeError('INVALID_NODE');
      return call('POST', '/v1/modules/workspace/graph/nodes', input, signal, value => validNode(value.node));
    },
    createEdge(input, signal) { return call('POST', '/v1/modules/workspace/graph/edges', input, signal, value => object(value.edge) && ID.test(value.edge.id ?? '')); },
    run(input, signal) {
      if (!object(input) || !['node', 'branch', 'all'].includes(input.scope)) throw new TypeError('INVALID_RUN');
      return call('POST', '/v1/modules/workspace/graph/runs', input, signal, value => object(value.run) && ID.test(value.run.id ?? '') && Array.isArray(value.artifacts) && value.artifacts.every(validArtifact));
    },
    trigger(input, signal) {
      if (!object(input) || !ID.test(input.requestId ?? '') || !ID.test(input.nodeId ?? '')) throw new TypeError('INVALID_TRIGGER');
      return call('POST', '/v1/modules/workspace/graph/triggers', input, signal, value => object(value.run) && ID.test(value.run.id ?? '') &&
        object(value.command) && ID.test(value.command.id ?? '') && ID.test(value.command.requestId ?? ''));
    },
    updateLayout(nodeId, input, signal) { return call('POST', `/v1/modules/workspace/graph/nodes/${id(nodeId)}/layout`, input, signal, value => validNode(value.node)); },
    updateArtifact(nodeId, input, signal) { return call('POST', `/v1/modules/workspace/graph/nodes/${id(nodeId)}/settings`, input, signal, value => validNode(value.node)); },
  };
}
