import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptObjectRegistry} from '../src/runtime/script-object-construction.mjs';
import {destructScriptObject,freeScriptObject} from '../src/runtime/script-object-release.mjs';

test('Core final destruction unhashes with the retained Outer index, recycles the slot, then frees frame and object',()=>{
  const registry=new ScriptObjectRegistry(),outer={index:7},frame={},calls=[];
  const make=()=>({identity:{},index:-1,flags:0,outer,nameIndex:23,stateFrame:null,linkerIndex:-1});
  const tail=make(),object=make(),head=make();object.stateFrame=frame;
  registry.add(tail);registry.add(object);registry.add(head);
  const services={registry,gates:{[0x102a2644]:1,[0x101e5550]:0},
    isValid:record=>{assert.equal(record.nativeVtable,0x10179dfc);return registry.objects[record.index]===record;},
    conditionalDestroy:record=>{calls.push('destroy');record.linkerIndex=outer.index;},
    freeStateFrame:value=>{
      assert.equal(value,frame);assert.equal(registry.objects[1],null);
      assert.deepEqual(registry.freeIndices,[1]);assert.equal(head.hashNext,tail);calls.push('frame');
    },
    freeObject:record=>{assert.equal(record,object);calls.push('object');},
  };
  destructScriptObject(object,services);freeScriptObject(object,services);
  assert.deepEqual(calls,['destroy','frame','object']);assert.equal(registry.objects.length,3);
  assert.equal(object.index,1);assert.equal(object.stateFrame,frame);assert.equal(object.hashNext,tail);
  const replacement=make();registry.add(replacement);
  assert.equal(replacement.index,1);assert.equal(registry.objects.length,3);assert.deepEqual(registry.freeIndices,[]);
  destructScriptObject(head,{...services,gates:{[0x102a2644]:0,[0x101e5550]:0}});
  assert.equal(head.nativeVtable,0x10179dfc);assert.equal(registry.objects[2],head);
  assert.deepEqual(calls,['destroy','frame','object']);
});
