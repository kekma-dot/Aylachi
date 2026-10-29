import assert from 'node:assert/strict';
import test from 'node:test';
import { executionRecord, makeExecutionEvent, snapshotWorkerExecutionEvent } from './execution-events.mjs';

const card = { id: 'card1', canvasId: 'fixture', sessionId: 'session1' };
const command = { id: 'turn1' };
const workerEvent = { type: 'tool.started', sessionId: 'session1', turnId: 'turn1', itemId: 'turn1:tool:call1', eventId: 'turn1:call1:started', payload: { toolName: 'read' } };

test('worker execution events have bounded additive payloads and Hub-owned identity', () => {
  const snapshot = snapshotWorkerExecutionEvent(workerEvent);
  const event = makeExecutionEvent({ card, command, ...snapshot });
  assert.deepEqual(event, { schemaVersion: 1, workspaceId: 'fixture', conversationId: 'card1', runId: 'turn1', turnId: 'turn1',
    itemId: 'turn1:tool:call1', eventId: 'turn1:call1:started', type: 'tool.started', payload: { toolName: 'read' } });
  assert.deepEqual(executionRecord(7, event), { seq: 7, durable: true, event });
  assert.deepEqual(executionRecord(null, { ...event, type: 'text.delta', payload: { text: 'live' } }), { seq: null, durable: false,
    event: { ...event, type: 'text.delta', payload: { text: 'live' } } });
  const artifact = makeExecutionEvent({ card, command, type: 'artifact.version', itemId: 'artifact-one:v1', eventId: 'artifact-one:1:abc',
    payload: { artifactId: 'artifact-one', version: 1, contentHash: 'a'.repeat(64), format: 'markdown' } });
  assert.equal(executionRecord(8, artifact).durable, true);
});

test('worker events reject arbitrary extra fields, invalid identities and oversized deltas', () => {
  for (const value of [
    { ...workerEvent, workspaceId: 'attacker' },
    { ...workerEvent, sessionId: '../escape' },
    { ...workerEvent, type: 'item.completed' },
    { ...workerEvent, payload: { toolName: 'read', args: { secret: true } } },
    { ...workerEvent, type: 'text.delta', payload: { text: '' } },
    { ...workerEvent, type: 'text.delta', payload: { text: 'x'.repeat(16 * 1024 + 1) } },
  ]) assert.throws(() => snapshotWorkerExecutionEvent(value), /INVALID_EXECUTION_EVENT/);
});
