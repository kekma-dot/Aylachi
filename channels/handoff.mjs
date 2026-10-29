// Automatic handoff is a bounded graph/context/artifact reference, not copied content.
export function automaticHandoff({ graph, core, conversationId, commandId }) {
  const card = core.getCard(conversationId);
  if (!card) throw Object.assign(new Error('CHANNEL_CONVERSATION_NOT_FOUND'), { code: 'CHANNEL_CONVERSATION_NOT_FOUND', status: 404 });
  const snapshot = graph.snapshot(card.canvasId);
  return {
    source: { conversationId, commandId, canvasId: card.canvasId },
    context: snapshot.edges.filter(edge => edge.sourceNodeId === conversationId || edge.targetNodeId === conversationId)
      .map(edge => ({ edgeId: edge.id, sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, kind: edge.kind })),
    runs: snapshot.runs.filter(run => run.id === commandId).map(run => ({ id: run.id, rootNodeId: run.rootNodeId, status: run.status })),
    artifacts: snapshot.artifacts.filter(artifact => artifact.runId === commandId).slice(0, 20).map(artifact => ({
      id: artifact.id, runId: artifact.runId, nodeId: artifact.nodeId, attempt: artifact.attempt,
      kind: artifact.kind, refId: artifact.refId, revision: artifact.revision,
    })),
  };
}
