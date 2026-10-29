import { createHash } from 'node:crypto';
import { createHubClient } from '../hub/client.mjs';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bounded = (value, max = 5000) => value.length > max ? `${value.slice(0, max)}\n… truncated; use export for the complete artifact` : value;
const requestKey = (sessionId, turnId, toolCallId) => `pi-${createHash('sha256').update(JSON.stringify([sessionId, turnId, toolCallId])).digest('hex')}`;
function activeTurn(getTurnContext, sessionId) {
  const value = getTurnContext();
  if (!Object.isFrozen(value) || value.sessionId !== sessionId || !TURN_ID.test(value.turnId ?? '')) throw new Error('ARTIFACT_BINDING_FAILED');
  return value;
}
function notify(ctx, text, level = 'info') { if (ctx.hasUI) ctx.ui.notify(bounded(text), level); }
function setup({ Type, connection, sessionId, getTurnContext, fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (!Type || !connection || !SESSION_ID.test(sessionId ?? '') || typeof getTurnContext !== 'function') throw new TypeError('INVALID_ARTIFACT_EXTENSION');
  const client = createHubClient({ baseUrl: connection.baseUrl, bearer: connection.bearer, fetch, timeoutMs });
  return { Type, sessionId, getTurnContext,
    call: (method, path, body, signal) => client.moduleRequest({ method, path, ...(body === undefined ? {} : { body }), signal }) };
}

export function createArtifactTool(options) {
  const { Type, sessionId, getTurnContext, call } = setup(options);
  return Object.freeze({
    name: 'artifact_create', label: 'Create artifact',
    description: 'Create a durable Markdown, Mermaid or sandboxed HTML artifact with source snapshots and version history.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 120 }),
      format: Type.String({ pattern: '^(markdown|mermaid|html)$' }),
      content: Type.String({ minLength: 1, maxLength: 65536 }),
      sources: Type.Array(Type.Object({ uri: Type.String({ minLength: 1, maxLength: 2048 }),
        label: Type.Optional(Type.String({ maxLength: 120 })), snapshot: Type.String({ maxLength: 32768 }) }, { additionalProperties: false }), { maxItems: 16 }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      const turn = activeTurn(getTurnContext, sessionId);
      const result = await call('POST', '/v1/modules/artifacts', { ...params,
        idempotencyKey: requestKey(sessionId, turn.turnId, toolCallId),
        origin: { kind: 'pi', sessionId, turnId: turn.turnId, toolCallId } }, signal);
      return { content: [{ type: 'text', text: `Created ${result.artifact.title} (${result.artifact.id}), version ${result.version.version}, ${result.version.contentHash}. Open it on the Aylachi Canvas or with /artifact open ${result.artifact.id}.` }],
        details: { artifact: result.artifact, version: { ...result.version, content: undefined, sources: result.version.sources.map(({ snapshot, ...source }) => source) }, node: result.node, idempotent: result.idempotent === true } };
    },
  });
}

// Built-in trusted host integration. The command and model tool share the same Hub/Engine API.
export function createArtifactExtension(options) {
  const { call } = setup(options);
  return function artifactExtension(pi) {
    pi.registerCommand('artifact', {
      description: 'Create with an agent, or use /artifact list | open <id> | export <id> [version]',
      async handler(args, ctx) {
        const [subcommand, id, version] = args.trim().split(/\s+/);
        try {
          if (!args.trim()) { notify(ctx, 'Usage: /artifact <request> | list | open <id> | export <id> [version]'); return; }
          if (subcommand === 'list') {
            const result = await call('GET', '/v1/modules/artifacts');
            notify(ctx, result.artifacts.length ? result.artifacts.map(artifact => `${artifact.id} · v${artifact.currentVersion} · ${artifact.title}`).join('\n') : 'No artifacts yet.');
            return;
          }
          if (subcommand === 'open' && id && !version) {
            const result = await call('GET', `/v1/modules/artifacts/${encodeURIComponent(id)}`);
            const sources = result.version.sources.map(source => `${source.label}: ${source.uri} (${source.sha256})`).join('\n');
            notify(ctx, `${result.version.title} · v${result.version.version}\n\n${result.version.content}${sources ? `\n\nSources\n${sources}` : ''}`);
            return;
          }
          if (subcommand === 'export' && id) {
            const result = await call('GET', `/v1/modules/artifacts/${encodeURIComponent(id)}/export${version ? `?version=${encodeURIComponent(version)}` : ''}`);
            notify(ctx, `${result.fileName} · ${result.mimeType} · ${result.contentHash}\n\n${result.content}`);
            return;
          }
          pi.sendUserMessage(`Create one useful artifact using the artifact_create tool. Preserve exact evidence in source snapshots. User request:\n${args}`);
        } catch (error) { notify(ctx, `Artifact command failed: ${error.code ?? error.message}`, 'error'); }
      },
    });
  };
}
