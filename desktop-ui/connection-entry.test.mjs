import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('disconnected native entry has an explicit connection error and no seeded chat composers', async () => {
  const require = createRequire(import.meta.url);
  const intendedModules = fileURLToPath(new URL('./node_modules', import.meta.url));
  const modules = await realpath(intendedModules);
  assert.equal(modules, intendedModules, 'UI node_modules must not redirect to the separate prototype');
  const lock = JSON.parse(await readFile(new URL('./package-lock.json', import.meta.url), 'utf8'));
  for (const name of ['react', 'react-dom', 'vite']) {
    const installed = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'));
    assert.equal(installed.version, lock.packages[`node_modules/${name}`].version);
  }
  for (const name of ['react', 'react-dom/server', 'vite']) {
    assert.ok((await realpath(require.resolve(name))).startsWith(`${modules}/`), `dependency escaped UI node_modules: ${name}`);
  }
  const entry = await readFile(new URL('./main.jsx', import.meta.url), 'utf8');
  assert.match(entry, /bootstrapError: "Not connected\./);
  assert.match(entry, /<App \{\.\.\.connection\} cards=\{\[\]\} \/>/);
  assert.doesNotMatch(entry, /const cards\s*=|id: "card-[ab]"|title: "Chat [AB]"/);
  const vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  try {
    const { default: App } = await vite.ssrLoadModule('/App.jsx');
    for (const message of ['Not connected. Start Aylachi through its trusted Hub connection to use chats.', 'Connection configuration invalid. Check native connection setup.']) {
      const html = renderToStaticMarkup(React.createElement(App, { client: null, cards: [], bootstrapError: message }));
      assert.match(html, /role="alert"/);
      assert.ok(html.includes(message));
      assert.doesNotMatch(html, /<textarea|Write a message|Chat A|Chat B|Send transfer|Workspace views/);
    }
  } finally { await vite.close(); }
});
