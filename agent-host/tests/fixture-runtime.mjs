import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSdkManifest } from '../sdk-compat.mjs';

assert.ok(process.env.AYLACHI_SDK_ROOT, 'set AYLACHI_SDK_ROOT');
const sdkRoot = resolve(process.env.AYLACHI_SDK_ROOT);
export const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
const manifest = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
assertSdkManifest(manifest);
const dependencies = resolve(sdkRoot, '../..');
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(dependencies, '@earendil-works/pi-ai/dist/index.js')).href);
export { createAssistantMessageEventStream };
export const { Type } = await import(pathToFileURL(join(dependencies, 'typebox/build/index.mjs')).href);
export const model = { id: 'synthetic-adapter', name: 'Synthetic adapter', api: 'openai-completions', provider: 'synthetic', baseUrl: 'http://127.0.0.1/unused', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const message = (content, stopReason) => ({ role: 'assistant', content, stopReason, model: model.id, api: model.api, provider: model.provider, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, timestamp: Date.now() });
export function runtime({ fail = false, waitForAbort = false, onStart = () => {}, toolName = 'fixture_echo' } = {}) {
  let sequence = 0;
  return {
    getModel: () => model, getAvailable: async () => [model], hasConfiguredAuth: () => true,
    streamSimple(_model, context, options) {
      const stream = createAssistantMessageEventStream();
      onStart();
      const end = value => stream.push({ type: value.stopReason === 'error' || value.stopReason === 'aborted' ? 'error' : 'done', reason: value.stopReason, ...(value.stopReason === 'error' || value.stopReason === 'aborted' ? { error: value } : { message: value }) });
      if (waitForAbort) {
        const abort = () => end(message([], 'aborted'));
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
      } else if (fail) end({ ...message([], 'error'), errorMessage: 'synthetic failure' });
      else if (context.messages.at(-1)?.role === 'toolResult') end(message([{ type: 'text', text: 'fixture complete' }], 'stop'));
      else end(message([{ type: 'toolCall', id: `call-${++sequence}`, name: toolName, arguments: { text: 'safe fixture' } }], 'toolUse'));
      return stream;
    },
  };
}
