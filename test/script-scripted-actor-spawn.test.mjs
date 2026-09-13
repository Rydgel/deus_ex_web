import test from 'node:test';
import assert from 'node:assert/strict';

import {spawnScriptDataLinkPlay} from '../src/runtime/script-spawn.mjs';
import {
  resolveInheritedActorConstructor,
  SCRIPTED_ACTOR_CONSTRUCTION,
} from '../src/runtime/script-scripted-actor-construction.mjs';

function fixture() {
  const core={record:{key:'core.object'},base:null};
  const actorClass={record:{key:'engine.actor',name:'Actor'},metadata:{classFlags:0},base:core};
  const conPlayBase={record:{key:'deusex.conplaybase',name:'ConPlayBase'},metadata:{classFlags:0},base:actorClass};
  const cls={record:{key:'deusex.datalinkplay',name:'DataLinkPlay'},metadata:{classFlags:0},base:conPlayBase};
  const levelInfo={name:'LevelInfo',fields:{SpawnNotify:null}};
  const level={actors:[levelInfo],nativeObject:{outer:{name:'Map'}},editor:false,undo:null,
    spawnTracking:false,tickParity:false,spawnNotifyGuard:{active:false}};
  const events=[],construction=[],defaults=new Set([
    'bStatic','bNoDelete','bCollideWorld','bCollideWhenPlacing','bCollideActors',
    'bBlockActors','bBlockPlayers',
  ]);
  const selection=resolveInheritedActorConstructor({
    dataLinkPlay:{key:SCRIPTED_ACTOR_CONSTRUCTION.dataLinkPlay.key,nativeConstructor:null},
    conPlayBase:{key:SCRIPTED_ACTOR_CONSTRUCTION.conPlayBase.key,nativeConstructor:null},
    actor:{key:SCRIPTED_ACTOR_CONSTRUCTION.engineActor.key,
      nativeConstructor:SCRIPTED_ACTOR_CONSTRUCTION.engineActor.internalConstructor,
      nativeVtable:SCRIPTED_ACTOR_CONSTRUCTION.engineActor.vtable},
  });
  const services={
    read:(object,name)=>object.fields[name],
    write:(object,name,value)=>{object.fields[name]=value;},
    defaultRead:(_cls,name)=>defaults.has(name)?false:({bDeleteMe:false}[name]??false),
    isActorClass:()=>true,
    validate:input=>input.cls===cls&&input.level===level,
    resolveConstructor:received=>{assert.equal(received,cls);return selection;},
    construct:(received,options,context)=>{
      construction.push({received,options,context});
      const actor={fields:{ObjectFlags:0,Tag:'None',Region:null,Level:null,bTicked:false,
        Role:4,Brush:null,Location:null,OldLocation:null,Rotation:null,Owner:null,
        Instigator:null,bDeleteMe:false,LastRenderTime:0},nativeVtable:null};
      return actor;
    },
    setRegion:(object,zone,leaf,zoneNumber)=>{object.fields.Region={zone,leaf,zoneNumber};},
    setOwner:(object,owner)=>{object.fields.Owner=owner;},
    setNativeLevel:(object,world)=>{object.nativeLevel=world;},
    initExecution:object=>{object.executionInitialized=true;},
    processEvent:(object,name)=>{events.push(name);},
    setActorZone:(object,test,force)=>{object.zoneCall={test,force};},
  };
  return {cls,level,services,events,construction,selection};
}

test('DataLinkPlay Spawn passes the inherited AActor constructor report and original event order',()=>{
  const {cls,level,services,events,construction,selection}=fixture();
  const owner={name:'Owner'},instigator={name:'Instigator'};
  const actor=spawnScriptDataLinkPlay({cls,level,name:'None',owner,instigator,
    location:[1,2,3],rotation:[4,5,6]},services);
  assert.equal(level.actors[1],actor);
  assert.equal(construction.length,1);
  assert.equal(construction[0].received,cls);
  assert.deepEqual(construction[0].options,{outer:level.nativeObject.outer,name:'None',flags:0,template:null});
  assert.deepEqual(construction[0].context,{constructorSelection:selection});
  assert.deepEqual(events,['Spawned','PreBeginPlay','BeginPlay','PostBeginPlay','SetInitialState','PostPostBeginPlay']);
  assert.deepEqual(actor.fields.Location,[1,2,3]);
  assert.deepEqual(actor.fields.OldLocation,[1,2,3]);
  assert.deepEqual(actor.fields.Rotation,[4,5,6]);
  assert.equal(actor.fields.Level,levelInfoFor(level));
  assert.equal(actor.fields.Owner,owner);
  assert.equal(actor.fields.Instigator,instigator);
  assert.equal(actor.fields.LastRenderTime,-10);
  assert.equal(actor.fields.ObjectFlags,1);
  assert.equal(actor.nativeLevel,level);
  assert.deepEqual(actor.zoneCall,{test:false,force:true});
});

test('DataLinkPlay Spawn rejects an unverified constructor before appending an actor',()=>{
  const {cls,level,services,selection}=fixture();
  services.resolveConstructor=()=>({...selection,nativeVtable:0});
  assert.throws(()=>spawnScriptDataLinkPlay({cls,level,name:'None',owner:null,instigator:null,
    location:[0,0,0],rotation:[0,0,0]},services),/inherited Engine\.Actor constructor binding/);
  assert.equal(level.actors.length,1);
});

function levelInfoFor(level) {
  return level.actors[0];
}
