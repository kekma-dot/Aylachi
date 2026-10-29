import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotWorkerIsolation, prepareOfflineWorkerSpawn } from './worker-isolation.mjs';
import { openSourceWorkbench, snapshotSourceWorkbenchConfig } from '../source-workbench/store.mjs';
import { createSourceRoutes } from '../source-workbench/hub-routes.mjs';
import { snapshotModelSelection, modelPatch } from './model-policy.mjs';
import { makeRunner, startWorker } from './worker-host.mjs';
import { checkedSessionIds, exactDataRecord as exactData } from './bootstrap-protocol.mjs';
export { makeRunner } from './worker-host.mjs';
import { ADDRESS_NAME, BEARER_NAME, ROOT_MARKER, acquireLock, assertCanonicalAbsolute, consumeLiveApproval, ensureBearer,
  ensureDatabaseFile, ensurePrivateDir, initializeRoot, privateRegular, readPrivate, releaseLock, removeAddress, trustedAuthPath,
  trustedSdkRoot, validateRoot, writeAddress } from './development-state.mjs';
export { withOfflineDevelopmentState } from './development-state.mjs';

const PROJECT_ID = 'aylachi-private-dev';
const OWNER_ID = 'aylachi-dev-owner';
const CANVAS_ID = 'fixture';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 46231;
const DEVELOPMENT_LIFETIME_MS = 30 * 60_000;
const LIVE_CLEANUP_MARGIN_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const unresolvedStartupOwners = new Set();

const coded = (code, exitCode = 1) => Object.assign(new Error(code), { code, exitCode });
const modePrivate = stat => (stat.mode & 0o077) === 0;
const uid = () => typeof process.getuid === 'function' ? process.getuid() : null;

function abortError(signal) { if (signal?.aborted) throw coded('STARTUP_CANCELLED', 1); }

function snapshotDelegationOptions(value) {
  if (value === undefined) return undefined;
  const options = exactData(value, ['parentSessionIds']);
  const parentSessionIds = options && checkedSessionIds(options.parentSessionIds);
  if (!parentSessionIds) throw coded('DELEGATION_OPTIONS_INVALID', 64);
  return Object.freeze({ parentSessionIds: Object.freeze([...parentSessionIds]) });
}

function checkedDisabledModules(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isInteger(length) || length > 2) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes('length')) return null;
    const modules = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !['wiki', 'handoff'].includes(descriptor.value)) return null;
      modules.push(descriptor.value);
    }
    return new Set(modules).size === modules.length ? modules : null;
  } catch { return null; }
}

function snapshotDisabledModules(value) {
  if (value === undefined) return Object.freeze([]);
  const modules = checkedDisabledModules(value);
  if (!modules) throw coded('MODULE_OPTIONS_INVALID', 64);
  return Object.freeze([...modules]);
}

function snapshotSatelliteOptions(value) {
  if (value === undefined) return undefined;
  const options = exactData(value, ['registrations']) ?? exactData(value, ['registrations', 'port']) ?? exactData(value, ['registrations', 'port', 'host', 'allowRemote']);
  if (!options || !Array.isArray(options.registrations) || options.registrations.length < 1 || options.registrations.length > 8 ||
      (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) ||
      (options.host !== undefined && typeof options.host !== 'string') || (options.allowRemote !== undefined && typeof options.allowRemote !== 'boolean')) throw coded('SATELLITE_CONFIG_INVALID', 64);
  const registrations = options.registrations.map(input => {
    const registration = exactData(input, ['id', 'secret', 'tools', 'capabilities']);
    if (!registration || !ID.test(registration.id ?? '') || typeof registration.secret !== 'string' || registration.secret.length < 32 || registration.secret.length > 4096 ||
        !Array.isArray(registration.tools) || !registration.tools.length || registration.tools.length > 128 || registration.tools.some(tool => !ID.test(tool ?? '')) ||
        !Array.isArray(registration.capabilities) || registration.capabilities.length > 128 || registration.capabilities.some(capability => typeof capability !== 'string' || !/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/.test(capability))) {
      throw coded('SATELLITE_CONFIG_INVALID', 64);
    }
    return Object.freeze({ id: registration.id, secret: registration.secret,
      tools: Object.freeze([...registration.tools]), capabilities: Object.freeze([...registration.capabilities]) });
  });
  return Object.freeze({ registrations: Object.freeze(registrations), port: options.port ?? 0, host: options.host ?? HOST, allowRemote: options.allowRemote ?? false });
}

export function snapshotLiveLimits(value) {
  if (value === undefined) return Object.freeze({ maxSdkCalls: 20, durationMs: DEVELOPMENT_LIFETIME_MS });
  const limits = exactData(value, ['maxSdkCalls', 'durationMs']);
  if (!limits || !Number.isInteger(limits.maxSdkCalls) || limits.maxSdkCalls < 1 || limits.maxSdkCalls > 20 ||
      !Number.isSafeInteger(limits.durationMs) || limits.durationMs < 10_000 || limits.durationMs > DEVELOPMENT_LIFETIME_MS) {
    throw coded('LIVE_LIMITS_INVALID', 64);
  }
  return Object.freeze({ ...limits });
}

