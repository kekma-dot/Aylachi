import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, lstat, realpath, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPiAdapter, createDefaultResourceLoader } from '../agent-host/pi-adapter.mjs';
import { attachPiAdapterIpc } from '../agent-host/ipc.mjs';
import { loadRestoredSessionFiles } from './restored-session-files.mjs';
import { snapshotToolsBootstrap } from './tools-bootstrap.mjs';
import { exactDataRecord as exactData, snapshotDelegationBootstrap } from './bootstrap-protocol.mjs';
import { MODEL_PROVIDER, DEFAULT_MODEL_ID, DEFAULT_REASONING, snapshotModelCatalog, snapshotModelSelection } from './model-policy.mjs';

import { loadSelectedSdk, loadSelectedMcpSupport } from '../agent-host/sdk-compat.mjs';

// Backwards-compatible host API name; policy and private SDK imports live in the shim.
export const loadPinnedMcpSupport = loadSelectedMcpSupport;
const PROVIDER = MODEL_PROVIDER;
const MODEL_ID = DEFAULT_MODEL_ID;
const MAX_CALLS = 20;
const MAX_WINDOW_MS = 30 * 60 * 1_000;
const safeError = () => Object.assign(new Error('HOST_START_FAILED'), { code: 'HOST_START_FAILED' });

export function readDelegationBootstrap(channel, env = process.env, options) {
  let enabled;
  try { enabled = env?.AYLACHI_DEV_DELEGATION; } catch { throw safeError(); }
  return readBootstrap(channel, enabled, options, snapshotDelegationBootstrap);
}

export function readToolsBootstrap(channel, env = process.env, options) {
  let enabled;
  try {
    enabled = env?.AYLACHI_DEV_TOOLS;
    if (enabled !== undefined && env?.AYLACHI_DEV_DELEGATION !== undefined) throw safeError();
  } catch { throw safeError(); }
  return readBootstrap(channel, enabled, options, snapshotToolsBootstrap);
}

function readBootstrap(channel, enabled, options, snapshot) {
  if (enabled === undefined) return undefined;
  if (enabled !== '1') throw safeError();
  let timeoutMs = 5000;
  if (options !== undefined) {
    const config = exactData(options, ['timeoutMs']);
    if (!config) throw safeError();
    timeoutMs = config.timeoutMs;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000 || channel?.connected !== true ||
      typeof channel.on !== 'function' || typeof channel.off !== 'function') throw safeError();

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      for (const [event, handler] of [['message', onMessage], ['error', onFailure], ['disconnect', onFailure]]) {
        try { channel.off(event, handler); } catch {}
      }
    };
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (ok) resolvePromise(value); else rejectPromise(safeError());
    };
    const onMessage = message => {
      let frame;
      try { frame = snapshot(message); } catch { finish(false); return; }
      finish(true, frame);
    };
    const onFailure = () => finish(false);
    try {
      channel.on('message', onMessage);
      if (settled) return;
      channel.on('error', onFailure);
      if (settled) return;
      channel.on('disconnect', onFailure);
      if (settled) return;
      timer = setTimeout(() => finish(false), timeoutMs);
    } catch { finish(false); }
  });
}

function validateBudgetArgs({ root, deadlineEpochMs, maxSdkCalls, now }) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) throw new TypeError('absolute app root required');
  if (!Number.isSafeInteger(deadlineEpochMs) || typeof now !== 'function') throw new TypeError('valid deadline and clock required');
  const current = now();
  if (!Number.isFinite(current) || deadlineEpochMs <= current || deadlineEpochMs - current > MAX_WINDOW_MS) throw new RangeError('deadline must be within 30 minutes');
  if (!Number.isInteger(maxSdkCalls) || maxSdkCalls < 1 || maxSdkCalls > MAX_CALLS) throw new RangeError('invalid SDK call limit');
}

const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function readTurnOptions(options, catalog) {
  if (options === undefined) return { turnId: undefined, selection: catalog.default, explicit: false };
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError();
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(options);
    if (keys.length < 1 || keys.length > 2 || !keys.includes('turnId') || keys.some(key => !['turnId', 'model'].includes(key))) throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(options, 'turnId');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true || typeof descriptor.value !== 'string' || !TURN_ID.test(descriptor.value)) throw new TypeError();
    return { turnId: descriptor.value, selection: Object.hasOwn(options, 'model') ? snapshotModelSelection(options.model, catalog) : catalog.default, explicit: Object.hasOwn(options, 'model') };
  } catch {
    throw new TypeError('invalid turn context');
  }
}

