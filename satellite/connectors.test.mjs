import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createBrowserExtensionConnector, createHeadlessConnector, createNativeConnector } from './connectors.mjs';

test('native connector confines reads to real workspace files and bounds output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-native-')), outside = await mkdtemp(join(tmpdir(), 'aylachi-native-outside-'));
  try {
    await writeFile(join(root, 'ok.txt'), 'ok'); await writeFile(join(outside, 'secret.txt'), 'no');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const connector = createNativeConnector({ root });
    assert.equal((await connector.execute({ payload: { path: 'ok.txt' } })).text, 'ok');
    await assert.rejects(connector.execute({ payload: { path: '../outside/secret.txt' } }));
    await assert.rejects(connector.execute({ payload: { path: 'link.txt' } }));
    await writeFile(join(root, 'large.txt'), 'x'.repeat(64 * 1024 + 1));
    await assert.rejects(connector.execute({ payload: { path: 'large.txt' } }), /TOO_LARGE/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('headless connector enforces host allowlist, redirects and streaming size limit', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/final' }); res.end(); return; }
    if (req.url === '/large') { res.writeHead(200); res.end('x'.repeat(64 * 1024 + 1)); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connector = createHeadlessConnector({ allowedHosts: ['127.0.0.1'] }), base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await connector.execute({ payload: { url: `${base}/ok` } })).text, 'ok');
    await assert.rejects(connector.execute({ payload: { url: 'http://localhost/ok' } }), /URL_DENIED/);
    await assert.rejects(connector.execute({ payload: { url: `${base}/redirect` } }));
    await assert.rejects(connector.execute({ payload: { url: `${base}/large` } }), /TOO_LARGE/);
  } finally { server.close(); await once(server, 'close'); }
});

test('browser extension adapter exposes only explicit tab grant and validates bounded result', async () => {
  const calls = [];
  const connector = createBrowserExtensionConnector({ bridge: { async extractText(input) {
    calls.push(input); return { tabId: input.tabId, title: 'Page', text: 'visible text' };
  } } });
  const result = await connector.execute({ payload: { tabId: 'tab-1' }, commandId: 'connector-1' });
  assert.equal(result.text, 'visible text');
  assert.deepEqual(Object.keys(calls[0]).sort(), ['requestId', 'signal', 'tabId'].sort());
  assert.equal(calls[0].requestId, 'connector-1');
  await assert.rejects(connector.execute({ payload: { tabId: '../bad' }, commandId: 'connector-2' }));
});
