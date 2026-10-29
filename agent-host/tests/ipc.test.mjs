import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const configuredSdkRoot=process.env.AYLACHI_SDK_ROOT;
assert.ok(configuredSdkRoot,'set AYLACHI_SDK_ROOT to pinned SDK package directory');
const sdkRoot=resolve(configuredSdkRoot);
const fixture=fileURLToPath(new URL('./ipc-fixture.mjs',import.meta.url));
const children=new Set();

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit',resolve));
}
function launch(root) {
  const child=fork(fixture,[],{env:{AYLACHI_SDK_ROOT:sdkRoot,AYLACHI_TEST_ROOT:root},stdio:['ignore','ignore','inherit','ipc']});
  children.add(child);
  const pending=new Map(); let sequence=0;
  child.on('message',message=>{const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.ok?waiter.resolve(message.result):waiter.reject(new Error(message.error));});
  child.on('exit',(code,signal)=>{children.delete(child);for(const waiter of pending.values())waiter.reject(new Error(`child exit ${code??signal}`));pending.clear();});
  return {child,send(verb,sessionId,payload){const id=`request${++sequence}`;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.send({id,verb,...(sessionId?{sessionId}:{}),...(payload===undefined?{}:{payload})},error=>{if(error&&pending.has(id)){pending.delete(id);reject(error);}});});}};
}
async function waitFor(predicate, timeoutMs=10000) {
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error('timed out waiting for fixture readiness');
}
async function stop(child) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  child.kill('SIGTERM');
  let timer; await Promise.race([exited(child),new Promise(resolve=>{timer=setTimeout(resolve,1500);})]); clearTimeout(timer);
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited(child);}
}

test('forked Agent Host runs actual Pi SDK fixture, persists, cancels, bounds IPC and cleans owner',async t=>{
  const root=await mkdtemp(join(tmpdir(),'aylachi-ipc-'));
  t.after(async()=>{await Promise.all([...children].map(stop));await rm(root,{recursive:true,force:true});});
  const host=launch(root);
  const result=await host.send('prompt','ipcSession',{text:'ipc marker'});
  assert.equal(result.text,'fixture complete');assert.match(result.nativeSessionFile,/ipcSession/);
  const persisted=await readFile(result.nativeSessionFile,'utf8');assert.ok(persisted.includes('ipc marker'));assert.ok(persisted.includes('fixture_echo'));assert.ok(persisted.includes('safe fixture'));
  await assert.rejects(host.send('not-a-verb','ipcSession'),/UNKNOWN_VERB/);
  await assert.rejects(host.send('prompt','../bad',{text:'bad'}),/INVALID_SESSION_ID/);
  await host.send('shutdown');await exited(host.child);assert.equal(host.child.exitCode,0);

  const waitingRoot=join(root,'waiting');await import('node:fs/promises').then(fs=>fs.mkdir(waitingRoot));await writeFile(join(waitingRoot,'mode'),'wait');
  const waiting=launch(waitingRoot);
  const active=Array.from({length:8},(_,i)=>waiting.send('prompt',`cancel${i}`,{text:`wait ${i}`}));
  await waitFor(async()=>{try{return (await readFile(join(waitingRoot,'stream-started'),'utf8')).trim().split('\n').filter(Boolean).length>=8;}catch{return false;}});
  await assert.rejects(waiting.send('prompt','overflow',{text:'blocked'}),/INFLIGHT_LIMIT/);
  assert.deepEqual(await waiting.send('cancel','cancel0'),{cancelled:true});
  await assert.rejects(active[0],/CANCELLED/);
  for(let i=1;i<8;i++){assert.deepEqual(await waiting.send('cancel',`cancel${i}`),{cancelled:true});await assert.rejects(active[i],/CANCELLED/);}
  waiting.child.disconnect();await exited(waiting.child);assert.equal(waiting.child.exitCode,0);

  const failingRoot=join(root,'failing');await import('node:fs/promises').then(fs=>fs.mkdir(failingRoot));await writeFile(join(failingRoot,'mode'),'fail');
  const failing=launch(failingRoot);
  await assert.rejects(failing.send('prompt','failureSession',{text:'fail'}),/PROVIDER_FAILED/);
  await failing.send('shutdown');await exited(failing.child);assert.equal(failing.child.exitCode,0);
});
