/** Validate one source-backed DataLinkPlay SpawnActor fixture.  The fixture
 * uses the installed DataLinkPlay class and its inherited Actor startup
 * functions; it does not enable arbitrary script-class construction. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {ScriptObjectRegistry, constructActorBase} from '../src/runtime/script-object-construction.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {createScriptObjectLookup} from '../src/runtime/script-object-lookup.mjs';
import {pointRegion} from '../src/runtime/zone.mjs';
import {createNativeRng} from '../src/runtime/rng.mjs';
import {bindScriptClassConstructor} from '../src/runtime/script-class-bind.mjs';
import {createScriptTriggers} from '../src/runtime/script-triggers.mjs';
import {prepareDataLinkFunctions} from '../src/runtime/script-datalink-transmission.mjs';
import {
  DATALINK_PLAY_CONSTRUCTION,
  SCRIPTED_ACTOR_CONSTRUCTION,
  resolveInheritedActorConstructor,
  verifyDataLinkPlayDefaults,
} from '../src/runtime/script-scripted-actor-construction.mjs';
import {gameDirectory} from './game-directory.mjs';

function exportIndex(asset, path) {
  const index=asset.exportsByPath.get(path.toLowerCase());
  assert.ok(Number.isInteger(index), `missing original export ${asset.name}.${path}`);
  return index;
}

const root=gameDirectory();
const assets=new AssetStore((await readdir(`${root}/System`)).map(name=>({
  path:`System/${name}`,read:()=>readFile(`${root}/System/${name}`),
})));
const engine=await assets.get('Engine');
const deusEx=await assets.get('DeusEx');
const level={actors:[],engine:{audio:null},collisionHash:null,editor:false,undo:null,
  spawnTracking:false,tickParity:false,spawnNotifyGuard:{active:false}};
const rng=createNativeRng(17);
const fixtureObjects=[],triggerNatives=createScriptTriggers();
const runtime=new ScriptRuntime(assets,{levelFor:()=>level,rng,conversationObjects:()=>fixtureObjects,native:call=>{
  const handled=triggerNatives.handleNative(call);
  if(handled.handled)return handled.value;
  throw new Error(`DataLinkPlay spawn reached an unbound native ${call.index} (${call.script?.entry?.path??'unknown'})`);
}});
const dataLinkClass=await runtime.loadClass(deusEx,exportIndex(deusEx,'DataLinkPlay'));
const levelClass=await runtime.loadClass(engine,exportIndex(engine,'LevelInfo'));
const gameClass=await runtime.loadClass(deusEx,exportIndex(deusEx,'DeusExGameInfo'));
const mutatorClass=await runtime.loadClass(engine,exportIndex(engine,'Mutator'));
assert.equal(dataLinkClass.record.key,'deusex.datalinkplay');
assert.equal(dataLinkClass.base?.record.key,'deusex.conplaybase');
assert.equal(dataLinkClass.base?.base?.record.key,'engine.actor');
assert.equal(dataLinkClass.base?.base?.base?.record.key,'core.object');

const levelInfo={name:'LevelInfo DataLinkPlay spawn fixture'};
const game={name:'DeusExGameInfo DataLinkPlay spawn fixture'};
const mutator={name:'Mutator DataLinkPlay spawn fixture'};
runtime.attach(levelInfo,levelClass);
runtime.attach(game,gameClass);
runtime.attach(mutator,mutatorClass);
const ref=(receiver,name)=>runtime.namedReference(receiver,name);
const set=(receiver,name,value)=>ref(receiver,name).set(value);
set(levelInfo,'NetMode',0);
// This fixture models spawning into the running level, after LoadMap's
// bBegunPlay store; the original Actor.ProcessEvent gate must admit events.
set(levelInfo,'bBegunPlay',true);
set(levelInfo,'Game',game);
set(game,'Level',levelInfo);
set(game,'BaseMutator',mutator);
set(game,'Difficulty',0);
set(game,'bNoMonsters',false);
set(game,'SecretGoals',0);
set(game,'ItemGoals',0);
set(game,'KillGoals',0);
set(mutator,'NextMutator',null);
level.actors=[levelInfo,game,mutator];
level.pointRegion=position=>pointRegion({nodes:[]},position,levelInfo,[]);

const outer={identity:{},index:-1,name:'StartupMap',outer:null};
const nativeLevel={identity:{},index:-1,name:'MyLevel',outer};
level.nativeObject=nativeLevel;
const registry=new ScriptObjectRegistry();
const noneEntry={index:0,flags:0,hashNext:null,text:'None'};
const names=createScriptNames({names:[noneEntry],freeIndices:[],buckets:Array(0x1000).fill(null),
  allocator:{free:()=>{throw new Error('DataLinkPlay spawn fixture does not model FName release');}}});
names.buckets[names.hashBucket(noneEntry.text)]=noneEntry;
for(const object of [outer,nativeLevel]){
  object.nameIndex=names.intern(object.name).index;
  registry.add(object);
}
const lookup=createScriptObjectLookup({registry,names});

const actorRecord={key:dataLinkClass.base.base.record.key,
  nativeConstructor:SCRIPTED_ACTOR_CONSTRUCTION.engineActor.internalConstructor,
  nativeVtable:SCRIPTED_ACTOR_CONSTRUCTION.engineActor.vtable};
const constructorSelection=resolveInheritedActorConstructor({
  dataLinkPlay:{key:dataLinkClass.record.key,nativeConstructor:null},
  conPlayBase:{key:dataLinkClass.base.record.key,nativeConstructor:null},
  actor:actorRecord,
});
// Explicit class registration inputs, followed by the recovered mutable
// UClass.Bind chain. A report alone does not initialize native class slots.
const classRecords=new Map();
classRecords.set(dataLinkClass.base.base.base,{});
for(const cls of [dataLinkClass.base.base,dataLinkClass.base,dataLinkClass])
  classRecords.set(cls,{base:classRecords.get(cls.base),objectFlags:cls.metadata.entry.flags,
    nativeConstructor:cls===dataLinkClass.base.base?actorRecord.nativeConstructor:null});
const bind=record=>bindScriptClassConstructor(record,{
  coreObject:classRecords.get(dataLinkClass.base.base.base),isEditor:()=>level.editor,bindSuper:bind,
});
bind(classRecords.get(dataLinkClass));
assert.equal(classRecords.get(dataLinkClass).nativeConstructor,constructorSelection.constructor);
assert.equal(classRecords.get(dataLinkClass.base).nativeConstructor,constructorSelection.constructor);
const defaults={};
for(const name of Object.keys(DATALINK_PLAY_CONSTRUCTION.authoredDefaults))
  defaults[name]=runtime.defaultValue(dataLinkClass,runtime.lookupMember(dataLinkClass,'fields',name));
verifyDataLinkPlayDefaults(defaults);

const construction={
  validate:args=>args.cls===dataLinkClass&&args.outer===outer&&args.template===null,
  registry,findObject:lookup.findObject,internName:name=>names.intern(name),
  initNativeProperties:object=>{object.auxiliary=null;},
  nativeConstructor:object=>{
    // This is the recovered inherited Engine.Actor constructor. The strict
    // selection above is separate so an unrelated native subclass cannot reach
    // this body through the fixture.
    constructActorBase(object);
  },
};

const lifecycle={
  validateSpawn:args=>args.cls===dataLinkClass&&args.level===level,
  construction,
  // Class+0x4e0 for this standalone world: the fixture's recovered Bind chain.
  classConstructor:cls=>{assert.equal(cls,dataLinkClass);return classRecords.get(cls).nativeConstructor;},
};
runtime.actorLifecycle=lifecycle;

for(const name of ['spawned','prebeginplay','beginplay','postbeginplay','postpostbeginplay','setinitialstate'])
  await runtime.prepareFunction(engine,exportIndex(engine,`Actor.${name}`));
for(const [path,asset] of [
  ['GameInfo.IsRelevant',engine],['Mutator.AlwaysKeep',engine],
  ['Mutator.IsRelevant',engine],['Mutator.CheckReplacement',engine],
]) await runtime.prepareFunction(asset,exportIndex(asset,path));

const actorEvents=[];
const originalProcessEvent=runtime.processEvent.bind(runtime);
runtime.processEvent=(receiver,name,args=[])=>{
  if(runtime.instance(receiver).cls===dataLinkClass)actorEvents.push(name);
  return originalProcessEvent(receiver,name,args);
};
const rngBefore=rng.state;
const created=runtime.spawnActor({cls:dataLinkClass.record,level,name:'None',owner:null,instigator:null,
  location:[11,22,33],rotation:[111,222,333]});
assert.ok(created);
assert.equal(level.actors.at(-1),created);
assert.equal(ref(created,'Name').get(),'DataLinkPlay0');
assert.equal(ref(created,'Tag').get(),'DataLinkPlay');
assert.deepEqual(ref(created,'Location').get(),[11,22,33]);
assert.deepEqual(ref(created,'OldLocation').get(),[11,22,33]);
assert.deepEqual(ref(created,'Rotation').get(),[111,222,333]);
assert.equal(ref(created,'Level').get(),levelInfo);
assert.equal(ref(created,'ObjectFlags').get(),0x02004001);
assert.equal(runtime.instance(created).nativeObject.nativeVtable,SCRIPTED_ACTOR_CONSTRUCTION.engineActor.vtable);
assert.deepEqual(actorEvents,['Spawned','PreBeginPlay','BeginPlay','PostBeginPlay','SetInitialState','PostPostBeginPlay']);
const expectedRng=createNativeRng(17);
expectedRng.frand();
assert.equal(rng.state,expectedRng.state);
assert.notEqual(rng.state,rngBefore);
assert.equal(level.spawnNotifyGuard.active,false);

// Original player transmission through Spawn into the busy-conversation
// branch. All unprepared UI/audio natives still fail in the native callback.
const conSys=await assets.get('ConSys'),conText=await assets.get('DeusExConText');
const prepared=await prepareDataLinkFunctions(runtime,{deusEx,conSys});
await runtime.prepareFunction(engine,exportIndex(engine,'Actor.Spawn'));
const extension=await assets.get('Extension');
for(const path of ['ExtensionObject.StringToName','FlagBase.GetBool'])
  await runtime.prepareFunction(extension,exportIndex(extension,path));
runtime.nameServices={internName:(text,mode)=>names.intern(text,mode).name};
async function fixture(asset,path){const object={};runtime.attach(object,await runtime.loadClass(asset,exportIndex(asset,path)));return object;}
const player=await fixture(deusEx,'DeusExPlayer');
const jaime=await fixture(deusEx,'JaimeReyes');
const window=await fixture(deusEx,'DeusExRootWindow');
const activeConPlay=await fixture(deusEx,'ConPlay');
const info=await fixture(deusEx,'DeusExLevelInfo');
const item=await fixture(conSys,'ConListItem');
const conversation=await runtime.objects.resolve(conText,1926);
await runtime.prepareObject(conversation);
const speech=ref(conversation,'eventList').get();
await runtime.prepareObject(speech);
await runtime.prepareObject(ref(speech,'nextEvent').get());
set(item,'con',conversation);
set(player,'ConListItems',item);
set(player,'rootWindow',window);
set(player,'conPlay',activeConPlay);
set(player,'Level',levelInfo);
set(player,'Location',[11,22,33]);
set(player,'Rotation',[111,222,333]);
set(info,'MissionLocation','Training');
triggerNatives.bindPlayerFlagBase(runtime,player);
level.actors.push(player,jaime,info);
fixtureObjects.push(player,jaime);
const start=prepared.get('deusex.deusexplayer.startdatalinktransmission');
const before=level.actors.length;
set(levelInfo,'bPlayersOnly',true);
assert.equal(runtime.callFunction(start,player,1,()=> 'dl_start'),false);
assert.equal(level.actors.length,before);
set(levelInfo,'bPlayersOnly',false);
assert.equal(runtime.callFunction(start,player,1,()=> 'dl_start'),true);
const transmission=ref(player,'dataLinkPlay').get();
assert.ok(transmission&&transmission!==created);
assert.equal(level.actors.length,before+1);
assert.equal(level.actors.at(-1),transmission);
assert.equal(ref(transmission,'Name').get(),'DataLinkPlay1');
assert.equal(ref(transmission,'Tag').get(),'None');
assert.equal(ref(transmission,'con').get(),conversation);
assert.equal(ref(transmission,'startCon').get(),conversation);
assert.equal(ref(transmission,'bConversationStarted').get(),true);
assert.equal(ref(transmission,'dataLink').get(),null);
assert.equal(ref(transmission,'currentEvent').get(),null);
assert.equal(ref(transmission,'bStartTransmission').get(),false);
assert.equal(ref(transmission,'TimerRate').get(),0);
assert.deepEqual(ref(transmission,'ConActorsBound').get(),[player,jaime,...Array(8).fill(null)]);
assert.equal(ref(speech,'speaker').get(),jaime);
assert.equal(ref(speech,'speakingTo').get(),player);
console.log('Original DataLinkPlay construction/startup and player StartDataLinkTransmission passed through Spawn and the busy-conversation return branch; UI/audio remains unbound.');

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  // Module top-level validation is intentional so CI reports the first
  // unsupported native/source boundary directly.
}
