import test from'node:test';import assert from'node:assert/strict';import{moveTranslatingMover}from'../src/runtime/mover-move.mjs';
const make=()=>({movingBrush:true,movable:true,collideActors:true,blockPlayers:true,blockActors:true,position:[1,2,3],rotation:[0,0,0],standingCount:0});
test('mover commit follows encroachment query and preserves remove/add pose order',()=>{
 const m=make(),log=[];assert.equal(moveTranslatingMover(m,[.25,0,0],{encroachmentCheck:()=>{log.push('query');return[];},removeActor:a=>log.push([...a.position]),addActor:a=>log.push([...a.position])}),true);
 assert.deepEqual(log,['query',[1,2,3],[1.25,2,3]]);
});
test('failed push tries reverse with proposed mover pose then notifies and commits',()=>{
 const m=make(),pawn={isPawn:true,collideWorld:true},log=[];
 moveTranslatingMover(m,[1,2,3],{encroachmentCheck:()=>[pawn],moveSmooth:(a,d)=>log.push({delta:d,pose:[...m.position]}),dispatch:(a,event)=>{log.push(event);return false;},removeActor:()=>log.push('remove'),addActor:()=>log.push('add')});
 assert.deepEqual(log,[{delta:[1,2,3],pose:[1,2,3]},{delta:[-1,-2,-3],pose:[2,4,6]},'EncroachingOn','EncroachedBy','remove','add']);
});
test('script rejection retains original mover pose and omits hash commit',()=>{
 const m=make(),pawn={isPawn:true,collideWorld:true},events=[];
 assert.equal(moveTranslatingMover(m,[1,0,0],{encroachmentCheck:()=>[pawn],moveSmooth:()=>{},dispatch:(a,e)=>{events.push(e);return true;},removeActor:()=>assert.fail(),addActor:()=>assert.fail()}),false);
 assert.deepEqual(m.position,[1,2,3]);assert.deepEqual(events,['EncroachingOn']);
});
test('unsupported passengers fail and tiny move does not query',()=>{
 const m=make();assert.equal(moveTranslatingMover(m,[0,0,.00009],{}),true);m.standingCount=1;assert.throws(()=>moveTranslatingMover(m,[1,0,0],{}),/based passengers/);
});
