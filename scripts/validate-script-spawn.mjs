/** Original CameraPoint construction and startup scripts in an explicitly
 * supplied standalone world. This does not bootstrap a loaded map or run the
 * selected Idle state's next tick. */
import assert from 'node:assert/strict';
import {createStartupFixture} from './validate-script-startup.mjs';
import {ScriptObjectRegistry,constructCameraPoint} from '../src/runtime/script-object-construction.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {createScriptObjectLookup} from '../src/runtime/script-object-lookup.mjs';
import {pointRegion} from '../src/runtime/zone.mjs';
import {createNativeRng} from '../src/runtime/rng.mjs';

const {runtime,engine,levelInfo,game,mutator,cameraClass,rng}=await createStartupFixture();
const ref=(actor,name)=>runtime.namedReference(actor,name);
const caller={};runtime.attach(caller,cameraClass);
ref(caller,'Level').set(levelInfo);ref(caller,'Location').set([11,22,33]);
ref(caller,'Rotation').set([111,222,333]);
const outer={identity:{},index:-1,name:'StartupMap',outer:null};
const nativeLevel={identity:{},index:-1,name:'MyLevel',outer};
const level={actors:[levelInfo,caller,game,mutator,null],nativeObject:nativeLevel,
  editor:false,undo:null,spawnTracking:false,tickParity:false,spawnNotifyGuard:{active:false},
  pointRegion:position=>pointRegion({nodes:[]},position,levelInfo,[])};
const registry=new ScriptObjectRegistry();
// Keep the native index-zero None entry explicit. This isolated startup
// fixture supplies the FName table; it does not claim native table bootstrap.
const noneEntry={index:0,flags:0,hashNext:null,text:'None'};
const names=createScriptNames({
  names:[noneEntry],
  freeIndices:[],
  buckets:Array(0x1000).fill(null),
  allocator:{free:()=>{throw new Error('Spawn fixture does not model FName release');}},
});
names.buckets[names.hashBucket(noneEntry.text)]=noneEntry;
assert.equal(names.find('None'),0);
for(const object of [outer,nativeLevel]){
  object.nameIndex=names.intern(object.name).index;registry.add(object);
}
const lookup=createScriptObjectLookup({registry,names});
runtime.actorLifecycle={
  validateSpawn:args=>args.cls===cameraClass&&args.level===level,
  construction:{
    validate:args=>args.cls===cameraClass&&args.outer===outer&&args.template===null,
    registry,findObject:lookup.findObject,
    internName:name=>names.intern(name),
    // Explicit native-tail fixture inputs; a full native CDO loader is separate.
    initNativeProperties:object=>{object.auxiliary=null;runtime.instance(object.identity).sleepTimeLeft=0;},
    nativeConstructor:constructCameraPoint,
  },
};
const priorLevelFor=runtime.levelFor;
runtime.levelFor=actor=>actor===caller?level:priorLevelFor(actor);
for(const name of ['spawn','spawned','beginplay','postbeginplay','postpostbeginplay','setinitialstate','gainedchild','lostchild'])
  await runtime.prepareFunction(engine,engine.exportsByPath.get(`actor.${name}`));
const idle=await runtime.prepareState(engine,engine.exportsByPath.get('camerapoint.idle'));
const expectedRng=createNativeRng(rng.state);expectedRng.frand();
const events=[],processEvent=runtime.processEvent.bind(runtime);
runtime.processEvent=(actor,name,args=[])=>{
  if(actor!==caller&&runtime.instance(actor).cls===cameraClass)events.push({name,tag:ref(actor,'Tag').get()});
  return processEvent(actor,name,args);
};
const spawn=runtime.lookup(caller,'Spawn');
const created=runtime.callFunction(spawn,caller,3,index=>[cameraClass.record,null,'RequestedTag'][index]);
assert.ok(created);assert.equal(level.actors.length,6);assert.equal(level.actors[4],null);assert.equal(level.actors[5],created);
assert.equal(ref(created,'Name').get(),'CameraPoint0');assert.equal(ref(created,'Tag').get(),'RequestedTag');
assert.deepEqual(events.map(event=>event.name),['Spawned','PreBeginPlay','BeginPlay','PostBeginPlay','SetInitialState','PostPostBeginPlay']);
assert.ok(events.every(event=>event.tag==='CameraPoint'));
assert.deepEqual(ref(created,'Location').get(),[11,22,33]);assert.deepEqual(ref(created,'OldLocation').get(),[11,22,33]);
assert.deepEqual(ref(created,'Rotation').get(),[111,222,333]);assert.equal(ref(created,'Level').get(),levelInfo);
assert.equal(ref(created,'LastRenderTime').get(),-10);assert.equal(ref(created,'bTicked').get(),true);
assert.equal(ref(created,'ObjectFlags').get(),0x02000001);assert.equal(runtime.levelFor(created),level);
assert.deepEqual(runtime.regionValue(created),{zone:levelInfo,leaf:-1,zoneNumber:0});
assert.equal(runtime.instance(created).nativeObject.nativeVtable,0x10427178);
assert.equal(runtime.instance(created).state.stateNode,idle);assert.equal(runtime.instance(created).state.execution.cursor,0);
assert.equal(runtime.instance(created).state.latent,0);assert.equal(rng.state,expectedRng.state);
assert.equal(level.spawnNotifyGuard.active,false);
const actorClass=await runtime.loadClass(engine,engine.exportsByPath.get('actor'));
assert.equal(runtime.callFunction(spawn,caller,1,()=>actorClass.record),null);assert.equal(level.actors.length,6);
console.log('Original CameraPoint Spawn native wrapper, construction, relevance/RNG scripts, callback order, zone fields and automatic state selection passed; abstract Actor rejected before insertion.');
