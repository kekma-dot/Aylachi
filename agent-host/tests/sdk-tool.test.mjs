import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertSdkManifest } from '../sdk-compat.mjs';

const configuredSdkRoot = process.env.AYLACHI_SDK_ROOT;
assert.ok(configuredSdkRoot, "set AYLACHI_SDK_ROOT");
const sdkRoot = resolve(configuredSdkRoot);
const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
const packageRoot = resolve(join(sdkRoot, "../.."));
const aiRoot = join(packageRoot, "@earendil-works/pi-ai");
const typeboxRoot = join(packageRoot, "typebox");
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(aiRoot, "dist/utils/event-stream.js")).href);
const { Type } = await import(pathToFileURL(join(typeboxRoot, "build/index.mjs")).href);
const manifest = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assertSdkManifest(manifest);

const model = { id: "synthetic-tool", name: "Synthetic tool test", api: "openai-completions", provider: "synthetic", baseUrl: "http://127.0.0.1/unused", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function assistant(content, stopReason) {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason, timestamp: Date.now() };
}
function createRuntime() {
  let calls = 0;
  const seenToolResults = [];
  return {
    seenToolResults,
    getAvailable: async () => [model],
    getModel: () => model,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ type: "api_key", source: "synthetic fixture" }),
    isUsingOAuth: () => false,
    streamSimple(selected, context, options) { return this.stream(selected, context, options); },
    stream(_model, context) {
      const stream = createAssistantMessageEventStream();
      const empty = assistant([], "stop");
      stream.push({ type: "start", partial: empty });
      if (calls++ === 0) {
        const call = { type: "toolCall", id: "fixture-call-1", name: "fixture_echo", arguments: { text: "fixture input" } };
        const message = assistant([call], "toolUse");
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
      } else {
        const result = context.messages.findLast((item) => item.role === "toolResult");
        seenToolResults.push(result);
        const final = assistant([{ type: "text", text: `final:${result?.content?.map((item) => item.text ?? "").join("") ?? "missing tool result"}` }], "stop");
        stream.push({ type: "text_start", contentIndex: 0, partial: empty });
        stream.push({ type: "text_end", contentIndex: 0, content: final.content[0].text, partial: final });
        stream.push({ type: "done", reason: "stop", message: final });
      }
      return stream;
    },
    complete: async () => { throw new Error("unexpected provider complete"); },
  };
}

test("actual SDK agent loop executes one fixture tool and consumes its result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aylachi-sdk-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path, { recursive: true })));
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let invocations = 0;
  const tool = {
    name: "fixture_echo", label: "Fixture echo", description: "Echo fixture text",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, args) => { invocations++; return { content: [{ type: "text", text: args.text }] }; },
  };
  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => pi.registerTool(tool)],
  });
  await loader.reload();
  const models = createRuntime();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, model, modelRuntime: models, thinkingLevel: "low", resourceLoader: loader, sessionManager: sdk.SessionManager.create(cwd, sessionDir), settingsManager, tools: ["fixture_echo"] });
  const events = [];
  const unsubscribe = session.subscribe((event) => events.push(event.type));
  try {
    await session.prompt("Use fixture_echo with fixture input.");
    assert.deepEqual(session.getActiveToolNames(), ["fixture_echo"]);
    assert.equal(invocations, 1, JSON.stringify(session.messages));
    assert.ok(events.includes("tool_execution_start"));
    assert.ok(events.includes("tool_execution_end"));
    assert.equal(models.seenToolResults.length, 1);
    assert.equal(models.seenToolResults[0]?.content?.[0]?.text, "fixture input");
    assert.equal(session.getLastAssistantText(), "final:fixture input");
  } finally {
    unsubscribe();
    session.dispose();
  }
});
