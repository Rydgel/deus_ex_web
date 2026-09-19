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
assert.deepEqual(snapshot(),before,'inspection must not change actor state');
assert.deepEqual(game.player.status(),player,'inspection must not move or tick JC');
for(const name of ['JaimeReyes0','ScientistMale0','MedicalBot0','RepairBot0'])
  assert.ok(preview.actors.some(actor=>actor.summary.actor===name),`Missing ${name}`);
assert.equal(preview.actors.length,14);
assert.equal(preview.summary.errors.length,4);
assert.ok(preview.summary.errors.every(error=>error.message==='Environment-mapped mesh preview is unsupported'));
console.log('Explicit unsupported boundaries:',preview.summary.errors);
assert.equal(preview.root.visible,false);
for(const actor of preview.actors) {
  let triangles=0;
  actor.root.traverse(object=>{
    if(!object.isMesh)return;
    const positions=object.geometry.getAttribute('position'),uv=object.geometry.getAttribute('uv');
    assert.ok(positions.count>0);assert.equal(positions.count,uv.count);
    assert.ok([...positions.array,...uv.array].every(Number.isFinite));
    assert.ok(object.material.map.image.data.length>0);
    triangles+=positions.count/3;
  });
  assert.equal(triangles,actor.summary.triangles);
  console.log(`${actor.summary.actor}: ${triangles} triangles, ${actor.summary.textures.length} original skins`);
}
preview.dispose();
console.log('NPC preview: shared draw path, captured identities, unchanged actor/player state.');