async function waitBounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(coded('CLEANUP_TIMEOUT')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// workerDependencies is an in-process fake-child seam; the CLI never supplies it.
export async function startDevelopmentServer({ stateRoot, port = DEFAULT_PORT, allowLive = false, sdkRoot, signal, workerDependencies, workerIsolation, delegation, requireDelegationApproval = false, projectContext, nativeMcp, nativeSkills, sourceWorkbench, liveLimits, disabledModules: requestedDisabledModules, plugins: requestedPlugins, channelAdapter, memoryPromotion, browserAdapters, satellite } = {}) {
  const isolation = snapshotWorkerIsolation(workerIsolation);
  if (isolation && (!allowLive || workerDependencies !== undefined || delegation !== undefined || projectContext !== undefined || nativeMcp !== undefined)) throw coded('WORKER_ISOLATION_INVALID', 64);
  const isolationAuthPath = isolation ? process.env.AYLACHI_DEV_AUTH_PATH : undefined;
  if (isolation && typeof isolationAuthPath !== 'string') throw coded('WORKER_ISOLATION_INVALID', 64);
  const disabledModules = snapshotDisabledModules(requestedDisabledModules);
  const disabledModuleSet = new Set(disabledModules);
  const satelliteOptions = snapshotSatelliteOptions(satellite);
  const channelOptions = channelAdapter === undefined ? undefined : exactData(channelAdapter, ['id', 'send']);
  if (channelAdapter !== undefined && (!channelOptions || !ID.test(channelOptions.id ?? '') || typeof channelOptions.send !== 'function')) throw coded('CHANNEL_CONFIG_INVALID', 64);
  const promotionOptions = memoryPromotion === undefined ? undefined : exactData(memoryPromotion, ['promotionPolicy', 'applyPromotion']);
  if (memoryPromotion !== undefined && (!promotionOptions || typeof promotionOptions.promotionPolicy !== 'function' || typeof promotionOptions.applyPromotion !== 'function')) throw coded('MEMORY_CONFIG_INVALID', 64);
  const browserOptions = browserAdapters === undefined ? undefined : exactData(browserAdapters, ['remoteReadOnly', 'localInteractive']);
  if (browserAdapters !== undefined && (!browserOptions ||
      browserOptions.remoteReadOnly !== undefined && (typeof browserOptions.remoteReadOnly.navigate !== 'function' || typeof browserOptions.remoteReadOnly.health !== 'function') ||
      browserOptions.localInteractive !== undefined && (typeof browserOptions.localInteractive.snapshot !== 'function' || typeof browserOptions.localInteractive.health !== 'function'))) throw coded('BROWSER_CONFIG_INVALID', 64);
  assertCanonicalAbsolute(stateRoot, 'INVALID_STATE_ROOT');
  let sourceConfig;
  if (sourceWorkbench !== undefined) {
    const config = exactData(sourceWorkbench, ['labRoot', 'files']);
    if (!config) throw coded('SOURCE_OPTIONS_INVALID', 64);
    try {
      sourceConfig = snapshotSourceWorkbenchConfig({ ...config,
        forbiddenRoots: [stateRoot, dirname(SCRIPT_DIR), resolve(process.env.HOME || homedir()), '/srv/aylachi/baza'],
        authorize: async ({ actor }) => actor === OWNER_ID,
      });
    } catch { throw coded('SOURCE_OPTIONS_INVALID', 64); }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw coded('INVALID_PORT', 64);
  if (typeof allowLive !== 'boolean' || (allowLive && !sdkRoot) || (!allowLive && sdkRoot !== undefined)) throw coded('LIVE_FLAGS_INVALID', 64);
  const limits = snapshotLiveLimits(liveLimits);
  if (liveLimits !== undefined && !allowLive) throw coded('LIVE_FLAGS_INVALID', 64);
  const stopAt = Date.now() + limits.durationMs;
  const delegationOptions = snapshotDelegationOptions(delegation);
  if (delegationOptions && !allowLive) throw coded('LIVE_FLAGS_INVALID', 64);
  if (typeof requireDelegationApproval !== 'boolean' || (requireDelegationApproval && !delegationOptions)) throw coded('LIVE_FLAGS_INVALID', 64);
  let core;
  const projectModule = projectContext === undefined ? undefined : (await import('../projects/runtime-module.mjs')).createBoundProjectContextModule({
    config: projectContext, getStore: () => core, ownerId: OWNER_ID, canvasId: CANVAS_ID,
  });
  const nativeMcpOptions = nativeMcp === undefined ? undefined : exactData(nativeMcp, ['bindings']);
  if (nativeMcp !== undefined && (!allowLive || !nativeMcpOptions)) throw coded('NATIVE_MCP_CONFIG_INVALID', 64);
  const nativeMcpBindings = nativeMcpOptions === undefined ? undefined
    : (await import('./native-mcp-config.mjs')).snapshotNativeMcpBindings(nativeMcpOptions.bindings);
  if (nativeMcpBindings && !nativeMcpBindings.length) throw coded('NATIVE_MCP_CONFIG_INVALID', 64);
  const nativeSkillOptions = nativeSkills === undefined ? undefined : exactData(nativeSkills, ['bindings']);
  if (nativeSkills !== undefined && (!allowLive || !nativeSkillOptions)) throw coded('NATIVE_SKILLS_INVALID', 64);
  const nativeSkillBindings = nativeSkillOptions === undefined ? undefined
    : (await import('./native-skills.mjs')).snapshotNativeSkillBindings(nativeSkillOptions.bindings);
  if (nativeSkillBindings && !nativeSkillBindings.length) throw coded('NATIVE_SKILLS_INVALID', 64);
  const trustedRoot = allowLive ? await trustedSdkRoot(sdkRoot) : undefined;
  const isolationRoot = isolation ? await validateRoot(stateRoot) : undefined;
  const isolatedSpawn = isolation ? await prepareOfflineWorkerSpawn({ root: isolationRoot, sdkRoot: trustedRoot, authPath: isolationAuthPath }) : undefined;
  const authPath = allowLive ? await trustedAuthPath(isolationAuthPath) : undefined;
  abortError(signal);
  const root = isolationRoot ?? (projectModule || nativeMcpBindings || nativeSkillBindings ? await validateRoot(stateRoot) : await initializeRoot(stateRoot));
  const lock = await acquireLock(root);
  let handoffs, delegations, toolEffects, wiki, graph, artifactStore, artifactEngine, artifactAdapter, backendStore, backendRegistry, pluginPlane, channelStore, channelPlane, memoryStore, memoryPlane, browserStore, browserPlane, browserAdapter, themeStore, hub, host, address, timer, sourceStore, satelliteStore, satellitePlane, satelliteServer, satelliteAddress;
  const delegationReservations = new Map();
  let delegationHubClient;
  let closing;
  let resolveDone;
  const done = new Promise(resolvePromise => { resolveDone = resolvePromise; });
  let finalizing = false;
  async function finalize() {
    if (finalizing) return;
    finalizing = true;
    try {
      await removeAddress(address);
      await satelliteServer?.close();
      satelliteStore?.close();
      await pluginPlane?.shutdown();
      await backendRegistry?.shutdown();
      backendStore?.close();
      channelStore?.close();
      memoryStore?.close();
      browserStore?.close();
      themeStore?.close();
      await sourceStore?.close();
      handoffs?.close();
      delegations?.close();
      toolEffects?.close();
      artifactStore?.close();
      graph?.close();
      core?.close();
      await releaseLock(lock);
      resolveDone({ status: 'STOPPED' });
    } catch {
      resolveDone({ status: 'CLEANUP_UNRESOLVED' });
    }
  }
  async function shutdown(reason = 'STOP_REQUESTED') {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(timer);
      const hubWork = hub ? hub.shutdown({ abortActive: true }) : Promise.resolve();
      const hostWork = host ? host.shutdown() : Promise.resolve();
      try {
        await waitBounded(Promise.all([hubWork, hostWork]), SHUTDOWN_TIMEOUT_MS);
        await finalize();
      } catch {
        resolveDone({ status: 'CLEANUP_UNRESOLVED', reason });
      }
      return await done;
    })();
    return closing;
  }

  try {
    abortError(signal);
    if (sourceConfig) sourceStore = await openSourceWorkbench(sourceConfig);
    const [{ createHub }, { openStore }, { openDelegationStore }, { createDelegationModule }, { openToolEffectStore }, { createDelegationEffectRoutes }, { createHubClient }] = await Promise.all([
      import('../hub/server.mjs'), import('../persistence/store.mjs'), import('../delegation/store.mjs'),
      import('../delegation/hub-routes.mjs'), import('../delegation/effects.mjs'), import('../delegation/effect-routes.mjs'), import('../hub/client.mjs'),
    ]);
    const wikiModules = disabledModuleSet.has('wiki') ? null : await Promise.all([
      import('../wiki/wiki.mjs'), import('../wiki/hub-routes.mjs'),
    ]);
    const [{ openWorkspaceGraphStore }, { createWorkspaceGraphRoutes }] = await Promise.all([
      import('../workspace/graph-store.mjs'), import('../workspace/hub-routes.mjs'),
    ]);
    const [{ openArtifactStore }, { createArtifactEngine }, { createAylachiArtifactAdapter }, { createArtifactRoutes }] = await Promise.all([
      import('../artifact-engine/store.mjs'), import('../artifact-engine/engine.mjs'),
      import('../artifact-engine/aylachi-adapter.mjs'), import('../artifact-engine/hub-routes.mjs'),
    ]);
    const [{ openBackendStore }, { createBackendRegistry }, { createBackendRoutes }, { createPluginPlane }, { createPluginRoutes }] = await Promise.all([
      import('../backends/store.mjs'), import('../backends/registry.mjs'), import('../backends/hub-routes.mjs'),
      import('../plugins/plane.mjs'), import('../plugins/hub-routes.mjs'),
    ]);
    const [{ openBrowserStore }, { createBrowserPlane }, { createAylachiBrowserAdapter }, { createBrowserRoutes }, { createRemoteReadOnlyAdapter }, { openThemeStore }, { createThemeRoutes }] = await Promise.all([
      import('../browser/store.mjs'), import('../browser/plane.mjs'), import('../browser/aylachi-adapter.mjs'), import('../browser/hub-routes.mjs'), import('../browser/adapters.mjs'),
      import('../themes/store.mjs'), import('../themes/hub-routes.mjs'),
    ]);
    const satelliteModules = satelliteOptions ? await Promise.all([
      import('../satellite/store.mjs'), import('../satellite/plane.mjs'), import('../satellite/server.mjs'), import('../satellite/hub-routes.mjs'),
    ]) : null;
    const handoffModules = disabledModuleSet.has('handoff') ? null : await Promise.all([
      import('../handoff/store.mjs'), import('../handoff/module.mjs'), import('../hub/authorization.mjs'),
    ]);
    const [{ openChannelStore }, { createChannelPlane }, { createChannelRoutes }, { openMemoryStore }, { createMemoryPlane }, { createMemoryRoutes }] = await Promise.all([
      import('../channels/store.mjs'), import('../channels/plane.mjs'), import('../channels/hub-routes.mjs'),
      import('../memory/store.mjs'), import('../memory/plane.mjs'), import('../memory/hub-routes.mjs'),
    ]);
    // Enabling bindings requires existing owned state; never invent its card database.
    if (projectModule || nativeMcpBindings || nativeSkillBindings) await privateRegular(join(root, 'core.sqlite'));
    if (wikiModules) await ensurePrivateDir(join(root, 'wiki'));
    await ensurePrivateDir(join(root, 'pi'));
    await ensurePrivateDir(join(root, 'workspace'));
    const corePath = join(root, 'core.sqlite'), handoffPath = join(root, 'handoff.sqlite'), graphPath = join(root, 'workspace-graph.sqlite'), artifactPath = join(root, 'artifacts.sqlite'), backendPath = join(root, 'backends.sqlite'), channelPath = join(root, 'channels.sqlite'), memoryPath = join(root, 'memory.sqlite'), browserPath = join(root, 'browser.sqlite'), themePath = join(root, 'themes.sqlite'), satellitePath = join(root, 'satellite.sqlite');
    await ensureDatabaseFile(corePath);
    await ensureDatabaseFile(graphPath);
    await ensureDatabaseFile(artifactPath);
    await ensureDatabaseFile(backendPath);
    await ensureDatabaseFile(channelPath);
    await ensureDatabaseFile(memoryPath);
    await ensureDatabaseFile(browserPath);
    await ensureDatabaseFile(themePath);
    if (satelliteOptions) await ensureDatabaseFile(satellitePath);
    if (handoffModules) await ensureDatabaseFile(handoffPath);
    core = openStore(corePath);
    graph = openWorkspaceGraphStore(graphPath);
    artifactStore = openArtifactStore(artifactPath);
    artifactEngine = createArtifactEngine({ store: artifactStore });
    artifactAdapter = createAylachiArtifactAdapter({ engine: artifactEngine, graph, canvasId: CANVAS_ID });
    backendStore = openBackendStore(backendPath);
    channelStore = openChannelStore(channelPath);
    memoryStore = openMemoryStore(memoryPath);
    memoryPlane = createMemoryPlane({ store: memoryStore, promotionPolicy: promotionOptions?.promotionPolicy, applyPromotion: promotionOptions?.applyPromotion });
    browserStore = openBrowserStore(browserPath);
    browserPlane = createBrowserPlane({ store: browserStore, remoteReadOnly: browserOptions?.remoteReadOnly ?? createRemoteReadOnlyAdapter(), localInteractive: browserOptions?.localInteractive });
    browserAdapter = createAylachiBrowserAdapter({ plane: browserPlane, graph, canvasId: CANVAS_ID });
    themeStore = openThemeStore(themePath);
    pluginPlane = createPluginPlane({ hostApiVersion: 5 });
    for (const plugin of requestedPlugins ?? []) pluginPlane.register(plugin); // Trusted composition only; HTTP cannot load code.
    if (satelliteModules) {
      satelliteStore = satelliteModules[0].openSatelliteStore(satellitePath);
      satellitePlane = satelliteModules[1].createSatellitePlane({ store: satelliteStore, registrations: satelliteOptions.registrations });
      satelliteServer = satelliteModules[2].createSatelliteServer({ plane: satellitePlane, registrations: satelliteOptions.registrations });
    }
    projectModule?.validateCards();
    for (const binding of nativeMcpBindings ?? []) {
      const card = core.getCard(binding.cardId);
      if (!card || card.id !== binding.cardId || card.canvasId !== CANVAS_ID || card.sessionId !== binding.sessionId) {
        throw coded('NATIVE_MCP_CARD_NOT_FOUND', 64);
      }
    }
    for (const binding of nativeSkillBindings ?? []) {
      const card = core.getCard(binding.cardId);
      if (!card || card.id !== binding.cardId || card.canvasId !== CANVAS_ID || card.sessionId !== binding.sessionId) {
        throw coded('NATIVE_SKILLS_CARD_NOT_FOUND', 64);
      }
    }
    if (handoffModules) handoffs = handoffModules[0].openHandoffStore(handoffPath);
    if (wikiModules) wiki = await wikiModules[0].openWiki({ root: join(root, 'wiki'), authorize: async ({ actor }) => actor === OWNER_ID });
    core.recoverInterrupted();
    graph.recoverRunning();
    const parentSessionSet = new Set(delegationOptions?.parentSessionIds ?? []);
    if (delegationOptions) {
      const cards = core.listCards({ canvasId: CANVAS_ID, limit: 101 });
      if (!Array.isArray(cards) || cards.length > 100 || delegationOptions.parentSessionIds.some(sessionId =>
        !cards.some(card => card.canvasId === CANVAS_ID && card.sessionId === sessionId))) throw coded('DELEGATION_PARENT_NOT_FOUND', 64);
    }
    const grants = [
      ['card.create', 'write'], ['card.list', 'read'], ['card.read', 'read'], ['card.update', 'write'], ['card.delete', 'write'],
      ['command.read', 'read'], ['command.cancel', 'write'], ['events.read', 'read'], ['snapshot.read', 'read'], ['session.message', 'write'],
      ['workspace.capabilities.read', 'read'], ['workspace.graph.read', 'read'], ['workspace.graph.write', 'write'], ['workspace.graph.run', 'write'], ['workspace.graph.trigger', 'write'],
      ['artifact.read', 'read'], ['artifact.write', 'write'],
      ['backend.read', 'read'], ['backend.write', 'write'], ['plugin.read', 'read'], ['plugin.write', 'write'],
      ['channel.read', 'read'], ['channel.write', 'write'], ['memory.read', 'read'], ['memory.write', 'write'],
      ['browser.read', 'read'], ['browser.write', 'write'], ['theme.read', 'read'], ['theme.write', 'write'],
      ['models.catalog.read', 'read'], ['models.settings.write', 'write'],
      ...(satelliteOptions ? [['connector.read', 'read'], ['connector.write', 'write']] : []),
      ...(sourceStore ? ['list', 'read', 'diff', 'save'].map(name => [`source.${name}`, name === 'save' ? 'write' : 'read']) : []),
      ...(wikiModules ? ['create', 'search', 'read', 'write', 'history', 'diff', 'restore', 'links'].map(name => [`wiki.${name}`, ['create', 'write', 'restore'].includes(name) ? 'write' : 'read']) : []),
      ...(handoffModules ? [
        ...['propose', 'list', 'read', 'accept'].map(name => [`handoff.${name}`, ['propose', 'accept'].includes(name) ? 'write' : 'read']),
        ['handoff.source.read', 'read'], ['handoff.target.write', 'write'],
      ] : []),
      ...(delegationOptions ? [['delegation.delegate', 'write'], ['delegation.read', 'read']] : []),
    ].map(([operation, permission]) => ({ operation, permission, effect: 'allow', projectId: PROJECT_ID }));
    for (const route of projectModule?.routes ?? []) grants.push({
      operation: route.operation, permission: 'read', effect: 'allow', projectId: route.target.projectId,
    });
    const authContext = { principalId: OWNER_ID, revoked: false, expiresAt: stopAt, grants };
    const permitCard = async ({ actor, action, cardId }) => {
      if (actor !== OWNER_ID || !['read', 'write'].includes(action) || !ID.test(cardId)) return false;
      const card = core.getCard(cardId);
      if (!card || card.canvasId !== CANVAS_ID || !ID.test(card.sessionId)) return false;
      const operation = action === 'read' ? 'handoff.source.read' : 'handoff.target.write';
      if (!handoffModules) return false;
      const result = handoffModules[2].authorize(authContext, { operation, requestId: `handoff-${action}` }, {
        operation, effect: action, projectId: PROJECT_ID, cardId: card.id, sessionId: card.sessionId,
      }, Date.now());
      return result.allowed === true;
    };
    const resolveSource = async ({ actor, source }) => {
      const card = core.getCard(source.cardId);
      if (actor !== OWNER_ID || !card || card.canvasId !== CANVAS_ID) throw coded('NOT_FOUND');
      if (source.kind === 'wiki') {
        if (!wiki) throw coded('NOT_FOUND');
        const note = await wiki.read({ actor, id: source.id, revision: source.revision });
        return { source: { ...source, revision: note.revision }, text: note.content };
      }
      const command = core.getCommand(source.id);
      if (!command || command.cardId !== card.id || command.state !== 'COMPLETED' || command.result?.status !== 'ok') throw coded('NOT_FOUND');
      const text = command.result.value?.text;
      if (typeof text !== 'string') throw coded('NOT_FOUND');
      return { source: { ...source }, text };
    };
    if (delegationOptions) {
      const delegationPath = join(root, 'delegation.sqlite'), effectsPath = join(root, 'tool-effects.sqlite');
      await ensureDatabaseFile(delegationPath);
      await ensureDatabaseFile(effectsPath);
      delegations = openDelegationStore(delegationPath);
      toolEffects = openToolEffectStore(effectsPath);
    }
    let delegationRoutes = [];
    if (delegationOptions) {
      const bridge = Object.freeze(Object.fromEntries(['createCard', 'sendMessage', 'readCommand', 'cancelCommand'].map(name => [
        name, (...args) => {
          if (!delegationHubClient) throw coded('DELEGATION_HUB_UNAVAILABLE');
          return delegationHubClient[name](...args);
        },
      ])));
      delegationRoutes = createDelegationModule({
        store: delegations,
        hubClient: bridge,
        projectId: PROJECT_ID,
        resolveParent({ actor, parentCommandId, action }) {
          if (actor !== OWNER_ID || !ID.test(parentCommandId) || !['delegate', 'read', 'approve'].includes(action)) return null;
          const command = core.getCommand(parentCommandId);
          if (!command || command.id !== parentCommandId || !['RUNNING', 'COMPLETED', 'NEEDS_RECONCILIATION'].includes(command.state)) return null;
          if (action === 'delegate' && command.state !== 'RUNNING') return null;
          const card = core.getCard(command.cardId);
          if (!card || card.id !== command.cardId || card.canvasId !== CANVAS_ID || !parentSessionSet.has(card.sessionId)) return null;
          return { actor: OWNER_ID, parentCommandId: command.id, parentCardId: card.id, canvasId: card.canvasId };
        },
        approve({ action, context, request }) {
          const current = core.getCommand(context.parentCommandId);
          const card = current && core.getCard(current.cardId);
          if (!current || !card || current.id !== context.parentCommandId || current.cardId !== context.parentCardId ||
              card.id !== context.parentCardId || card.canvasId !== context.canvasId || card.canvasId !== CANVAS_ID ||
              !parentSessionSet.has(card.sessionId)) return false;
          if (action === 'read' || action === 'approve') return ['RUNNING', 'COMPLETED', 'NEEDS_RECONCILIATION'].includes(current.state);
          if (action !== 'delegate' || current.state !== 'RUNNING' || !request || !ID.test(request.requestId)) return false;
          const reserved = delegationReservations.get(current.id);
          if (reserved !== undefined && reserved !== request.requestId) return false;
          delegationReservations.set(current.id, request.requestId);
          return true;
        },
        pollIntervalMs: 10,
        waitTimeoutMs: 20_000,
      });
      delegationRoutes = createDelegationEffectRoutes({
        routes: delegationRoutes,
        effects: toolEffects,
        resolveParent({ actor, parentCommandId, action }) {
          const command = core.getCommand(parentCommandId);
          const card = command && core.getCard(command.cardId);
          if (actor !== OWNER_ID || !['delegate', 'read', 'approve'].includes(action) || !command || !card ||
              card.canvasId !== CANVAS_ID || !parentSessionSet.has(card.sessionId) || (action === 'delegate' && command.state !== 'RUNNING')) return null;
          return { actor: OWNER_ID, parentCommandId: command.id, parentCardId: card.id, canvasId: card.canvasId };
        },
        approve({ action, context }) {
          const command = core.getCommand(context.parentCommandId);
          return action === 'approve' && command && ['RUNNING', 'COMPLETED', 'NEEDS_RECONCILIATION'].includes(command.state);
        },
        ownerId: `hub-${randomUUID()}`,
        requireApproval: () => requireDelegationApproval,
        onEffect(effect) {
          hub?.appendModuleExecution(effect.parentCommandId, 'tool.effect', effect.id,
            `${effect.id}:${effect.attempt}:${effect.state}`, { toolName: effect.toolName, state: effect.state,
              attempt: effect.attempt, payloadHash: effect.payloadHash, reasonCode: effect.reasonCode });
        },
      });
    }
    const runner = makeRunner(() => host);
    backendRegistry = createBackendRegistry({ store: backendStore, adapters: [{ id: 'pi', revision: 1,
      capabilities: ['chat', 'models', 'artifacts', 'events'], run: runner, health: () => ({ state: host ? 'READY' : 'OFFLINE' }) }] });
    channelPlane = createChannelPlane({ store: channelStore, graph, core,
      deliver: input => hub.dispatchChannelMessage(input), sendOutbound: channelOptions?.send });
    const capabilities = Object.freeze({ version: sourceStore ? 2 : 1, modules: Object.freeze({
      wiki: Boolean(wikiModules), handoff: Boolean(handoffModules), artifactEngine: true, backends: true, pluginPlane: true, channels: true, memory: true, browser: true, themes: true,
      ...(satelliteOptions ? { connectors: true } : {}), ...(sourceStore ? { sourceWorkbench: true } : {}),
    }) });
    const routes = [
      {
        method: 'GET', path: '/v1/modules/workspace/capabilities',
        operation: 'workspace.capabilities.read', effect: 'read', target: { projectId: PROJECT_ID },
        handle: async ({ query, body }) => {
          if (Object.keys(query ?? {}).length || Object.keys(body ?? {}).length) {
            throw Object.assign(new Error('invalid_request'), { code: 'invalid_request', status: 400 });
          }
          return { status: 200, body: host?.modelCatalog ? { version: 3, modules: {
            wiki: Boolean(wikiModules), handoff: Boolean(handoffModules), artifactEngine: true, backends: true, pluginPlane: true, channels: true, memory: true, browser: true, themes: true, ...(satelliteOptions ? { connectors: true } : {}), sourceWorkbench: Boolean(sourceStore), models: true,
          } } : capabilities };
        },
      },
      {
        method: 'GET', path: '/v1/modules/models/catalog', operation: 'models.catalog.read', effect: 'read', target: { projectId: PROJECT_ID },
        handle: async ({ query, body }) => {
          if (Object.keys(query ?? {}).length || Object.keys(body ?? {}).length || !host?.modelCatalog) {
            throw Object.assign(new Error('not_found'), { code: 'not_found', status: 404 });
          }
          return { status: 200, body: host.modelCatalog };
        },
      },
      {
        method: 'POST', path: '/v1/modules/models/cards/:cardId/settings', operation: 'models.settings.write', effect: 'write', target: { projectId: PROJECT_ID },
        handle: async ({ params, body }) => {
          if (!host?.modelCatalog || !body || Object.keys(body).length !== 4 ||
              !['expectedRevision', 'provider', 'modelId', 'reasoning'].every(key => Object.hasOwn(body, key)) ||
              !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
            throw Object.assign(new Error('invalid_request'), { code: 'invalid_request', status: 400 });
          }
          const card = core.getCard(params.cardId);
          if (!card || card.canvasId !== CANVAS_ID) throw Object.assign(new Error('not_found'), { code: 'not_found', status: 404 });
          let selection;
          try { selection = snapshotModelSelection({ provider: body.provider, modelId: body.modelId, reasoning: body.reasoning }, host.modelCatalog); }
          catch { throw Object.assign(new Error('invalid_request'), { code: 'invalid_request', status: 400 }); }
          let updated;
          try { updated = core.updateCard(card.id, body.expectedRevision, modelPatch(selection)); }
          catch (error) {
            if (error.message === 'REVISION_CONFLICT' || error.message === 'MODEL_SETTINGS_BUSY') {
              throw Object.assign(new Error('conflict'), { code: 'conflict', status: 409 });
            }
            throw error;
          }
          return { status: 200, body: { card: updated, selection } };
        },
      },
      ...createBackendRoutes({ registry: backendRegistry, projectId: PROJECT_ID, ownerId: OWNER_ID }),
      ...createPluginRoutes({ plane: pluginPlane, projectId: PROJECT_ID, ownerId: OWNER_ID }),
      ...(satelliteModules ? satelliteModules[3].createConnectorRoutes({ plane: satellitePlane, projectId: PROJECT_ID, ownerId: OWNER_ID }) : []),
      ...createChannelRoutes({ store: channelStore, plane: channelPlane, projectId: PROJECT_ID, ownerId: OWNER_ID }),
      ...createMemoryRoutes({ store: memoryStore, projectId: PROJECT_ID }),
      ...createBrowserRoutes({ browsers: browserAdapter, canvasId: CANVAS_ID, projectId: PROJECT_ID, ownerId: OWNER_ID }),
      ...createThemeRoutes({ store: themeStore, canvasId: CANVAS_ID, projectId: PROJECT_ID, ownerId: OWNER_ID,
        onProposal(result) {
          const turnId = result.requestOrigin.turnId;
          hub?.appendModuleExecution(turnId, 'theme.proposal', `theme:${result.theme.id}:v${result.version.version}`,
            `${result.theme.id}:${result.version.version}`, { themeId: result.theme.id, version: result.version.version, state: result.theme.state });
        } }),
      ...createArtifactRoutes({ engine: artifactEngine, adapter: artifactAdapter, graph, projectId: PROJECT_ID, canvasId: CANVAS_ID, ownerId: OWNER_ID,
        onVersion(result) {
          const turnId = result.version.origin.turnId;
          if (turnId) hub?.appendModuleExecution(turnId, 'artifact.version', `artifact:${result.artifact.id}:v${result.version.version}`,
            `${result.artifact.id}:${result.version.version}:${result.version.contentHash}`, { artifactId: result.artifact.id,
              version: result.version.version, contentHash: result.version.contentHash, format: result.version.format });
        } }),
      ...createWorkspaceGraphRoutes({ graph, wiki, core, artifacts: artifactAdapter, browsers: browserAdapter, connectors: satellitePlane, projectId: PROJECT_ID, canvasId: CANVAS_ID, ownerId: OWNER_ID }),
      ...(wikiModules ? wikiModules[1].createWikiRouteHandlers({ wiki, projectId: PROJECT_ID }) : []),
      ...(handoffModules ? handoffModules[1].createHandoffModule({ store: handoffs, projectId: PROJECT_ID, authorizeCard: permitCard, resolveSource }) : []),
      ...delegationRoutes,
      ...(projectModule?.routes ?? []),
      ...(sourceStore ? createSourceRoutes({ store: sourceStore, projectId: PROJECT_ID }) : []),
    ];
    const bearer = await ensureBearer(root);
    abortError(signal);
    hub = createHub({
      store: core,
      graph,
      backends: backendRegistry,
      bearerSecret: await ensureBearer(root),
      authContext,
      resolveTarget({ operation, input, card }) {
        if (operation === 'card.list' && !card) return input?.canvasId === CANVAS_ID ? { projectId: PROJECT_ID } : null;
        if (operation === 'card.create') {
          if (input?.canvasId !== CANVAS_ID) return null;
          if (card) return card.canvasId === CANVAS_ID ? { projectId: PROJECT_ID, cardId: card.id, sessionId: card.sessionId } : null;
          return typeof input.id === 'string' && ID.test(input.id) && typeof input.sessionId === 'string' && ID.test(input.sessionId)
            ? { projectId: PROJECT_ID, cardId: input.id, sessionId: input.sessionId } : null;
        }
        if (!card || card.canvasId !== CANVAS_ID || !ID.test(card.id) || !ID.test(card.sessionId)) return null;
        return { projectId: PROJECT_ID, cardId: card.id, sessionId: card.sessionId };
      },
      runner,
      routeHandlers: routes,
    });
    channelPlane.recover();
    memoryPlane.recover();
    if (toolEffects) for (const effect of toolEffects.recoverRunning({ now: Date.now() })) {
      hub.appendModuleExecution(effect.parentCommandId, 'tool.effect', effect.id,
        `${effect.id}:${effect.attempt}:UNKNOWN`, { toolName: effect.toolName, state: 'UNKNOWN', attempt: effect.attempt,
          payloadHash: effect.payloadHash, reasonCode: effect.reasonCode });
    }
    const bound = await hub.listen(port, HOST);
    if (satelliteServer) satelliteAddress = await satelliteServer.listen(satelliteOptions.port, satelliteOptions.host, { allowRemote: satelliteOptions.allowRemote });
    if (delegationOptions) delegationHubClient = createHubClient({ baseUrl: `http://${HOST}:${bound.port}`, bearer });
    if (allowLive) {
      await consumeLiveApproval(root);
      const deadline = stopAt - Math.min(LIVE_CLEANUP_MARGIN_MS, Math.floor(limits.durationMs / 10));
      const toolsBootstrap = projectModule || nativeMcpBindings || nativeSkillBindings || !delegationOptions ? {
        type: 'tools_bootstrap', connection: { baseUrl: `http://${HOST}:${bound.port}`, bearer }, artifactEngine: true, themes: true,
        delegationSessionIds: delegationOptions?.parentSessionIds ?? [], projectBindings: projectModule?.bindings ?? [],
        ...(nativeMcpBindings === undefined ? {} : { nativeMcpBindings }),
        ...(nativeSkillBindings === undefined ? {} : { nativeSkillBindings }),
      } : undefined;
      const delegationBootstrap = !toolsBootstrap && delegationOptions ? {
        type: 'delegation_bootstrap',
        connection: { baseUrl: `http://${HOST}:${bound.port}`, bearer },
        parentSessionIds: delegationOptions.parentSessionIds, artifactEngine: true, themes: true,
      } : undefined;
      host = await startWorker(root, trustedRoot, authPath, deadline, signal, {
        ...workerDependencies, ...(isolatedSpawn ? { spawnChild: isolatedSpawn } : {}), ...(delegationBootstrap ? { delegationBootstrap } : {}), ...(toolsBootstrap ? { toolsBootstrap } : {}),
        onExecutionEvent: runner.onExecutionEvent,
        ...(liveLimits === undefined ? {} : { maxSdkCalls: limits.maxSdkCalls }),
      });
    }
    abortError(signal);
    address = await writeAddress(root, bound.port);
    timer = setTimeout(() => { void shutdown('DEV_DEADLINE').catch(() => {}); }, Math.max(1, stopAt - Date.now()));
    return {
      stateRoot: root,
      address: { host: HOST, port: bound.port },
      ...(satelliteAddress ? { satelliteAddress: { host: satelliteOptions.host, port: satelliteAddress.port } } : {}),
      modelStatus: allowLive ? 'live' : 'disabled',
      done,
      shutdown,
    };
  } catch (error) {
    if (error?.childStillOwned === true) {
      try { await waitBounded(hub ? hub.shutdown({ abortActive: true }) : Promise.resolve(), SHUTDOWN_TIMEOUT_MS); } catch {}
      try { await satelliteServer?.close(); satelliteStore?.close(); } catch {}
      unresolvedStartupOwners.add({ child: error.ownedChild, lock, core, handoffs, delegations, toolEffects, wiki, graph, artifactStore, backendStore, sourceStore, root, hub });
      throw error;
    }
    const hubWork = hub ? hub.shutdown({ abortActive: true }) : Promise.resolve();
    const hostWork = host ? host.shutdown() : Promise.resolve();
    let clean = false;
    try { await waitBounded(Promise.all([hubWork, hostWork]), SHUTDOWN_TIMEOUT_MS); clean = true; } catch {}
    if (clean) {
      try {
        await removeAddress(address);
        await satelliteServer?.close();
        satelliteStore?.close();
        await pluginPlane?.shutdown();
        await backendRegistry?.shutdown();
        backendStore?.close();
        channelStore?.close();
        memoryStore?.close();
        browserStore?.close();
        themeStore?.close();
        await sourceStore?.close();
        handoffs?.close();
        delegations?.close();
        toolEffects?.close();
        artifactStore?.close();
        graph?.close();
        core?.close();
        await releaseLock(lock);
      } catch { /* retain lock and state if startup cleanup is uncertain */ }
    }
    throw error?.code ? error : coded('STARTUP_FAILED');
  }
}

