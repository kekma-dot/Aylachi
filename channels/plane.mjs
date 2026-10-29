import { automaticHandoff } from './handoff.mjs';

const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });

export function createChannelPlane({ store, graph, core, deliver, sendOutbound } = {}) {
  if (!store || !graph || !core || typeof deliver !== 'function' || (sendOutbound !== undefined && typeof sendOutbound !== 'function')) {
    throw new TypeError('channel store, graph, core and trusted delivery required');
  }
  return Object.freeze({
    async ingest(routeId, input) {
      const { message, duplicate } = store.receive(routeId, input);
      if (message.state === 'RECEIVED') {
        const route = store.route(routeId);
        const commandId = `channel:${message.id}`;
        // The durable inbox ID makes crash/retry reuse the same Hub command.
        const command = await deliver({ cardId: route.conversationId, requestId: commandId,
          text: message.text, actingPrincipal: message.actingPrincipal });
        const handoff = automaticHandoff({ graph, core, conversationId: route.conversationId, commandId });
        const resultText = command?.state === 'COMPLETED' && command.result?.status === 'ok' && typeof command.result.value?.text === 'string'
          ? command.result.value.text : null;
        store.completeInbound(message.id, { commandId, handoff, responseText: resultText });
      }
      return { message: store.inbox(message.id), duplicate };
    },
    async flush() {
      if (!sendOutbound) throw bad('CHANNEL_ADAPTER_UNAVAILABLE', 409);
      const delivered = [];
      for (const pending of store.pendingOutbound()) {
        const message = store.beginOutbound(pending.id);
        try {
          const route = store.route(message.routeId);
          const receipt = await sendOutbound({ route, message });
          delivered.push(store.completeOutbound(message.id, receipt));
        } catch (error) {
          store.unknownOutbound(message.id);
          throw error;
        }
      }
      return delivered;
    },
    recover() { return store.recoverOutbound(); },
  });
}