function writeBudget(root, record) {
  const target = join(root, 'live-budget.json');
  const temporary = join(root, `.live-budget-${process.pid}-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    const dirFd = openSync(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(temporary); } catch {}
    throw new Error('LIVE_BUDGET_PERSIST_FAILED');
  }
}

function loadBudget(root, deadlineEpochMs, maxSdkCalls) {
  const target = join(root, 'live-budget.json');
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('LIVE_BUDGET_INVALID');
  let fd;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)); }
  catch (failure) {
    if (failure?.code !== 'ENOENT') throw new Error('LIVE_BUDGET_INVALID');
    try {
      fd = openSync(target, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, deadlineEpochMs, maxSdkCalls, sdkCallsStarted: 0 })}\n`, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const dirFd = openSync(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      return 0;
    } catch {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      throw new Error('LIVE_BUDGET_INVALID');
    }
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1_024 || (stat.mode & 0o077) !== 0 || typeof process.getuid !== 'function' || stat.uid !== process.getuid()) throw new Error('LIVE_BUDGET_INVALID');
    const record = JSON.parse(readFileSync(fd, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion !== 1 ||
        record.deadlineEpochMs !== deadlineEpochMs || record.maxSdkCalls !== maxSdkCalls ||
        !Number.isInteger(record.sdkCallsStarted) || record.sdkCallsStarted < 0 || record.sdkCallsStarted > maxSdkCalls) throw new Error('LIVE_BUDGET_INVALID');
    return record.sdkCallsStarted;
  } catch { throw new Error('LIVE_BUDGET_INVALID'); }
  finally { closeSync(fd); }
}

