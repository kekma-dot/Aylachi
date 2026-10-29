import { attachPiAdapterIpc } from '../ipc.mjs';

const adapter = {
  async prompt(...args) {
    const [sessionId, text, context] = args;
    if (text === 'slow') await new Promise(resolve => setTimeout(resolve, 30));
    return { text: JSON.stringify({ sessionId, text, arity: args.length, context: context ?? null, frozen: context ? Object.isFrozen(context) : false }) };
  },
  async cancel() { return true; },
  async shutdown() {},
};

attachPiAdapterIpc(adapter);
