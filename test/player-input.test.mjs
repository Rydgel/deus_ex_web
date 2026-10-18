import test from 'node:test';
import assert from 'node:assert/strict';
import {walkingInput,healthyWalkingGroundSpeed} from '../src/runtime/player-input.mjs';
test('walking input preserves diagonal magnitude and uses original quantized body axes',()=>{
 const a=walkingInput({rotation:[0,0,0],aForward:6000,aStrafe:6000});assert.deepEqual(a.newAccel,[2400,2400,0]);
 assert.deepEqual(walkingInput({rotation:[0,3,0],aForward:6000,aStrafe:6000}),a);
 assert.notDeepEqual(walkingInput({rotation:[0,4,0],aForward:6000,aStrafe:6000}).newAccel,a.newAccel);
});
// (pitch 16384 reads the sine table's entry 8192, the real x87 FSIN's word 0x250d3000: docs/fitting.md)
test('GetAxes applies before planar acceleration projection',()=>{
 const a=walkingInput({rotation:[16384,0,0],aForward:6000,aStrafe:0});assert.deepEqual(a.newAccel,[2.9390552491737054e-13,0,0]);
});
test('original integer backward assignment truncates float32 .65 product',()=>{
 assert.equal(healthyWalkingGroundSpeed(320,-2400),207);assert.equal(healthyWalkingGroundSpeed(320.9,2400),320);
 assert.equal(healthyWalkingGroundSpeed(100,-2400),100);assert.equal(healthyWalkingGroundSpeed(0,0),100);
});
test('analog inputs retain original scalar float stores',()=>{
 const f=Math.fround,a=walkingInput({rotation:[0,0,0],aForward:1.234,aStrafe:-567.8,aLookup:51.12,aTurn:-23.4});
 assert.equal(a.aForward,f(f(1.234)*f(.4)));assert.equal(a.aLookup,f(f(51.12)*f(.24)));assert.equal(a.aTurn,f(f(-23.4)*f(.24)));
});