export function createWorkerAdapter({ sdk, modelRuntime, model, models = [model], root, cwd, deadlineEpochMs, maxSdkCalls = MAX_CALLS, now = Date.now, toolDefinitionsFactory, extensionFactoriesFactory, resourceLoaderFactory, onEvent, restoredSessionFiles }) {
  validateBudgetArgs({ root, deadlineEpochMs, maxSdkCalls, now });
  if (!sdk || !modelRuntime || typeof modelRuntime.streamSimple !== 'function' || !model || typeof model.id !== 'string' || typeof model.provider !== 'string' || typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new TypeError('explicit SDK, authorized model/runtime, root and cwd required');
  }
  if (toolDefinitionsFactory !== undefined && typeof toolDefinitionsFactory !== 'function') throw new TypeError('toolDefinitionsFactory must be a trusted function');
  if (extensionFactoriesFactory !== undefined && typeof extensionFactoriesFactory !== 'function') throw new TypeError('extensionFactoriesFactory must be a trusted function');
  if (resourceLoaderFactory !== undefined && typeof resourceLoaderFactory !== 'function') throw new TypeError('resourceLoaderFactory must be a trusted function');
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('onEvent must be a trusted function');
  const catalog = snapshotModelCatalog({ models: models.map(item => ({ provider: item.provider, id: item.id, name: item.name || item.id, contextWindow: item.contextWindow })),
    default: { provider: model.provider, modelId: model.id, reasoning: DEFAULT_REASONING } }, model.provider);
  const authorizedModels = new Map(models.map(item => [`${item.provider}/${item.id}`, item]));
  let sdkCallsStarted = loadBudget(root, deadlineEpochMs, maxSdkCalls);
  const originalStreamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  const wrappedRuntime = new Proxy(modelRuntime, {
    get(target, property, receiver) {
      if (property === 'streamSimple') return (targetModel, context, options = {}) => {
        const selection = { provider: targetModel?.provider, modelId: targetModel?.id, reasoning: options.reasoning ?? DEFAULT_REASONING };
        try { snapshotModelSelection(selection, catalog); } catch { throw new Error('MODEL_POLICY_REJECTED'); }
        if (!authorizedModels.has(`${selection.provider}/${selection.modelId}`)) throw new Error('MODEL_POLICY_REJECTED');
        const remainingMs = Math.floor(deadlineEpochMs - now());
        if (remainingMs <= 0) throw new Error('WORKER_DEADLINE_EXPIRED');
        if (sdkCallsStarted >= maxSdkCalls) throw new Error('SDK_CALL_LIMIT_REACHED');
        const nextCount = sdkCallsStarted + 1;
        writeBudget(root, { schemaVersion: 1, deadlineEpochMs, maxSdkCalls, sdkCallsStarted: nextCount });
        sdkCallsStarted = nextCount;
        const deadlineSignal = AbortSignal.timeout(remainingMs);
        const signal = options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal;
        return originalStreamSimple(targetModel, context, { ...options, maxRetries: 0, signal });
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const turnStorage = new AsyncLocalStorage();
  const getTurnContext = () => {
    const scope = turnStorage.getStore();
    return scope?.active ? scope.context : undefined;
  };
  const adapterOptions = { sdk, modelRuntime: wrappedRuntime, model, root: join(root, 'pi'), cwd, toolDefinitions: [],
    ...(onEvent === undefined ? {} : { onEvent }), ...(restoredSessionFiles === undefined ? {} : { restoredSessionFiles }) };
  if (toolDefinitionsFactory) {
    adapterOptions.toolDefinitionsFactory = selection => toolDefinitionsFactory({ ...selection, getTurnContext });
  }
  if (extensionFactoriesFactory) {
    adapterOptions.extensionFactoriesFactory = selection => extensionFactoriesFactory({ ...selection, getTurnContext });
  }
  if (resourceLoaderFactory) {
    adapterOptions.resourceLoaderFactory = selection => resourceLoaderFactory({ ...selection, getTurnContext });
  }
  const adapter = createPiAdapter(adapterOptions);
  return {
    async prompt(id, text, options) {
      const { turnId, selection, explicit } = readTurnOptions(options, catalog);
      const selectedModel = authorizedModels.get(`${selection.provider}/${selection.modelId}`);
      const context = turnId === undefined ? undefined : Object.freeze({ sessionId: id, turnId });
      const scope = { active: true, context };
      return turnStorage.run(scope, async () => {
        try { return await adapter.prompt(id, text, ...(explicit ? [{ model: selectedModel, reasoning: selection.reasoning }] : [])); }
        finally { scope.active = false; }
      });
    },
    cancel(id) { return adapter.cancel(id); },
    shutdown() { return adapter.shutdown(); },
  };
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await realpath(path) !== path) throw safeError();
}

export function parseWorkerEnvironment(env, now) {
  const root = env?.AYLACHI_DEV_STATE_ROOT;
  const sdkRoot = env?.AYLACHI_SDK_ROOT;
  const authPath = env?.AYLACHI_DEV_AUTH_PATH;
  const deadlineText = env?.AYLACHI_DEV_DEADLINE_MS;
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root ||
      typeof sdkRoot !== 'string' || !isAbsolute(sdkRoot) || resolve(sdkRoot) !== sdkRoot ||
      typeof authPath !== 'string' || !isAbsolute(authPath) || resolve(authPath) !== authPath ||
      typeof deadlineText !== 'string' || !/^\d+$/.test(deadlineText)) throw safeError();
  const deadlineEpochMs = Number(deadlineText);
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= now || deadlineEpochMs - now > MAX_WINDOW_MS) throw safeError();
  const calls = env?.AYLACHI_DEV_MAX_SDK_CALLS;
  if (calls !== undefined && (typeof calls !== 'string' || !/^(?:[1-9]|1[0-9]|20)$/.test(calls))) throw safeError();
  return { root, sdkRoot, authPath, deadlineEpochMs, ...(calls === undefined ? {} : { maxSdkCalls: Number(calls) }) };
}

export function createWorkerModelRuntime(sdk, authPath) {
  if (typeof authPath !== 'string' || !isAbsolute(authPath) || resolve(authPath) !== authPath || typeof sdk?.ModelRuntime?.create !== 'function') throw safeError();
  return sdk.ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
}

async function loadPinnedTypebox(sdkRoot, sdkManifest) {
  const version = sdkManifest?.dependencies?.typebox;
  if (version !== '1.3.27') throw safeError();
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(join(sdkRoot, 'package.json'));
    const entry = require.resolve('typebox');
    const packageRoot = dirname(dirname(entry));
    if (await realpath(packageRoot) !== packageRoot) throw safeError();
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== 'typebox' || manifest.version !== version) throw safeError();
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.Type?.Object !== 'function' || typeof module.Type?.String !== 'function') throw safeError();
    return module.Type;
  } catch { throw safeError(); }
}

