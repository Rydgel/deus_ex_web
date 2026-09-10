import test from 'node:test';
import assert from 'node:assert/strict';
import {compileFunction} from '../src/runtime/script-vm.mjs';
import {createAllActorsIterator} from '../src/runtime/script-iterators.mjs';

const pkg={exports:[{name:'Found'},{name:'Count'}],imports:[]};
const compile=(bytes,size)=>compileFunction({pkg,entry:{path:'Iterator fixture'},bytes:Uint8Array.from(bytes),size});
function services(actors){
  return {iterator:call=>createAllActorsIterator({...call,actorClass:{},
    levelFor:()=>({actors}),isA:()=>true,tagOf:()=> 'None'})};
}

test('IteratorNext runs each body and exhaustion consumes the target Pop',()=>{
  // foreach AllActors(None, Found) Count++; return Count;
  // The native's encoded target is expanded offset20, its IteratorPop.
  const fn=compile([0x2f,0x61,0x30,0x2a,0x01,1,0x16,20,0,
    165,0x01,2,0x16,0x31,0x30,0x04,0x01,2],27);
  const object={Found:null,Count:0};
  assert.equal(fn.run(object,{},services([{},null,{},{}])),3);
  assert.equal(object.Found,null);
});

test('compiled Pop before Return unwinds the iterator while keeping its current actor',()=>{
  // foreach AllActors(None, Found) return Found; return None;
  const fn=compile([0x2f,0x61,0x30,0x2a,0x01,1,0x16,20,0,
    0x30,0x04,0x01,1,0x31,0x30,0x04,0x2a],23);
  const actor={},object={Found:null};
  assert.equal(fn.run(object,{},services([actor,{}])),actor);
  assert.equal(object.Found,actor);
  assert.equal(fn.run(object,{},services([])),null);
});
