import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertSdkManifest } from '../sdk-compat.mjs';

const sdkRoot = resolve(process.env.AYLACHI_SDK_ROOT ?? "");
assert.ok(sdkRoot, "set AYLACHI_SDK_ROOT to immutable SDK package directory");
const sdkUrl = pathToFileURL(join(sdkRoot, "dist/index.js"));
const sdk = await import(sdkUrl.href);
const manifest = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assertSdkManifest(manifest);
assert.equal(resolve(new URL(sdkUrl).pathname), resolve(join(sdkRoot, "dist/index.js")));
const { createAgentSession, SessionManager, SettingsManager, createExtensionRuntime } = sdk;
for (const name of ["createAgentSession", "SessionManager", "SettingsManager", "createExtensionRuntime"])
  assert.ok(sdk[name], `SDK export missing: ${name}`);

function resources() {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "SDK smoke", getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources() {}, async reload() {},
  };
}
const model = { id: "synthetic", name: "synthetic", api: "openai-completions", provider: "synthetic", baseUrl: "http://127.0.0.1/unused", reasoning: false, input: ["text"], contextWindow: 1024, maxTokens: 128, compat: {} };
const runtime = { getAvailable: async () => [model], getModel: () => model, stream: async () => { throw Error("provider execution forbidden"); }, complete: async () => { throw Error("provider execution forbidden"); } };

test("actual SDK controlled setup, native history append/resume, isolated sessions and empty tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aylachi-sdk-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd"), agentDir = join(root, "agent"), base = join(root, "sessions");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true }), mkdir(base, { recursive: true })]);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const makeSession = async (id) => {
    const dir = join(base, id);
    const result = await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, thinkingLevel: "low", resourceLoader: resources(), sessionManager: SessionManager.create(cwd, dir), settingsManager: settings, tools: [] });
    assert.deepEqual(result.session.getActiveToolNames(), []);
    return result.session;
  };
  const a = await makeSession("a");
  const managerA = a.sessionManager;
  managerA.appendMessage({ role: "user", content: "marker-A-only", timestamp: Date.now() });
  a.dispose();
  const aFileName = (await readdir(join(base, "a"))).find((x) => x.endsWith(".jsonl"));
  assert.ok(aFileName, "native session file not persisted");
  const aPath = join(base, "a", aFileName);
  const resumed = await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, thinkingLevel: "low", resourceLoader: resources(), sessionManager: SessionManager.open(aPath, join(base, "a"), cwd), settingsManager: settings, tools: [] });
  assert.deepEqual(resumed.session.getActiveToolNames(), []);
  assert.ok(resumed.session.messages.some((m) => JSON.stringify(m).includes("marker-A-only")), "resume did not restore marker A");
  resumed.session.dispose();
  const b = await makeSession("b");
  b.sessionManager.appendMessage({ role: "user", content: "marker-B-only", timestamp: Date.now() });
  b.dispose();
  const bFileName = (await readdir(join(base, "b"))).find((x) => x.endsWith(".jsonl"));
  assert.ok(bFileName, "second native session file not persisted");
  const bPath = join(base, "b", bFileName);
  const openedA = SessionManager.open(aPath, join(base, "a"), cwd);
  const openedB = SessionManager.open(bPath, join(base, "b"), cwd);
  assert.ok(JSON.stringify(openedA.buildSessionContext()).includes("marker-A-only"));
  assert.ok(!JSON.stringify(openedA.buildSessionContext()).includes("marker-B-only"));
  assert.ok(JSON.stringify(openedB.buildSessionContext()).includes("marker-B-only"));
  assert.ok(!JSON.stringify(openedB.buildSessionContext()).includes("marker-A-only"));
});
