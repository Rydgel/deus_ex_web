/** Original native declarations and linked class storage at the lifecycle
 * boundary. Fixture world/registry identities are explicit; this does not
 * claim SpawnActor construction or final garbage collection. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {modifyScriptObject} from '../src/runtime/script-object-lifecycle.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const name of await readdir(`${root}/System`))files.push({path:name,read:()=>readFile(`${root}/System/${name}`)});
const assets=new AssetStore(files),engine=await assets.get('Engine');
const level={actors:[],pendingDeleted:null,engine:{audio:null},collisionHash:null,editor:false,
  native3c:null,native88:null};
const runtime=new ScriptRuntime(assets,{levelFor:()=>level});
const cls=await runtime.loadClass(engine,engine.exportsByPath.get('camerapoint'));
const levelClass=await runtime.loadClass(engine,engine.exportsByPath.get('levelinfo'));
const outer={identity:{name:'FixturePackage'},index:7};
let nextIndex=20;
function attach(name,actorClass=cls){
  const actor={name};runtime.attach(actor,actorClass);
  const record={identity:actor,index:nextIndex++,name,flags:1,outer,linker:null,linkerIndex:-1,auxiliary:null,
    destroy:identity=>runtime.destroyActorBase(identity)};
  runtime.bindNativeObject(actor,record);level.actors.push(actor);return actor;
}
const info=attach('LevelInfo',levelClass),owner=attach('Owner'),parent=attach('Parent'),child=attach('Child');
runtime.actorLifecycle={
  validate:actor=>{
    if(runtime.instance(actor).cls!==cls||level.actors[0]!==info||level.native3c!==null||level.native88!==null)
      throw new Error('Fixture supports only ordinary CameraPoint destruction without level driver hooks');
    return true;
  },
  modify:actor=>modifyScriptObject(runtime.instance(actor).nativeObject,null),
};
const ref=(actor,name)=>runtime.namedReference(actor,name);
const setOwner=await runtime.prepareFunction(engine,engine.exportsByPath.get('actor.setowner'));
const destroy=await runtime.prepareFunction(engine,engine.exportsByPath.get('actor.destroy'));
for(const event of ['destroyed','endstate','gainedchild','lostchild']){
  const record=runtime.lookup(parent,event);
  await runtime.prepareFunction(record.asset,record.index);
}
runtime.callFunction(setOwner,parent,1,()=>owner);
runtime.callFunction(setOwner,child,1,()=>parent);
assert.equal(ref(parent,'Owner').get(),owner);assert.equal(ref(child,'Owner').get(),parent);
const region=runtime.lookupMember(runtime.instance(owner).cls,'fields','Region');
assert(region,'CameraPoint must inherit Actor.Region');
assert.equal(region.entry.path,'Actor.Region');
assert.equal(region.entry.outer,engine.exportsByPath.get('actor'));
await runtime.field(region);
assert.equal(region.metadata.structKey,'engine.actor.pointregion');
assert.deepEqual(region.metadata.structFields.map(field=>field.metadata.name),['Zone','iLeaf','ZoneNumber']);
const regionMembers=Object.fromEntries(region.metadata.structFields.map(field=>[field.metadata.name,field]));
const zone={identity:{name:'PointRegionZone'},index:777};
const suppliedRegion={
  [regionMembers.Zone.key]:zone,
  [regionMembers.iLeaf.key]:-17,
  [regionMembers.ZoneNumber.key]:0x123,
};
const regionReference=ref(owner,'Region');regionReference.set(suppliedRegion);
const copiedRegion=regionReference.get();
assert.notStrictEqual(copiedRegion,suppliedRegion);
assert.equal(copiedRegion[regionMembers.Zone.key],zone);
assert.equal(copiedRegion[regionMembers.iLeaf.key],-17);
assert.equal(copiedRegion[regionMembers.ZoneNumber.key],0x23);
const leafReference=runtime.structReference(regionReference,regionMembers.iLeaf);
leafReference.set(-31);
assert.equal(regionReference.get()[regionMembers.iLeaf.key],-31);
const zoneNumberReference=runtime.structReference(regionReference,regionMembers.ZoneNumber);
zoneNumberReference.set(0x1ff);
assert.equal(regionReference.get()[regionMembers.ZoneNumber.key],0xff);
const authoredStructDefaults=[];
for(const name of ['Color','Scale']){
  const field=runtime.lookupMember(runtime.instance(owner).cls,'fields',name);
  if(!field||!runtime.instance(owner).cls.defaults.has(field.key))continue;
  await runtime.field(field);
  const value=runtime.defaultValue(runtime.instance(owner).cls,field);
  assert(value&&typeof value==='object'&&!Array.isArray(value),`Authored ${name} default must link members`);
  authoredStructDefaults.push(name);
}
ref(parent,'BindName').set('Release this owned string');
ref(parent,'Location').set([11,22,33]);
const state=runtime.instance(parent).state;state.latent=384;
assert.equal(runtime.callFunction(destroy,parent),true);
assert.equal(level.actors[2],null);assert.equal(level.pendingDeleted,parent);
assert.equal(ref(child,'Owner').get(),null);
assert.equal(ref(parent,'bDeleteMe').get(),true);
assert.equal(ref(parent,'BindName').get(),'');
assert.deepEqual(ref(parent,'Location').get(),[11,22,33]);
assert.equal(ref(parent,'Owner').get(),owner);
assert.equal(state.latent,384);assert.equal(runtime.instance(parent).state,state);
assert.equal(runtime.instance(parent).nativeObject.flags,0x80800001);
assert.equal(runtime.instance(parent).nativeObject.linkerIndex,outer.index);
assert.equal(runtime.processEvent(parent,'Destroyed'),false);
assert.equal(runtime.callFunction(destroy,parent),true);
assert.equal(ref(parent,'Deleted').get(),null);
console.log(`Original Actor.SetOwner/Destroy declarations, CameraPoint ownership cleanup, typed string destruction, pending chain and repeated destroy passed; inherited PointRegion typed copy/member writeback passed; authored Color/Scale defaults checked: ${authoredStructDefaults.length?authoredStructDefaults.join(', '):'none present'}.`);
