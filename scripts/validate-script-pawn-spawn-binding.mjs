/** Constructor/collision/zone integration boundary using original class data.
 * Script event bodies and spatial queries are explicit fixture services here;
 * this does not establish Login or the scripts' startup behavior. Original
 * constructor branch cases are checked by validate-native-actor-constructors.
 * Zone query positions/order come from Engine SetActorZone 0x1039b940. */
import assert from 'node:assert/strict';
import {createStartupFixture} from './validate-script-startup.mjs';
import {ScriptObjectRegistry} from '../src/runtime/script-object-construction.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {createScriptObjectLookup} from '../src/runtime/script-object-lookup.mjs';
import {NATIVE_ACTOR_CONSTRUCTORS} from '../src/runtime/script-native-actor-constructors.mjs';

const {runtime,assets,deusEx,engine,levelInfo}=await createStartupFixture();
const extension=await assets.get('Extension');
const pawnClass=await runtime.loadClass(deusEx,deusEx.exportsByPath.get('jcdentonmale'));
await runtime.loadClass(extension,extension.exportsByPath.get('flagbase'));
const infoClass=await runtime.loadClass(engine,engine.exportsByPath.get('playerreplicationinfo'));
const registry=new ScriptObjectRegistry();
const none={index:0,flags:0,hashNext:null,text:'None'};
const names=createScriptNames({names:[none],freeIndices:[],buckets:Array(4096).fill(null),allocator:{free(){throw Error('fixture free');}}});
names.buckets[names.hashBucket('None')]=none;
const outer={identity:{},index:-1,name:'PawnSpawnFixture',outer:null};
outer.nameIndex=names.intern(outer.name).index;registry.add(outer);
const lookup=createScriptObjectLookup({registry,names});
const queries=[],events=[],hashAdds=[],baseQueries=[];
const bodyZone={},footZone={},headZone={};
let distinctZones=false;
const level={actors:[levelInfo],nativeObject:{outer},editor:false,undo:null,spawnTracking:false,
 tickParity:false,spawnNotifyGuard:{active:false},netMode:0,
 pointRegion(position){queries.push(position);return {zone:distinctZones?[bodyZone,footZone,headZone][(queries.length-1)%3]:levelInfo,leaf:5,zoneNumber:2};},
 hash:{levelInfo,addActor:actor=>hashAdds.push(actor),lineCheck:(...args)=>{baseQueries.push(args);return {actor:null,time:1};}},
};
runtime.levelFor=()=>level;
runtime.bindProperty(levelInfo,runtime.lookupMember(runtime.instance(levelInfo).cls,'fields','PawnList'),{
 get:()=>level.pawnList??null,set:value=>{level.pawnList=value;},
});
runtime.actorLifecycle={validateSpawn:args=>args.level===level,
 classConstructor:()=>0x100016b0,
 construction:{validate:args=>args.outer===outer&&args.template===null,
 registry,findObject:lookup.findObject,internName:name=>names.intern(name),initNativeProperties:()=>{}},
};
runtime.processEvent=(actor,name,args=[])=>{events.push({actor,name,args});};
const read=(actor,name)=>runtime.namedReference(actor,name).get();
const write=(actor,name,value)=>runtime.namedReference(actor,name).set(value);
const pawn=runtime.spawnActor({cls:pawnClass.record,level,name:'None',owner:null,instigator:null,
 location:[10,20,100],rotation:[0,0,0],noCollisionFail:true});
assert.ok(pawn);assert.equal(pawn.isPawn,true);assert.equal(pawn.pawn,true);
assert.deepEqual(hashAdds,[pawn]);assert.deepEqual(pawn.position,read(pawn,'Location'));
assert.equal(baseQueries.length,1);
assert.deepEqual(queries,[[10,20,100],[10,20,Math.fround(100-read(pawn,'CollisionHeight'))],
 [10,20,Math.fround(100+read(pawn,'EyeHeight'))]]);
const flags=read(pawn,'FlagBase');
assert.ok(flags&&typeof flags.setBool==='function');
assert.equal(runtime.instance(flags).nativeObject.outer,runtime.instance(pawn).nativeObject);
assert.equal(runtime.instance(flags).nativeObject.nativeVtable,0x1205c20c);
assert.equal(flags.defaultExpiration,0);flags.setBool('SpawnFixture',true);assert.equal(flags.getBool('SpawnFixture'),true);
const count=registry.objects.length;
runtime.constructPlayerFlagBase(runtime.instance(pawn).nativeObject,NATIVE_ACTOR_CONSTRUCTORS['deusex.deusexplayer'].conditionalFlagBase);
assert.equal(read(pawn,'FlagBase'),flags);assert.equal(registry.objects.length,count);
const info={};runtime.attach(info,infoClass);write(pawn,'PlayerReplicationInfo',info);
distinctZones=true;queries.length=0;events.length=0;
runtime.setSpawnActorZone(pawn,false,true);
assert.deepEqual(events.map(event=>event.name),['ActorLeaving','ZoneChange','ActorEntered','FootZoneChange','HeadZoneChange']);
assert.deepEqual(events.map(event=>event.actor),[levelInfo,pawn,bodyZone,pawn,pawn]);
assert.equal(runtime.regionValue(pawn).zone,bodyZone);
assert.equal(runtime.regionValue(pawn,'FootRegion').zone,footZone);
assert.equal(runtime.regionValue(pawn,'HeadRegion').zone,headZone);
assert.equal(read(info,'PlayerZone'),bodyZone);
write(info,'PlayerZone',null);level.netMode=3;events.length=0;queries.length=0;
runtime.setSpawnActorZone(pawn,true,true);
assert.equal(read(info,'PlayerZone'),null);assert.equal(events.length,0);assert.equal(queries.length,3);
const prior={nextPawn:null};level.pawnList=prior;
runtime.invokeNative({receiver:pawn,index:529,argumentCount:0});
assert.equal(level.pawnList,pawn);assert.equal(read(levelInfo,'PawnList'),pawn);
assert.equal(pawn.nextPawn,prior);assert.equal(read(pawn,'NextPawn'),prior);
runtime.invokeNative({receiver:pawn,index:530,argumentCount:0});
assert.equal(level.pawnList,prior);assert.equal(read(pawn,'NextPawn'),prior);
runtime.invokeNative({receiver:pawn,index:529,argumentCount:0});
runtime.invokeNative({receiver:pawn,index:529,argumentCount:0});
assert.equal(read(pawn,'NextPawn'),pawn,'original duplicate AddPawn retains its self-cycle');
level.pawnList=null;write(pawn,'NextPawn',null);
console.log('Pawn SpawnActor constructor/FlagBase identity, hash view, original foot/head zone positions, event order and PRI net-mode gate passed.');
