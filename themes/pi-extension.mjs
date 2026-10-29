import { createHash } from 'node:crypto';
import { createHubClient } from '../hub/client.mjs';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function activeTurn(getTurnContext, sessionId) {
  const value = getTurnContext();
  if (!Object.isFrozen(value) || value.sessionId !== sessionId || !TURN_ID.test(value.turnId ?? '')) throw new Error('THEME_BINDING_FAILED');
  return value;
}
export function createThemeProposalTool({ Type, connection, sessionId, getTurnContext, fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (!Type || !connection || !SESSION_ID.test(sessionId ?? '') || typeof getTurnContext !== 'function') throw new TypeError('INVALID_THEME_EXTENSION');
  const client = createHubClient({ baseUrl: connection.baseUrl, bearer: connection.bearer, fetch, timeoutMs });
  const color = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });
  const optional = schema => Type.Optional(schema);
  const exact = (value, fields) => Type.Object(Object.fromEntries(fields.map(field => [field, optional(value)])), { additionalProperties: false });
  return Object.freeze({
    name: 'theme_propose', label: 'Propose theme',
    description: 'Propose declarative Aylachi theme tokens for human review. Never activates a theme and cannot install executable plugins or CSS.',
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 120 }), base: Type.String({ pattern: '^(light|dark)$' }),
      tokens: Type.Object({
        colors: Type.Optional(exact(color, ['background', 'surface', 'text', 'muted', 'accent', 'border', 'accentSoft', 'accentStrong'])),
        radius: Type.Optional(Type.Integer({ minimum: 0, maximum: 24 })),
        shadow: Type.Optional(Type.Object({ x: Type.Optional(Type.Integer({ minimum: 0, maximum: 24 })), y: Type.Optional(Type.Integer({ minimum: 0, maximum: 24 })),
          blur: Type.Optional(Type.Integer({ minimum: 0, maximum: 48 })), color: optional(color), opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 0.5 })) }, { additionalProperties: false })),
        typography: Type.Optional(Type.Object({ family: Type.Optional(Type.String({ pattern: '^(system|serif|mono)$' })), size: Type.Optional(Type.Integer({ minimum: 12, maximum: 18 })) }, { additionalProperties: false })),
        density: Type.Optional(Type.String({ pattern: '^(comfortable|compact)$' })),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      const turn = activeTurn(getTurnContext, sessionId);
      const idempotencyKey = `pi-theme-${createHash('sha256').update(JSON.stringify([sessionId, turn.turnId, toolCallId])).digest('hex')}`;
      const result = await client.moduleRequest({ method: 'POST', path: '/v1/modules/themes/proposals', body: { ...params,
        idempotencyKey, origin: { kind: 'pi', sessionId, turnId: turn.turnId, toolCallId } }, signal });
      return { content: [{ type: 'text', text: `Proposed ${result.theme.name} (${result.theme.id}), version ${result.version.version}. Human review is required; no theme was activated.` }],
        details: { theme: result.theme, version: result.version, idempotent: result.idempotent === true } };
    },
  });
}
