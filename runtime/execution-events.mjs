// Backward-compatible runtime import; the event contract belongs to the Hub.
export { EXECUTION_EVENT_KIND, EXECUTION_SCHEMA_VERSION, snapshotWorkerExecutionEvent, makeExecutionEvent, executionRecord } from '../hub/execution-events.mjs';
