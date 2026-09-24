/** Validate canonical GM_Trench payload preparation and the native-259 boundary. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';

import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {decodeLodMesh, findSequence} from '../src/runtime/lodmesh.mjs';
import {readLodMeshFrame} from '../src/runtime/lodmesh-payload.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {loadOriginalGObjects} from './original-gobjects.mjs';

const root=gameDirectory();
const engineBytes=await readFile(`${root}/System/Engine.dll`);
const characterBytes=await readFile(`${root}/System/DeusExCharacters.u`);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(engineBytes),'0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4');
assert.equal(sha256(characterBytes),'bc9911e4e35440aef12d27c6239c596eef28673e3360d8e6b18fcdffdfbdc32d');

// Full arrays and original vertex unpack are compared in validate-mesh-payload.
// This validator checks the boundary into the live script runtime.

const files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files);
const characters=await assets.get('DeusExCharacters');
const meshIndex=characters.exportsByPath.get('gm_trench');
assert.equal(meshIndex,669);
const mesh=decodeLodMesh(characters.pkg,characterBytes,meshIndex);
assert.equal(mesh.entry.className,'LodMesh');
assert.equal(mesh.entry.serialSize,1019128);
assert.equal(mesh.eagerEnd,993850);
assert.equal(mesh.sequences.length,71);
assert.deepEqual(findSequence(mesh,'HitTorso'),{
  name:'HitTorso',group:'TakeHit',startFrame:71,numFrames:4,
  notifyCount:0,notifies:[],rate:10,
});
assert.deepEqual(findSequence(mesh,'HitLegLeft'),{
  name:'HitLegLeft',group:'TakeHit',startFrame:79,numFrames:4,
  notifyCount:0,notifies:[],rate:10,
});

const mapAsset=await assets.get('00_Training');
const game=await createGame(decodeMap(mapAsset.bytes),mapAsset,assets,{randomSeed:1});
const runtime=game.doors.scriptRuntime.runtime;
const player=game.player.collisionActor;
const meshReference=runtime.namedReference(player,'Mesh').get();
assert.equal(meshReference.key,'deusexcharacters.gm_trench');
const prepared=await runtime.prepareMesh(player);
const loader=runtime.classLoader, graph=loader.graph, {slotOf}=graph;
const resource=runtime.resources.resources.get(meshReference.key);
assert.equal(prepared,runtime.meshPayload(player));
assert.equal(resource.loadRecord,meshReference.loadRecord);
assert.equal(resource.payloadSource,'original-linker-serialized');
assert.equal(prepared,meshReference.loadRecord.meshPayload);
assert.equal(loader.identity(meshReference.loadRecord),meshReference);
assert.equal(slotOf(meshReference.loadRecord,0x1c)&0x200,0);
assert.ok(slotOf(meshReference.loadRecord,0x1c)&0x01000000,'full Play EndLoad remains pending');
assert.equal(prepared.sequences.length,71);
assert.equal(runtime.resources.resources.get(meshReference.key).payloadStatus,'decoded-lodmesh');
assert.equal(prepared.serializedEnd,1019128);
assert.equal(prepared.frameCount,366);
assert.equal(prepared.frameVertexCount,339);
assert.equal(prepared.arrays.get(0x60).num,0); // Still deferred after PlayAnim preparation.
const meshArchive=slotOf(meshReference.loadRecord,0x10).archive;
const archivePosition=meshArchive.tell();
assert.equal(meshReference.loadRecord.instanceValues.get(0x54).archive,meshArchive);
assert.equal(readLodMeshFrame(prepared,71).length,339*3);
assert.equal(meshArchive.tell(),archivePosition,'deferred frame access restores Play\'s shared cursor');
assert.equal(prepared.arrays.get(0x60).num,124074);
assert.strictEqual(prepared,runtime.meshPayload(player));

// A live NPC already has a mesh reference constructed by class-default loading.
// Preparation must fill that record, preserving the VM handle and pending queue.
const jaimeIndex=mapAsset.exportsByPath.get('jaimereyes0');
assert.ok(jaimeIndex);
const jaime=await runtime.objects.resolve(mapAsset,jaimeIndex);
const jaimeMesh=runtime.namedReference(jaime,'Mesh').get();
const originalRecord=jaimeMesh.loadRecord;
assert.ok(originalRecord);
// The live NPC preview decoded Jaime's LodMesh during scene setup, so this
// record's payload is already resident. Play draws every visible Training prop
// (ff237e1), so a prop mesh such as plant2's is resident too, in its own
// VM-visible load record. Compare scalars only: a failing assertion on a payload
// view makes Node's assert diff walk the whole object graph (tens of GiB).
const plantIndex=mapAsset.exportsByPath.get('plant2');
assert.ok(plantIndex);
const plantMesh=runtime.namedReference(await runtime.objects.resolve(mapAsset,plantIndex),'Mesh').get();
assert.equal(plantMesh.loadRecord.meshPayload?.payloadStatus,'decoded-lodmesh','Play decodes visible prop meshes at scene setup');
assert.equal(loader.identity(plantMesh.loadRecord)===plantMesh,true,'the prop payload fills the mesh reference\'s own load record');
const [jaimePayload,repeated]=await Promise.all([runtime.prepareMesh(jaime),runtime.prepareMesh(jaime)]);
assert.equal(jaimePayload,repeated);
assert.equal(jaimeMesh.loadRecord,originalRecord);
assert.equal(jaimePayload,originalRecord.meshPayload);
assert.ok(jaimePayload.sequences.some(sequence=>sequence.name==='BreatheLight'));
assert.ok(graph.loadedObjects.includes(originalRecord));
assert.ok(slotOf(originalRecord,0x1c)&0x01000000);

// First resource load before any VM class load, with an actual Texture edge.
const fresh=new ScriptRuntime(assets,{nativeClassLoading:true});
const deco=await assets.get('DeusExDeco');
const light=await fresh.objects.resolve(deco,606);
assert.equal(light.loadRecord,undefined);
const [lightResource,lightAgain]=await Promise.all([fresh.prepareResource(light),fresh.prepareResource(light)]);
assert.equal(lightResource,lightAgain);
assert.equal(lightResource.loadRecord,light.loadRecord);
assert.equal(lightResource.payload,light.loadRecord.meshPayload);
assert.equal(lightResource.payloadSource,'original-linker-serialized');
const textureReference=lightResource.payload.objectReferences[0];
const textureEdge=lightResource.payloadReferences[0];
assert.equal(textureEdge.target.object,fresh.classLoader.identity(textureReference.object));
assert.equal(textureEdge.target.object.loadRecord,textureReference.object);
assert.equal(textureEdge.target.payloadStatus,'opaque','mesh admission does not invent Texture services');
const freshGraph=fresh.classLoader.graph;
const textureFlags=freshGraph.slotOf(textureReference.object,0x1c);
assert.throws(()=>freshGraph.preload(textureReference.object),/no recovered Serialize body/);
assert.equal(freshGraph.slotOf(textureReference.object,0x1c),textureFlags);

// TakeDamage uses PlayAnim('Hit*',,0.1): EX_Nothing occupies Rate while the
// later TweenTime is present. Native P_GET_FLOAT_OPTX retains Rate=1.
for(const [name,value] of [
  ['AnimSequence','None'],['AnimFrame',0],['AnimRate',0],['TweenRate',0],
  ['AnimLast',0],['OldAnimRate',0],
]) runtime.namedReference(player,name).set(value);
const args=['HitTorso',undefined,Math.fround(0.1)];
runtime.invokeNative({
  index:259,receiver:player,argumentCount:args.length,
  evaluateArgument:index=>args[index],script:{entry:{path:'Fixture.GMTrenchPlayAnim'}},
});
assert.equal(runtime.namedReference(player,'AnimSequence').get(),'HitTorso');
assert.equal(runtime.namedReference(player,'AnimFrame').get(),Math.fround(0.001));
assert.equal(runtime.namedReference(player,'AnimRate').get(),Math.fround(2.5));
assert.equal(runtime.namedReference(player,'TweenRate').get(),0);
assert.equal(runtime.namedReference(player,'AnimLast').get(),Math.fround(0.75));
assert.equal(runtime.namedReference(player,'OldAnimRate').get(),Math.fround(2.5));

// Original ScriptedPawn pivot helpers call the new controls on a live NPC.
// This is a call/preparation boundary, not a claim that NPC startup/ticking runs.
const deusEx=await assets.get('DeusEx'), pivots={};
for(const name of ['LoopAnimPivot','TweenAnimPivot','PlayAnimPivot'])
  pivots[name]=await runtime.prepareFunction(deusEx,deusEx.exportsByPath.get(`scriptedpawn.${name.toLowerCase()}`));
const get=name=>runtime.namedReference(jaime,name).get();
const set=(name,value)=>runtime.namedReference(jaime,name).set(value);
for(const [name,mask] of [['bAnimFinished',8],['bAnimLoop',16],['bAnimNotify',32]]) {
  const property=runtime.lookupMember(runtime.instance(jaime).cls,'fields',name).loadRecord;
  assert.equal(slotOf(property,0x48),0x28);assert.equal(slotOf(property,0x5c),mask);
}
const simProperty=runtime.lookupMember(runtime.instance(jaime).cls,'fields','SimAnim');
assert.equal(slotOf(simProperty.loadRecord,0x48),0x22c);
assert.deepEqual(new Set(simProperty.metadata.structFields.map(f=>f.key)),new Set([
  'core.object.vector.x','core.object.vector.y','core.object.vector.z','core.object.plane.w',
]));
const staticBefore=get('bStatic'), hiddenBefore=get('bHidden');
set('AnimSequence','None');set('bAnimFinished',true);set('bAnimNotify',true);
const breathe=jaimePayload.sequences.find(s=>s.name==='BreatheLight');
const loopingArgs=['BreatheLight',undefined,0.3,0.2];
runtime.callFunction(pivots.LoopAnimPivot,jaime,loopingArgs.length,i=>loopingArgs[i]);
assert.equal(get('AnimSequence'),'BreatheLight');assert.equal(get('bAnimLoop'),true);
assert.equal(get('bAnimFinished'),false);assert.equal(get('bAnimNotify'),Boolean(breathe.notifyCount));
assert.equal(get('AnimFrame'),Math.fround(0.0001));
assert.equal(get('AnimRate'),Math.fround(breathe.rate/breathe.numFrames));
assert.equal(get('AnimMinRate'),Math.fround(breathe.rate/breathe.numFrames*Math.fround(0.2)));
assert.equal(get('PrePivotTime'),Math.fround(0.3));
set('AnimFrame',0.375);set('bAnimFinished',true);
runtime.callFunction(pivots.LoopAnimPivot,jaime,1,()=> 'BreatheLight');
assert.equal(get('AnimFrame'),0.375,'repeated looping call preserves animation progress');
assert.equal(get('bAnimFinished'),false);
runtime.callFunction(pivots.TweenAnimPivot,jaime,2,i=>i===0?'BreatheLight':0.25);
assert.equal(get('AnimFrame'),Math.fround(-1/breathe.numFrames));
assert.equal(get('TweenRate'),Math.fround(1/(breathe.numFrames*0.25)));
assert.equal(get('bAnimLoop'),false);assert.equal(get('AnimLast'),0);
const hitArgs=['HitTorso',undefined,0.1];
runtime.callFunction(pivots.PlayAnimPivot,jaime,3,i=>hitArgs[i]);
assert.equal(get('AnimFrame'),-0.25);assert.equal(get('AnimLast'),0.75);
assert.equal(get('TweenRate'),2.5);assert.equal(get('bAnimLoop'),false);
assert.equal(get('bStatic'),staticBefore);assert.equal(get('bHidden'),hiddenBefore);
assert.deepEqual(get('SimAnim'),{'core.object.vector.x':-2500,'core.object.vector.y':12500,
  'core.object.vector.z':2500,'core.object.plane.w':7500});
runtime.invokeNative({index:261,receiver:jaime,argumentCount:0});
const jaimeState=runtime.instance(jaime).state;
assert.equal(jaimeState.latent,0x181,'corrected final-frame value permits the real FinishAnim wait');
runtime.services.pollLatent({index:0x181,receiver:jaime,state:jaimeState,seconds:0});
assert.equal(jaimeState.latent,0x181);
// Run the recovered original animation phase before ProcessState. It must
// complete the tween and one-shot without manually writing the finished flag.
const animEnd=runtime.lookup(jaime,'AnimEnd');
await runtime.prepareFunction(animEnd.asset,animEnd.index);
runtime.processActorAnimation(jaime,0.2);
assert.equal(get('AnimFrame'),0.25);assert.equal(get('bAnimFinished'),false);
runtime.processActorScript(jaime,0.2);
assert.equal(jaimeState.latent,0x181);
runtime.processActorAnimation(jaime,0.3);
assert.equal(get('AnimFrame'),0.75);assert.equal(get('AnimRate'),0);
assert.equal(get('bAnimFinished'),true);
// Poll the FinishAnim latent directly: bAnimFinished clears it. The live pawn's
// real StartUp state would otherwise resume its own bytecode here and install
// its next latent (Sleep), which is correct live behaviour but not the
// FinishAnim contract under test.
runtime.services.pollLatent({index:0x181,receiver:jaime,state:jaimeState,seconds:0.3});
assert.equal(jaimeState.latent,0);
assert.equal(get('RemoteRole'),2,'Jaime defaults to a simulated remote proxy');
assert.equal(get('SimAnim')['core.object.vector.x'],-2500,'RemoteRole gates the completion replication write');
assert.equal(get('SimAnim')['core.object.vector.y'],12500);

// Original script helpers -> Tick -> GetFrame, with the real NPC resource,
// linked transforms and captured global identity. The separate frame oracle
// compares full original instructions; this checks the shared runtime boundary.
const capturedObjects=await loadOriginalGObjects('.cache/original-gobjects.txt');
runtime.setOriginalObjectIndex(capturedObjects.provider());
assert.equal(capturedObjects.index('JaimeReyes','JaimeReyes0'),34333);
for(const [name,offset,mask] of [['bAnimByOwner',0x28,0x40],['bParticles',0x194,4],
  ['DrawScale',0x17c],['PrePivot',0x180],['Location',0x114],['Rotation',0x120]]) {
  const property=runtime.lookupMember(runtime.instance(jaime).cls,'fields',name).loadRecord;
  assert.equal(slotOf(property,0x48),offset);
  if(mask!==undefined)assert.equal(slotOf(property,0x5c),mask);
}
const identityCoords=[0,0,0,1,0,0,0,1,0,0,0,1];
runtime.callFunction(pivots.LoopAnimPivot,jaime,1,()=> 'BreatheLight');
runtime.processActorAnimation(jaime,0.15); // Complete the helper's authored .1s tween.
assert.ok(get('AnimFrame')>=0);
const frameFields=['AnimSequence','AnimFrame','AnimRate','TweenRate','bAnimFinished',
  'bAnimLoop','bAnimNotify','Location','Rotation','PrePivot','DrawScale'];
const beforeFrame=frameFields.map(get);
const firstPose=runtime.getActorMeshFrame(jaime,identityCoords);
assert.deepEqual(frameFields.map(get),beforeFrame,'GetFrame leaves linked actor fields unchanged');
assert.equal(firstPose.vertexCount,336);assert.equal(firstPose.output.byteLength,339*12);
assert.ok(new Float32Array(firstPose.output.buffer).every(Number.isFinite));
const poseKey=BigInt((34333<<8)+0x1d),poseEntry=runtime.meshFrameCache.entries.get(poseKey);
assert.equal(poseEntry.mesh,jaimePayload);assert.equal(poseEntry.valid,339);
assert.equal(poseEntry.locks,0);
runtime.processActorAnimation(jaime,0.04);
const progressedPose=runtime.getActorMeshFrame(jaime,identityCoords);
assert.notDeepEqual(progressedPose.output,firstPose.output,'original animation Tick changes rendered vertices');
assert.equal(runtime.meshFrameCache.entries.get(poseKey),poseEntry);
runtime.callFunction(pivots.TweenAnimPivot,jaime,2,i=>i===0?'HitTorso':0.25);
const tweenStart=runtime.getActorMeshFrame(jaime,identityCoords);
assert.deepEqual(tweenStart.output,progressedPose.output,'new tween starts with the previous cached pose');
assert.equal(poseEntry.sequence,'HitTorso');assert.equal(poseEntry.frame,get('AnimFrame'));
assert.equal(poseEntry.completion,0);
runtime.processActorAnimation(jaime,0.05);
const tweenProgress=runtime.getActorMeshFrame(jaime,identityCoords);
assert.notDeepEqual(tweenProgress.output,tweenStart.output);
assert.equal(poseEntry.frame,get('AnimFrame'));
assert.ok(poseEntry.completion>0&&poseEntry.completion<1);assert.equal(poseEntry.locks,0);

// Full-resolution surface data and skin selection consume that same resource.
// This remains a data boundary: reduced LOD, lighting and draw submission are open.
const jaimeSurfaces=runtime.getActorMeshSurfaces(jaime);
assert.equal(jaimeSurfaces.length,603);
assert.ok(jaimeSurfaces.every(face=>face.vertices.every(index=>index>=3&&index<339)));
for(const [name,offset] of [['Skin',0x170],['MultiSkins',0x1a4],['Mesh',0x174]]) {
  const property=runtime.lookupMember(runtime.instance(jaime).cls,'fields',name).loadRecord;
  assert.equal(slotOf(property,0x48),offset);
}
const authoredMulti=get('MultiSkins'),authoredSkin=get('Skin'),authoredStyle=get('Style'),authoredGlow=get('ScaleGlow');
const selectedTextures=Array.from({length:8},(_,index)=>runtime.invokeNative({index:1013,receiver:jaime,
  argumentCount:1,evaluateArgument:()=>index}));
for(const slot of new Set(jaimeSurfaces.map(face=>face.texture))){
  assert.equal(runtime.getActorMeshTexture(jaime,slot),selectedTextures[slot]);
  assert.equal(selectedTextures[slot],authoredMulti[slot]);
  assert.ok(selectedTextures[slot]?.key,'Jaime surface resolves its canonical authored skin');
}
for(const name of ['GetStyleTexture','SetSkinStyle','ResetSkinStyle']) {
  const method=runtime.lookup(jaime,name);await runtime.prepareFunction(method.asset,method.index);
}
const setSkin=runtime.lookup(jaime,'SetSkinStyle');
runtime.callFunction(setSkin,jaime,1,()=>1); // Original STY_Normal enum value.
assert.equal(get('Style'),1);assert.equal(get('ScaleGlow'),authoredGlow);
assert.ok(get('MultiSkins').every(texture=>texture!==null));
runtime.callFunction(runtime.lookup(jaime,'ResetSkinStyle'),jaime,0,()=>undefined);
assert.deepEqual(get('MultiSkins'),authoredMulti);assert.equal(get('Skin'),authoredSkin);
assert.equal(get('Style'),authoredStyle);assert.equal(get('ScaleGlow'),authoredGlow);

// Native blend-array offsets and a nonzero slot cross the same linked storage.
for(const [name,offset] of [['BlendAnimSequence',0x68],['BlendAnimFrame',0x78],
  ['BlendAnimRate',0x88],['BlendTweenRate',0x98],['BlendAnimLast',0x23c],
  ['BlendAnimMinRate',0x24c],['OldBlendAnimRate',0x25c],['SimBlendAnim',0x26c]]) {
  const property=runtime.lookupMember(runtime.instance(jaime).cls,'fields',name);
  assert.equal(property.metadata.arrayDim,4);
  assert.equal(slotOf(property.loadRecord,0x48),offset);
}
set('AnimFrame',0.1);set('AnimRate',0.5);set('AnimLast',0.875);
set('BlendAnimSequence',['None','None','HitTorso','None']);
set('BlendAnimFrame',[0,0,0.8,0]);set('BlendAnimRate',[0,0,0.5,0]);
set('BlendAnimLast',[0,0,0.875,0]);
set('RemoteRole',0); // Explicit input admits the separate SimBlendAnim branch.
runtime.processActorAnimation(jaime,0.4);
assert.deepEqual(get('BlendAnimFrame'),[0,0,0.875,0]);
assert.deepEqual(get('BlendAnimRate'),[0,0,0,0]);
assert.equal(get('SimBlendAnim')[2]['core.object.vector.x'],8750);
set('RemoteRole',2);
assert.equal(get('bStatic'),staticBefore);assert.equal(get('bHidden'),hiddenBefore);

// The full standalone Actor.Tick bridge uses actual linked admission fields.
// Tick an authored LightSwitch after its real Frob, without a replacement clock
// or manually setting animation completion. World iteration remains separate.
const lightSwitch=await runtime.objects.resolve(mapAsset,mapAsset.exportsByPath.get('lightswitch0'));
const engine=await assets.get('Engine');
await runtime.prepareFunction(engine,engine.exportsByPath.get('actor.tick'));
await runtime.prepareFunction(deusEx,deusEx.exportsByPath.get('deusexdecoration.tick'));
for(const [name,offset,mask] of [['bTicked',0x28,0x200],['bStasis',0x28,0x200000],
  ['bForceStasis',0x28,0x400000],['bIsPawn',0x28,0x800000],['bTransient',0x2c,2]]) {
  const property=runtime.lookupMember(runtime.instance(lightSwitch).cls,'fields',name).loadRecord;
  assert.equal(slotOf(property,0x48),offset);assert.equal(slotOf(property,0x5c),mask);
}
runtime.processEvent(lightSwitch,'Frob',[player,null]);
const lightField=name=>runtime.namedReference(lightSwitch,name).get();
assert.equal(lightField('bFloating'),false);assert.equal(lightField('flyGen'),null);
assert.equal(lightField('ConListItems'),null);
assert.ok(['On','Off'].includes(lightField('AnimSequence')));
assert.equal(lightField('AnimFrame'),-1);assert.equal(lightField('bAnimFinished'),false);
assert.equal(lightField('Skin'),null);assert.equal(lightField('MultiSkins')[0],null);
const switchTexture=runtime.meshResource(lightField('Mesh')).payloadReferences.find(edge=>edge.slot==='textures[0]').target.object;
assert.equal(runtime.getActorMeshTexture(lightSwitch,0),switchTexture);
assert.equal(runtime.invokeNative({index:1013,receiver:lightSwitch,argumentCount:0}),switchTexture);
const tickLevel={timeSeconds:1,netMode:0,demoRecDriver:null,tickTag:1,deferredHead:null,
  // LoadMap's LastRenderTime=-10 pass (Engine.dll 0x1038da26) makes the actor
  // stasis-eligible, so the gate consults the zone render stamp and
  // DistanceFromPlayer; this fixture renders and sits next to the player.
  zoneLastRenderTime:()=>tickLevel.timeSeconds};
runtime.namedReference(lightSwitch,'DistanceFromPlayer').set(0);
assert.equal(runtime.processActorTick(lightSwitch,0.2,{level:tickLevel}),1);
assert.equal(lightField('AnimFrame'),0);assert.equal(lightField('bAnimFinished'),true);
assert.equal(lightField('bTicked'),true);
tickLevel.tickTag=0;
assert.equal(runtime.processActorTick(lightSwitch,0.2,{level:tickLevel}),1);
assert.equal(lightField('bTicked'),false);

// Compose the verified world scheduler, actual Actor.Tick and actual cleanup.
// This explicit fixture is not the unprepared full Training actor population.
const parentLight=await runtime.objects.resolve(mapAsset,mapAsset.exportsByPath.get('triggerlight0'));
assert.ok(parentLight);
const worldInfo=runtime.levelFor(lightSwitch).actors[0];
assert.equal(runtime.namedReference(worldInfo,'EventManager').get(),null);
runtime.namedReference(worldInfo,'TimeDilation').set(1);
runtime.namedReference(worldInfo,'Pauser').set('');
runtime.namedReference(worldInfo,'bPlayersOnly').set(false);
runtime.namedReference(lightSwitch,'Owner').set(parentLight); // Explicit owner-before-child scheduling input.
runtime.namedReference(parentLight,'Owner').set(null);
// The level tick recomputes DistanceFromPlayer from the real positions (the
// player is far), and LoadMap's -10 LastRenderTime makes the serialized
// bStasis actor stasis-eligible now — pin it off so the fixture still
// exercises the owner-defer retry rather than the stasis early-out.
runtime.namedReference(lightSwitch,'bStasis').set(false);
for(const actor of [lightSwitch,parentLight])runtime.namedReference(actor,'bTicked').set(false);
runtime.processEvent(lightSwitch,'Frob',[player,null]);
const tickWorld={...tickLevel,actors:[worldInfo,lightSwitch,parentLight,null],firstDynamicActor:1,
  netDriver:null,serviceAtF8:null,firstViewport:{actor:player},tickTag:1,inTick:0,
  editor:false,undo:null,pendingDeleted:null};
const playerViewport=runtime.namedReference(player,'Player');
const savedViewport=playerViewport.get();
// The selected Play bridge has no original viewport/input loop yet. Supply
// this explicit native pointer fixture to exercise the distance admission gate.
playerViewport.set(tickWorld.firstViewport);
const arena=[],order=[],calendars=[];
const actualActorTick=runtime.processActorTick;
runtime.processActorTick=function(actor,seconds,options){
  order.push(actor===lightSwitch?'child':'owner');
  return actualActorTick.call(this,actor,seconds,options);
};
const levelServices={
  beginTick:world=>{assert.equal(world.inTick,0);return arena.length;},
  allocateDeferredActor:()=>{const node={};arena.push(node);return node;},
  endTick:(world,mark)=>{assert.equal(world.inTick,0);arena.length=mark;},
  updateTime:info=>{assert.equal(info,worldInfo);calendars.push(info);}, // Calendar is an explicit OS service.
  pauserArrayCount:()=>0,
};
try {
  runtime.processLevelTick(tickWorld,0.2,levelServices);
  assert.deepEqual(order,['child','owner','child']);
  assert.equal(lightField('AnimFrame'),0);assert.equal(lightField('bAnimFinished'),true);
  assert.equal(lightField('bTicked'),true);assert.equal(tickWorld.tickTag,0);
  assert.equal(tickWorld.actors.length,3,'the real CleanupDestroyed compacts the dynamic null slot');
  assert.equal(tickWorld.deferredHead,null);assert.equal(arena.length,0);
  const playerLocation=runtime.namedReference(player,'Location').get();
  for(const actor of [lightSwitch,parentLight]) {
    const location=runtime.namedReference(actor,'Location').get();
    assert.equal(runtime.namedReference(actor,'DistanceFromPlayer').get(),
      Math.fround(Math.hypot(...location.map((value,i)=>value-playerLocation[i]))));
  }
  order.length=0;
  runtime.processLevelTick(tickWorld,0.2,levelServices);
  assert.deepEqual(order,['child','owner','child']);
  assert.equal(lightField('bTicked'),false);assert.equal(tickWorld.tickTag,1);
  assert.equal(calendars.length,2);assert.equal(arena.length,0);
} finally {runtime.processActorTick=actualActorTick;playerViewport.set(savedViewport);}

// Real linked PlayerPawn input metadata feeds the same paused reset operation.
const inputFields=[];
for(let cls=runtime.instance(player).cls;cls;cls=cls.base)for(const field of cls.propertyOrder)
  if(field.metadata.type==='float'&&(field.metadata.flags&4))inputFields.push(field);
assert.ok(inputFields.length>10);
for(const field of inputFields)runtime.fieldReference(player,field).set(
  field.metadata.arrayDim===1?123:Array(field.metadata.arrayDim).fill(123));
runtime.namedReference(player,'Health').set(87);
runtime.resetActorInput(player);
for(const field of inputFields)assert.deepEqual(runtime.fieldReference(player,field).get(),
  field.metadata.arrayDim===1?0:[0,...Array(field.metadata.arrayDim-1).fill(123)]);
assert.equal(runtime.namedReference(player,'Health').get(),87);

// Native tick visibility on canonical NPC/player identities and the real BSP.
// This controlled two-pawn fixture does not claim full NPC startup/AI execution.
for(const [name,offset] of [['SightCounter',0x320],['LastSeenTime',0x3c8],['Enemy',0x3cc]])
  assert.equal(slotOf(runtime.lookupMember(runtime.instance(jaime).cls,'fields',name).loadRecord,0x48),offset);
const seePlayer=runtime.lookup(jaime,'SeePlayer'),enemyNotVisible=runtime.lookup(jaime,'EnemyNotVisible');
assert.equal(seePlayer.key,'deusex.scriptedpawn.seeplayer');
assert.equal(enemyNotVisible.key,'engine.pawn.enemynotvisible');
for(const record of [seePlayer,enemyNotVisible])await runtime.prepareFunction(record.asset,record.index);
assert.equal(runtime.isProbing(jaime,'SeePlayer'),true);
assert.equal(runtime.isProbing(jaime,'EnemyNotVisible'),false,'the inherited empty Pawn event is not probed');
const visibilityLevel={...runtime.levelFor(jaime),timeSeconds:12345.678912345,pawnList:jaime,
  tickTag:1,deferredHead:null};
const originalNextPawn=jaime.nextPawn,actualProcessEvent=runtime.processEvent;
const sightEvents=[];
runtime.processEvent=function(actor,name,args,...rest){
  const result=actualProcessEvent.call(this,actor,name,args,...rest);
  if(name==='SeePlayer'||name==='EnemyNotVisible')sightEvents.push({actor,name,args:[...args],result});
  return result;
};
const playerLocation=runtime.namedReference(player,'Location');
const closeLocation=get('Location').map((value,i)=>Math.fround(value+(i===0?32:0)));
const validity=actor=>{assert.equal(actor,player);return true;}; // Explicit native UObject validity leaf.
try {
  jaime.nextPawn=null;
  playerLocation.set(closeLocation);
  runtime.namedReference(player,'Visibility').set(128);
  set('Rotation',[0,0,0]);set('PeripheralVision',0);set('SightCounter',-0.1);set('bLOSflag',true);set('Enemy',null);
  runtime.showPawnSelf(player,{level:visibilityLevel});
  assert.equal(sightEvents.length,1);assert.equal(sightEvents[0].name,'SeePlayer');
  assert.equal(sightEvents[0].actor,jaime);assert.deepEqual(sightEvents[0].args,[player]);
  assert.equal(sightEvents[0].result,true,'original ScriptedPawn.SeePlayer executes');
  assert.equal(get('SightCounter'),Math.fround(-0.1),'ShowSelf does not reset the listener counter');
  set('Enemy',player);
  assert.throws(()=>runtime.checkPawnEnemyVisible(jaime,{level:visibilityLevel}),/requires original UObject validity/);
  runtime.checkPawnEnemyVisible(jaime,{level:visibilityLevel,isValid:validity});
  assert.equal(get('LastSeenTime'),Math.fround(visibilityLevel.timeSeconds));
  assert.deepEqual(get('LastSeenPos'),closeLocation);assert.deepEqual(get('LastSeeingPos'),get('Location'));
  playerLocation.set(closeLocation.map((value,i)=>value+(i===0?5000:0)));
  runtime.checkPawnEnemyVisible(jaime,{level:visibilityLevel,isValid:validity});
  assert.equal(sightEvents.at(-1).name,'EnemyNotVisible');
  assert.equal(sightEvents.at(-1).result,false,'ProcessEvent honors the original class probe mask');
  assert.deepEqual(sightEvents.at(-1).args,[]);
  assert.equal(get('LastSeenTime'),Math.fround(visibilityLevel.timeSeconds));

  // Actor.Tick preserves the same mask gate before calling the helper. Original
  // Disable('Tick') is an explicit fixture input; physics/startup are separate.
  runtime.invokeNative({index:118,receiver:jaime,argumentCount:1,evaluateArgument:()=> 'Tick'});
  for(const [name,value] of Object.entries({Physics:0,bStasis:false,bAdvancedTactics:false,
    AnimSequence:'None',SightCounter:0.01,PainTime:0,SpeechTime:0,LifeSpan:0,TimerRate:0,Weapon:null,Owner:null}))set(name,value);
  const eventCount=sightEvents.length;
  assert.equal(runtime.processActorTick(jaime,0.02,{level:visibilityLevel,isValid:validity}),1);
  assert.equal(sightEvents.length,eventCount);
  assert.equal(get('SightCounter'),Math.fround(Math.fround(0.01)-Math.fround(0.02)));

  // Reach default ShowSelf through the original RemoteRole=AutonomousProxy
  // branch, with its prepared empty state. That branch needs a PlayerPawn with
  // no local Player; Play binds JC's viewport, so the fixture detaches it and
  // the finally block restores it. Viewport input/player physics remain
  // outside this explicit tick fixture (the Play host owns those separately).
  assert.equal(runtime.instance(player).state.execution,null);
  assert.equal(savedViewport!==null,true,'Play binds the player viewport');
  playerViewport.set(null);
  for(const [name,value] of Object.entries({RemoteRole:3,bStasis:false,bIsPlayer:true,bHidden:false,
    bViewTarget:false,bAdvancedTactics:false,AnimSequence:'None',SightCounter:0.5,PainTime:0,
    SpeechTime:0,LifeSpan:0,TimerRate:0,Weapon:null,Owner:null}))runtime.namedReference(player,name).set(value);
  playerLocation.set(closeLocation);set('Enemy',null);set('SightCounter',-0.1);set('bLOSflag',true);
  assert.equal(runtime.processActorTick(player,0.02,{level:visibilityLevel}),1);
  assert.equal(sightEvents.length,eventCount+1);assert.equal(sightEvents.at(-1).name,'SeePlayer');
  assert.equal(sightEvents.at(-1).result,true);

  // Native 705 now calls the recovered AIVisibility cache/lighting chain.
  // Explicit native Region/time inputs isolate this from unfinished startup.
  playerLocation.set(closeLocation);runtime.namedReference(player,'bDetectable').set(true);
  set('MinAngularSize',0);set('VisibilityThreshold',0);
  const visibilityArgs=[player,1,true,false,false,false];
  const aiCanSee=()=>runtime.invokeNative({index:705,receiver:jaime,argumentCount:6,
    evaluateArgument:index=>visibilityArgs[index]});
  const region=runtime.levelFor(player).pointRegion(closeLocation);
  runtime.setRegion(player,region.zone,region.leaf,region.zoneNumber);
  runtime.namedReference(worldInfo,'TimeSeconds').set(100);
  runtime.namedReference(player,'VisUpdateTime').set(0);
  const visibility=aiCanSee();
  assert.ok(Number.isFinite(visibility)&&visibility>=0&&visibility<=1);
  assert.equal(runtime.namedReference(player,'VisUpdateTime').get(),100);
  assert.equal(runtime.namedReference(player,'LastVisibility').get(),runtime.namedReference(player,'CurrentVisibility').get());
} finally {
  jaime.nextPawn=originalNextPawn;runtime.processEvent=actualProcessEvent;playerViewport.set(savedViewport);
}

console.log(`Play mesh bridge passed: GM_Trench's 71 sequences, shared deferred vertices, `+
  `${jaimePayload.entry.name} NPC preparation, first-load LightSwitch/Texture identities, `+
  `original NPC animation helpers, linked main/blend tick, automatic FinishAnim completion, `+
  `shared GetFrame vertices and persistent tween cache, `+
  `${jaimeSurfaces.length} full-resolution surfaces, authored skins and original Set/ResetSkinStyle, `+
  `full standalone LightSwitch Actor.Tick after original Frob, two-frame world owner scheduling, `+
  `distance prepass, real destroyed-slot cleanup, ${inputFields.length} linked paused-input fields, `+
  `NPC visibility callbacks through original LOS/BSP and Actor.Tick, and original AICanSee lighting/cache.`);
