import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeRng} from '../src/runtime/rng.mjs';
test('original mixed rand/appFrand sequence retains full state and product',()=>{
 const rng=createNativeRng(1);
 assert.equal(rng.rand(),41);assert.equal(rng.state,2745024);
 assert.equal(rng.rand(),18467);assert.equal(rng.state,3357800067);
 assert.equal(rng.frand(),0.19330423884093761);assert.equal(rng.state,415139642);
 const resumed=createNativeRng(rng.state);assert.equal(resumed.rand(),26500);assert.equal(rng.rand(),26500);
 rng.seed(1);assert.equal(rng.rand(),41);
});
test('original appFrand endpoint store differs from its retained value',()=>{
 assert.equal(createNativeRng(2708534849).frand(),0);
 const value=createNativeRng(4028364353).frand();
 assert.equal(value,0.9999999990686774);assert.equal(Math.fround(value),1);
});
test('seed is mandatory; independent instances represent explicit thread streams',()=>{
 for(const seed of [undefined,-1,2**32,1.5,NaN])assert.throws(()=>createNativeRng(seed),/explicit unsigned/);
 const a=createNativeRng(42),b=createNativeRng(42);a.rand();assert.notEqual(a.state,b.state);b.rand();assert.equal(a.state,b.state);
});
