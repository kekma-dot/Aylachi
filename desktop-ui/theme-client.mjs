const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validWorkspace = value => object(value) && Number.isSafeInteger(value.revision) && Array.isArray(value.themes) && Array.isArray(value.proposals) &&
  (value.active === null || object(value.active) && object(value.active.version) && object(value.active.version.tokens));
export function createThemeClient({ hubClient } = {}) {
  if (!hubClient || typeof hubClient.moduleRequest !== 'function') throw new TypeError('INVALID_HUB_CLIENT');
  async function call(method, path, body, signal) {
    const result = await hubClient.moduleRequest({ method, path, body, signal });
    if (!object(result) || result.workspace !== undefined && !validWorkspace(result.workspace)) throw Object.assign(new Error('INVALID_THEME_RESPONSE'), { code: 'INVALID_THEME_RESPONSE' });
    return result;
  }
  return {
    workspace(signal) { return call('GET', '/v1/modules/themes', undefined, signal); },
    create(input, signal) { return call('POST', '/v1/modules/themes', input, signal); },
    append(id, input, signal) { return call('POST', `/v1/modules/themes/${encodeURIComponent(id)}/versions`, input, signal); },
    activate(id, input, signal) { return call('POST', `/v1/modules/themes/${encodeURIComponent(id)}/activate`, input, signal); },
    rollback(id, input, signal) { return call('POST', `/v1/modules/themes/${encodeURIComponent(id)}/rollback`, input, signal); },
    disable(input, signal) { return call('POST', '/v1/modules/themes/disable', input, signal); },
    reject(id, input, signal) { return call('POST', `/v1/modules/themes/proposals/${encodeURIComponent(id)}/reject`, input, signal); },
  };
}
