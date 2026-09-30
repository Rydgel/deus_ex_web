/** Whole-level actor mesh layer for Play: the captured NPC bindings plus every
 * other visible LodMesh actor (crates, plants, weapon/ammo pickups, datacubes,
 * keypads, cameras, lights). Props use a synthetic per-actor GetFrame cache key,
 * which selects only tween/blend heap identity — never the drawn geometry — and
 * every Training prop is AnimSequence None, so the drawn pose is exact and a
 * static prop's update() must report no re-upload. Building the layer must not
 * move, tick or mutate the shared runtime actors. See docs/npc-mesh-preview.md. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createActorMeshScene,TRAINING_NPC_IDENTITIES} from '../src/viewer/npc-mesh-preview.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor;
const level=runtime.levelFor(player);
const get=(o,k)=>runtime.namedReference(o,k).get();

// The player and the live actor pose fields must be untouched by preparing meshes.
const playerBefore=structuredClone(game.player.status());
const poseFields=['Location','Rotation','DrawScale','AnimSequence','AnimFrame','bHidden'];
const meshActors=level.actors.filter(a=>a&&a!==player&&(()=>{try{const m=get(a,'Mesh');return m&&['LodMesh','Mesh'].includes(m.kind);}catch{return false;}})());
const snapshot=()=>meshActors.map(a=>poseFields.map(k=>{const v=get(a,k);return Array.isArray(v)?[...v]:v;}));
const before=structuredClone(snapshot());

const scene=await createActorMeshScene(runtime,assets,asset,{player});

assert.deepEqual(game.player.status(),playerBefore,'building meshes must not move or tick JC');
assert.deepEqual(snapshot(),before,'building meshes must not mutate runtime actor pose fields');
assert.equal(scene.root.visible,false,'scene root starts hidden; the viewer reveals it');

// Layer composition: all 18 captured NPCs, plus the visible prop set.
assert.equal(scene.summary.npcs,18,'all captured NPC identities render');
assert.equal(scene.npcActors.length,18);
assert.equal(scene.summary.props,46,`expected 46 visible prop meshes, got ${scene.summary.props}`);
assert.equal(scene.actors.length,scene.summary.npcs+scene.summary.props);
assert.equal(scene.summary.poseBackend,'rust-wasm',scene.summary.kernelError);

// No actor fails outright; every actor renders at least its solid faces.
assert.deepEqual(scene.summary.errors,[],`unexpected mesh errors: ${JSON.stringify(scene.summary.errors)}`);

// The one undecodable skin in Training is the NanoKey's procedural FireTexture
// effect face; it is skipped so the solid key body still draws, and recorded.
assert.equal(scene.summary.skipped.length,1,`expected only the NanoKey fire face skipped: ${JSON.stringify(scene.summary.skipped)}`);
assert.equal(scene.summary.skipped[0].actor,'NanoKey0');
assert.match(scene.summary.skipped[0].texture,/biocell_sfx/);

// The props JC walks into and frobs must be present with real geometry.
const propByName=new Map(scene.propActors.map(p=>[p.summary.actor,p]));
for(const name of ['WeaponCrowbar1','WeaponCombatKnife0','CrateBreakableMedGeneral1','CrateBreakableMedGeneral2',
  'CrateUnbreakableMed0','CrateUnbreakableSmall0','Plant0','Plant2','Ammo10mm2','DataCube0','Keypad0',
  'LightSwitch0','SecurityCamera0','Multitool0','NanoKey0'])
  assert.ok(propByName.has(name),`missing prop mesh ${name}`);
assert.ok(propByName.get('NanoKey0').summary.triangles>0,'the NanoKey body renders despite its skipped effect face');

// Every prop mesh carries finite geometry, matched UVs and a decoded skin.
let propTriangles=0;
for(const prop of scene.propActors){
  let triangles=0;
  assert.equal(prop.summary.animation,'None',`${prop.summary.actor} is a static prop`);
  prop.root.traverse(object=>{
    if(!object.isMesh)return;
    const position=object.geometry.getAttribute('position'),uv=object.geometry.getAttribute('uv');
    assert.ok(position.count>0,`${prop.summary.actor} has empty geometry`);
    assert.equal(position.count,uv.count);
    assert.ok([...position.array,...uv.array].every(Number.isFinite));
    assert.ok(object.material.map.image.data.length>0,`${prop.summary.actor} skin is empty`);
    triangles+=position.count/3;
  });
  assert.equal(triangles,prop.summary.triangles);
  propTriangles+=triangles;
}
assert.ok(propTriangles>0);

// Static texture/sampler variants share one GPU resource, while materials
// and their live Style/ScaleGlow state remain private to each actor.
const drawMeshes=scene.actors.flatMap(preview=>preview.root.children);
const gpuTextures=new Set(drawMeshes.map(mesh=>mesh.material.map));
assert.ok(gpuTextures.size<drawMeshes.length,'repeated original skins share GPU textures');
assert.equal(new Set(drawMeshes.map(mesh=>mesh.material)).size,drawMeshes.length,'actor materials stay independent');
console.log(`Training actor textures: ${drawMeshes.length} draw groups, ${gpuTextures.size} shared GPU textures.`);

// A static prop's synthetic cache key is stable frame-to-frame: re-sampling an
// unchanged pose leaves the exact same vertex positions, exactly like the
// captured NPC contract. Non-environment props also report no re-upload at all;
// environment-mapped props (camera lenses, reflective skins) recompute only UVs
// against the camera, so their positions must still be identical.
// Environment-mapped skins (camera lenses, datacube screens, reflective suit)
// recompute only UVs against the camera; every other prop is fully static.
const environmentProps=new Set(['SecurityCamera0','SecurityCamera1','SecurityCamera2','SecurityCamera3',
  'DataCube0','DataCube2','HazMatSuit2']);
let staticReports=0;
for(const prop of scene.propActors){
  const buffers=prop.root.children.map(mesh=>({position:mesh.geometry.getAttribute('position'),
    array:[...mesh.geometry.getAttribute('position').array]}));
  // A draw passes the camera; only environment UVs depend on it.
  const reuploaded=prop.update([0,0,0]);
  if(environmentProps.has(prop.summary.actor))assert.equal(reuploaded,true,`${prop.summary.actor} should track the camera`);
  else{assert.equal(reuploaded,false,`${prop.summary.actor} static pose re-uploaded geometry`);staticReports++;}
  for(const [index,mesh] of prop.root.children.entries()){
    assert.equal(mesh.geometry.getAttribute('position'),buffers[index].position,'same buffer object retained');
    assert.deepEqual([...mesh.geometry.getAttribute('position').array],buffers[index].array,
      `${prop.summary.actor} positions changed on an unchanged pose`);
  }
}
assert.equal(staticReports,scene.summary.props-environmentProps.size,'most props are fully static');

// Determinism: a second build over the same runtime yields the same geometry.
const again=await createActorMeshScene(runtime,assets,asset,{player});
assert.equal(again.summary.triangles,scene.summary.triangles,'scene triangle total is deterministic');
assert.equal(again.summary.props,scene.summary.props);
again.dispose();

// Live Level.Actors reconciliation: a removed identity releases its draw resource,
// and an identity first appearing after scene construction is decoded on update.
// This is a display fixture only; SpawnActor/destruction are tested separately.
const crate=level.actors.find(a=>a?.name==='CrateBreakableMedGeneral2');
const cratePreview=propByName.get(crate.name),slot=level.actors.indexOf(crate);
level.actors[slot]=null;scene.update();
assert.equal(scene.actors.includes(cratePreview),false,'removed actor leaves the scene');
level.actors[slot]=crate;scene.update();await scene.ready();scene.update();
const restored=scene.propActors.find(p=>p.actor===crate);
assert.ok(restored,'a newly encountered live identity acquires its mesh');
let colorWrites=0;
for(const mesh of restored.root.children){
  const setRGB=mesh.material.color.setRGB;
  mesh.material.color.setRGB=function(...args){colorWrites++;return setRGB.apply(this,args);};
}
restored.update();
assert.equal(colorWrites,0,'unchanged actor material state is not rewritten');
const glow=get(crate,'ScaleGlow'),style=get(crate,'Style'),deleted=get(crate,'bDeleteMe');
runtime.namedReference(crate,'ScaleGlow').set(Math.fround(.46));
restored.update();
assert.ok(restored.root.children.every(mesh=>mesh.material.color.r===Math.fround(.46)),
  'damage ScaleGlow reaches every material');
assert.equal(colorWrites,restored.root.children.length);
const sibling=propByName.get('CrateBreakableMedGeneral1');
for(const mesh of restored.root.children){
  const shared=sibling.root.children.find(other=>other.material.map===mesh.material.map);
  assert.ok(shared,'sibling crates share the skin resource');
  assert.notEqual(shared.material.color.r,mesh.material.color.r,'one actor glow cannot change a sibling');
}
runtime.namedReference(crate,'Style').set(3);restored.update();
assert.ok(restored.root.children.every(mesh=>mesh.material.transparent&&!mesh.material.depthWrite),
  'fragment STY_Translucent reaches live materials');
runtime.namedReference(crate,'bDeleteMe').set(true);restored.update();
assert.equal(restored.root.visible,false,'deleted crate stops drawing');
runtime.namedReference(crate,'ScaleGlow').set(glow);
runtime.namedReference(crate,'Style').set(style);
runtime.namedReference(crate,'bDeleteMe').set(deleted);restored.update();

// Disposal releases geometry without disturbing the runtime.
scene.dispose();
assert.deepEqual(snapshot(),before,'disposing meshes must not mutate runtime actor fields');

// A script-driven Mesh change. Picking Multitool0 up (Inventory.BecomeItem)
// swaps its Mesh to the POV mesh and hides it. Putting it away from the hand
// (SkilledTool.PutDown -> DownItem) unhides it for the Down animation. Render.dll's
// world pass draws an owned bOnlyOwnerSee actor in first person, so the layer
// rebuilds the actor for its new Mesh instead of refusing.
const live=await createActorMeshScene(runtime,assets,asset,{player});
const input=createPlayerInputFixture(game);
const frames=async count=>{for(let i=0;i<count;i++){input.tick(1);live.update([0,0,0]);await live.ready();}};
const tool=level.actors.find(a=>a?.name==='Multitool0');
const worldMesh=get(tool,'Mesh');
assert.equal((await input.frob(tool)).ok,true,'Multitool0 is picked up');
const belt=game.hud.read(game.hud.hud,'belt');
const toolSlot=[...Array(10).keys()].find(i=>game.hud.invoke(belt,'GetObjectFromBelt',[i])===tool);
assert.equal((await game.activateBelt(toolSlot)).name,'Multitool0');
await frames(90);
assert.notEqual(get(tool,'Mesh'),worldMesh,'BecomeItem selected the POV mesh');
const emptySlot=[...Array(10).keys()].find(i=>i>0&&!game.hud.invoke(belt,'GetObjectFromBelt',[i]));
await game.activateBelt(emptySlot);
const states=[];
for(let i=0;i<120;i++){
  await frames(1);
  const preview=live.actors.find(p=>p.actor===tool);
  states.push(`${get(tool,'bHidden')?'hidden':'shown'}:${preview?(preview.root.visible?'drawn':'not drawn'):'none'}`);
}
assert.deepEqual([...new Set(states)],['shown:drawn','hidden:not drawn'],'DownItem draws the tool, then hides it');
const rebuilt=live.actors.find(p=>p.actor===tool);
assert.equal(rebuilt.mesh,get(tool,'Mesh'),'the drawn resource follows the new Mesh');
assert.deepEqual(live.summary.errors,[]);
// The same pass's owner rules, on the owned tool: a bOnlyOwnerSee actor is not
// drawn from behind; an owned bOwnerNoSee actor is not drawn in first person.
const saved=['bHidden','bOnlyOwnerSee','bOwnerNoSee'].map(name=>[name,get(tool,name)]),behind=get(player,'bBehindView');
const drawn=()=>{rebuilt.update([0,0,0]);return rebuilt.root.visible;};
runtime.namedReference(tool,'bHidden').set(false);
runtime.namedReference(tool,'bOnlyOwnerSee').set(true);runtime.namedReference(tool,'bOwnerNoSee').set(false);
assert.equal(drawn(),true);
runtime.namedReference(player,'bBehindView').set(true);assert.equal(drawn(),false);
runtime.namedReference(player,'bBehindView').set(false);
runtime.namedReference(tool,'bOnlyOwnerSee').set(false);runtime.namedReference(tool,'bOwnerNoSee').set(true);
assert.equal(drawn(),false);
for(const [name,value] of saved)runtime.namedReference(tool,name).set(value);
runtime.namedReference(player,'bBehindView').set(behind);
live.dispose();

console.log(`actor mesh scene: ${scene.summary.npcs} NPC + ${scene.summary.props} prop meshes, `+
  `${scene.summary.triangles} triangles (${propTriangles} prop), backend ${scene.summary.poseBackend}, `+
  `${scene.summary.skipped.length} skipped face(s): ${scene.summary.skipped.map(s=>`${s.actor}/${s.texture}`).join(', ')||'none'}; `+
  'a put-away SkilledTool is rebuilt for its POV Mesh and drawn through DownItem');
