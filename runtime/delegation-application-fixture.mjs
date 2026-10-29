import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkerAdapter, readDelegationBootstrap } from './pi-worker.mjs';
import { createRuntimeDelegationToolFactory } from './delegation-tools.mjs';
import { attachPiAdapterIpc } from '../agent-host/ipc.mjs';
import { sdk, Type } from '../agent-host/tests/fixture-runtime.mjs';
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(resolve(process.env.AYLACHI_SDK_ROOT, '../..'), '@earendil-works/pi-ai/dist/utils/event-stream.js')).href);
const model = { id: 'gpt-6-luna', provider: 'openai-codex', api: 'openai-codex-responses', name: 'Synthetic delegation fixture', reasoning: true, input: ['text'], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };
const runtime = { getModel: () => model, getAvailable: async () => [model], hasConfiguredAuth: () => true,
  streamSimple(_model, context) {
    const stream = createAssistantMessageEventStream();
    const last = context.messages.at(-1);
    const parent = context.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('ROOT_DELEGATION_REQUEST'));
    const tools = context.messages.flatMap(message => message.role === 'system' ? (message.toolsAdded ?? []).map(tool => tool.name) : []);
    if (!parent && tools.length) throw new Error('CHILD_HAS_TOOLS');
    const toolCall = parent && last?.role !== 'toolResult';
    const content = toolCall ? [{ type: 'toolCall', id: 'root-call-1', name: 'delegate_task', arguments: { text: 'bounded synthetic child task' } }]
      : [{ type: 'text', text: parent ? last.content.map(part => part.text ?? '').join('') : 'CHILD_FORK_OK' }];
    const message = { role: 'assistant', content, stopReason: toolCall ? 'toolUse' : 'stop', api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, timestamp: Date.now() };
    const finish = () => stream.push({ type: 'done', reason: message.stopReason, message });
    if (parent) finish(); else setTimeout(finish, 250);
    return stream;
  },
};
const bootstrap = await readDelegationBootstrap(process, process.env);
const root = process.env.AYLACHI_DEV_STATE_ROOT;
const adapter = createWorkerAdapter({ sdk, modelRuntime: runtime, model, root, cwd: join(root, 'workspace'), deadlineEpochMs: Number(process.env.AYLACHI_DEV_DEADLINE_MS),
  toolDefinitionsFactory: createRuntimeDelegationToolFactory({ Type, connection: bootstrap.connection, allowSession: sessionId => bootstrap.parentSessionIds.includes(sessionId), timeoutMs: 2000, waitTimeoutMs: 4000, pollIntervalMs: 5 }),
});
const ipc = attachPiAdapterIpc(adapter);
process.once('disconnect', () => { void ipc.shutdown(); });
process.send({ type: 'ready' });