async function sendFrame(channel, frame) {
  await new Promise((resolvePromise, rejectPromise) => {
    try {
      if (!channel.connected || channel.send(frame, failure => failure ? rejectPromise(failure) : resolvePromise()) === false) rejectPromise(new Error('IPC_SEND_FAILED'));
    } catch (failure) { rejectPromise(failure); }
  });
}

async function runWorker(channel = process, env = process.env) {
  let adapter;
  let ipc;
  try {
    if (!channel.connected || typeof channel.send !== 'function' || typeof channel.on !== 'function' || typeof channel.off !== 'function') throw safeError();
    const toolsPending = readToolsBootstrap(channel, env);
    const toolsBootstrap = toolsPending === undefined ? undefined : await toolsPending;
    const bootstrapPending = toolsBootstrap ? undefined : readDelegationBootstrap(channel, env);
    const delegationBootstrap = toolsBootstrap && toolsBootstrap.delegationSessionIds.length ? {
      connection: toolsBootstrap.connection, parentSessionIds: toolsBootstrap.delegationSessionIds,
    } : bootstrapPending === undefined ? undefined : await bootstrapPending;
    const now = Date.now;
    const { root, sdkRoot, authPath, deadlineEpochMs, maxSdkCalls } = parseWorkerEnvironment(env, now());
    await ensurePrivateDirectory(root);
    const restoredSessionFiles = await loadRestoredSessionFiles(root);
    const cwd = join(root, 'workspace');
    await Promise.all([ensurePrivateDirectory(join(root, 'pi')), ensurePrivateDirectory(cwd)]);
    const { sdk, manifest } = await loadSelectedSdk(sdkRoot);
    let toolDefinitionsFactory;
    const factories = [];
    const Type = delegationBootstrap || toolsBootstrap ? await loadPinnedTypebox(sdkRoot, manifest) : undefined;
    if (delegationBootstrap) {
      const { createRuntimeDelegationToolFactory } = await import('./delegation-tools.mjs');
      factories.push(createRuntimeDelegationToolFactory({
        Type,
        connection: delegationBootstrap.connection,
        allowSession: sessionId => delegationBootstrap.parentSessionIds.includes(sessionId),
        timeoutMs: 20_000,
        waitTimeoutMs: 20_000,
        pollIntervalMs: 10,
      }));
    }
    if (toolsBootstrap?.projectBindings.length) {
      const { createRuntimeProjectContextToolFactory } = await import('./project-context-tools.mjs');
      const bindings = new Map(toolsBootstrap.projectBindings.map(binding => [binding.sessionId, binding]));
      factories.push(createRuntimeProjectContextToolFactory({
        Type, connection: toolsBootstrap.connection, getSessionBinding: sessionId => bindings.get(sessionId), timeoutMs: 5000,
      }));
    }
    let extensionFactoriesFactory;
    const artifactConnection = toolsBootstrap?.artifactEngine ? toolsBootstrap.connection
      : delegationBootstrap?.artifactEngine ? delegationBootstrap.connection : undefined;
    if (artifactConnection) {
      const { createArtifactExtension, createArtifactTool } = await import('../artifact-engine/pi-extension.mjs');
      factories.push(({ sessionId, getTurnContext }) => [createArtifactTool({
        Type, connection: artifactConnection, sessionId, getTurnContext,
      })]);
      extensionFactoriesFactory = ({ sessionId, getTurnContext }) => [createArtifactExtension({
        Type, connection: artifactConnection, sessionId, getTurnContext,
      })];
    }
    const themeConnection = toolsBootstrap?.themes ? toolsBootstrap.connection
      : delegationBootstrap?.themes ? delegationBootstrap.connection : undefined;
    if (themeConnection) {
      const { createThemeProposalTool } = await import('../themes/pi-extension.mjs');
      factories.push(({ sessionId, getTurnContext }) => [createThemeProposalTool({
        Type, connection: themeConnection, sessionId, getTurnContext,
      })]);
    }
    let resourceLoaderFactory;
    if (toolsBootstrap?.nativeMcpBindings?.length) {
      const { createNativeMcpFactories } = await import('./native-mcp-loader.mjs');
      const native = createNativeMcpFactories({ bindings: toolsBootstrap.nativeMcpBindings, ...await loadPinnedMcpSupport(sdkRoot) });
      factories.push(native.toolDefinitionsFactory);
      resourceLoaderFactory = native.resourceLoaderFactory;
    }
    if (toolsBootstrap?.nativeSkillBindings?.length) {
      const { prepareNativeSkills } = await import('./native-skills.mjs');
      const { withNativeSkillResources } = await import('./native-skills-resources.mjs');
      const skillsBySession = await prepareNativeSkills({ workspace: cwd, bindings: toolsBootstrap.nativeSkillBindings });
      const baseFactory = resourceLoaderFactory;
      resourceLoaderFactory = async selection => {
        const loader = baseFactory ? await baseFactory(selection) : createDefaultResourceLoader(selection);
        return withNativeSkillResources(loader, skillsBySession[selection.sessionId] ?? [], selection);
      };
    }
    if (factories.length) toolDefinitionsFactory = selection => factories.flatMap(factory => factory(selection));
    const modelRuntime = await createWorkerModelRuntime(sdk, authPath);
    const refresh = await modelRuntime.refresh({ providers: [PROVIDER], allowNetwork: false });
    if (refresh?.aborted || refresh?.errors?.has?.(PROVIDER)) throw safeError();
    const model = modelRuntime.getPhysicalModel(PROVIDER, MODEL_ID);
    if (!model || typeof modelRuntime.hasConfiguredAuth !== 'function' || !modelRuntime.hasConfiguredAuth(PROVIDER) ||
        typeof modelRuntime.isUsingOAuth !== 'function' || !modelRuntime.isUsingOAuth(PROVIDER)) throw safeError();
    const models = (typeof modelRuntime.getModels === 'function' ? modelRuntime.getModels(PROVIDER) : [model])
      .filter(item => item.reasoning === true && modelRuntime.getPhysicalModel(PROVIDER, item.id));
    if (!models.some(item => item.id === MODEL_ID)) throw safeError();
    const modelCatalog = snapshotModelCatalog({ models: models.map(item => ({ provider: PROVIDER, id: item.id, name: item.name || item.id, contextWindow: item.contextWindow })),
      default: { provider: PROVIDER, modelId: MODEL_ID, reasoning: DEFAULT_REASONING } });
    adapter = createWorkerAdapter({ sdk, modelRuntime, model, models, root, cwd, deadlineEpochMs,
      onEvent: event => { void sendFrame(channel, { type: 'execution_event', event }).catch(() => {}); },
      ...(maxSdkCalls === undefined ? {} : { maxSdkCalls }), ...(toolDefinitionsFactory ? { toolDefinitionsFactory } : {}),
      ...(extensionFactoriesFactory ? { extensionFactoriesFactory } : {}),
      ...(resourceLoaderFactory ? { resourceLoaderFactory } : {}), ...(restoredSessionFiles === undefined ? {} : { restoredSessionFiles }) });
    ipc = attachPiAdapterIpc(adapter, channel);
    channel.once?.('disconnect', () => { void ipc.shutdown().catch(() => { process.exitCode = 1; }); });
    await sendFrame(channel, { type: 'ready', modelCatalog });
  } catch (error) {
    ipc?.detach();
    if (adapter) { try { await adapter.shutdown(); } catch {} }
    if (channel.connected && typeof channel.send === 'function') {
      const code = ['SDK_VERSION_UNSUPPORTED', 'SDK_API_UNSUPPORTED', 'SDK_COHORT_UNSUPPORTED'].includes(error?.code) ? error.code : 'HOST_START_FAILED';
      try { channel.send({ type: 'startup_error', code }, () => channel.disconnect?.()); }
      catch { process.exitCode = 1; }
    } else process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runWorker();
