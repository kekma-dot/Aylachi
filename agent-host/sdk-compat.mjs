import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';

// Qualification policy, not the reproducible dependency pin in package-lock.json.
// Add a version only after running the real SDK matrix; never infer from semver.
export const qualifiedSdkVersions = Object.freeze(['1.3.0', '1.4.0']);
const fail = code => Object.assign(new Error(code), { code });
export function assertSdkManifest(manifest) {
  if (manifest?.name !== '@earendil-works/pi-coding-agent' || !qualifiedSdkVersions.includes(manifest.version)) {
    throw fail('SDK_VERSION_UNSUPPORTED');
  }
  return manifest.version;
}

export function assertSdkApi(sdk) {
  for (const value of [sdk?.ModelRuntime?.create, sdk?.SessionManager?.open,
    sdk?.SessionManager?.continueRecent, sdk?.SettingsManager?.inMemory,
    sdk?.DefaultResourceLoader, sdk?.createAgentSessionFromServices, sdk?.createAgentSessionRuntime]) {
    if (typeof value !== 'function') throw fail('SDK_API_UNSUPPORTED');
  }
}

export async function loadSelectedSdk(sdkRoot) {
  if (await realpath(sdkRoot) !== sdkRoot) throw fail('SDK_ROOT_INVALID');
  const manifest = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
  assertSdkManifest(manifest);
  const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
  assertSdkApi(sdk);
  return { sdk, manifest };
}

// The SDK does not publicly export these OAuth storage classes. Keep the
// version-sensitive deep imports in this one shim, including cohort checks.
export async function loadSelectedMcpSupport(sdkRoot) {
  const base = pathToFileURL(join(sdkRoot, 'package.json')).href;
  const mcpRoot = await realpath(dirname(findPackageJSON('@earendil-works/pi-mcp', base)));
  const actualSdkRoot = await realpath(dirname(findPackageJSON('@earendil-works/pi-coding-agent', base)));
  const selected = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
  const version = assertSdkManifest(selected);
  for (const [root, name] of [[mcpRoot, '@earendil-works/pi-mcp'], [actualSdkRoot, '@earendil-works/pi-coding-agent']]) {
    if (await realpath(root) !== root) throw fail('SDK_COHORT_UNSUPPORTED');
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (manifest.name !== name || manifest.version !== version) throw fail('SDK_COHORT_UNSUPPORTED');
  }
  const [{ StreamableHttpTransport }, { McpOAuthCredentialStore }, { InMemoryAuthStorageBackend }] = await Promise.all([
    import(pathToFileURL(join(mcpRoot, 'dist/index.js')).href),
    import(pathToFileURL(join(actualSdkRoot, 'dist/extensions/mcp/oauth.js')).href),
    import(pathToFileURL(join(actualSdkRoot, 'dist/core/auth-storage.js')).href),
  ]);
  if ([StreamableHttpTransport, McpOAuthCredentialStore, InMemoryAuthStorageBackend].some(value => typeof value !== 'function')) throw fail('SDK_API_UNSUPPORTED');
  return { StreamableHttpTransport,
    createCredentials: agentDir => new McpOAuthCredentialStore(new InMemoryAuthStorageBackend(), agentDir) };
}
