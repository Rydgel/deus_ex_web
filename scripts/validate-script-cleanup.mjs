/** Original CameraPoint metadata through typed reference cleanup and final
 * native release. Native registry/process/allocator inputs are explicit fixture
 * state; this is not a general native package or resource loader. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {ScriptObjectRegistry,constructCameraPoint} from '../src/runtime/script-object-construction.mjs';
import {modifyScriptObject} from '../src/runtime/script-object-lifecycle.mjs';
import {nativeScriptPendingKill} from '../src/runtime/script-pending-kill.mjs';
import {destroyCameraPointString} from '../src/runtime/script-object-release.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const name of await readdir(`${root}/System`))files.push({path:name,read:()=>readFile(`${root}/System/${name}`)});
const assets=new AssetStore(files),engine=await assets.get('Engine');
const level={actors:[],pendingDeleted:null,engine:{audio:null},collisionHash:null,editor:false,
  native3c:null,native88:null,undo:null,firstDynamicActor:1};
const runtime=new ScriptRuntime(assets,{levelFor:()=>level});
const cameraClass=await runtime.loadClass(engine,engine.exportsByPath.get('camerapoint'));
const levelClass=await runtime.loadClass(engine,engine.exportsByPath.get('levelinfo'));
const registry=new ScriptObjectRegistry(),records=new Map(),names=new Map();
const internName=name=>{if(!names.has(name))names.set(name,{name,index:names.size});return names.get(name);};
function register(identity,name,nativeVtable,outer=null){
  const object={identity,index:-1,flags:1,outer,name,nameIndex:internName(name).index,
    linker:null,linkerIndex:-1,stateFrame:null,nativeVtable};
  registry.add(object);records.set(identity,object);return object;
}
const outer=register({name:'FixturePackage'},'FixturePackage',0x101753a0);
// These concrete loaded resource identities use PE-verified IsPendingKill
// vtable entries. No unrecognized native subclass is accepted by this fixture.
register(cameraClass.record,'CameraPoint',0x101758f4,outer);
register(levelClass.record,'LevelInfo',0x101758f4,outer);
for(const path of ['s_camera','s_zoneinfo','defaulttexture']){
  const texture=await runtime.objects.resolve(engine,engine.exportsByPath.get(path));
  assert.equal(texture.kind,'Texture');register(texture,texture.name,0x1042672c,outer);
}
const info={name:'LevelInfo'};runtime.attach(info,levelClass);
runtime.bindNativeObject(info,register(info,info.name,0x10427a34,outer));level.actors.push(info);
const ref=(actor,name)=>runtime.namedReference(actor,name),freedFrames=new Set(),released=[];
const construction={
  registry,validate:args=>args.cls===cameraClass&&args.outer===outer&&args.template===null,
  findObject:(scope,name)=>registry.objects.find(object=>object?.outer===scope&&object.name.toLowerCase()===name.toLowerCase()),
  internName,nativeConstructor:constructCameraPoint,
  initNativeProperties:object=>{
    object.auxiliary=null;object.destroy=actor=>runtime.destroyActorBase(actor);
    records.set(object.identity,object);
  },
};
function camera(){
  const actor=runtime.constructObject(cameraClass,{outer,flags:1},construction);
  runtime.initExecution(actor);ref(actor,'Level').set(info);level.actors.push(actor);return actor;
}
const dead=camera(),live=camera(),deadObject=records.get(dead),frame=deadObject.stateFrame;
const stringCalls=[],services={registry,gates:{[0x102a2644]:1,[0x101e5550]:0},
  isValid:object=>registry.objects[object.index]===object,
  conditionalDestroy:object=>runtime.conditionalDestroy(object.identity),
  destroyActorString:(object,offset)=>{
    stringCalls.push(offset);
    destroyCameraPointString(object.nativeStrings.get(offset),{
      reallocate:(data,size,tag)=>{
        assert.equal(data,null);assert.equal(size,0);assert.equal(tag,0x101ab50c);return null;
      },
      freeAllocation:()=>{throw new Error('Fixture zero-sized realloc must return null');},
    });
  },
  freeStateFrame:value=>{freedFrames.add(value);},
  freeObject:object=>{
    assert.equal(level.pendingDeleted,null);assert.equal(ref(live,'Target').get(),null);
    assert.deepEqual(ref(live,'Touching').get(),[null,info,null,null]);
    assert.equal(runtime.regionValue(live).zone,null);assert(freedFrames.has(frame));
    released.push(object);object.released=true;
  },
};
runtime.actorLifecycle={
  validate:actor=>runtime.instance(actor).cls===cameraClass,
  modify:actor=>modifyScriptObject(records.get(actor),null),
  references:{isValid:actor=>{
    const object=records.get(actor);
    assert(object,`Fixture native identity is not linked: ${actor?.key??actor?.name}`);
    return services.isValid(object);
  },isPendingKill:actor=>nativeScriptPendingKill(records.get(actor),(actor,name)=>ref(actor,name).get())},
  finalRelease:services,
};
for(const name of ['destroy','destroyed','endstate']){
  const record=runtime.lookup(dead,name);await runtime.prepareFunction(record.asset,record.index);
}
ref(dead,'BindName').set('Owned CameraPoint string');
assert.equal(runtime.callFunction(runtime.lookup(dead,'Destroy'),dead),true);
assert.equal(level.pendingDeleted,dead);assert.equal(registry.objects[deadObject.index],deadObject);
// ExitProperties has destroyed every reflected FString. Supply the matching
// native empty records at the final-release boundary without guessing the
// unresolved offset-to-property mapping or a general native CDO layout.
for(const name of ['BindName','BarkBindName','FamiliarName','UnfamiliarName'])assert.equal(ref(dead,name).get(),'');
deadObject.nativeStrings=new Map([0x2ac,0x2b8,0x2c4,0x2d0].map(offset=>[offset,{data:null,count:0,capacity:0}]));
// Install stale references to the now-pending object in an actual object field,
// fixed array, and nested PointRegion. These are the cleanup traversal boundary.
ref(live,'Target').set(dead);ref(live,'Touching').set([dead,info,null,dead]);
runtime.setRegion(live,dead,-7,3);
const archived=[],archivedNames=[];
runtime.serializeReferences(live,{
  objectReference:(reference,context)=>archived.push({key:context.key,value:reference.get()}),
  nameReference:(reference,context)=>archivedNames.push({key:context.key,value:reference.get()}),
});
assert(archived.some(entry=>entry.key==='engine.actor.target'&&entry.value===dead));
assert.deepEqual(archived.filter(entry=>entry.key.startsWith('engine.actor.touching[')).map(entry=>entry.value),[dead,info,null,dead]);
assert(archived.some(entry=>entry.key==='engine.actor.pointregion.zone'&&entry.value===dead));
assert(archivedNames.some(entry=>entry.key==='engine.actor.tag'&&entry.value==='None'));
runtime.cleanupDestroyed(level);
assert.deepEqual(level.actors,[info,live]);assert.equal(released.length,0);
runtime.cleanupDestroyed(level,true);
assert.equal(released.length,1);assert.equal(released[0],deadObject);
assert.deepEqual(stringCalls,[0x2d0,0x2c4,0x2b8,0x2ac]);
assert.equal(deadObject.stateFrame,frame);assert.equal(deadObject.nativeVtable,0x10179dfc);
assert.equal(registry.objects[deadObject.index],null);assert.deepEqual(registry.freeIndices,[deadObject.index]);
assert.throws(()=>ref(dead,'Location').get(),/allocation has been released/);
const replacement=camera();assert.equal(records.get(replacement).index,deadObject.index);
assert.deepEqual(registry.freeIndices,[]);
console.log('Original CameraPoint Destroy, pending threshold, typed object/array/PointRegion cleanup, final release and object-index reuse passed.');
