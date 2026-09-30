import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createTrainingNpcPreview,TRAINING_NPC_IDENTITIES} from '../src/viewer/npc-mesh-preview.mjs';
import {gameDirectory} from './game-directory.mjs';
import {loadOriginalGObjects} from './original-gobjects.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1});
const runtime=game.doors.scriptRuntime.runtime;
const captured=await loadOriginalGObjects('.cache/original-gobjects.txt');
const names=Object.keys(TRAINING_NPC_IDENTITIES),indices=Object.values(TRAINING_NPC_IDENTITIES);
const actors=await Promise.all(names.map(name=>runtime.objects.resolve(asset,asset.exportsByPath.get(name.toLowerCase()))));
for(const [i,actor] of actors.entries())assert.equal(captured.index(runtime.instance(actor).cls.record.name,names[i]),indices[i]);
const fields=['Location','Rotation','DrawScale','AnimSequence','AnimFrame','AnimRate','bUnlit','Skin','MultiSkins'];
const snapshot=()=>actors.map(actor=>fields.map(name=>{
  const value=runtime.namedReference(actor,name).get();
  return Array.isArray(value)?value.map(v=>v?.key??v):value?.key??value;
}));
const before=structuredClone(snapshot()),player=structuredClone(game.player.status());
const preview=await createTrainingNpcPreview(runtime,assets,asset);
assert.equal(preview.summary.poseBackend,'rust-wasm',preview.summary.kernelError);
assert.deepEqual(snapshot(),before,'inspection must not change actor state');
assert.deepEqual(game.player.status(),player,'inspection must not move or tick JC');
for(const name of ['JaimeReyes0','ScientistMale0','MedicalBot0','RepairBot0'])
  assert.ok(preview.actors.some(actor=>actor.summary.actor===name),`Missing ${name}`);
assert.equal(preview.actors.length,18);
assert.deepEqual(preview.summary.errors,[]);
assert.equal(preview.root.visible,false);
for(const actor of preview.actors) {
  let triangles=0;
  actor.root.traverse(object=>{
    if(!object.isMesh||object.userData.twinOf)return; // a two-sided group's front-face twin shares its geometry
    const positions=object.geometry.getAttribute('position'),uv=object.geometry.getAttribute('uv');
    assert.ok(positions.count>0);assert.equal(positions.count,uv.count);
    assert.ok([...positions.array,...uv.array].every(Number.isFinite));
    assert.ok(object.material.map.image.data.length>0);
    triangles+=positions.count/3;
  });
  assert.equal(triangles,actor.summary.triangles);
  console.log(`${actor.summary.actor}: ${triangles} triangles, ${actor.summary.textures.length} original skins`);
}

// Controlled original script -> animation phase -> existing GPU buffer bridge.
// This intentionally does not claim that PreBeginPlay/StartUp ran in Play.
const dx=await assets.get('DeusEx');
for(const name of ['LoopAnimPivot','PlayAnimPivot','TweenAnimPivot','HasTwoHandedWeapon','GetSwimPivot'])
  await runtime.prepareFunction(dx,dx.exportsByPath.get(`scriptedpawn.${name.toLowerCase()}`));
const originalBuffers=new Map();
for(const view of preview.actors){
  const actor=actors[names.indexOf(view.summary.actor)],waiting=runtime.lookup(actor,'PlayWaiting');
  await runtime.prepareFunction(waiting.asset,waiting.index);
  const animEnd=runtime.lookup(actor,'AnimEnd');await runtime.prepareFunction(animEnd.asset,animEnd.index);
  assert.equal(view.update(),false,'unchanged poses do not re-upload geometry');
  originalBuffers.set(view,view.root.children.map(mesh=>({
    geometry:mesh.geometry,position:mesh.geometry.getAttribute('position'),
    uv:mesh.geometry.getAttribute('uv'),material:mesh.material,
  })));
  runtime.callFunction(waiting,actor);
  view.update(); // Cache the initial tween, just as a draw between simulation ticks would.
  runtime.processActorAnimation(actor,.4);
}
const scriptedFields=structuredClone(snapshot());
preview.update();
assert.deepEqual(snapshot(),scriptedFields,'draw updates cannot mutate runtime actor fields');
for(const view of preview.actors){
  const actor=actors[names.indexOf(view.summary.actor)];
  assert.equal(runtime.namedReference(actor,'bInitialized').get(),false);
  assert.equal(view.summary.animation,runtime.namedReference(actor,'AnimSequence').get());
  assert.equal(view.summary.frame,runtime.namedReference(actor,'AnimFrame').get());
  for(const [index,mesh] of view.root.children.entries()){
    const old=originalBuffers.get(view)[index];
    assert.equal(mesh.geometry,old.geometry);assert.equal(mesh.geometry.getAttribute('position'),old.position);
    assert.equal(mesh.geometry.getAttribute('uv'),old.uv);assert.equal(mesh.material,old.material);
    assert.ok([...old.position.array].every(Number.isFinite));
    assert.ok(Number.isFinite(mesh.geometry.boundingSphere.radius));
  }
}
const jaime=actors[names.indexOf('JaimeReyes0')];
const view=preview.actors.find(actor=>actor.summary.actor==='JaimeReyes0');
const get=name=>runtime.namedReference(jaime,name).get();
const set=(name,value)=>runtime.namedReference(jaime,name).set(value);
const mesh=view.root.children[0],position=mesh.geometry.getAttribute('position');
const pose=()=>Array.from(position.array);
assert.equal(view.summary.animation,'BreatheLight','the original ScriptedPawn method chooses the sequence');
const firstPose=pose(),version=position.version;
runtime.processActorAnimation(jaime,.04);assert.equal(view.update(),true);
assert.notDeepEqual(pose(),firstPose,'runtime animation advances displayed vertices');
assert.equal(position.version,version+1);
assert.equal(view.update(),false);assert.equal(position.version,version+1);
const previousPose=pose();
const tween=runtime.lookup(jaime,'TweenAnimPivot');
runtime.callFunction(tween,jaime,2,index=>index===0?'HitTorso':.25);
view.update();
assert.deepEqual(pose(),previousPose,'a new tween starts at the cached displayed pose');
runtime.processActorAnimation(jaime,.05);view.update();
assert.notDeepEqual(pose(),previousPose,'persistent native cache interpolates the new tween');
const bounds=mesh.geometry.boundingBox.clone(),location=get('Location');
set('Location',[location[0]+40,location[1],location[2]]);view.update();
assert.ok(Math.abs(mesh.geometry.boundingBox.min.z-(bounds.min.z-40))<.001);
assert.deepEqual(view.location,get('Location'),'focus follows the live transform');
set('bHidden',true);view.update();assert.equal(view.root.visible,false);
set('bHidden',false);view.update();assert.equal(view.root.visible,true);
set('bDeleteMe',true);view.update();assert.equal(view.root.visible,false);
assert.deepEqual(game.player.status(),player,'mesh sampling and controlled NPC animation do not tick JC');
preview.dispose();
assert.equal(view.update(),false,'disposed geometry is not uploaded again');
console.log('NPC preview: 18 shared runtime poses, persistent buffers/tweens/bounds, hidden/deleted actors, read-only sampling.');
