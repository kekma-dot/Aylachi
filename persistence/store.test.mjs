import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "./store.mjs";

test("durable state, command receipt, canonical inputs and recovery", () => {
  const dir=mkdtempSync(join(tmpdir(),"aylachi-store-")); const path=join(dir,"test.sqlite");
  try {
    let s=openStore(path);
    assert.throws(()=>s.createCard({id:"x",canvasId:"c",sessionId:"s",title:"t",x:NaN,y:0}),TypeError);
    const polluted={id:"x",canvasId:"c",sessionId:"s",title:"t",x:0,y:0}; Object.defineProperty(polluted,"__proto__",{value:1,enumerable:true}); assert.throws(()=>s.createCard(polluted),TypeError);
    s.createCard({id:"card",canvasId:"canvas",sessionId:"session",title:"title",x:0,y:0});
    assert.equal(s.updateCard("card",1,{x:2}).revision,2); assert.throws(()=>s.updateCard("card",1,{title:"stale"}),/REVISION_CONFLICT/);
    const first=s.reserveCommand({id:"cmd",cardId:"card",input:{op:"safe",nested:{a:1,b:2}}}); assert.equal(first.created,true); assert.equal(first.command.state,"RUNNING");
    let dispatches=0; if(first.created) dispatches++;
    const dup=s.reserveCommand({id:"cmd",cardId:"card",input:{op:"safe",nested:{b:2,a:1}}}); if(dup.created) dispatches++;
    assert.equal(dup.created,false); assert.equal(dispatches,1); assert.deepEqual(dup.command,first.command);
    assert.throws(()=>s.reserveCommand({id:"cmd",cardId:"card",input:{op:"different"}}),/COMMAND_ID_CONFLICT/);
    for (const invalid of [{v:undefined},{v:Infinity},{f(){}},(()=>{const x={};x.self=x;return x;})(),{toJSON(){return {op:"safe"}}}]) assert.throws(()=>s.reserveCommand({id:"invalid",cardId:"card",input:invalid}),TypeError);
    const eventsBefore=s.getEvents(0,100).length; assert.throws(()=>s.reserveCommand({id:"missing",cardId:"no-card",input:{op:"safe"}}),/unknown cardId/); assert.equal(s.getEvents(0,100).length,eventsBefore);
    assert.equal(s.completeCommand("cmd",{ok:true}).state,"COMPLETED"); assert.deepEqual(s.completeCommand("cmd",{ok:true}).result,{ok:true}); assert.throws(()=>s.completeCommand("cmd",{ok:false}),/COMMAND_NOT_RUNNING/);
    s.appendEvent("card","note",{ok:true});
    s.createCard({id:"other",canvasId:"other-canvas",sessionId:"other-session",title:"other",x:0,y:0});
    const aSnapshot=s.getCardSnapshot("card"), aEvents=s.getCardEvents("card",0,1000);
    s.appendEvent("other","private.activity",{private:"B-only"});
    s.appendEvent("other","private.activity",{private:"B-only-2"});
    assert.deepEqual(s.getCardSnapshot("card"),aSnapshot);
    assert.deepEqual(s.getCardEvents("card",0,1000),aEvents);
    assert.equal(Object.keys(aSnapshot).sort().join(","),"card,eventSequence");
    assert.equal(aSnapshot.eventSequence,aEvents.length);
    assert.ok(aEvents.every(e=>Object.keys(e).sort().join(",")==="kind,payload,sequence"));
    assert.ok(aEvents.every(e=>!JSON.stringify(e).includes("B-only")));
    s.appendEvent("card","note.after",{ok:"A"});
    const next=s.getCardEvents("card",aSnapshot.eventSequence,1000);
    assert.equal(s.getCardSnapshot("card").eventSequence,aSnapshot.eventSequence+1);
    assert.equal(next.length,1); assert.equal(next[0].sequence,aSnapshot.eventSequence+1); assert.equal(next[0].kind,"note.after");
    assert.throws(()=>s.getCardEvents("missing",0,10),/unknown cardId/);
    assert.throws(()=>s.getCardSnapshot("missing"),/unknown cardId/);
    for(const [after,limit] of [[-1,10],[1.5,10],[Number.MAX_SAFE_INTEGER+1,10],[0,0],[0,1001]]) assert.throws(()=>s.getCardEvents("card",after,limit),TypeError);
    s.close();
    s=openStore(path); assert.equal(s.getCard("card").revision,2); assert.deepEqual(s.getCommand("cmd").result,{ok:true}); assert.equal(s.getCommand("cmd").state,"COMPLETED");
    const running=s.reserveCommand({id:"interrupted",cardId:"card",input:{op:"other"}}); assert.equal(running.created,true); s.close();
    s=openStore(path); assert.equal(s.recoverInterrupted(),1); assert.equal(s.getCommand("interrupted").state,"NEEDS_RECONCILIATION"); assert.equal(s.recoverInterrupted(),0);
    assert.throws(()=>s.completeCommand("interrupted",{ok:true}),/COMMAND_NOT_RUNNING/); assert.equal(s.reserveCommand({id:"interrupted",cardId:"card",input:{op:"other"}}).created,false);
    const a=s.reserveCommand({id:"a",cardId:"card",input:{op:"a"}}), b=s.reserveCommand({id:"b",cardId:"card",input:{op:"b"}}); assert.equal(a.created,true); assert.equal(b.created,true);
    const before=s.getEvents(0,100).filter(e=>e.kind==="command.needs_reconciliation").length;
    assert.equal(s.markNeedsReconciliation("a","RUNNER_UNKNOWN").state,"NEEDS_RECONCILIATION");
    assert.equal(s.getCommand("b").state,"RUNNING");
    assert.equal(s.markNeedsReconciliation("a","RUNNER_UNKNOWN").state,"NEEDS_RECONCILIATION");
    assert.equal(s.getEvents(0,100).filter(e=>e.kind==="command.needs_reconciliation").length,before+1);
    assert.equal(s.markNeedsReconciliation("completed-does-not-exist","REASON"),null);
    assert.equal(s.markNeedsReconciliation("b","RUNNER_UNKNOWN").state,"NEEDS_RECONCILIATION");
    assert.throws(()=>s.completeCommand("a",{ok:true}),/COMMAND_NOT_RUNNING/);
    assert.equal(s.reserveCommand({id:"a",cardId:"card",input:{op:"a"}}).created,false);
    assert.throws(()=>s.markNeedsReconciliation("b","raw secret failure detail"),TypeError);
    assert.ok(s.getEvents(0,100).some(e=>e.kind==="command.needs_reconciliation")); s.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});


test("deleteCard enforces CAS and idle state, then removes card history atomically", () => {
  const dir=mkdtempSync(join(tmpdir(),"aylachi-delete-card-"));
  try {
    const s=openStore(join(dir,"test.sqlite"));
    s.createCard({id:"card",canvasId:"canvas",sessionId:"session",title:"title",x:0,y:0});
    s.reserveCommand({id:"command",cardId:"card",input:{text:"hello"}});
    assert.throws(()=>s.deleteCard("card",1),/CARD_BUSY/);
    assert.ok(s.getCard("card"));
    s.completeCommand("command",{status:"ok",text:"done"});
    assert.throws(()=>s.deleteCard("card",2),/REVISION_CONFLICT/);
    assert.equal(s.deleteCard("card",1).id,"card");
    assert.equal(s.getCard("card"),undefined);
    assert.equal(s.getCommand("command"),undefined);
    assert.deepEqual(s.listCards({canvasId:"canvas"}),[]);
    assert.equal(s.deleteCard("card",1),null);
    s.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("listCards returns bounded canvas-scoped cards in binary ID order without writes", () => {
  const dir=mkdtempSync(join(tmpdir(),"aylachi-list-cards-")); const path=join(dir,"test.sqlite");
  try {
    const s=openStore(path);
    s.createCard({id:"z",canvasId:"canvas-a",sessionId:"session-z",title:"z",x:9,y:0});
    s.createCard({id:"B",canvasId:"canvas-a",sessionId:"session-B",title:"B",x:2,y:0});
    s.createCard({id:"a",canvasId:"canvas-a",sessionId:"session-a",title:"a",x:1,y:0});
    s.createCard({id:"other",canvasId:"canvas-b",sessionId:"session-other",title:"other",x:0,y:0});
    const beforeEvents=s.getEvents(0,100);
    const beforeCards=["B","a","z","other"].map(id=>s.getCard(id));
    const listed=s.listCards({canvasId:"canvas-a"});
    assert.deepEqual(listed.map(card=>card.id),["B","a","z"]);
    assert.deepEqual(listed,[beforeCards[0],beforeCards[1],beforeCards[2]]);
    assert.equal(s.listCards({canvasId:"canvas-a",limit:2}).length,2);
    assert.deepEqual(s.listCards({canvasId:"empty"}),[]);
    assert.equal(s.listCards({canvasId:"canvas-a",limit:101}).length,3);
    assert.equal(s.listCards({canvasId:"canvas-a",limit:undefined}).length,3);
    assert.deepEqual(s.getEvents(0,100),beforeEvents);
    assert.deepEqual(["B","a","z","other"].map(id=>s.getCard(id)),beforeCards);
    const accessor=Object.defineProperty({canvasId:"canvas-a"},"limit",{get(){throw Error("must not invoke getter");}});
    for(const options of [null,{}, [], {canvasId:"",limit:1},{canvasId:"x".repeat(257)},{canvasId:"canvas-a",limit:0},{canvasId:"canvas-a",limit:102},{canvasId:"canvas-a",limit:1.5},{canvasId:"canvas-a",limit:"2"},{canvasId:"canvas-a",extra:true},accessor])
      assert.throws(()=>s.listCards(options),TypeError);
    s.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
