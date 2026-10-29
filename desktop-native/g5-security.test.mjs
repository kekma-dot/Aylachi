import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('foreign UI bundles have no raw Tauri command or capability path', () => {
  const rust = readFileSync(new URL('./src-tauri/src/main.rs', import.meta.url), 'utf8');
  const config = JSON.parse(readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.app.security.capabilities, []);
  assert.doesNotMatch(rust, /\.invoke_handler|tauri::generate_handler/);
  assert.match(rust, /on_new_window\(\|_, _\| tauri::webview::NewWindowResponse::Deny\)/);
  assert.ok(config.app.security.csp.includes("connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:46231"));
});
