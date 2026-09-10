import test from 'node:test';
import assert from 'node:assert/strict';
import {conditionalDestroyScriptObject,destroyScriptObject,setObjectLinker} from '../src/runtime/script-object-lifecycle.mjs';

test('conditional destruction guards recursion before cleanup and retains identity until later collection',()=>{
  const identity={},frame={cursor:17,latent:384},outer={index:7};
  const object={identity,index:12,flags:1,outer,linker:{exports:[{object:identity}]},linkerIndex:0,frame};
  const linker=object.linker,events=[];
  const services={destroy:()=>{
    events.push('destroy');
    assert.equal(conditionalDestroyScriptObject(object,services),false);
    destroyScriptObject(object,{exitProperties:receiver=>{
      assert.equal(receiver,identity);assert.ok(object.flags&0x80000000);
      assert.equal(linker.exports[0].object,identity);events.push('properties');
    }});
  }};
  assert.equal(conditionalDestroyScriptObject(object,services),true);
  assert.deepEqual(events,['destroy','properties']);
  assert.equal(object.flags,0x80800001);assert.equal(object.index,12);
  assert.equal(linker.exports[0].object,null);assert.equal(object.linker,null);
  assert.equal(object.linkerIndex,outer.index);assert.deepEqual(frame,{cursor:17,latent:384});
  assert.equal(conditionalDestroyScriptObject(object,services),false);
});

test('unregistered objects skip destruction and linker detachment checks its old identity',()=>{
  assert.equal(conditionalDestroyScriptObject({index:-1,flags:0},{}),false);
  const identity={},object={identity,linker:{exports:[{object:{}}]},linkerIndex:0};
  assert.throws(()=>setObjectLinker(object,null,-1),/identity mismatch/);
  assert.notEqual(object.linker,null);
});
