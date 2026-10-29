import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../persistence/store.mjs';
import { createHub } from '../hub/server.mjs';
import { createHubClient } from './hub-client.mjs';
import { createSessionController } from './session-controller.mjs';

const cards = ['a','b'].map((id,index) => ({ id, canvasId: 'canvas', sessionId: `session-${id}`, title: id, x: index * 500, y: 0, revision: 1 }));
async function fixture(t, runner = async ({ card, input }) => ({ text: `${card.sessionId}:${input.text}` })) {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-ui-state-'));
  const store = openStore(join(root, 'store.sqlite'));
  for (const card of cards) store.createCard(card);
  const bearer = 'synthetic-ui-controller-fixture-credential';
  const operations = ['snapshot.read','events.read','command.read','session.message','command.cancel','card.update'];
  const hub = createHub({store, bearerSecret: bearer,
    authContext: { principalId:'fixture', expiresAt:1000, revoked:false, grants:operations.map(operation => ({effect:'allow', permission:operation.endsWith('.read')?'read':'write', operation, projectId:'fixture'})) },
    now:()=>1, resolveTarget:({card})=>({projectId:'fixture',cardId:card.id,sessionId:card.sessionId}), runner});
  const address = await hub.listen();
  const client = createHubClient({baseUrl:`http://127.0.0.1:${address.port}`,bearer});
  t.after(async()=>{await hub.shutdown({abortActive:true});store.close();await rm(root,{recursive:true,force:true});});
  return { client, store, hub };
}
const input = (name,text) => ({cardId:name,sessionId:`session-${name}`,text});
async function settle(controller, predicate) {
  for(let i=0;i<50;i++){await controller.refresh();if(predicate(controller.getSnapshot()))return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('controller did not settle');
}

test('actual Hub restores separate accepted user/result histories after a fresh UI controller', async t => {
  const {client}=await fixture(t);
  const sent=[];
  const trackedClient={...client,sendMessage(...args){sent.push({cardId:args[0],id:args[2]});return client.sendMessage(...args);}};
  const controller=createSessionController({client:trackedClient,cards});
  t.after(()=>controller.dispose());
  await controller.refresh();
  assert.equal(controller.getSnapshot().statusBySession['session-a'],'ready');
  assert.deepEqual(await controller.send(input('a','A private')), {accepted:true});
  assert.deepEqual(await controller.send(input('b','B private')), {accepted:true});
  await settle(controller,state=>Object.values(state.statusBySession).every(status=>status==='ready'));
  const state=controller.getSnapshot();
  assert.deepEqual(state.messagesBySession['session-a'].map(message=>message.text),['A private','session-a:A private']);
  assert.deepEqual(state.messagesBySession['session-b'].map(message=>message.text),['B private','session-b:B private']);
  const resultA=state.messagesBySession['session-a'].at(-1);
  const resultB=state.messagesBySession['session-b'].at(-1);
  assert.deepEqual(resultA.transferSource,{kind:'command',cardId:'a',id:sent.find(item=>item.cardId==='a').id});
  assert.deepEqual(resultB.transferSource,{kind:'command',cardId:'b',id:sent.find(item=>item.cardId==='b').id});
  assert.notEqual(resultA.id,resultA.transferSource.id,'source uses authoritative command ID, not display message ID');
  controller.dispose();
  const reopened=createSessionController({client,cards});t.after(()=>reopened.dispose());
  await reopened.refresh();
  assert.deepEqual(reopened.getSnapshot().messagesBySession,state.messagesBySession);
  assert.equal((await reopened.send(input('a','next'))).accepted,true);
});

test('explicit card removal drops only that session and permits the remaining authoritative catalog', async t => {
  const { client } = await fixture(t);
  const controller = createSessionController({ client, cards }); t.after(() => controller.dispose());
  await controller.refresh();
  controller.removeCards(['a']);
  assert.deepEqual(controller.getSnapshot().cards.map(card => card.id), ['a']);
  assert.equal(controller.getSnapshot().messagesBySession['session-b'], undefined);
  assert.deepEqual(controller.addCards(cards.filter(card => card.id === 'a')), { added: 0 });
  assert.equal((await controller.send(input('a', 'still connected'))).accepted, true);
});

test('uncertain request and draft survive catalog addition; same-ID reconciliation does not replay', async t => {
  let effects=0, posts=0;
  const {client,store}=await fixture(t,async()=>{effects++;return{text:'done'};});
  const child={id:'c',canvasId:'canvas',sessionId:'session-c',title:'child',x:20,y:0,revision:1};
  store.createCard(child);
  const reads=[];
  const lossy={...client,
    snapshot(...args){reads.push('snapshot');return client.snapshot(...args);},
    events(...args){reads.push('events');return client.events(...args);},
    readCommand(...args){reads.push(`command:${args[0]}`);return client.readCommand(...args);},
    async sendMessage(...args){posts++;await client.sendMessage(...args);throw Object.assign(Error('not surfaced'),{unknownOutcome:true});},
  };
  const controller=createSessionController({client:lossy,cards,newId:()=> 'one-stable-id'});t.after(()=>controller.dispose());
  await controller.refresh();
  assert.equal((await controller.send(input('a','keep draft'))).accepted,false);
  assert.ok(controller.getSnapshot().messagesBySession['session-a'].every(message=>!Object.hasOwn(message,'transferSource')));
  assert.equal(controller.getSnapshot().statusBySession['session-a'],'reconciliation');
  const beforeAdd=reads.length;
  assert.deepEqual(controller.addCards([...cards,child]),{added:1});
  assert.equal(reads.length,beforeAdd,'catalog addition must not read from Hub');
  assert.equal(controller.getSnapshot().cards.length,3);
  assert.equal(controller.getSnapshot().statusBySession['session-c'],'disconnected');
  assert.equal((await controller.send(input('c','not yet'))).message,'DISCONNECTED');
  assert.equal(posts,1);
  assert.equal(controller.getSnapshot().messagesBySession['session-a'][0].text,'keep draft');
  assert.equal(controller.getSnapshot().statusBySession['session-a'],'reconciliation');
  await controller.refresh();
  assert.equal(controller.getSnapshot().statusBySession['session-a'],'reconciliation');
  assert.equal(posts,1);assert.equal(effects,1);
  assert.equal((await controller.send(input('a','changed draft'))).message,'RECONCILE_ORIGINAL_DRAFT');
  assert.deepEqual(await controller.send(input('a','keep draft')),{accepted:true});
  assert.equal(posts,1);assert.equal(effects,1);
  assert.ok(reads.includes('command:one-stable-id'),'explicit same-draft action must reconcile the original command ID');
  assert.deepEqual(controller.getSnapshot().messagesBySession['session-a'].map(message=>message.text),['keep draft','done']);
  assert.deepEqual(controller.getSnapshot().messagesBySession['session-a'].at(-1).transferSource,{kind:'command',cardId:'a',id:'one-stable-id'});
});

test('only accepted completed ok results carry transfer source metadata', async t => {
  const commands=[
    {id:'running-id',state:'RUNNING',result:null,message:{role:'user',text:'running input'}},
    {id:'error-id',state:'COMPLETED',result:{status:'error',text:'failed'},message:{role:'user',text:'failed input'}},
    {id:'cancel-id',state:'COMPLETED',result:{status:'cancelled'},message:{role:'user',text:'cancelled input'}},
    {id:'reconcile-id',state:'NEEDS_RECONCILIATION',result:{status:'ok',text:'unconfirmed'},message:{role:'user',text:'unconfirmed input'}},
    {id:'completed-id',state:'COMPLETED',result:{status:'ok',text:'verified result'},message:{role:'user',text:'verified input'}},
  ];
  const client={
    snapshot:async()=>({card:cards[0],eventSequence:commands.length}),
    events:async(_id,after)=>{
      const page=commands.slice(after,after+100);
      return {events:page.map((command,index)=>({sequence:after+index+1,kind:`command.${command.state.toLowerCase()}`,payload:{id:command.id}})),nextSequence:after+page.length};
    },
    readCommand:async id=>({command:commands.find(command=>command.id===id)}),
  };
  const controller=createSessionController({client,cards:[cards[0]]});t.after(()=>controller.dispose());
  await controller.refresh();
  const messages=controller.getSnapshot().messagesBySession['session-a'];
  const sourced=messages.filter(message=>Object.hasOwn(message,'transferSource'));
  assert.equal(sourced.length,1);
  assert.equal(sourced[0].text,'verified result');
  assert.deepEqual(sourced[0].transferSource,{kind:'command',cardId:'a',id:'completed-id'});
});

test('unreserved uncertain send only retries on explicit same-draft action with the original request ID', async t => {
  let effects=0, attempts=0;
  const {client}=await fixture(t,async()=>{effects++;return{text:'once'};});
  const flaky={...client,async sendMessage(...args){attempts++;if(attempts===1)throw Object.assign(Error(),{unknownOutcome:true});assert.equal(args[2],'stable');return client.sendMessage(...args);}};
  const controller=createSessionController({client:flaky,cards,newId:()=> 'stable'});t.after(()=>controller.dispose());
  await controller.refresh();
  assert.equal((await controller.send(input('a','text'))).accepted,false);
  await controller.refresh();await controller.refresh();
  assert.equal(attempts,1);assert.equal(effects,0);
  assert.equal((await controller.send(input('a','text'))).accepted,true);
  await settle(controller,state=>state.statusBySession['session-a']==='ready');
  assert.equal(effects,1);assert.equal(attempts,2);
});

test('disposing a controller drops stale reads without cancelling a running backend job', async t => {
  let finish, aborted=false;
  const {client,store}=await fixture(t,({signal})=>new Promise(resolve=>{finish=resolve;signal.addEventListener('abort',()=>{aborted=true;resolve({status:'CANCELLED'});},{once:true});}));
  const controller=createSessionController({client,cards,newId:()=> 'running'});
  await controller.refresh();await controller.send(input('a','work'));
  controller.dispose();finish({text:'completed without GUI'});
  for(let i=0;store.getCommand('running').state==='RUNNING'&&i<30;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(store.getCommand('running').state,'COMPLETED');assert.equal(aborted,false);
  let release, events=0, observedSignal;
  const delayed={...client,snapshot:(_id,signal)=>{observedSignal=signal;return new Promise(resolve=>{release=resolve;});},events:()=>{events++;throw Error('stale read');}};
  const stale=createSessionController({client:delayed,cards:[cards[0]]});let notifications=0;stale.subscribe(()=>notifications++);
  const pending=stale.refresh();stale.dispose();release({card:cards[0],eventSequence:1});await pending;
  assert.equal(observedSignal.aborted,true);assert.equal(events,0);assert.equal(notifications,0);
});

test('cancel acceptance does not replace an authoritative successful result with cancelled', async t => {
  const {client}=await fixture(t,({signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve({text:'success despite cancellation'}),{once:true})));
  let number=0;
  const controller=createSessionController({client,cards,newId:()=>`id-${++number}`});t.after(()=>controller.dispose());
  await controller.refresh();await controller.send(input('a','work'));
  assert.equal(await controller.cancel(input('a','')),true);
  await settle(controller,state=>state.statusBySession['session-a']==='ready');
  assert.equal(controller.getSnapshot().messagesBySession['session-a'].at(-1).text,'success despite cancellation');
  assert.equal(await controller.cancel(input('a','')),false);
});

test('duplicate sessions and forged card-session mapping are rejected without sending', async t => {
  const {client}=await fixture(t);
  assert.throws(()=>createSessionController({client,cards:[cards[0],{...cards[1],sessionId:cards[0].sessionId}]}),/INVALID_SESSION_MAPPING/);
  const controller=createSessionController({client,cards});t.after(()=>controller.dispose());await controller.refresh();
  await assert.rejects(controller.send({cardId:'a',sessionId:'session-b',text:'forged'}),/INVALID_SESSION_MAPPING/);
  assert.deepEqual(controller.getSnapshot().messagesBySession['session-a'],[]);
});

test('a stale RUNNING read cannot replace a reconciled terminal result', async t => {
  let release, entered, reads=0;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const command=state=>({id:'stable',state,result:state==='COMPLETED'?{status:'ok',text:'final answer'}:null,message:{role:'user',text:'draft'}});
  const client={
    snapshot:async()=>({card:cards[0],eventSequence:0}),
    events:async()=>({events:[],nextSequence:0}),
    sendMessage:async()=>{throw Object.assign(Error(),{unknownOutcome:true});},
    readCommand:async()=>{
      if(++reads===1){entered();return new Promise(resolve=>{release=()=>resolve({command:command('RUNNING')});});}
      return {command:command('COMPLETED')};
    },
  };
  const controller=createSessionController({client,cards:[cards[0]],newId:()=> 'stable'});t.after(()=>controller.dispose());
  await controller.refresh();await controller.send(input('a','draft'));
  const stale=controller.refresh();await waiting;
  assert.equal((await controller.send(input('a','draft'))).accepted,true);
  assert.equal(controller.getSnapshot().statusBySession['session-a'],'ready');
  release();await stale;
  assert.equal(controller.getSnapshot().statusBySession['session-a'],'ready');
  assert.equal(controller.getSnapshot().messagesBySession['session-a'].at(-1).text,'final answer');
});

test('history backlog stays disconnected until the authoritative snapshot watermark is reached', async t => {
  const {client,store}=await fixture(t);
  for(let i=0;i<1000;i++)store.appendEvent('a','fixture.event',{number:i});
  const controller=createSessionController({client,cards});t.after(()=>controller.dispose());
  await controller.refresh();
  assert.equal(controller.getSnapshot().statusBySession['session-a'],'disconnected');
  assert.equal(controller.getSnapshot().errorBySession['session-a'],'SYNCHRONIZING_HISTORY');
  assert.equal(controller.getSnapshot().statusBySession['session-b'],'ready');
  assert.equal((await controller.send(input('a','too early'))).accepted,false);
  await controller.refresh();
  assert.equal(controller.getSnapshot().statusBySession['session-a'],'ready');
});

const moveCard = (card, patch = {}) => ({ ...card, ...patch });
const canvasMove = (card, patch = {}) => ({ id: card.id, canvasId: card.canvasId, sessionId: card.sessionId, x: card.x, y: card.y, revision: card.revision, ...patch });
function positionClient(overrides = {}) {
  const current = new Map(cards.map(card => [card.id, { ...card }]));
  return {
    current,
    snapshot: async id => ({ card: current.get(id), eventSequence: 0 }),
    events: async (_id, after) => ({ events: [], nextSequence: after }),
    readCommand: async id => ({ command: { id, state: 'COMPLETED', message: { role: 'user', text: 'from refresh' }, result: { status: 'ok', text: 'refreshed command' } } }),
    moveCard: async (id, { expectedRevision, x, y }) => {
      const previous = current.get(id);
      if (previous.revision !== expectedRevision) throw Object.assign(Error(), { status: 409, code: 'HTTP_ERROR' });
      const card = moveCard(previous, { x, y, revision: previous.revision + 1 });
      current.set(id, card);
      return { card };
    },
    ...overrides,
  };
}

test('Canvas position move uses authoritative mapping/revision and updates only a matching valid card', async () => {
  const calls = [];
  const client = positionClient({ moveCard: async (...args) => {
    calls.push(args);
    return { card: moveCard(cards[0], { x: 40, y: -25, revision: 2 }) };
  } });
  const controller = createSessionController({ client, cards });
  await controller.refresh();
  assert.deepEqual(await controller.move(canvasMove(cards[0], { x: 40, y: -25 })), { accepted: true });
  assert.deepEqual(calls, [['a', { expectedRevision: 1, x: 40, y: -25 }, calls[0][2]]]);
  assert.equal(calls[0][2] instanceof AbortSignal, true);
  assert.deepEqual(controller.getSnapshot().cards[0], moveCard(cards[0], { x: 40, y: -25, revision: 2 }));
  assert.equal(controller.getSnapshot().positionErrorByCard.a, null);
  controller.dispose();
});

test('model settings update does not require canvas coordinates', async () => {
  const client = positionClient({
    updateModelSettings: async (id, update) => {
      const previous = currentCard();
      assert.equal(id, previous.id);
      assert.equal(update.expectedRevision, previous.revision);
      const card = moveCard(previous, { modelProvider: update.provider, modelId: update.modelId,
        reasoning: update.reasoning, revision: previous.revision + 1 });
      client.current.set(id, card);
      return { card };
    },
  });
  const currentCard = () => client.current.get('a');
  const controller = createSessionController({ client, cards });
  await controller.refresh();
  assert.deepEqual(await controller.updateModel({ id: 'a', canvasId: 'canvas', sessionId: 'session-a', revision: 1,
    provider: 'openai-codex', modelId: 'gpt-6-luna', reasoning: 'high' }), { accepted: true });
  assert.equal(controller.getSnapshot().cards[0].reasoning, 'high');
  assert.equal(controller.getSnapshot().positionErrorByCard.a, null);
  controller.dispose();
});

test('move rejects disconnected, forged, stale, invalid, and unbounded input without POST', async () => {
  let posts = 0;
  const client = positionClient({ moveCard: async () => { posts++; return { card: cards[0] }; } });
  const controller = createSessionController({ client, cards });
  const move = input => controller.move(input);
  assert.equal((await move(canvasMove(cards[0]))).message, 'DISCONNECTED');
  await controller.refresh();
  assert.equal((await move(canvasMove(cards[0], { canvasId: 'forged' }))).message, 'INVALID_SESSION_MAPPING');
  assert.equal((await move({ ...canvasMove(cards[0]), cardId: 'b' })).message, 'INVALID_SESSION_MAPPING');
  assert.equal((await move(canvasMove(cards[0], { revision: 2 }))).message, 'STALE_POSITION');
  assert.equal((await move(canvasMove(cards[0], { x: Number.NaN }))).message, 'INVALID_POSITION');
  assert.equal((await move(canvasMove(cards[0], { y: 1_000_001 }))).message, 'INVALID_POSITION');
  assert.equal((await move({ ...canvasMove(cards[0]), id: 'unknown' })).message, 'INVALID_SESSION_MAPPING');
  assert.equal(posts, 0);
  assert.equal(controller.getSnapshot().positionErrorByCard.a, 'INVALID_POSITION');
  controller.dispose();
});

test('moves serialize per card but different cards can move concurrently', async () => {
  const waits = new Map(), calls = [];
  const client = positionClient({ moveCard: (id, args) => {
    calls.push([id, args]);
    const wait = new Promise(resolve => waits.set(id, resolve));
    return wait;
  } });
  const controller = createSessionController({ client, cards });
  await controller.refresh();
  const firstA = controller.move(canvasMove(cards[0], { x: 10 }));
  const firstB = controller.move(canvasMove(cards[1], { x: 510 }));
  assert.equal((await controller.move(canvasMove(cards[0], { x: 20 }))).message, 'POSITION_BUSY');
  assert.equal(calls.length, 2);
  waits.get('a')({ card: moveCard(cards[0], { x: 10, revision: 2 }) });
  waits.get('b')({ card: moveCard(cards[1], { x: 510, revision: 2 }) });
  assert.deepEqual(await Promise.all([firstA, firstB]), [{ accepted: true }, { accepted: true }]);
  controller.dispose();
});

test('409 preserves last confirmed card; a newer read-only refresh recovers position state', async () => {
  const client = positionClient({ moveCard: async () => { throw Object.assign(Error(), { status: 409, code: 'HTTP_ERROR' }); } });
  const controller = createSessionController({ client, cards });
  await controller.refresh();
  assert.equal((await controller.move(canvasMove(cards[0], { x: 12 }))).message, 'CONFLICT');
  assert.deepEqual(controller.getSnapshot().cards[0], cards[0]);
  assert.equal(controller.getSnapshot().positionErrorByCard.a, 'CONFLICT');
  client.current.set('a', moveCard(cards[0], { x: 30, y: 40, revision: 2 }));
  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().cards[0], client.current.get('a'));
  assert.equal(controller.getSnapshot().positionErrorByCard.a, null);
  controller.dispose();
});

test('no-effect unknown move recovers after same-revision refresh; actual Hub CAS rejects late old POST', async t => {
  const { client, store } = await fixture(t);
  let posts = 0, lateOldPost;
  const wrapped = {
    ...client,
    moveCard(id, request, signal) {
      posts++;
      if (posts === 1) {
        lateOldPost = () => client.moveCard(id, request, signal); // delayed request with the original CAS revision
        throw Object.assign(Error(), { unknownOutcome: true, code: 'CONNECTION_FAILED' });
      }
      return client.moveCard(id, request, signal);
    },
  };
  const controller = createSessionController({ client: wrapped, cards });
  t.after(() => controller.dispose());
  await controller.refresh();
  assert.equal((await controller.move(canvasMove(cards[0], { x: 20 }))).message, 'OUTCOME_UNKNOWN');
  assert.equal(controller.getSnapshot().cards[0].revision, 1);
  assert.equal(controller.getSnapshot().positionErrorByCard.a, 'OUTCOME_UNKNOWN');
  assert.equal(posts, 1);

  await controller.refresh();
  assert.equal(posts, 1); // refresh never POSTs; error remains until the next explicit action
  assert.equal(controller.getSnapshot().cards[0].revision, 1);
  assert.equal(controller.getSnapshot().positionErrorByCard.a, 'OUTCOME_UNKNOWN');
  assert.deepEqual(await controller.move(canvasMove(cards[0], { x: 30 })), { accepted: true });
  assert.equal(posts, 2);
  assert.equal(controller.getSnapshot().cards[0].revision, 2);
  assert.equal(controller.getSnapshot().cards[0].x, 30);
  await assert.rejects(lateOldPost(), error => error.status === 409);
  assert.equal(store.getCard('a').revision, 2);
  assert.equal(store.getCard('a').x, 30);
  assert.equal(controller.getSnapshot().positionErrorByCard.a, null);
});

test('refresh begun before a successful move cannot roll back card state and still reconciles events', async () => {
  const stale = (() => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; })();
  let snapshots = 0;
  const eventReads = new Map();
  const client = positionClient({
    snapshot: async id => {
      if (id !== 'a') return { card: cards[1], eventSequence: 0 };
      return ++snapshots === 1 ? { card: cards[0], eventSequence: 0 } : stale.promise;
    },
    events: async (id, after) => {
      const count = (eventReads.get(id) ?? 0) + 1; eventReads.set(id, count);
      if (id !== 'a' || count === 1) return { events: [], nextSequence: after };
      return {
        events: [{ sequence: after + 1, kind: 'command.completed', payload: { id: 'refresh-command' } }],
        nextSequence: after + 1,
      };
    },
    moveCard: async () => ({ card: moveCard(cards[0], { x: 60, y: 70, revision: 2 }) }),
  });
  const controller = createSessionController({ client, cards });
  await controller.refresh();
  const oldRefresh = controller.refresh();
  assert.deepEqual(await controller.move(canvasMove(cards[0], { x: 60, y: 70 })), { accepted: true });
  stale.resolve({ card: cards[0], eventSequence: 1 });
  await oldRefresh;
  const state = controller.getSnapshot();
  assert.equal(state.cards[0].revision, 2); assert.equal(state.cards[0].x, 60); assert.equal(state.cards[0].y, 70);
  assert.deepEqual(state.messagesBySession['session-a'].map(message => message.text), ['from refresh', 'refreshed command']);
  assert.equal(state.statusBySession['session-a'], 'ready');
  controller.dispose();
});