export function parseArgs(args) {
  const out = { help: false, bootstrap: false, allowLive: false, stateRoot: undefined, sdkRoot: undefined, port: DEFAULT_PORT, portSpecified: false };
  const parentSessionIds = [];
  const disabledModules = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--bootstrap') out.bootstrap = true;
    else if (arg === '--allow-live') out.allowLive = true;
    else if (arg === '--require-delegation-approval') out.requireDelegationApproval = true;
    else if (arg === '--disable-module') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw coded('INVALID_ARGUMENTS', 64);
      const moduleName = args[++i];
      if (!['wiki', 'handoff'].includes(moduleName) || disabledModules.includes(moduleName)) throw coded('INVALID_ARGUMENTS', 64);
      disabledModules.push(moduleName);
    }
    else if (arg === '--state-root' || arg === '--sdk-root' || arg === '--port' || arg === '--delegate-session') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw coded('INVALID_ARGUMENTS', 64);
      const value = args[++i];
      if (arg === '--state-root') out.stateRoot = value;
      else if (arg === '--sdk-root') out.sdkRoot = value;
      else if (arg === '--delegate-session') parentSessionIds.push(value);
      else {
        out.portSpecified = true;
        if (!/^(0|[1-9][0-9]{0,4})$/.test(value)) throw coded('INVALID_PORT', 64);
        out.port = Number(value);
        if (out.port > 65535) throw coded('INVALID_PORT', 64);
      }
    } else throw coded('INVALID_ARGUMENTS', 64);
  }
  if (disabledModules.length) out.disabledModules = Object.freeze([...disabledModules]);
  if (out.help) return out;
  if (!out.stateRoot) throw coded('STATE_ROOT_REQUIRED', 64);
  assertCanonicalAbsolute(out.stateRoot, 'INVALID_STATE_ROOT');
  if (out.bootstrap && (out.allowLive || out.sdkRoot || out.portSpecified || parentSessionIds.length || disabledModules.length || out.requireDelegationApproval)) throw coded('INVALID_ARGUMENTS', 64);
  if (out.requireDelegationApproval && !parentSessionIds.length) throw coded('LIVE_FLAGS_INVALID', 64);
  if (parentSessionIds.length) {
    if (!out.allowLive) throw coded('LIVE_FLAGS_INVALID', 64);
    out.delegation = snapshotDelegationOptions({ parentSessionIds });
  }
  if (out.allowLive !== Boolean(out.sdkRoot)) throw coded('LIVE_FLAGS_INVALID', 64);
  if (!out.allowLive && out.sdkRoot) throw coded('LIVE_FLAGS_INVALID', 64);
  return out;
}

