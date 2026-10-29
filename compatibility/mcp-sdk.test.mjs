import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertSdkManifest } from '../agent-host/sdk-compat.mjs';

const sdkRoot = resolve(process.env.AYLACHI_SDK_ROOT ?? "");
assert.ok(process.env.AYLACHI_SDK_ROOT, "set AYLACHI_SDK_ROOT to selected qualified Pi SDK");
const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
const packageRoot = resolve(join(sdkRoot, "../.."));
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(packageRoot, "@earendil-works/pi-ai/dist/utils/event-stream.js")).href);
const { InMemoryAuthStorageBackend } = await import(pathToFileURL(join(sdkRoot, "dist/core/auth-storage.js")).href);
const { McpOAuthCredentialStore } = await import(pathToFileURL(join(sdkRoot, "dist/extensions/mcp/oauth.js")).href);
const manifest = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
const mcpManifest = JSON.parse(await readFile(join(packageRoot, "@earendil-works/pi-mcp/package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assertSdkManifest(manifest);
assert.equal(mcpManifest.version, manifest.version);

const model = { id: "synthetic-mcp", name: "Synthetic MCP test", api: "openai-completions", provider: "synthetic", baseUrl: "http://127.0.0.1/unused", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const assistant = (content, stopReason) => ({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason, timestamp: Date.now() });
const waitFor = async (check, timeoutMs = 10000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};
const readIfExists = async (path) => readFile(path, "utf8").catch(() => undefined);

function syntheticRuntime() {
  let calls = 0;
  const toolResults = [];
  const runtime = {
    toolResults,
    getAvailable: async () => [model],
    getModel: () => model,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ type: "api_key", source: "synthetic fixture" }),
    isUsingOAuth: () => false,
    streamSimple(selected, context, options) { return this.stream(selected, context, options); },
    stream(_selected, context) {
      const stream = createAssistantMessageEventStream();
      const empty = assistant([], "stop");
      stream.push({ type: "start", partial: empty });
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") {
        toolResults.push(last);
        const text = last.content?.map((item) => item.text ?? "").join("") ?? "";
        const final = assistant([{ type: "text", text: `observed:${text}` }], "stop");
        stream.push({ type: "text_start", contentIndex: 0, partial: empty });
        stream.push({ type: "text_end", contentIndex: 0, content: final.content[0].text, partial: final });
        stream.push({ type: "done", reason: "stop", message: final });
      } else {
        const call = { type: "toolCall", id: `mcp-fixture-${++calls}`, name: "mcp__fixture__echo", arguments: { text: calls === 1 ? "safe" : "fail" } };
        const message = assistant([call], "toolUse");
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
      }
      return stream;
    },
    complete: async () => { throw new Error("unexpected provider complete"); },
  };
  return runtime;
}

test("selected Pi SDK native MCP extension performs stdio initialize/list/call and shuts down its server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aylachi-mcp-sdk-"));
  const cwd = join(root, "cwd"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path, { recursive: true })));
  const auditPath = join(root, "mcp-audit.jsonl"), startPath = join(root, "mcp-started.pid"), exitPath = join(root, "mcp-exited.pid");
  const fixturePath = new URL("./mcp-fixture-server.mjs", import.meta.url).pathname;
  const toolName = "mcp__fixture__echo";
  process.env.HOME = agentDir;
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let registeredServer, registrationConfig;
  let loadConfigCalls = 0, openUrlCalls = 0, updateConfigCalls = 0;
  const credentialStore = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend(), root);
  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      sdk.createMcpExtension({
        loadConfig: () => { loadConfigCalls++; return { servers: [], errors: [], autoEnableCodemode: false, projectConfig: undefined }; },
        credentials: credentialStore,
        logPath: join(root, "mcp.log"),
        openUrl: () => { openUrlCalls++; throw new Error("unexpected auth flow in fixture"); },
        updateConfig: () => { updateConfigCalls++; throw new Error("unexpected config write in fixture"); },
      }),
      (pi) => {
        registrationConfig = {
          type: "stdio",
          command: process.execPath,
          args: [fixturePath, auditPath, startPath, exitPath],
          cwd,
          env: {},
          exposure: "direct",
          description: "One isolated, local safe echo fixture",
          timeout: 5,
        };
        pi.registerMcpServer("fixture", registrationConfig);
        pi.on("session_start", () => {
          registeredServer = pi.getMcpServers().find((server) => server.name === "fixture");
        });
      },
    ],
  });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0, JSON.stringify(loader.getExtensions().errors));
  assert.equal(registrationConfig?.command, process.execPath, "fixture must use the current Node executable");
  assert.equal(registrationConfig?.type, "stdio");
  const modelRuntime = syntheticRuntime();
  const { session } = await sdk.createAgentSession({
    cwd, agentDir, model, modelRuntime, thinkingLevel: "low", resourceLoader: loader,
    sessionManager: sdk.SessionManager.create(cwd, sessionDir), settingsManager,
    tools: [toolName],
  });
  const services = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] };
  const host = new sdk.AgentSessionRuntime(session, services, async () => { throw new Error("session replacement is outside this test"); });
  let disposed = false;
  t.after(async () => {
    if (!disposed) {
      await host.dispose();
      disposed = true;
    }
    if (await readIfExists(startPath)) await waitFor(() => readIfExists(exitPath));
    await rm(root, { recursive: true, force: true });
  });

  try {
    await session.bindExtensions({});
    if (!registeredServer) {
      assert.fail(`registered MCP server was not visible after runner bind: ${JSON.stringify({ extensionErrors: loader.getExtensions().errors, registrationConfig, fixtureAudit: await readIfExists(auditPath) })}`);
    }
    const readiness = await waitFor(async () =>
      session.getActiveToolNames().includes(toolName) ||
      loader.getExtensions().errors.length > 0 ||
      Boolean(await readIfExists(exitPath)),
    );
    const activeTools = session.getActiveToolNames();
    if (!readiness || !activeTools.includes(toolName)) {
      const diagnostics = {
        activeTools,
        extensionErrors: loader.getExtensions().errors,
        loadedExtensions: loader.getExtensions().extensions.map((extension) => ({ path: extension.path, hasSessionStart: extension.handlers.has("session_start") })),
        registeredServer,
        registrationConfig,
        fixtureStarted: await readIfExists(startPath),
        fixtureAudit: await readIfExists(auditPath),
        fixtureExited: await readIfExists(exitPath),
        mcpLog: await readIfExists(join(root, "mcp.log")),
        ioSeams: { loadConfigCalls, openUrlCalls, updateConfigCalls },
      };
      assert.fail(`MCP fixture did not become an active tool or report a loader error: ${JSON.stringify(diagnostics)}`);
    }
    assert.deepEqual(activeTools, [toolName], "explicit tool allowlist must exclude defaults");
    assert.equal(loadConfigCalls, 1, "MCP config must come only from the injected empty fixture");
    assert.equal(openUrlCalls, 0, "authentication must not start");
    assert.equal(updateConfigCalls, 0, "test must not write MCP configuration");
    await session.prompt("Invoke the isolated echo tool successfully.");
    assert.match(session.getLastAssistantText(), /observed:echo:safe/);
    await session.prompt("Invoke the isolated echo tool and observe its tool error.");
    assert.match(session.getLastAssistantText(), /intentional fixture tool error/);
    assert.equal(modelRuntime.toolResults.length, 2);
    assert.match(modelRuntime.toolResults[0].content.map((item) => item.text ?? "").join(""), /echo:safe/);
    assert.match(modelRuntime.toolResults[1].content.map((item) => item.text ?? "").join(""), /intentional fixture tool error/);
    assert.equal(modelRuntime.toolResults[1].isError, true);
  } finally {
    await host.dispose();
    disposed = true;
  }

  assert.ok(await readIfExists(startPath), "fixture process must have started");
  assert.ok(await waitFor(() => readIfExists(exitPath)), "session_shutdown must await MCP fixture process exit");
  const audit = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const methods = audit.map((entry) => entry.method);
  assert.ok(methods.includes("initialize"), JSON.stringify(methods));
  assert.ok(methods.includes("tools/list"), JSON.stringify(methods));
  const calls = audit.filter((entry) => entry.method === "tools/call");
  assert.deepEqual(calls.map((entry) => [entry.params.name, entry.params.arguments.text]), [["echo", "safe"], ["echo", "fail"]]);
  const replies = audit.filter((entry) => entry.method === "fixture/result");
  assert.deepEqual(replies.map((entry) => entry.isError), [false, true]);
  console.log(JSON.stringify({ sdk: `${manifest.name}@${manifest.version}`, mcp: `${mcpManifest.name}@${mcpManifest.version}`, node: process.version, transport: "native MCP stdio", protocol: methods.filter((method) => ["initialize", "tools/list", "tools/call"].includes(method)), calls: calls.length, toolError: replies[1].isError, serverExitPid: (await readFile(exitPath, "utf8")).trim() }));
});