test('newer refresh before delayed older move receipt is not downgraded', async () => {
  let serverCard = { ...cards[0] }, release;
  const client = positionClient({
    snapshot: async id => ({ card: id === 'a' ? serverCard : cards[1], eventSequence: 0 }),
    moveCard: async () => new Promise(resolve => { release = resolve; }),
  });
  const controller = createSessionController({ client, cards });
  await controller.refresh();
  const pendingMove = controller.move(canvasMove(cards[0], { x: 10, y: 11 }));
  serverCard = moveCard(cards[0], { x: 90, y: 91, revision: 3 });
  await controller.refresh();
  release({ card: moveCard(cards[0], { x: 10, y: 11, revision: 2 }) });
  assert.deepEqual(await pendingMove, { accepted: true });
  assert.equal(controller.getSnapshot().cards[0].revision, 3);
  assert.equal(controller.getSnapshot().cards[0].x, 90); assert.equal(controller.getSnapshot().cards[0].y, 91);
  controller.dispose();
});

test('invalid successful move receipt is uncertain and does not replace the confirmed card', async () => {
  const client = positionClient({ moveCard: async () => ({ card: moveCard(cards[0], { id: 'b', x: 10, revision: 2 }) }) });
  const controller = createSessionController({ client, cards });
  await controller.refresh();
  assert.equal((await controller.move(canvasMove(cards[0], { x: 10 }))).message, 'OUTCOME_UNKNOWN');
  assert.deepEqual(controller.getSnapshot().cards[0], cards[0]);
  assert.equal(controller.getSnapshot().positionErrorByCard.a, 'OUTCOME_UNKNOWN');
  controller.dispose();
});

