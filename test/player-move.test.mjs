import test from'node:test';import assert from'node:assert/strict';import{playerMove}from'../src/runtime/player-move.mjs';
const make=()=>({controlledPlayer:true,flags:15,position:[0,0,0],rotation:[0,0,0],radius:17,height:42,standingCount:0,touching:[null,null,null,null]});
test('normal Time0 collision still commits hash and collision events before false',()=>{
 const source=make(),world={},log=[];
 const r=playerMove(source,[10,0,0],{worldActor:world,multiLineCheck:()=>[{actor:world,time:0,location:[1,0,0],normal:[-1,0,0]}],removeActor:()=>log.push('remove'),addActor:()=>log.push('add'),dispatch:(a,e)=>log.push(e),setActorZone:()=>log.push('zone')});
 assert.equal(r.success,false);assert.deepEqual(log,['remove','add','BumpWall','zone']);assert.deepEqual(source.position,[0,0,0]);
});
test('tiny movement returns before scene and callback work',()=>{
 const source=make(),r=playerMove(source,[.00009,0,0],{});assert.equal(r.success,true);assert.deepEqual(source.position,[0,0,0]);
});
test('actor bump is bidirectional except when source is based on the hit actor',()=>{
 const other={flags:15},run=base=>{const source=make();source.base=base;const events=[];
 playerMove(source,[10,0,0],{multiLineCheck:()=>[{actor:other,time:0,location:[0,0,0],normal:[-1,0,0]}],removeActor:()=>{},addActor:()=>{},dispatch:(a,e,args)=>events.push([a,args[0]]),setActorZone:()=>{}});return {source,events};};
 const r=run(null);assert.deepEqual(r.events,[[other,r.source],[r.source,other]]);assert.deepEqual(run(other).events,[]);
});
test('BeginTouch precedes cleanup and cleanup re-reads each touching slot',()=>{
 const source=make(),trigger={flags:1},log=[];
 playerMove(source,[10,0,0],{multiLineCheck:()=>[{actor:trigger,time:.1}],removeActor:()=>{},addActor:()=>{},isBlockedBy:()=>false,
 beginTouch:(a,b)=>{log.push('begin');a.touching[0]=b;},isOverlapping:()=>false,endTouch:(a,b,noNotify)=>{assert.equal(noNotify,false);log.push('end');a.touching[0]=null;},setActorZone:()=>log.push('zone')});
 assert.deepEqual(log,['begin','end','zone']);
});
