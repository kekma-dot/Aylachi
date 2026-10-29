const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function snapshotBrowserPolicy(input, mode) {
  if (!['remote-read-only', 'local-interactive'].includes(mode) || !object(input) || Object.keys(input).some(key => key !== 'allowedHosts')) throw bad('INVALID_BROWSER_POLICY');
  const hosts = input.allowedHosts ?? [];
  if (!Array.isArray(hosts) || hosts.length > 16 || hosts.some(host => typeof host !== 'string' || !HOST.test(host) || host.includes('..'))) throw bad('INVALID_BROWSER_POLICY');
  const allowedHosts = [...new Set(hosts.map(host => host.toLowerCase()))];
  if (mode === 'remote-read-only' && !allowedHosts.length || mode === 'local-interactive' && allowedHosts.length) throw bad('INVALID_BROWSER_POLICY');
  return Object.freeze({ allowedHosts: Object.freeze(allowedHosts) });
}

export function browserUrl(value, policy) {
  let url;
  try { url = new URL(value); } catch { throw bad('INVALID_BROWSER_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
      !HOST.test(url.hostname) || !policy?.allowedHosts?.includes(url.hostname.toLowerCase())) throw bad('BROWSER_URL_DENIED', 403);
  url.hash = '';
  return url;
}
