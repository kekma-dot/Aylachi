import { readProjectContextRecord as record } from '../projects/context-tool.mjs';
import { snapshotProjectBindings } from '../projects/runtime-module.mjs';
import { snapshotNativeMcpBindings } from './native-mcp-config.mjs';
import { snapshotNativeSkillBindings } from './native-skills.mjs';

const fail = () => Object.assign(new Error('TOOLS_BOOTSTRAP_INVALID'), { code: 'TOOLS_BOOTSTRAP_INVALID' });

// One private IPC record for both optional capabilities. Never carried in argv/env.
export function snapshotToolsBootstrap(value) {
  try {
    const legacyKeys = ['type', 'connection', 'delegationSessionIds', 'projectBindings'];
    const optional = ['nativeMcpBindings', 'nativeSkillBindings', 'artifactEngine', 'themes'].filter(key => Object.hasOwn(value, key));
    const frame = record(value, [...legacyKeys, ...optional]);
    const connection = frame && record(frame.connection, ['baseUrl', 'bearer']);
    if (!frame || frame.type !== 'tools_bootstrap' || !connection || typeof connection.baseUrl !== 'string' ||
        typeof connection.bearer !== 'string' || !/^[a-f0-9]{64}$/.test(connection.bearer)) throw fail();
    const url = new URL(connection.baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        ![url.origin, `${url.origin}/`].includes(connection.baseUrl)) throw fail();
    const selected = frame.delegationSessionIds;
    if (!Array.isArray(selected) || Object.getPrototypeOf(selected) !== Array.prototype || selected.length > 3 ||
        Reflect.ownKeys(selected).length !== selected.length + 1) throw fail();
    const ids = [];
    for (let index = 0; index < selected.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(selected, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(descriptor.value)) throw fail();
      ids.push(descriptor.value);
    }
    if (new Set(ids).size !== ids.length) throw fail();
    const nativeMcpBindings = Object.hasOwn(frame, 'nativeMcpBindings') ? snapshotNativeMcpBindings(frame.nativeMcpBindings) : undefined;
    const nativeSkillBindings = Object.hasOwn(frame, 'nativeSkillBindings') ? snapshotNativeSkillBindings(frame.nativeSkillBindings) : undefined;
    if (Object.hasOwn(frame, 'artifactEngine') && frame.artifactEngine !== true || Object.hasOwn(frame, 'themes') && frame.themes !== true) throw fail();
    const emptyProjects = (frame.artifactEngine === true || frame.themes === true || nativeMcpBindings?.length || nativeSkillBindings?.length) && Array.isArray(frame.projectBindings) &&
      Object.getPrototypeOf(frame.projectBindings) === Array.prototype && frame.projectBindings.length === 0 &&
      Reflect.ownKeys(frame.projectBindings).length === 1;
    const bindings = emptyProjects ? Object.freeze([]) : snapshotProjectBindings(frame.projectBindings);
    const result = Object.freeze({ type: 'tools_bootstrap', connection: Object.freeze({ ...connection }),
      delegationSessionIds: Object.freeze(ids), projectBindings: bindings,
      ...(nativeMcpBindings === undefined ? {} : { nativeMcpBindings }),
      ...(nativeSkillBindings === undefined ? {} : { nativeSkillBindings }),
      ...(frame.artifactEngine === undefined ? {} : { artifactEngine: true }),
      ...(frame.themes === undefined ? {} : { themes: true }) });
    if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw fail();
    return result;
  } catch { throw fail(); }
}
