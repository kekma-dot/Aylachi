import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPiAdapter } from '../pi-adapter.mjs';
import { attachPiAdapterIpc } from '../ipc.mjs';
import { sdk, Type, model, runtime } from './fixture-runtime.mjs';

const testRoot = resolve(process.env.AYLACHI_TEST_ROOT ?? '');
if (!testRoot || !process.env.AYLACHI_SDK_ROOT) throw new Error('explicit test root and SDK root required');
await mkdir(testRoot, { recursive: true });
let mode = 'normal';
try { mode = (await readFile(join(testRoot, 'mode'), 'utf8')).trim(); } catch {}
const cwd = join(testRoot, 'workspace');
await mkdir(cwd, { recursive: true });
const tool = { name: 'fixture_echo', label: 'Fixture echo', description: 'Safe fixture only', parameters: Type.Object({ text: Type.String() }), execute: async (_id, args) => ({ content: [{ type: 'text', text: args.text }] }) };
const adapter = createPiAdapter({ sdk, modelRuntime: runtime({ fail: mode === 'fail', waitForAbort: mode === 'wait', onStart: () => appendFile(join(testRoot, 'stream-started'), 'started\n') }), model, root: join(testRoot, 'state'), cwd, toolDefinitions: [tool] });
attachPiAdapterIpc(adapter);
