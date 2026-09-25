/** Controlled PreBeginPlay integration, not a complete LoadMap replay. */
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {zeroValue,copyValue,arrayReference,propertyReference} from '../src/runtime/script-values.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1});
const runtime=game.doors.scriptRuntime.runtime,level=runtime.levelFor(game.player.collisionActor);
// A controlled original-client fixture: the installed DeusEx.ini has Decals=True.
// The live host still requires its own original Client.Decals binding.
level.engine.client.decals=true;
const get=(actor,name)=>runtime.namedReference(actor,name).get();
const set=(actor,name,value)=>runtime.namedReference(actor,name).set(value);
const jaime=await runtime.objects.resolve(asset,asset.exportsByPath.get('jaimereyes0'));
assert.equal(runtime.lookup(jaime,'PreBeginPlay').key,'deusex.scriptedpawn.prebeginplay');
for(const key of ['engine.pawn.prebeginplay','deusex.scriptedpawn.prebeginplay',
  'deusex.scriptedpawn.presetmovement','deusex.scriptedpawn.createshadow',
  'deusex.scriptedpawn.setalliance','deusex.scriptedpawn.updatereactioncallbacks']){
  const [packageName,...parts]=key.split('.'),original=await assets.get(packageName);
  await runtime.prepareFunction(original,original.exportsByPath.get(parts.join('.')));
}

// The Play host pre-populates this list for collision/perception. Reset it in
// this isolated fixture to the original serialized empty state, established
// by the loaded-level audit in docs/pawn-list.md. Never do this to live Play.
for(const actor of level.actors.filter(actor=>actor?.lineage?.includes('engine.pawn')))
  set(actor,'NextPawn',null);
level.pawnList=null;
// The live host now runs each pawn's startup chain at load, so Jaime already
// owns the Shadow0 spawn and the shrunk CollisionHeight this fixture
// re-creates. Restore the serialized field values — the same isolation the
// pawn-list reset performs — leaving the spawned actor in place
// (originalActorCount below already includes it).
set(jaime,'Shadow',null);
set(jaime,'CollisionHeight',jaime.values.CollisionHeight);
assert.equal(get(jaime,'bInitialized'),false);
assert.equal(get(jaime,'bHasShadow'),true);
assert.equal(get(jaime,'bInWorld'),true);
assert.equal(get(jaime,'Shadow'),null);
const initialHeight=get(jaime,'CollisionHeight'),radius=get(jaime,'CollisionRadius');
const eyeHeight=get(jaime,'BaseEyeHeight'),rotation=[...get(jaime,'Rotation')];
const hashCalls=[];
const originalActorCount=level.actors.length;
for(const name of ['removeActor','addActor']){
  const original=level.hash[name].bind(level.hash);
  level.hash[name]=actor=>{if(actor===jaime)hashCalls.push([name,actor.radius,actor.height]);return original(actor);};
}
// Decal.BeginPlay attaches through AttachDecal(100) with no direction — the
// original builds a normalized random direction from the shared RNG stream,
// so an unpinned re-run attaches or destroys nondeterministically. The two
// FRand calls earlier in PreBeginPlay keep the real stream; the fixture pins
// only the three draws the surface sweep consumes, producing the original's
// straight-down probe (v=(0,0,1) -> D1=(0,0,-1)).
const originalRng=runtime.rng;let rngDraw=0;
runtime.rng={...originalRng,frand:()=>++rngDraw<=2?originalRng.frand():[.5,.5,.9999][rngDraw-3]??originalRng.frand()};
let boundary;
try{runtime.processEvent(jaime,'PreBeginPlay');}catch(error){boundary=error;}
runtime.rng=originalRng;
assert.equal(boundary,undefined,'PreBeginPlay now completes: shadow attach, alliance and reaction callbacks all resolve');
assert.equal(level.actors.length,originalActorCount+1);
const shadow=level.actors.at(-1),instance=runtime.instance(shadow);
assert.equal(instance.cls.record.key,'deusex.shadow');
assert.equal(instance.nativeObject.nativeVtable,0x10426f74);
assert.equal(get(shadow,'Owner'),jaime);
assert.equal(get(shadow,'Instigator'),jaime);
assert.equal(get(shadow,'Level'),level.actors[0]);
const feet=[...get(jaime,'Location')];feet[2]=Math.fround(feet[2]-get(jaime,'CollisionHeight'));
assert.deepEqual(get(shadow,'Location'),feet);
assert.deepEqual(get(shadow,'Rotation'),[16384,0,0]);
assert.equal(get(shadow,'Texture').key,'deusexitems.skins.flatfxtex40');
assert.equal(get(shadow,'MultiDecalLevel'),4);
// The recovered surface path swept -XAxis to the floor BSP and appended the
// footprint-covering surface indices through the convex point-in-poly test.
assert.ok(get(shadow,'SurfList').length>0,'AttachDecal appended real BSP surface indices');
assert.ok(get(shadow,'SurfList').every(index=>Number.isInteger(index)&&index>=0&&index<level.model.surfaces.length));
assert.deepEqual(get(shadow,'SurfList'),instance.nativeObject.decalSurfaces);
assert.equal(get(shadow,'bDeleteMe'),false,'AttachDecal returned true so Decal.BeginPlay retains the shadow');
assert.equal(get(jaime,'Shadow'),shadow);

