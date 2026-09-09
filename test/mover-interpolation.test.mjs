import test from 'node:test';
import assert from 'node:assert/strict';
import {interpolateMoverTo,tickMoverInterpolation} from '../src/runtime/mover-interpolation.mjs';
function mover(){
 const m={position:[-220,800,-64],basePosition:[-220,800,-64],oldPosition:[-220,800,-64],keyPositions:[[0,0,0],[0,-56,0]],rotation:[0,16384,0],key:0,previousKey:0,alpha:0,rate:.5,glideType:1,interpolating:false};
 m.move=(delta,rotation)=>{assert.deepEqual(rotation,[0,16384,0]);m.position=m.position.map((v,i)=>Math.fround(v+delta[i]));return true;};return m;
}
test('original first 120Hz movement stores absolute position before delta',()=>{
 const m=mover();interpolateMoverTo(m,1,2);tickMoverInterpolation(m,1/120);
 assert.deepEqual(m.position,[-220,799.9970703125,-64]);assert.equal(m.alpha,0.004166666883975267);
});
test('source InterpolateTo reverses key state and old position smoothly',()=>{
 const m=mover();interpolateMoverTo(m,1,2);tickMoverInterpolation(m,.5);
 assert.equal(m.position[1],791.25);interpolateMoverTo(m,0,2);
 assert.equal(m.alpha,.75);assert.equal(m.previousKey,1);assert.equal(m.key,0);assert.deepEqual(m.oldPosition,[-220,744,-64]);
 tickMoverInterpolation(m,.125);assert.equal(m.position[1],794.83203125);
});
test('native successful endpoint clears interpolation before its event',()=>{
 const m=mover();interpolateMoverTo(m,1,2);
 let events=0;m.onInterpolateEnd=()=>{events++;assert.equal(m.interpolating,false);assert.equal(m.previousKey,1);assert.equal(m.alpha,0);};
 tickMoverInterpolation(m,2.1);assert.equal(events,1);assert.equal(m.position[1],744);
});
test('native failed movement leaves alpha and position unchanged',()=>{
 const m=mover();interpolateMoverTo(m,1,2);m.move=()=>false;tickMoverInterpolation(m,.5);
 assert.equal(m.alpha,0);assert.equal(m.position[1],800);assert.equal(m.interpolating,true);
});
