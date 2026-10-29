function executionFor(projection, turnId) {
  if (!projection.executions.has(turnId)) projection.executions.set(turnId, {
    draft: '', finalText: null, itemFinal: false, terminal: null, metrics: null, tools: new Map(), transientIds: new Set(),
  });
  return projection.executions.get(turnId);
}

function reduceExecution(projection, record) {
  const { event } = record;
  const execution = executionFor(projection, event.turnId);
  if (event.type === 'text.delta' || event.type === 'reasoning.delta') {
    if (execution.transientIds.has(event.eventId)) return;
    execution.transientIds.add(event.eventId);
    if (!execution.itemFinal && !execution.terminal && projection.hasRunning(event.turnId) &&
        new TextEncoder().encode(execution.draft + event.payload.text).byteLength <= 64 * 1024) execution.draft += event.payload.text;
  } else if (event.type === 'tool.started' || event.type === 'tool.completed') {
    execution.tools.set(event.itemId, { id: event.itemId, turnId: event.turnId, toolName: event.payload.toolName,
      status: event.type === 'tool.started' ? 'running' : event.payload.isError ? 'failed' : 'completed' });
  } else if (event.type === 'tool.effect') {
    const status = { PENDING_APPROVAL: 'approval', APPROVED: 'running', RUNNING: 'running', UNKNOWN: 'unknown', SUCCEEDED: 'completed', FAILED: 'failed' }[event.payload.state];
    execution.tools.set(event.itemId, { id: event.itemId, effectId: event.itemId, turnId: event.turnId, toolName: event.payload.toolName,
      status, attempt: event.payload.attempt, payloadHash: event.payload.payloadHash, reasonCode: event.payload.reasonCode });
  } else if (event.type === 'turn.metrics') {
    execution.metrics = { ...event.payload };
  } else if (event.type === 'item.completed') {
    execution.itemFinal = true; execution.draft = '';
    if (typeof event.payload.text === 'string') execution.finalText = event.payload.text;
  } else if (['turn.completed', 'turn.failed', 'turn.cancelled', 'turn.needs_reconciliation'].includes(event.type)) execution.terminal = event.type;
}

// Continuous-prefix durable cursor plus client-only provisional items. The
// projection is shared by live SSE and bounded history replay, never by transport.
export function createExecutionProjection({ conversationId, workspaceId, hasRunning }) {
  return {
    sequence: 0,
    executions: new Map(),
    pendingExecutions: new Map(),
    hasRunning,
    accept(record) {
      const { event } = record;
      if (event.conversationId !== conversationId || event.workspaceId !== workspaceId || event.runId !== event.turnId) return 'ignored';
      if (record.durable) {
        if (record.seq <= this.sequence) return 'duplicate';
        if (record.seq !== this.sequence + 1) { this.pendingExecutions.set(record.seq, record); return 'gap'; }
        this.sequence = record.seq;
      }
      reduceExecution(this, record);
      return 'accepted';
    },
  };
}
