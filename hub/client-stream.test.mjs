import assert from 'node:assert/strict';
import test from 'node:test';
import { createHubClient } from './client.mjs';
import { executionRecord, makeExecutionEvent } from './execution-events.mjs';

test('Hub client accepts durable artifact.version execution records', async () => {
  const event = makeExecutionEvent({ card: { id: 'card', canvasId: 'canvas', sessionId: 'session' }, command: { id: 'turn' },
    type: 'artifact.version', itemId: 'artifact-one:v1', eventId: 'artifact-one:1:hash',
    payload: { artifactId: 'artifact-one', version: 1, contentHash: 'a'.repeat(64), format: 'markdown' } });
  const record = executionRecord(1, event);
  const client = createHubClient({ baseUrl: 'http://127.0.0.1:43210', bearer: 'a'.repeat(64), fetch: async () => new Response(
    `event: execution\ndata: ${JSON.stringify(record)}\n\nevent: ready\ndata: {"seq":1}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  const received = [];
  const result = await client.streamEvents({ cardId: 'card', onEvent: event => received.push(event) });
  assert.equal(result.nextSequence, 1);
  assert.deepEqual(received, [record]);
});
