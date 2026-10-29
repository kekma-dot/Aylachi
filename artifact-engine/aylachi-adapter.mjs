const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });

// M3 owns graph/run identity; the engine owns immutable content versions and source snapshots.
export function createAylachiArtifactAdapter({ engine, graph, canvasId } = {}) {
  if (!engine || !graph || typeof canvasId !== 'string') throw new TypeError('artifact graph adapter requires engine, graph and canvas');
  const nodeIdFor = artifactId => `artifact-node-${artifactId}`;
  function correlate(result, node) {
    const { artifact, version } = result;
    const runId = `artifact-${artifact.id}-v${version.version}`;
    const run = graph.startRun({ runId, canvasId, rootNodeId: node.id, scope: 'node', items: [{
      nodeId: node.id, inputHash: version.contentHash,
      artifact: { id: `${runId}-output`, kind: 'artifact-version', refId: artifact.id, revision: String(version.version), content: version.content,
        metadata: { contentHash: version.contentHash, format: version.format, sourceHashes: version.sources.map(source => source.sha256), origin: version.origin } },
    }] });
    const current = graph.getArtifact(`${runId}-output`);
    if (current.state === 'RUNNING') graph.completeRun(runId, 'SUCCEEDED');
    return run;
  }
  function ensureNode(result, layout = {}) {
    const { artifact, version } = result;
    const id = nodeIdFor(artifact.id);
    let node = graph.getNode(id);
    if (node) {
      if (node.kind !== 'artifact' || node.refId !== artifact.id || node.canvasId !== canvasId) throw bad('ARTIFACT_NODE_CONFLICT', 409);
    } else {
      node = graph.createNode({ id, canvasId, kind: 'artifact', refId: artifact.id, title: version.title,
        x: layout.x ?? 0, y: layout.y ?? 0, settings: { format: version.format } });
    }
    correlate(result, node);
    return { ...result, node };
  }
  function current(node) {
    if (!node || node.kind !== 'artifact') throw bad('NOT_ARTIFACT_NODE');
    try { return engine.get(node.refId); }
    catch (error) {
      if (error?.code !== 'ARTIFACT_NOT_FOUND' || typeof node.settings?.content !== 'string') throw error;
      // One-way compatibility import for M3 nodes. New reads/writes use the engine as authority.
      return engine.create({ artifactId: node.refId, idempotencyKey: `legacy-node:${node.id}:revision:${node.revision}`,
        title: node.title, format: node.settings.format ?? 'markdown', content: node.settings.content, sources: [], origin: { kind: 'aylachi', nodeId: node.id } });
    }
  }
  return Object.freeze({
    create(input) { return ensureNode(engine.create(input), input.layout); },
    current,
    update(node, expectedRevision, title, content) {
      if (node.revision !== expectedRevision) throw bad('REVISION_CONFLICT', 409);
      const existing = current(node);
      const result = engine.update({ artifactId: node.refId, expectedVersion: existing.artifact.currentVersion,
        idempotencyKey: `graph-node:${node.id}:revision:${expectedRevision}`, title, format: existing.version.format, content,
        sources: existing.version.sources.map(({ uri, label, snapshot }) => ({ uri, label, snapshot })), origin: { kind: 'aylachi', nodeId: node.id } });
      const updated = graph.updateArtifact(node.id, expectedRevision, title, content);
      correlate(result, updated);
      return { ...result, node: updated };
    },
    rollback(node, expectedRevision, targetVersion, idempotencyKey) {
      if (node.revision !== expectedRevision) throw bad('REVISION_CONFLICT', 409);
      const result = engine.rollback({ artifactId: node.refId, targetVersion, idempotencyKey, origin: { kind: 'aylachi', nodeId: node.id } });
      const updated = graph.updateArtifact(node.id, expectedRevision, result.version.title, result.version.content);
      correlate(result, updated);
      return { ...result, node: updated };
    },
    nodeIdFor,
  });
}
