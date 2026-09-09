import test from'node:test';import assert from'node:assert/strict';import{moveSmooth}from'../src/runtime/move-smooth.mjs';
test('moveSmooth keeps first MoveActor bool even after later successful slides',()=>{
 const actor={rotation:[0,0,0]},calls=[],responses=[{result:false,time:.25,normal:[1,0,0]},{result:true,time:1,normal:[0,0,0]}];
 const result=moveSmooth(actor,[1,2,3],{moveActor:(a,d,r,f)=>{calls.push(d);assert.deepEqual(f,[0,0,0,0]);return responses.shift();}});
 assert.equal(result,false);assert.deepEqual(calls,[[1,2,3],[0,1.5,2.25]]);
});
test('second hit directly dispatches HitWall and rereads rotation before third move',()=>{
 const actor={rotation:[0,4,0]},rotations=[],events=[],responses=[{result:true,time:.25,normal:[1,0,0]},{result:false,time:.5,normal:[0,1,0],actor:'wall'},{result:false,time:0,normal:[0,0,1]}];
 assert.equal(moveSmooth(actor,[1,2,3],{moveActor:(a,d,r)=>{rotations.push(r);return responses.shift();},dispatch:(a,e,args)=>{events.push([e,args]);a.rotation=[0,8,0];}}),true);
 assert.deepEqual(events,[['HitWall',[[0,1,0],'wall']]]);assert.deepEqual(rotations,[[0,4,0],[0,4,0],[0,8,0]]);
});
test('clear first move bypasses slide and event callbacks',()=>{
 let count=0;assert.equal(moveSmooth({rotation:[0,0,0]},[0,0,0],{moveActor:()=>{count++;return{result:true,time:1};},dispatch:()=>assert.fail()}),true);assert.equal(count,1);
});
test('zero slide progress still issues the original second MoveActor',()=>{
 let count=0;moveSmooth({rotation:[0,0,0]},[10,0,0],{moveActor:(a,d)=>{count++;if(count===1)return{result:false,time:0,normal:[1,0,0]};assert.deepEqual(d,[0,0,0]);return{result:true,time:1};}});assert.equal(count,2);
});
