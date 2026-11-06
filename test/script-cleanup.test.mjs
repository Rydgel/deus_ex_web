import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupLevelDestroyed,cleanupScriptReferences} from '../src/runtime/script-cleanup.mjs';
import {propertyReference} from '../src/runtime/script-values.mjs';
import {baseEpoch} from '../src/runtime/base-epoch.mjs';

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

test('CompactActors with the flagged slots gives the loop\'s result, reading bDeleteMe of those only',()=>{
  // a deterministic mix of live, deleted and null slots, the deleted ones early, late and in runs
  let seed=12345;const next=()=>(seed=(seed*1103515245+12345)>>>0)/2**32;
  for(let round=0;round<200;round++){
    const length=1+Math.floor(next()*40),start=Math.floor(next()*Math.min(length,6));
    const make=()=>Array.from({length},(_,i)=>{const r=next();return r<0.15?null:{id:i,bDeleteMe:r<0.35};});
    const base=make(),run=(withFlags)=>{
      const actors=base.map(actor=>actor&&{...actor}),reads=[],warnings=[];
      const level={editor:false,undo:null,firstDynamicActor:start,actors,pendingDeleted:null};
      const services={read:(actor,key)=>{reads.push(actor.id);return actor[key];},warning:event=>warnings.push(event.actor.id),
        // (a slot the "image" could not answer is flagged too, and read: every third live one)
        flagged:withFlags?(list,from)=>Uint32Array.from(list.flatMap((actor,i)=>i>=from&&(!actor||actor.bDeleteMe||actor.id%3===0)?[i]:[])):undefined};
      const epoch=baseEpoch();
      cleanupLevelDestroyed(level,services);
      return {ids:level.actors.map(actor=>actor&&actor.id),reads,warnings,advances:baseEpoch()-epoch};
    };
    const reference=run(false),flagged=run(true);
    assert.deepEqual(flagged.ids,reference.ids);assert.deepEqual(flagged.warnings,reference.warnings);assert.equal(flagged.advances,reference.advances);
    // the loop reads bDeleteMe of the flagged slots only (the first of them and later), never of a live slot the image answered
    for(const id of flagged.reads)assert.ok(base[id].bDeleteMe||id%3===0,`slot ${id} was read`);
    assert.ok(flagged.reads.length<=reference.reads.length);
  }
});
