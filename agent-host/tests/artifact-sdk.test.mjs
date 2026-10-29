import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArtifactExtension, createArtifactTool } from '../../artifact-engine/pi-extension.mjs';
import { createDefaultResourceLoader } from '../pi-adapter.mjs';
import { sdk, Type, createAssistantMessageEventStream } from './fixture-runtime.mjs';

const model = { id: 'artifact-synthetic', name: 'Artifact synthetic', api: 'openai-completions', provider: 'synthetic', baseUrl: 'http://127.0.0.1/unused', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const message = (content, stopReason) => ({ role: 'assistant', content, stopReason, model: model.id, api: model.api, provider: model.provider,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, timestamp: Date.now() });
function runtime() {
  let calls = 0;
  return { getModel: () => model, getAvailable: async () => [model], hasConfiguredAuth: () => true,
    streamSimple() {
      const stream = createAssistantMessageEventStream();
      if (calls++ === 0) stream.push({ type: 'done', reason: 'toolUse', message: message([{ type: 'toolCall', id: 'call_sdk|fc_1', name: 'artifact_create',
        arguments: { title: 'SDK artifact', format: 'markdown', content: '# SDK', sources: [{ uri: 'https://example.com', snapshot: 'evidence' }] } }], 'toolUse') });
      else stream.push({ type: 'done', reason: 'stop', message: message([{ type: 'text', text: 'artifact complete' }], 'stop') });
      return stream;
    } };
}

test('actual SDK loader activates and executes the built-in artifact tool with empty legacy tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-artifact-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'cwd'), agentDir = join(root, 'agent'), sessions = join(root, 'sessions');
  await Promise.all([cwd, agentDir, sessions].map(path => mkdir(path, { recursive: true })));
  const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const calls = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    return new Response(JSON.stringify({ artifact: { id: 'artifact-sdk', title: body.title, currentVersion: 1 },
      version: { artifactId: 'artifact-sdk', version: 1, title: body.title, content: body.content, contentHash: 'a'.repeat(64), sources: body.sources },
      node: { id: 'artifact-node:artifact-sdk' } }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const context = Object.freeze({ sessionId: 'session', turnId: 'turn' });
  const options = { Type, connection: { baseUrl: 'http://127.0.0.1:46231', bearer: 'a'.repeat(64) },
    sessionId: 'session', getTurnContext: () => context, fetch };
  const extension = createArtifactExtension(options);
  const tool = createArtifactTool(options);
  const resourceLoader = createDefaultResourceLoader({ sdk, cwd, agentDir, settingsManager, toolDefinitions: [tool], extensionFactories: [extension] });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, model, modelRuntime: runtime(), thinkingLevel: 'low', resourceLoader,
    sessionManager: sdk.SessionManager.create(cwd, sessions), settingsManager, tools: ['artifact_create'] });
  try {
    await session.prompt('Create the SDK artifact.');
    assert.ok(session.getActiveToolNames().includes('artifact_create'));
    assert.equal(calls.length, 1, JSON.stringify(session.messages));
    assert.equal(calls[0].origin.toolCallId, 'call_sdk|fc_1');
    assert.equal(session.getLastAssistantText(), 'artifact complete');
  } finally { session.dispose(); }
});
