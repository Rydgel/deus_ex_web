import test from 'node:test';
import assert from 'node:assert/strict';
import {createGarbageArchive,purgeGarbage,GC_FLAGS} from '../src/runtime/script-gc.mjs';
import {createScriptGcBridge} from '../src/runtime/script-gc-bridge.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {serializeScriptReferences} from '../src/runtime/script-reference-serialization.mjs';
import {propertyReference} from '../src/runtime/script-values.mjs';

test('typed GC slots preserve shared identities and connect FName marking, deletion and reuse',()=>{
  const identity={},excludedIdentity={};
  const object={identity,index:0,flags:0},excluded={identity:excludedIdentity,index:1,flags:GC_FLAGS.archiveExcluded};
  const releases=[];
  const names=createScriptNames({allocator:{free:entry=>releases.push(['name',entry])}});
  const none=names.intern('None',2).entry;
  const name=names.intern('FixtureName').entry,unused=names.intern('UnusedName').entry;
  const registry={objects:[object,excluded],names:names.names,rootSet:[]};
  const archive=createGarbageArchive(registry,{serializeObject:record=>{record.flags|=GC_FLAGS.serializeRoute;}});
  const bridge=createScriptGcBridge(archive,{registry,
    resolveObject:value=>value===identity?object:value===excludedIdentity?excluded:null,
    resolveName:value=>names.getEntry(names.find(value)),
  });
  // Collector MapObject/MapName ignore the value and do not mark or resolve
  // it; the measuring archive reaches them before the real archive operator.
  assert.equal(bridge.mapObject({unregistered:true}),0);
  assert.equal(bridge.mapName('UnregisteredName'),0);
  assert.equal(archive.serializedCount,0);
  assert.equal(object.flags&GC_FLAGS.unreachable,GC_FLAGS.unreachable);
  const fields=[{key:'targets',metadata:{type:'object',arrayDim:3}},
    {key:'tag',metadata:{type:'name',arrayDim:1}}];
  const storage={targets:[identity,excludedIdentity,identity],tag:name.text};
  serializeScriptReferences(fields,descriptor=>propertyReference(descriptor.field,
    ()=>storage[descriptor.key],value=>{storage[descriptor.key]=value;}),bridge);
  assert.deepEqual(storage.targets,[identity,null,identity]);assert.equal(storage.tag,name.text);
  assert.equal(object.flags&2,0);assert.equal(excluded.flags&2,2);assert.equal(name.flags&2,0);
  assert.equal(archive.serializedCount,3);
  assert.equal(archive.serializeName({value:name}),archive);
  assert.equal(bridge.nameReference({get:()=>name.text,set:()=>{throw new Error('FName must not be rewritten');}}),bridge);
  assert.throws(()=>archive.serializeName({value:null}),/registered name entry/);
  const stale={identity:{},index:0,flags:0};
  const bad=createScriptGcBridge(archive,{registry,resolveObject:()=>stale,resolveName:()=>name});
  assert.throws(()=>bad.objectReference({get:()=>stale.identity,set:()=>{}}),/not registered/);
  // Native object release is a recorded boundary in this storage check;
  // name release itself uses the recovered hash/free-index implementation.
  purgeGarbage(registry,{
    conditionalDestroy:record=>releases.push(['destroy',record]),
    finalDelete:(record,flags)=>{
      assert.equal(flags,1);releases.push(['object',record]);registry.objects[record.index]=null;
    },
    deleteName:index=>names.deleteEntry(index),
  });
  assert.deepEqual(releases,[['destroy',excluded],['object',excluded],['name',unused]]);
  assert.equal(names.getEntry(none.index),none);assert.equal(names.getEntry(name.index),name);
  assert.equal(names.find(unused.text),-1);assert.equal(names.getEntry(unused.index),null);
  assert.equal(names.intern('ReplacementName').index,unused.index);
});
