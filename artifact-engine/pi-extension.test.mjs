import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtifactExtension, createArtifactTool } from './pi-extension.mjs';

const Type = { Object: value => value, String: value => value, Optional: value => value, Array: value => value };
const connection = { baseUrl: 'http://127.0.0.1:46231', bearer: 'a'.repeat(64) };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Pi artifact tool binds composite call identity and command reads the same artifact API', async () => {
  const tools = [], commands = new Map(), requests = [], sent = [], notices = [];
  const context = Object.freeze({ sessionId: 'session', turnId: 'turn' });
  const created = body => ({ artifact: { id: 'artifact-one', title: body.title, currentVersion: 1 },
    version: { artifactId: 'artifact-one', version: 1, title: body.title, content: body.content, contentHash: 'a'.repeat(64), sources: body.sources },
    node: { id: 'artifact-node:artifact-one' }, idempotent: requests.filter(item => item.idempotencyKey === body.idempotencyKey).length > 1 });
  const fetch = async (url, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body); requests.push(body); return json(created(body), 201);
    }
    if (url.pathname.endsWith('/artifacts')) return json({ artifacts: [{ id: 'artifact-one', title: 'Plan', currentVersion: 1 }] });
    return json({ artifact: { id: 'artifact-one' }, version: { title: 'Plan', version: 1, content: '# Plan', sources: [{ uri: 'https://example.com', label: 'Spec', sha256: 'b'.repeat(64) }] } });
  };
  const options = { Type, connection, sessionId: 'session', getTurnContext: () => context, fetch };
  tools.push(createArtifactTool(options));
  createArtifactExtension(options)({
    registerCommand: (name, command) => commands.set(name, command), sendUserMessage: text => sent.push(text),
  });
  assert.equal(tools[0].name, 'artifact_create');
  const params = { title: 'Plan', format: 'markdown', content: '# Plan', sources: [{ uri: 'https://example.com', snapshot: 'evidence' }] };
  const first = await tools[0].execute('call_1|fc_1', params);
  const replay = await tools[0].execute('call_1|fc_1', params);
  assert.equal(first.details.artifact.id, 'artifact-one');
  assert.equal(replay.details.idempotent, true);
  assert.equal(requests.length, 2);
  assert.equal(new Set(requests.map(request => request.idempotencyKey)).size, 1);
  assert.equal(requests[0].origin.toolCallId, 'call_1|fc_1');
  assert.equal(first.details.version.content, undefined);
  const command = commands.get('artifact');
  await command.handler('list', { hasUI: true, ui: { notify: text => notices.push(text) } });
  await command.handler('open artifact-one', { hasUI: true, ui: { notify: text => notices.push(text) } });
  assert.match(notices[0], /artifact-one/);
  assert.match(notices[1], /Sources/);
  await command.handler('make a rollout plan', { hasUI: true, ui: { notify: text => notices.push(text) } });
  assert.match(sent[0], /artifact_create/);
});
