const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => Object.assign(new Error('INVALID_BROWSER_RESPONSE'), { code: 'INVALID_BROWSER_RESPONSE' });
const valid = value => object(value) && object(value.session) && typeof value.session.id === 'string' && Number.isSafeInteger(value.session.revision) && Array.isArray(value.tabs);
export function createBrowserClient({ hubClient } = {}) {
  if (!hubClient || typeof hubClient.moduleRequest !== 'function') throw new TypeError('INVALID_HUB_CLIENT');
  async function call(method, path, body, signal) {
    const result = await hubClient.moduleRequest({ method, path, body, signal });
    if (!valid(result)) throw invalid();
    return result;
  }
  return {
    read(id, signal) { return call('GET', `/v1/modules/browser/sessions/${encodeURIComponent(id)}`, undefined, signal); },
    navigate(id, input, signal) { return call('POST', `/v1/modules/browser/sessions/${encodeURIComponent(id)}/navigation`, input, signal); },
    openTab(id, input, signal) { return call('POST', `/v1/modules/browser/sessions/${encodeURIComponent(id)}/tabs`, input, signal); },
    refresh(id, input, signal) { return call('POST', `/v1/modules/browser/sessions/${encodeURIComponent(id)}/snapshots`, input, signal); },
    activate(id, input, signal) { return call('POST', `/v1/modules/browser/sessions/${encodeURIComponent(id)}/active-tab`, input, signal); },
  };
}
