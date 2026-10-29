import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSatelliteClient } from './client.mjs';
import { createBrowserExtensionConnector } from './connectors.mjs';
import { createNativeMessagingBridge } from './extension-bridge.mjs';
import { openSatelliteExecutionStore } from './execution-store.mjs';

async function config(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw new Error('INVALID_CONFIG');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['baseUrl', 'satelliteId', 'secretPath', 'databasePath'].every(key => typeof value[key] === 'string') ||
      !isAbsolute(value.secretPath) || !isAbsolute(value.databasePath)) throw new Error('INVALID_CONFIG');
  const url = new URL(value.baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port) throw new Error('INVALID_CONFIG');
  return value;
}

export async function startExtensionHost({ configPath, input = process.stdin, output = process.stdout } = {}) {
  const options = await config(configPath), secret = (await readFile(options.secretPath, 'utf8')).trim();
  const executionStore = openSatelliteExecutionStore(options.databasePath);
  const bridge = createNativeMessagingBridge({ input, output });
  const client = createSatelliteClient({ baseUrl: options.baseUrl, satelliteId: options.satelliteId, secret,
    executionStore, connectors: [createBrowserExtensionConnector({ bridge })] });
  await client.start();
  let closing;
  return async () => {
    if (closing) return closing;
    closing = (async () => { bridge.close(); await client.stop(); executionStore.close(); })();
    return closing;
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') throw new Error('USAGE: extension-host --config ABS');
  const close = await startExtensionHost({ configPath: args[1] });
  const stop = () => { void close().then(() => { process.exitCode = 0; }); };
  process.stdin.once('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { process.stderr.write(`${error?.code ?? 'EXTENSION_HOST_FAILED'}\n`); process.exitCode = 1; });
}
