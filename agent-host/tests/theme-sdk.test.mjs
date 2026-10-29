import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createThemeProposalTool } from '../../themes/pi-extension.mjs';
import { createDefaultResourceLoader } from '../pi-adapter.mjs';
import { sdk, Type, createAssistantMessageEventStream } from './fixture-runtime.mjs';

const model = { id: 'theme-synthetic', name: 'Theme synthetic', api: 'openai-completions', provider: 'synthetic', baseUrl: 'http://127.0.0.1/unused', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const message = (content, stopReason) => ({ role: 'assistant', content, stopReason, model: model.id, api: model.api, provider: model.provider,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, timestamp: Date.now() });
function runtime() {
  let calls = 0;
  return { getModel: () => model, getAvailable: async () => [model], hasConfiguredAuth: () => true,
    streamSimple() {
      const stream = createAssistantMessageEventStream();
      if (calls++ === 0) stream.push({ type: 'done', reason: 'toolUse', message: message([{ type: 'toolCall', id: 'call_theme|fc_1', name: 'theme_propose',
        arguments: { name: 'SDK calm', base: 'light', tokens: { radius: 6 } } }], 'toolUse') });
      else stream.push({ type: 'done', reason: 'stop', message: message([{ type: 'text', text: 'proposal ready for review' }], 'stop') });
      return stream;
    } };
}

test('actual SDK activates theme_propose with partial declarative tokens and preserves composite identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-theme-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'cwd'), agentDir = join(root, 'agent'), sessions = join(root, 'sessions');
  await Promise.all([cwd, agentDir, sessions].map(path => mkdir(path, { recursive: true })));
  const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const calls = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    return new Response(JSON.stringify({ theme: { id: 'theme-sdk', name: body.name, state: 'PROPOSED', currentVersion: 1 },
      version: { themeId: 'theme-sdk', version: 1, tokens: { ...body.tokens, base: body.base } } }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const context = Object.freeze({ sessionId: 'session', turnId: 'turn' });
  const tool = createThemeProposalTool({ Type, connection: { baseUrl: 'http://127.0.0.1:46231', bearer: 'a'.repeat(64) },
    sessionId: 'session', getTurnContext: () => context, fetch });
  const resourceLoader = createDefaultResourceLoader({ sdk, cwd, agentDir, settingsManager, toolDefinitions: [tool] });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, model, modelRuntime: runtime(), thinkingLevel: 'low', resourceLoader,
    sessionManager: sdk.SessionManager.create(cwd, sessions), settingsManager, tools: ['theme_propose'] });
  try {
    await session.prompt('Propose a calm theme.');
    assert.ok(session.getActiveToolNames().includes('theme_propose'));
    assert.equal(calls.length, 1, JSON.stringify(session.messages));
    assert.equal(calls[0].origin.toolCallId, 'call_theme|fc_1');
    assert.deepEqual(calls[0].tokens, { radius: 6 });
    assert.equal(session.getLastAssistantText(), 'proposal ready for review');
  } finally { session.dispose(); }
});
