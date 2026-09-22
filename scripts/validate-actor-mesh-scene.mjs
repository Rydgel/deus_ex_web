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
assert.equal(scene.summary.props,45,`expected 45 visible prop meshes, got ${scene.summary.props}`);
assert.equal(scene.actors.length,scene.summary.npcs+scene.summary.props);
assert.equal(scene.summary.poseBackend,'rust-wasm',scene.summary.kernelError);

// Errors are non-fatal texture-decode skips only, and never an NPC.
for(const e of scene.summary.errors){
  assert.ok(!(e.actor in TRAINING_NPC_IDENTITIES),`captured NPC failed to render: ${e.actor}: ${e.message}`);
  assert.match(e.message,/Texture|skin|unsupported/,`unexpected mesh error for ${e.actor}: ${e.message}`);
}

// The props JC walks into and frobs must be present with real geometry.
const propByName=new Map(scene.propActors.map(p=>[p.summary.actor,p]));
for(const name of ['WeaponCrowbar1','WeaponCombatKnife0','CrateBreakableMedGeneral1','CrateBreakableMedGeneral2',
  'CrateUnbreakableMed0','CrateUnbreakableSmall0','Plant0','Plant2','Ammo10mm2','DataCube0','Keypad0',
  'LightSwitch0','SecurityCamera0','Multitool0'])
  assert.ok(propByName.has(name),`missing prop mesh ${name}`);

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
  const reuploaded=prop.update();
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

// Disposal releases geometry without disturbing the runtime.
scene.dispose();
assert.deepEqual(snapshot(),before,'disposing meshes must not mutate runtime actor fields');

console.log(`actor mesh scene: ${scene.summary.npcs} NPC + ${scene.summary.props} prop meshes, `+
  `${scene.summary.triangles} triangles (${propTriangles} prop), backend ${scene.summary.poseBackend}, `+
  `${scene.summary.errors.length} non-fatal skip(s): ${scene.summary.errors.map(e=>e.actor).join(', ')||'none'}`);