// Real linked SurfList metadata crosses storage/copy/destruction boundaries.
// Reuse the previously recovered Core array contracts; do not emulate array
// opcodes or admit unresolved owning/nested containers.
const surfaceField=runtime.lookupMember(instance.cls,'fields','SurfList');
const first=zeroValue(surfaceField),second=zeroValue(surfaceField);
assert.notEqual(first,second);
first.push(1,0xffffffff,0x80000000);
const copied=copyValue(surfaceField,first);
assert.deepEqual(copied,[1,-1,-2147483648]);
first[0]=99;assert.equal(copied[0],1);
set(shadow,'SurfList',copied);
assert.deepEqual(instance.nativeObject.decalSurfaces,copied);
runtime.destroyProperties([surfaceField],field=>runtime.fieldReference(shadow,field));
assert.deepEqual(get(shadow,'SurfList'),[]);
assert.throws(()=>arrayReference(0,propertyReference(surfaceField,()=>copied,()=>{})),/array/i);
// Owning StrProperty inners (DumpLocation.dumpFileDirectory) copy element by
// element; any other inner type stays an explicit boundary.
const strings={type:'array',innerMetadata:{type:'string'}},names=zeroValue(strings);
assert.deepEqual(names,[]);names.push('a','b');
const namesCopy=copyValue(strings,names);names[0]='z';assert.deepEqual(namesCopy,['a','b']);
assert.throws(()=>zeroValue({type:'array',innerMetadata:{type:'float'}}),error=>error.code==='UNSUPPORTED_SCRIPT_VALUE');
assert.equal(level.pawnList,jaime);
assert.equal(get(jaime,'NextPawn'),null);
assert.equal(get(jaime,'CollisionHeight'),Math.fround(initialHeight-4.5));
assert.equal(get(jaime,'CollisionRadius'),radius);
assert.deepEqual(hashCalls,[['removeActor',radius,initialHeight],['addActor',radius,Math.fround(initialHeight-4.5)]]);
assert.equal(get(jaime,'Instigator'),jaime);
assert.deepEqual(get(jaime,'DesiredRotation'),rotation);
assert.equal(get(jaime,'BaseEyeHeight'),eyeHeight);
assert.equal(get(jaime,'bDeleteMe'),false,'the original relevance check retains Training Jaime');
assert.equal(get(jaime,'Shadow'),shadow,'attached Shadow survives and is stored on the pawn');
assert.equal(get(jaime,'bInitialized'),false,'PreBeginPlay does not initialize; BeginPlay/SetInitialState remain');

// Exercise the real negative BeginPlay route on the constructed actor. Only
// this isolated fixture disables decals; Play never bypasses BSP attachment.
level.engine.client.decals=false;
runtime.processEvent(shadow,'BeginPlay');
assert.equal(get(shadow,'bDeleteMe'),true);
assert.equal(level.actors[originalActorCount],null);
assert.equal(level.pendingDeleted,shadow);
assert.equal((instance.nativeObject.flags&0x80800000)>>>0,0x80800000);
assert.deepEqual(get(shadow,'SurfList'),[]);

// Check the shared list-native bridge against the already recovered original
// add/remove semantics, including stale links and the intentional duplicate
// self-loop. Native list instruction comparisons remain in their own validator.
const scientist=await runtime.objects.resolve(asset,asset.exportsByPath.get('scientistmale0'));
const invoke=(actor,index)=>runtime.invokeNative({receiver:actor,index,argumentCount:0});
invoke(scientist,529);assert.equal(level.pawnList,scientist);assert.equal(get(scientist,'NextPawn'),jaime);
invoke(scientist,530);assert.equal(level.pawnList,jaime);assert.equal(get(scientist,'NextPawn'),jaime);
invoke(jaime,529);assert.equal(get(jaime,'NextPawn'),jaime);
console.log('NPC PreBeginPlay: real list/collision/relevance/field writes, native Shadow construction, BSP surface attach and inherited BeginPlay; MultiDecalLevel grid collection remains documented. Disabled-decals BeginPlay destroys the spawned Shadow.');
