import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from '../agent-host/tests/fixture-runtime.mjs';
import { createProjectContextTool } from './context-tool.mjs';

const binding = {
  projectId: 'project-a', cardId: 'card-a', sessionId: 'session-a', commandId: 'command-a',
  bazaPrefix: '10 Проекты/Alpha/',
};
const validReply = projectId => ({ projectId, excerpts: [{ path: '10 Проекты/Alpha/state.md', text: 'synthetic context' }] });
const execute = (tool, args = { query: 'status' }) => tool.execute('call-1', args, new AbortController().signal);
const make = overrides => {
  const effects = { bindings: 0, authorizations: [], reads: [] };
  const tool = createProjectContextTool({
    Type,
    getBinding: () => { effects.bindings++; return binding; },
    authorize: descriptor => { effects.authorizations.push(descriptor); return true; },
    readProjectContext: async (...args) => { effects.reads.push(args); return validReply(binding.projectId); },
    ...overrides,
  });
  return { tool, effects };
};

test('tool registration is inert and successful reads use only the trusted binding', async () => {
  const { tool, effects } = make();
  assert.equal(tool.name, 'project_context');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(effects, { bindings: 0, authorizations: [], reads: [] });
  const signal = new AbortController().signal;
  const result = await tool.execute('call-1', { query: ' status ' }, signal);
  assert.deepEqual(JSON.parse(result.content[0].text), validReply(binding.projectId));
  assert.deepEqual(effects.authorizations, [{
    operation: 'project.context.read', permission: 'read',
    target: { projectId: binding.projectId, cardId: binding.cardId, sessionId: binding.sessionId },
    commandId: binding.commandId,
  }]);
  assert.deepEqual(effects.reads, [[binding.projectId, ' status ', signal]]);
});

test('malformed, extra, exotic, accessor, and oversized model arguments fail before any effect', async () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'query', { enumerable: true, get() { getterCalls++; throw Error('must not execute'); } });
  const hiddenExtra = { query: 'ok' };
  Object.defineProperty(hiddenExtra, 'projectId', { value: 'project-b', enumerable: false });
  const modelSelectedProject = { query: 'ok', projectId: 'project-b' };
  const symbolExtra = { query: 'ok', [Symbol('extra')]: true };
  const exotic = Object.assign(Object.create({ inherited: true }), { query: 'ok' });
  const { tool, effects } = make();
  for (const args of [null, [], {}, accessor, hiddenExtra, modelSelectedProject, symbolExtra, exotic, { query: '' }, { query: '界'.repeat(201) }]) {
    await assert.rejects(execute(tool, args), error => error.message === 'INVALID_INPUT');
  }
  assert.equal(getterCalls, 0);
  assert.deepEqual(effects, { bindings: 0, authorizations: [], reads: [] });
});

test('authorization must be explicitly true before the canonical RPC boundary', async () => {
  for (const decision of [false, 1, { allowed: true }, null]) {
    let reads = 0;
    const { tool } = make({ authorize: () => decision, readProjectContext: async () => { reads++; return validReply(binding.projectId); } });
    await assert.rejects(execute(tool), error => error.message === 'POLICY_DENIED');
    assert.equal(reads, 0);
  }
  const { tool } = make({ authorize: () => { throw Error('private authorization detail'); } });
  await assert.rejects(execute(tool), error => error.message === 'AUTHORIZATION_FAILED');
});

test('reply is validated completely before exposure, including project, path, shape, count, and UTF8 budget', async () => {
  const invalidReplies = [
    { projectId: 'project-b', excerpts: [] },
    { projectId: 'project-a', excerpts: [{ path: '10 Проекты/Beta/secret.md', text: 'foreign' }] },
    { projectId: 'project-a', excerpts: [{ path: '../secret.md', text: 'bad' }] },
    { projectId: 'project-a', excerpts: [{ path: '/10 Проекты/Alpha/a.md', text: 'bad' }] },
    { projectId: 'project-a', excerpts: [{ path: '10 Проекты/Alpha\\a.md', text: 'bad' }] },
    { projectId: 'project-a', excerpts: [{ path: '10 Проекты/Alpha/.hidden.md', text: 'bad' }] },
    { projectId: 'project-a', excerpts: [{ path: '10 Проекты/Alpha/bad\u0000name.md', text: 'bad' }] },
    { projectId: 'project-a', excerpts: [{ path: '10 Проекты/Alpha/../Beta/a.md', text: 'bad' }] },
    { projectId: 'project-a', excerpts: [{ path: '10 Проекты/Alpha//a.md', text: 'bad' }] },
    { projectId: 'project-a', extra: true, excerpts: [] },
    { projectId: 'project-a', excerpts: [{ path: '10 Проекты/Alpha/a.md', text: 'valid' }, { path: '10 Проекты/Beta/b.md', text: 'foreign' }] },
    { projectId: 'project-a', excerpts: Array.from({ length: 11 }, (_, i) => ({ path: `10 Проекты/Alpha/${i}.md`, text: 'x' })) },
    { projectId: 'project-a', excerpts: [{ path: '10 Проекты/Alpha/a.md', text: '界'.repeat(11000) }] },
  ];
  for (const reply of invalidReplies) {
    const { tool } = make({ readProjectContext: async () => reply });
    await assert.rejects(execute(tool), error => error.message === 'INVALID_CONTEXT_RESPONSE');
  }

  let getterCalls = 0;
  const exactBase = { projectId: 'project-a', excerpts: [{ path: '10 Проекты/Alpha/a.md', text: '' }] };
  const exactText = 'x'.repeat(32 * 1024 - Buffer.byteLength(JSON.stringify(exactBase)));
  const exactReply = { projectId: 'project-a', excerpts: [{ path: '10 Проекты/Alpha/a.md', text: exactText }] };
  const exactTool = make({ readProjectContext: async () => exactReply }).tool;
  const exactResult = await execute(exactTool);
  assert.equal(Buffer.byteLength(exactResult.content[0].text), 32 * 1024);
  const overTool = make({ readProjectContext: async () => ({ ...exactReply, excerpts: [{ ...exactReply.excerpts[0], text: `${exactText}x` }] }) }).tool;
  await assert.rejects(execute(overTool), error => error.message === 'INVALID_CONTEXT_RESPONSE');

  const getterReply = Object.defineProperties({}, {
    projectId: { enumerable: true, get() { getterCalls++; throw Error('must not execute'); } },
    excerpts: { enumerable: true, value: [] },
  });
  const { tool } = make({ readProjectContext: async () => getterReply });
  await assert.rejects(execute(tool), error => error.message === 'INVALID_CONTEXT_RESPONSE');
  assert.equal(getterCalls, 0);
});

test('binding failures and raw RPC failures are masked', async () => {
  const { tool: badBinding } = make({ getBinding: () => { throw Error('private binding value'); } });
  await assert.rejects(execute(badBinding), error => error.message === 'PROJECT_BINDING_FAILED');
  const { tool: badPrefix } = make({ getBinding: () => ({ ...binding, bazaPrefix: '../private/' }) });
  await assert.rejects(execute(badPrefix), error => error.message === 'PROJECT_BINDING_FAILED');
  const { tool: badRpc } = make({ readProjectContext: async () => { throw Error('https://private.invalid/?token=synthetic-secret'); } });
  await assert.rejects(execute(badRpc), error => error.message === 'CONTEXT_UNAVAILABLE' && !error.message.includes('private'));
});
