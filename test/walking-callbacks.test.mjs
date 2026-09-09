import test from 'node:test';
import assert from 'node:assert/strict';
import {setBase,setSupportBase,setWalkingPhysics,processPlayerHitWall} from '../src/runtime/walking-callbacks.mjs';

test('SetBase preserves event-visible identity, wraps counts, and treats world specially',()=>{
 const world={},old={standingCount:0},next={standingCount:255},pawn={base:old,worldActor:world},events=[];
 setBase(pawn,next,(target,event)=>events.push([target,event,pawn.base]));
 assert.equal(old.standingCount,255);assert.equal(next.standingCount,0);
 assert.deepEqual(events,[[old,'Detach',old],[next,'Attach',next],[pawn,'BaseChange',next]]);
 events.length=0;setBase(pawn,world,(target,event)=>events.push(event));
 assert.deepEqual(events,['Detach','BaseChange']);assert.equal(world.standingCount,undefined);
});
test('SetBase rejects base cycles and unchanged bases without events',()=>{
 const pawn={base:null},target={base:pawn};
 const fail=()=>assert.fail('unexpected event');setBase(pawn,target,fail);setBase(pawn,null,fail);assert.equal(pawn.base,null);
});
test('SupportActor remains a synchronous event boundary, and same physics skips it',()=>{
 const target={standingCount:0},pawn={base:null,physics:1},events=[];
 const dispatch=(actor,event)=>{events.push(event);if(event==='SupportActor')setBase(pawn,actor,dispatch);};
 setWalkingPhysics(pawn,1,target,{dispatch});assert.deepEqual(events,[]);
 setSupportBase(pawn,target,dispatch);assert.equal(pawn.base,target);assert.deepEqual(events,['SupportActor','Attach','BaseChange']);
});
test('Falling changes physics before detach callbacks; event-induced None clears motion',()=>{
 const old={standingCount:1},pawn={base:old,physics:1,velocity:[1,2,3],acceleration:[4,5,6]},events=[];
 setWalkingPhysics(pawn,2,null,{dispatch:(actor,event)=>{events.push([event,pawn.physics]);if(event==='BaseChange')pawn.physics=0;}});
 assert.deepEqual(events,[['Detach',2],['BaseChange',2]]);assert.deepEqual(pawn.velocity,[0,0,0]);assert.deepEqual(pawn.acceleration,[0,0,0]);
});
test('HitWall separates walking bookkeeping from script dispatch and preserves unrelated flags',()=>{
 const pawn={physics:1,acceleration:[1,0,0],destination:[10,0,0],position:[0,0,0],minHitWall:-.6,pawnFlags:0x24,justTeleported:true};
 const events=[],callbacks={isProbing:()=>false,dispatch:(actor,event,args)=>events.push(args)};
 processPlayerHitWall(pawn,[-1,0,.5],{},callbacks);assert.equal(pawn.pawnFlags,0x100024);assert.equal(pawn.moveTimer,-1);assert.equal(pawn.justTeleported,true);
 pawn.physics=2;processPlayerHitWall(pawn,[-1,0,.5],{},callbacks);assert.deepEqual(events[0][0],[-1,0,.5]);
 pawn.physics=1;processPlayerHitWall(pawn,[-1,0,.5],{},{...callbacks,isProbing:()=>true});assert.deepEqual(events[1][0],[-1,0,0]);
});