test('disposing during move prevents late card mutation', async () => {
  let finish, observedSignal, notifications = 0;
  const client = positionClient({ moveCard: (_id, _input, signal) => {
    observedSignal = signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  const controller = createSessionController({ client, cards });
  await controller.refresh();
  controller.subscribe(() => notifications++);
  const pendingMove = controller.move(canvasMove(cards[0], { x: 99 }));
  const beforeDispose = controller.getSnapshot();
  controller.dispose();
  const disposedSnapshot = controller.getSnapshot();
  assert.equal(observedSignal.aborted, true);
  finish({ card: moveCard(cards[0], { x: 99, revision: 2 }) });
  assert.deepEqual(await pendingMove, { accepted: false, message: 'VIEW_CLOSED' });
  assert.equal(controller.getSnapshot(), disposedSnapshot);
  assert.deepEqual(controller.getSnapshot().cards[0], cards[0]);
  assert.equal(beforeDispose.cards[0].revision, 1);
  assert.equal(notifications, 0);
});

test('catalog addition preserves actual Hub history/cursor, keeps owner snapshots, and waits for child sync', async t => {
  const {client,store}=await fixture(t);
  const child={id:'c',canvasId:'canvas',sessionId:'session-c',title:'child',x:25,y:5,revision:1};
  store.createCard(child);
  const calls=[],eventCursors=[];
  const tracked={...client,
    snapshot(...args){calls.push('snapshot');return client.snapshot(...args);},
    events(...args){calls.push('events');return client.events(...args).then(page=>{eventCursors.push({id:args[0],after:args[1],next:page.nextSequence});return page;});},
    readCommand(...args){calls.push('readCommand');return client.readCommand(...args);},
    sendMessage(...args){calls.push('sendMessage');return client.sendMessage(...args);},
  };
  const controller=createSessionController({client:tracked,cards});t.after(()=>controller.dispose());
  await controller.refresh();
  assert.deepEqual(await controller.send(input('a','before catalog')),{accepted:true});
  await settle(controller,state=>state.statusBySession['session-a']==='ready');
  const oldMessages=controller.getSnapshot().messagesBySession['session-a'];
  const oldCursor=eventCursors.filter(event=>event.id==='a').at(-1).next;
  const catalog=[{...cards[0],title:'stale catalog title',x:999,y:999,revision:99},cards[1],child];
  let notifications=0;controller.subscribe(()=>notifications++);
  const callsBefore=calls.length;
  assert.deepEqual(controller.addCards(catalog),{added:1});
  assert.equal(calls.length,callsBefore,'addCards must not issue Hub reads or writes');
  assert.equal(controller.getSnapshot().cards[0].title,'a');
  assert.equal(controller.getSnapshot().cards[0].revision,1);
  assert.deepEqual(controller.getSnapshot().messagesBySession['session-a'],oldMessages);
  assert.equal(controller.getSnapshot().statusBySession['session-c'],'disconnected');
  assert.deepEqual(await controller.send(input('c','before sync')),{accepted:false,message:'DISCONNECTED'});
  assert.equal(calls.length,callsBefore);
  const notificationsAfterAdd=notifications;
  assert.deepEqual(controller.addCards(catalog),{added:0});
  assert.equal(notifications,notificationsAfterAdd,'identical catalog must not publish');
  assert.equal(calls.length,callsBefore,'no-op catalog must not read from Hub');
  await controller.refresh();
  const nextA=eventCursors.filter(event=>event.id==='a').at(-1);
  assert.equal(nextA.after,oldCursor,'existing event cursor must be retained');
  assert.deepEqual(controller.getSnapshot().messagesBySession['session-a'],oldMessages,'accepted history must not duplicate or disappear');
  assert.equal(controller.getSnapshot().statusBySession['session-c'],'ready');
});

test('catalog addition during an in-flight actual Hub send preserves the operation and dispatches once', async t => {
  let effects=0,posts=0,enteredResolve,release;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const {client,store}=await fixture(t,async()=>{effects++;return{text:'sent once'};});
  const child={id:'c',canvasId:'canvas',sessionId:'session-c',title:'child',x:25,y:5,revision:1};store.createCard(child);
  const delayed={...client,sendMessage(...args){posts++;return client.sendMessage(...args).then(async result=>{enteredResolve();await gate;return result;});}};
  const controller=createSessionController({client:delayed,cards});
  t.after(()=>{release();controller.dispose();});
  await controller.refresh();
  const pending=controller.send(input('a','held receipt'));
  await entered;
  assert.deepEqual(controller.addCards([...cards,child]),{added:1});
  assert.equal((await controller.send(input('a','held receipt'))).message,'SESSION_BUSY');
  assert.equal((await controller.send(input('c','child'))).message,'DISCONNECTED');
  assert.equal(posts,1);
  release();
  assert.deepEqual(await pending,{accepted:true});
  await settle(controller,state=>state.statusBySession['session-a']==='ready'&&state.statusBySession['session-c']==='ready');
  assert.equal(posts,1);assert.equal(effects,1);
  assert.deepEqual(controller.getSnapshot().messagesBySession['session-a'].map(message=>message.text),['held receipt','sent once']);
});

test('catalog addition during an in-flight actual Hub move preserves CAS state and dispatches once', async t => {
  let posts=0,enteredResolve,release;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const {client,store}=await fixture(t);
  const child={id:'c',canvasId:'canvas',sessionId:'session-c',title:'child',x:25,y:5,revision:1};store.createCard(child);
  const delayed={...client,moveCard(...args){posts++;return client.moveCard(...args).then(async result=>{enteredResolve();await gate;return result;});}};
  const controller=createSessionController({client:delayed,cards});
  t.after(()=>{release();controller.dispose();});
  await controller.refresh();
  const pending=controller.move(canvasMove(cards[0],{x:41,y:42}));
  await entered;
  const catalog=[{...cards[0],title:'stale',x:700,y:800,revision:99},cards[1],child];
  assert.deepEqual(controller.addCards(catalog),{added:1});
  assert.equal(controller.getSnapshot().cards[0].x,0,'catalog must not overwrite active card state');
  assert.equal((await controller.move(canvasMove(cards[0],{x:50,y:50}))).message,'POSITION_BUSY');
  assert.equal((await controller.send(input('c','child'))).message,'DISCONNECTED');
  assert.equal(posts,1);
  release();
  assert.deepEqual(await pending,{accepted:true});
  assert.equal(controller.getSnapshot().cards[0].x,41);
  assert.equal(controller.getSnapshot().cards[0].y,42);
  assert.equal(controller.getSnapshot().cards[0].revision,2);
  assert.equal(store.getCard('a').revision,2);
  assert.equal(store.getCard('a').x,41);
  assert.equal(posts,1);
});

test('addCards validates atomically, accepts finite legacy positions, and enforces the 100-card cap without HTTP', async () => {
  let http=0,notifications=0;
  const client={snapshot(){http++;},events(){http++;},readCommand(){http++;},sendMessage(){http++;},moveCard(){http++;}};
  const original={...cards[0]};
  const controller=createSessionController({client,cards:[original]});
  controller.subscribe(()=>notifications++);
  const good={id:'new-card',canvasId:'canvas',sessionId:'session-new',title:'new',x:1,y:2,revision:1};
  const assertInvalid=catalog=>{
    const before=notifications;
    assert.throws(()=>controller.addCards(catalog),error=>error instanceof TypeError&&error.code==='INVALID_SESSION_MAPPING');
    assert.deepEqual(controller.getSnapshot().cards.map(card=>card.id),['a']);
    assert.equal(notifications,before,'invalid catalog must not partially publish');
    assert.equal(http,0,'invalid catalog must not make HTTP calls');
  };
  assertInvalid([]);
  const sparse=[original,,good];
  assertInvalid(sparse);
  assertInvalid([original,good,{...good,id:'bad id'}]);
  assertInvalid([original,{...good,id:'a',sessionId:'session-other'}]);
  assertInvalid([original,{...good,sessionId:original.sessionId}]);
  assertInvalid([{...original,sessionId:'remapped'},good]);
  assertInvalid([good]);
  assertInvalid([original,Object.assign(Object.create({}),good)]);
  assertInvalid([original,good,{...good,id:'bad-x',sessionId:'session-bad',x:Number.POSITIVE_INFINITY}]);
  assertInvalid([original,{...good,id:'bad-rev',sessionId:'session-rev',revision:0}]);
  assertInvalid([original,{...good,id:'bad-title',sessionId:'session-title',title:'x'.repeat(4097)}]);
  assertInvalid([original,...Array.from({length:100},(_,index)=>({...good,id:`over-${index}`,sessionId:`session-over-${index}`}))]);
  assert.equal(controller.getSnapshot().cards.length,1);
  controller.dispose();

  let boundaryHttp=0,boundaryNotifications=0;
  const boundary=createSessionController({client:{snapshot(){boundaryHttp++;},events(){boundaryHttp++;}},cards:[original]});
  boundary.subscribe(()=>boundaryNotifications++);
  const maxCatalog=[{...original,title:'catalog copy',x:999,y:999,revision:99},...Array.from({length:99},(_,index)=>({
    id:`new-${index}`,canvasId:'canvas',sessionId:`session-new-${index}`,title:`card-${index}`,
    x:index===0?1e200:index,y:index===0?-1e200:0,revision:1,
  }))];
  assert.deepEqual(boundary.addCards(maxCatalog),{added:99});
  assert.equal(boundary.getSnapshot().cards.length,100);
  assert.equal(boundary.getSnapshot().cards[0].title,'a','existing metadata is not replaced by the catalog');
  assert.equal(boundary.getSnapshot().cards[1].x,1e200,'finite legacy positions are not artificially bounded');
  assert.equal(boundary.getSnapshot().cards[1].y,-1e200);
  assert.equal(boundary.getSnapshot().statusBySession['session-new-0'],'disconnected');
  assert.equal((await boundary.send(input('new-0','not synced'))).message,'DISCONNECTED');
  assert.equal(boundaryHttp,0,'addCards and disconnected send must not call HTTP');
  assert.equal(boundaryNotifications,1);
  boundary.dispose();
});
