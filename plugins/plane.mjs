const CAPABILITIES = new Set(['nodeViews', 'tools', 'commands', 'events', 'channels', 'providers', 'permissions']);
const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function descriptor(value, hostApiVersion) {
  if (!plain(value) || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.version !== 'string' || !value.version ||
      value.apiVersion !== hostApiVersion || typeof value.owner !== 'string' || !ID.test(value.owner) ||
      !Array.isArray(value.capabilities) || !value.capabilities.length || value.capabilities.some(item => !CAPABILITIES.has(item)) ||
      new Set(value.capabilities).size !== value.capabilities.length || typeof value.activate !== 'function') throw bad('INCOMPATIBLE_PLUGIN');
  return Object.freeze({ id: value.id, version: value.version, owner: value.owner,
    capabilities: Object.freeze([...value.capabilities]), activate: value.activate });
}
function snapshotActivation(value) {
  if (value === undefined) return Object.freeze({});
  if (!plain(value) || (value.dispose !== undefined && typeof value.dispose !== 'function') ||
      (value.health !== undefined && typeof value.health !== 'function')) throw bad('INVALID_PLUGIN_ACTIVATION');
  return Object.freeze({ dispose: value.dispose, health: value.health });
}

// Dynamic ESM supplied by a trusted host is trusted code, not a sandbox.
export function createPluginPlane({ hostApiVersion = 5 } = {}) {
  if (!Number.isSafeInteger(hostApiVersion) || hostApiVersion < 1) throw new TypeError('host API version required');
  const definitions = new Map(), states = new Map();
  let closed = false;
  const stateFor = id => states.get(id) ?? { status: 'INACTIVE', generation: 0 };
  const view = definition => ({ id: definition.id, version: definition.version, owner: definition.owner,
    capabilities: [...definition.capabilities], ...stateFor(definition.id) });
  async function disposeOwned(state) {
    const activation = state.activation;
    state.activation = undefined;
    if (activation?.dispose) await activation.dispose();
  }
  return Object.freeze({
    register(input) {
      if (closed) throw bad('PLUGIN_PLANE_CLOSED', 409);
      const definition = descriptor(input, hostApiVersion);
      if (definitions.has(definition.id)) throw bad('PLUGIN_ALREADY_REGISTERED', 409);
      definitions.set(definition.id, definition);
      states.set(definition.id, { status: 'INACTIVE', generation: 0 });
      return view(definition);
    },
    list() { return [...definitions.values()].map(view); },
    async activate(id) {
      const definition = definitions.get(id);
      if (!definition) throw bad('PLUGIN_NOT_FOUND', 404);
      if (closed) throw bad('PLUGIN_PLANE_CLOSED', 409);
      const previous = stateFor(id), generation = previous.generation + 1;
      const state = { status: 'ACTIVATING', generation };
      states.set(id, state);
      await disposeOwned(previous);
      let activation;
      try { activation = snapshotActivation(await definition.activate({ generation, owner: definition.owner, capabilities: definition.capabilities })); }
      catch (error) {
        if (states.get(id) === state) states.set(id, { status: 'FAILED', generation });
        throw bad('PLUGIN_ACTIVATION_FAILED');
      }
      if (states.get(id) !== state || closed) {
        await activation.dispose?.();
        return { activated: false, ...view(definition) };
      }
      state.activation = activation; state.status = 'ACTIVE';
      return { activated: true, ...view(definition) };
    },
    async disable(id) {
      const definition = definitions.get(id);
      if (!definition) throw bad('PLUGIN_NOT_FOUND', 404);
      const previous = stateFor(id), state = { status: 'DISABLED', generation: previous.generation + 1 };
      states.set(id, state);
      await disposeOwned(previous);
      return view(definition);
    },
    async health(id) {
      const definition = definitions.get(id);
      if (!definition) throw bad('PLUGIN_NOT_FOUND', 404);
      const state = stateFor(id);
      if (state.status !== 'ACTIVE' || typeof state.activation?.health !== 'function') return { id, state: state.status === 'ACTIVE' ? 'READY' : 'OFFLINE' };
      try {
        const value = await state.activation.health();
        return { id, state: ['READY', 'DEGRADED', 'OFFLINE'].includes(value?.state) ? value.state : 'OFFLINE' };
      } catch { return { id, state: 'OFFLINE' }; }
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      const current = [...definitions.keys()].map(id => stateFor(id));
      for (const [index, id] of [...definitions.keys()].entries()) {
        states.set(id, { status: 'DISABLED', generation: current[index].generation + 1 });
        await disposeOwned(current[index]);
      }
    },
  });
}