function privateStdout() {
  let stat;
  try { stat = fstatSync(1); } catch { throw coded('BOOTSTRAP_OUTPUT_REFUSED', 64); }
  // This is an accidental-output guard, not a same-user security boundary.
  if ((!stat.isFIFO() && !stat.isSocket()) || (uid() !== null && stat.uid !== uid()) || (stat.isFIFO() && !modePrivate(stat))) throw coded('BOOTSTRAP_OUTPUT_REFUSED', 64);
}

async function bootstrap(root) {
  privateStdout();
  await validateRoot(root);
  const saved = await readPrivate(join(root, BEARER_NAME), 128);
  if (saved.length !== 65 || saved.charCodeAt(64) !== 10 || !TOKEN.test(saved.slice(0, 64))) throw coded('BEARER_FILE_INVALID', 64);
  const token = saved.slice(0, 64);
  const portText = await readPrivate(join(root, ADDRESS_NAME), 64);
  if (!/^([1-9][0-9]{0,4})\n$/.test(portText) || Number(portText.trim()) > 65535) throw coded('SERVER_NOT_RUNNING', 64);
  const response = await fetch(`http://${HOST}:${Number(portText.trim())}/v1/cards?canvasId=${CANVAS_ID}`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000), redirect: 'error',
  }).catch(() => null);
  if (!response || response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response?.body?.cancel().catch(() => {});
    throw coded('SERVER_NOT_RUNNING', 64);
  }
  await response.body?.cancel().catch(() => {});
  await new Promise((resolvePromise, rejectPromise) => process.stdout.write(`${token}\n`, error => error ? rejectPromise(coded('BOOTSTRAP_OUTPUT_FAILED', 64)) : resolvePromise()));
}

