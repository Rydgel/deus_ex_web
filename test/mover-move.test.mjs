import test from'node:test';import assert from'node:assert/strict';import{moveTranslatingMover,moverMoveTail}from'../src/runtime/mover-move.mjs';
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
test('a blocking non-Pawn is pushed through the same moveSmooth as a Pawn (0x1039a577)',()=>{
 const m=make(),deco={isPawn:false,collideWorld:true,lineage:['deusex.deusexdecoration']},log=[];
 assert.equal(moveTranslatingMover(m,[1,2,3],{encroachmentCheck:()=>[deco],moveSmooth:(a,d)=>log.push({a,delta:d,pose:[...m.position]}),
  dispatch:(a,event)=>{log.push(event);return false;},removeActor:()=>log.push('remove'),addActor:()=>log.push('add')}),true);
 assert.deepEqual(log,[{a:deco,delta:[1,2,3],pose:[1,2,3]},{a:deco,delta:[-1,-2,-3],pose:[2,4,6]},'EncroachingOn','EncroachedBy','remove','add']);
});

test('a rotation-only commit, with or without collision, ends the held touches and refreshes the zone after the hash add (0x10399d17..0x10399f03)',()=>{
 for(const collideActors of [true,false]){
  const m={...make(),collideActors,touching:[null,null,null,null]},held={id:'held'},log=[];
  m.touching[1]=held;
  const tail=mover=>moverMoveTail(mover,{isOverlapping:()=>false,endTouch:(a,b,suppress)=>log.push(['untouch',b.id,suppress]),setActorZone:(a,test,force)=>log.push(['zone',test,force])});
  assert.equal(moveTranslatingMover(m,[0,0,0],{rotation:[0,512,0],encroachmentCheck:()=>[],removeActor:()=>log.push('remove'),addActor:()=>log.push('add'),afterCommit:tail}),true);
  assert.deepEqual(m.rotation,[0,512,0]);
  assert.deepEqual(log,[...(collideActors?['remove','add']:[]),['untouch','held',false],['zone',false,false]]);
 }
});
test('no tail without a commit: the unchanged-pose early return and a script rejection',()=>{
 const m={...make(),touching:[{id:'t'},null,null,null]},pawn={isPawn:true,collideWorld:true},tail=()=>assert.fail('the tail runs only after the commit');
 assert.equal(moveTranslatingMover(m,[0,0,.00009],{afterCommit:tail}),true);
 assert.equal(moveTranslatingMover(m,[1,0,0],{encroachmentCheck:()=>[pawn],moveSmooth:()=>{},dispatch:()=>true,afterCommit:tail,removeActor:()=>assert.fail(),addActor:()=>assert.fail()}),false);
});
test('the tail re-reads each touching slot at its turn and keeps overlapping ones',()=>{
 const a={id:'a'},b={id:'b'},c={id:'c'},m={touching:[a,b,c,null]},ended=[];
 moverMoveTail(m,{isOverlapping:(s,o)=>o===b,endTouch:(s,o)=>{ended.push(o.id);if(o===a)m.touching[2]=null;},setActorZone:()=>ended.push('zone')});
 assert.deepEqual(ended,['a','zone']);
});
