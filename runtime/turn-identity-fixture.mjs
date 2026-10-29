import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkerAdapter } from './pi-worker.mjs';
import { attachPiAdapterIpc } from '../agent-host/ipc.mjs';
import { sdk, Type } from '../agent-host/tests/fixture-runtime.mjs';
const dependencies = resolve(process.env.AYLACHI_SDK_ROOT, '../..');
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(dependencies, '@earendil-works/pi-ai/dist/utils/event-stream.js')).href);
const model = { id: 'gpt-6-luna', provider: 'openai-codex', api: 'openai-codex-responses', name: 'Synthetic identity fixture', reasoning: true, input: ['text'], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let sequence = 0;
const runtime = { getModel: () => model, getAvailable: async () => [model], hasConfiguredAuth: () => true,
  streamSimple(_model, context) {
    const stream = createAssistantMessageEventStream();
    const last = context.messages.at(-1);
    const content = last?.role === 'toolResult'
      ? [{ type: 'text', text: last.content.map(part => part.text ?? '').join('') }]
      : [{ type: 'toolCall', id: `identity-${++sequence}`, name: 'identity_probe', arguments: {} }];
    const message = { role: 'assistant', content, stopReason: last?.role === 'toolResult' ? 'stop' : 'toolUse', api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, timestamp: Date.now() };
    stream.push({ type: 'done', reason: message.stopReason, message });
    return stream;
  },
};
const root = process.env.AYLACHI_TEST_ROOT;
const adapter = createWorkerAdapter({ sdk, modelRuntime: runtime, model, root, cwd: join(root, 'workspace'), deadlineEpochMs: Date.now() + 60000,
  toolDefinitionsFactory: ({ sessionId, getTurnContext }) => [{ name: 'identity_probe', label: 'Identity probe', description: 'Harmless synthetic identity probe', parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const context = getTurnContext();
      if (!context || context.sessionId !== sessionId || !Object.isFrozen(context)) throw new Error('CONTEXT_MISSING');
      await new Promise(resolve => setTimeout(resolve, 10));
      if (getTurnContext() !== context) throw new Error('CONTEXT_DRIFT');
      return { content: [{ type: 'text', text: JSON.stringify(context) }] };
    },
  }],
});
const ipc = attachPiAdapterIpc(adapter);
process.once('disconnect', () => { void ipc.shutdown(); });
process.send({ type: 'ready' });
