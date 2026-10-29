import { browserUrl } from './policy.mjs';

const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const decode = value => value.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity])
  .replace(/&#(\d{1,5});/g, (_, code) => Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : ' ');
const plainText = html => decode(html.replace(/<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 32768);

export function browserSnapshotFromHtml(html, url) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 128 * 1024) throw bad('BROWSER_CONTENT_LIMIT', 502);
  const title = decode(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) || url.hostname;
  const links = [], seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href;
    try { href = new URL(decode(match[1]), url); } catch { continue; }
    if (href.protocol !== 'https:' || href.username || href.password || seen.has(href.href)) continue;
    seen.add(href.href);
    links.push({ href: href.href, text: plainText(match[2]).slice(0, 240) || href.hostname });
    if (links.length === 32) break;
  }
  return { url: url.href, title, text: plainText(html), links };
}

async function boundedBody(response, maxBytes) {
  if (!response.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw bad('BROWSER_CONTENT_LIMIT', 502);
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export function createRemoteReadOnlyAdapter({ fetch: fetchImpl = globalThis.fetch, timeoutMs = 5_000, maxBytes = 65_536 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 65_536) throw new TypeError('INVALID_REMOTE_BROWSER_ADAPTER');
  return Object.freeze({
    id: 'remote-read-only', mode: 'remote-read-only',
    health: () => ({ state: 'READY', transport: 'https-get' }),
    async navigate({ url, policy, signal }) {
      let current = browserUrl(url, policy);
      for (let redirect = 0; redirect <= 3; redirect++) {
        const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(current, { method: 'GET', headers: { accept: 'text/html,text/plain' },
          redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: requestSignal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirect === 3 || !response.headers.get('location')) throw bad('BROWSER_REDIRECT_LIMIT', 502);
          current = browserUrl(new URL(response.headers.get('location'), current), policy);
          continue;
        }
        if (!response.ok) throw bad('BROWSER_HTTP_ERROR', 502);
        const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (!['text/html', 'text/plain'].includes(contentType)) throw bad('BROWSER_CONTENT_TYPE_DENIED', 502);
        const html = await boundedBody(response, maxBytes);
        return browserSnapshotFromHtml(html, current);
      }
      throw bad('BROWSER_REDIRECT_LIMIT', 502);
    },
  });
}

export function createLocalInteractiveAdapter({ snapshot } = {}) {
  if (typeof snapshot !== 'function') throw new TypeError('LOCAL_BROWSER_SNAPSHOT_REQUIRED');
  return Object.freeze({ id: 'local-interactive', mode: 'local-interactive',
    health: () => ({ state: 'READY', transport: 'trusted-local-snapshot' }), snapshot });
}
