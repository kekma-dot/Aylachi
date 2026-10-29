import { readProjectContextRecord as record } from '../projects/context-tool.mjs';
import { createNativeMcpFetch } from './native-mcp-transport.mjs';

const invalid = () => Object.assign(new Error('NATIVE_MCP_CONFIG_INVALID'), { code: 'NATIVE_MCP_CONFIG_INVALID' });
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

function dense(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
    return descriptor.value;
  });
}

// One explicit server per bound session initially; never derived from model arguments.
export function snapshotNativeMcpBindings(value) {
  try {
    const sessions = new Set(), cards = new Set();
    return Object.freeze(dense(value, 3).map(item => {
      const binding = record(item, ['cardId', 'sessionId', 'serverName', 'url', 'tools']);
      if (!binding || !id(binding.cardId) || !id(binding.sessionId) || sessions.has(binding.sessionId) || cards.has(binding.cardId) ||
          typeof binding.serverName !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(binding.serverName)) throw invalid();
      createNativeMcpFetch({ url: binding.url }); // Reuse the transport's canonical destination validator; no I/O.
      const tools = dense(binding.tools, 10);
      if (!tools.length || tools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/.test(name)) ||
          new Set(tools).size !== tools.length) throw invalid();
      sessions.add(binding.sessionId); cards.add(binding.cardId);
      return Object.freeze({ ...binding, tools: Object.freeze(tools) });
    }));
  } catch { throw invalid(); }
}
