import { spawnSync } from 'node:child_process';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor !== 22 || nodeMinor < 19) throw new Error(`AYLACHI_NODE_22_REQUIRED: expected >=22.19 <23, got ${process.version}`);
const { assertSdkManifest } = await import('../agent-host/sdk-compat.mjs');

const root = fileURLToPath(new URL('../', import.meta.url));
const configured = process.env.AYLACHI_SDK_ROOT;
if (configured && !path.isAbsolute(configured)) throw new Error('AYLACHI_SDK_ROOT must be an absolute path');
const sdkRoot = await realpath(configured ?? path.join(root, 'node_modules/@earendil-works/pi-coding-agent'));
const manifest = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
assertSdkManifest(manifest);
console.log(JSON.stringify({ sdk: `${manifest.name}@${manifest.version}`, sdkRoot, node: process.version }));
const result = spawnSync(process.execPath, ['--test', '--test-timeout=15000', ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, AYLACHI_SDK_ROOT: sdkRoot },
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;