const usage = 'Usage: npm start -- --state-root ABS [--port N] [--disable-module wiki|handoff ...] [--allow-live --sdk-root ABS [--delegate-session ID ...] [--require-delegation-approval]]\n       npm start -- --bootstrap --state-root ABS\n       npm start -- --help\n';

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.code || 'INVALID_ARGUMENTS'}\n${usage}`); process.exitCode = error.exitCode || 64; return; }
  if (args.help) { process.stdout.write(usage); return; }
  if (args.bootstrap) {
    try { await bootstrap(args.stateRoot); }
    catch (error) { process.stderr.write(`${error.code || 'BOOTSTRAP_REFUSED'}\n`); process.exitCode = error.exitCode || 64; }
    return;
  }
  const lifecycle = new AbortController();
  let app, pendingSignal;
  const requestStop = reason => {
    if (app) void app.shutdown(reason).catch(() => {});
    else { pendingSignal ??= reason; lifecycle.abort(); }
  };
  const onInt = () => requestStop('SIGINT');
  const onTerm = () => requestStop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    app = await startDevelopmentServer({ stateRoot: args.stateRoot, port: args.port, allowLive: args.allowLive, sdkRoot: args.sdkRoot, signal: lifecycle.signal, ...(args.delegation ? { delegation: args.delegation } : {}), ...(args.requireDelegationApproval ? { requireDelegationApproval: true } : {}), ...(args.disabledModules ? { disabledModules: args.disabledModules } : {}) });
    process.stdout.write(`${JSON.stringify({ status: 'READY', port: app.address.port, stateRoot: app.stateRoot, live: app.modelStatus === 'live' })}\n`);
    if (pendingSignal) void app.shutdown(pendingSignal).catch(() => {});
    const report = await app.done;
    process.stdout.write(`${JSON.stringify({ status: report.status, port: app.address.port, stateRoot: app.stateRoot, live: app.modelStatus === 'live' })}\n`);
    if (report.status !== 'STOPPED') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error?.code || 'STARTUP_FAILED'}\n`);
    process.exitCode = error?.exitCode || 1;
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => {
  process.stderr.write('STARTUP_FAILED\n');
  process.exitCode = 1;
});
