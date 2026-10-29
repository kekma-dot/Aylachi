// Optional public Pi ToolDefinition; the caller explicitly registers it.
// requestIdForCall must bind a stable SDK tool-call ID to the trusted parent
// command context. Neither parent identity nor policy comes from model arguments.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ERRORS = new Set(['POLICY_DENIED', 'NOT_FOUND', 'CONFLICT', 'WAIT_TIMEOUT', 'ABORTED', 'DELEGATE_OUTCOME_UNKNOWN', 'INVALID_INPUT', 'INVALID_REQUEST', 'TOO_LARGE']);

export function createDelegationTool({ Type, coordinator, requestIdForCall } = {}) {
  if (typeof Type?.Object !== 'function' || typeof Type?.String !== 'function' ||
      typeof coordinator?.delegate !== 'function' || typeof coordinator?.wait !== 'function' ||
      typeof requestIdForCall !== 'function') throw new TypeError('EXPLICIT_DELEGATION_BINDING_REQUIRED');
  return {
    name: 'delegate_task',
    label: 'Delegate task',
    description: 'Delegate one bounded task to an independent server-owned session and await its result. Host policy controls permissions, model and limits.',
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 16384 }) }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      const descriptor = params && Object.getOwnPropertyDescriptor(params, 'text');
      if (!params || ![Object.prototype, null].includes(Object.getPrototypeOf(params)) ||
          Reflect.ownKeys(params).length !== 1 || descriptor?.enumerable !== true || !('value' in descriptor) ||
          typeof descriptor.value !== 'string' || !descriptor.value.trim() || Buffer.byteLength(descriptor.value) > 16384 ||
          typeof toolCallId !== 'string' || !toolCallId || Buffer.byteLength(toolCallId) > 1024) throw new Error('INVALID_INPUT');
      let requestId;
      try { requestId = requestIdForCall(toolCallId); }
      catch { throw new Error('DELEGATION_BINDING_FAILED'); }
      if (typeof requestId !== 'string' || !ID.test(requestId)) throw new Error('DELEGATION_BINDING_FAILED');
      let record;
      try {
        const receipt = await coordinator.delegate({ requestId, text: descriptor.value }, { signal });
        record = await coordinator.wait(receipt.record.id, { signal });
      } catch (error) {
        // Never expose raw injected-client errors, URLs or credential-bearing causes.
        throw new Error(SAFE_ERRORS.has(error?.code) ? error.code : 'DELEGATION_FAILED');
      }
      if (record?.state !== 'COMPLETED' || record.result?.status !== 'ok' || typeof record.result.text !== 'string') {
        throw new Error(record?.result?.status === 'cancelled' ? 'CHILD_CANCELLED' : 'CHILD_FAILED');
      }
      return {
        content: [{ type: 'text', text: `Delegated child ${record.id}: ${record.result.text}` }],
        details: { taskId: record.id, childCardId: record.childCardId, childCommandId: record.childCommandId },
      };
    },
  };
}
