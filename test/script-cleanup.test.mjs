import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupLevelDestroyed,cleanupScriptReferences} from '../src/runtime/script-cleanup.mjs';
import {propertyReference} from '../src/runtime/script-values.mjs';

test('pending cleanup keeps the native actor prefix and defers finalization below 128',()=>{
  const info={EventManager:null},live={bDeleteMe:false},dead={bDeleteMe:true,Deleted:null};
  const level={editor:false,undo:null,firstDynamicActor:2,actors:[info,null,null,dead,live],pendingDeleted:dead};
  const calls=[],services={
    read:(actor,key)=>actor[key],warning:event=>calls.push(event.type),
    cleanupReferences:actor=>calls.push(actor===info?'references:info':'references:live'),
    release:(actor,flags)=>{
      assert.equal(actor,dead);assert.equal(flags,1);assert.equal(level.pendingDeleted,null);
      calls.push('release');
    },
  };
  cleanupLevelDestroyed(level,services);
  assert.deepEqual(level.actors,[info,null,live]);assert.equal(level.pendingDeleted,dead);
  assert.deepEqual(calls,['PendingActorInArray']);
  cleanupLevelDestroyed(level,services,true);
  assert.deepEqual(calls,['PendingActorInArray','references:info','references:live','release']);
  level.pendingDeleted=dead;
  for(let index=1;index<128;index++)level.pendingDeleted={bDeleteMe:true,Deleted:level.pendingDeleted};
  let releases=0;
  cleanupLevelDestroyed(level,{...services,release:()=>releases++});
  assert.equal(releases,128);assert.equal(level.pendingDeleted,null);
});

test('reference cleanup visits direct object arrays before nested structs, and Modify precedes editor clearing',()=>{
  const field=(key,type,arrayDim=1,extra={})=>({key,metadata:{type,arrayDim,...extra}});
  const member=field('region.zone','object'),region=field('region','struct',1,{structKey:'fixture.region',structFields:[member]});
  const references=field('touching','object',2),classField=field('class','class');
  const dead={dead:true},live={dead:false},store={region:{[member.key]:dead},touching:[dead,live],class:live};
  const visited=[],ref=entry=>propertyReference(entry,()=>store[entry.key],value=>{
    visited.push(`write:${entry.key}`);store[entry.key]=value;
  });
  const services={isValid:()=>true,isPendingKill:value=>{visited.push(value===dead?'dead':'live');return value.dead;},
    modify:value=>{assert.equal(value,dead);visited.push('modify');}};
  cleanupScriptReferences([region,references,classField],ref,services);
  assert.deepEqual(visited,['dead','write:touching','live','live','dead','write:region']);
  assert.deepEqual(store.touching,[null,live]);assert.equal(store.region[member.key],null);
  store.region[member.key]=dead;store.touching[0]=dead;visited.length=0;
  cleanupScriptReferences([region,references,classField],ref,services,{editor:true});
  assert.deepEqual(visited,['dead','modify','write:region','dead','modify','write:touching','live','live']);
});
