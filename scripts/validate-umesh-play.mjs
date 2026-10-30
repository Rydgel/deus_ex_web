/** Classic UMesh actors in Play (docs/umesh.md): DX.dx's boot logos during the flight and the flies
 * FlyGenerators spawn on 01_NYC_UNATCOIsland, through the actor mesh layer (Node, no browser).
 *
 * The translations themselves are compared with the original elsewhere (validate-umesh-frame.mjs,
 * validate-umesh-draw.mjs); this checks that Play binds and draws the five classic meshes:
 *  - DX.dx's five classic actors (EidosLogo0, IonStormLogo0, DXLogo, two DXText) each get a CPU binding with
 *    their triangles grouped by skin and no error or skipped group, and every one is posed, lit and shown by
 *    some frame of the flight (the player flies the IntroCam path from tick 1);
 *  - a drawn frame's record is complete and finite: the world pose, the camera-space points DrawMesh
 *    projects, nine colour floats a face in [0, 1] and, for an environment-mapped mesh, its U and V;
 *  - the page side builds a three.js group per skin for each, and updates its colours and environment UVs;
 *  - on the Island (seed 2, where a decoration makes a FlyGenerator; the generator spawns flies where the
 *    player cannot see, within its ActiveArea), a Fly the generator made is bound, lit and drawn. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createMeshLightingView} from '../src/viewer/mesh-lighting-view.mjs';
import {createActorMeshScene} from '../src/viewer/npc-mesh-preview.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import { exportAt } from '../src/unreal/objects.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files);

async function open(mapName,seed) {
  const asset=await assets.get(mapName);
  const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:seed,presentation:true});
  const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor,level=runtime.levelFor(player);
  const exportIndexByName=new Map(asset.pkg.exports.map((entry,i)=>[entry.name,i+1]));
  const lighting=createMeshLightingView(runtime,()=>runtime.levelFor(player),
    {exportName:ref=>exportAt(asset.pkg, ref)?.name,exportIndex:name=>exportIndexByName.get(name)});
  return {asset,game,runtime,player,level,lighting,input:createPlayerInputFixture(game,{tickSeconds:1/60})};
}
const checkRecord=(record,binding,label)=>{
  const mesh=binding.payload,vertices=mesh.frameVertexCount,triangles=binding.summary.triangles;
  if(record.posed)assert.ok(record.posed.length===vertices*3&&record.posed.every(Number.isFinite),`${label} world pose`);
  assert.ok(record.cameraPoints.length===vertices*3&&record.cameraPoints.every(Number.isFinite),`${label} camera points`);
  assert.equal(record.colors.length,triangles*9,`${label} colours`);
  assert.ok(record.colors.every(c=>c>=0&&c<=1),`${label} colours in range`);
  if(record.envUv){
    assert.equal(record.envUv.length,triangles*6,`${label} environment UVs`);
    assert.ok(record.envUv.every(Number.isFinite),`${label} finite environment UVs`);
  }
};

// DX.dx: the logos during the flight.
{
  const {asset,game,runtime,player,level,lighting,input}=await open('DX',1);
  const scene=await createActorMeshScene(runtime,assets,asset,{player,lighting});
  await scene.ready();
  assert.deepEqual(scene.summary.errors,[],'no mesh errors');assert.deepEqual(scene.summary.skipped,[],'no skipped group');
  const classic=scene.sim.actors.filter(binding=>binding.summary.classic);
  const byMesh=new Map();for(const binding of classic)byMesh.set(binding.mesh.key,(byMesh.get(binding.mesh.key)??0)+1);
  assert.deepEqual(Object.fromEntries(byMesh),{'deusexdeco.eidoslogo':1,'deusexdeco.ionstormlogo':1,'deusexdeco.dxlogo':1,'deusexdeco.dxtext':2},'DX.dx has five classic actors');
  const triangles={'deusexdeco.eidoslogo':1664,'deusexdeco.ionstormlogo':3256,'deusexdeco.dxlogo':814,'deusexdeco.dxtext':2};
  for(const binding of classic)assert.equal(binding.summary.triangles,triangles[binding.mesh.key],`${binding.summary.actor} triangles`);
  const shown=new Map();let environmentFrames=0;
  for(let step=0;step<56;step++) {
    input.tick(30);
    const view=game.view();
    lighting.beginFrame({location:view.location,rotation:view.rotation,seconds:runtime.readNamed(level.actors[0],'TimeSeconds')});
    const out=scene.sim.update({lit:true});scene.draw.apply(out,[0,0,0]);
    for(const record of out.records) {
      const binding=scene.sim.actors.find(b=>b.id===record.id);
      if(!binding?.summary.classic||!record.visible||!record.colors)continue;
      checkRecord(record,binding,`${binding.summary.actor} tick ${30*(step+1)}`);
      shown.set(binding.summary.actor,(shown.get(binding.summary.actor)??0)+1);
      if(record.envUv)environmentFrames++;
    }
  }
  assert.deepEqual([...shown.keys()].sort(),classic.map(b=>b.summary.actor).sort(),`every classic actor is lit and shown by some frame of the flight: ${JSON.stringify([...shown])}`);
  assert.ok(environmentFrames>0,'an environment-mapped logo is lit with environment UVs');
  for(const binding of classic) {
    const draw=scene.draw.bindings.get(binding.id);
    assert.ok(draw?.ready,`${binding.summary.actor} page side built`);
    assert.ok(draw.root.children.length>0);
  }
  assert.deepEqual(scene.draw.errors,[],'no page-side error');
  console.log(`DX.dx: ${classic.length} classic actors bound, shown in frames ${JSON.stringify([...shown])}, ${environmentFrames} environment-mapped frames.`);
  scene.dispose();
}

// The Island: a FlyGenerator's flies.
{
  const {asset,runtime,player,level,lighting,input,game}=await open('01_NYC_UNATCOIsland',2);
  const cls=actor=>runtime.instance(actor)?.cls?.record?.name??actor.name;
  const generator=level.actors.find(actor=>actor&&cls(actor)==='FlyGenerator');
  assert.ok(generator,'seed 2 makes a FlyGenerator on the Island');
  const at=runtime.readNamed(generator,'Location');
  // Within the ActiveArea (700) and out of sight of the generator's spots: it spawns flies.
  input.place([at[0]+650,at[1],at[2]+30],{yaw:0});
  const scene=await createActorMeshScene(runtime,assets,asset,{player,lighting});
  let flies=[];
  for(let step=0;step<20&&!flies.length;step++){
    input.tick(30);
    flies=level.actors.filter(actor=>actor&&cls(actor)==='Fly');
  }
  assert.ok(flies.length>0,'the generator spawned flies');
  input.place([at[0]+120,at[1],at[2]+30],{yaw:32768});
  input.tick(20);
  let drawn=null;
  for(let step=0;step<6&&!drawn;step++){
    input.tick(10);
    const view=game.view();
    lighting.beginFrame({location:view.location,rotation:view.rotation,seconds:runtime.readNamed(level.actors[0],'TimeSeconds')});
    const out=scene.sim.update({lit:true});scene.draw.apply(out,[0,0,0]);
    await scene.ready();
    for(const record of out.records) {
      const binding=scene.sim.actors.find(b=>b.id===record.id);
      if(binding?.summary.classic&&record.visible&&record.colors){drawn={binding,record};checkRecord(record,binding,'Fly');break;}
    }
  }
  assert.ok(drawn,'a Fly is lit and shown');
  assert.equal(drawn.binding.mesh.key,'deusexcharacters.fly');
  assert.equal(drawn.binding.summary.triangles,3);
  const draw=scene.draw.bindings.get(drawn.binding.id);
  assert.ok(draw.ready&&draw.root.children.length>0,'the Fly page side is built');
  assert.deepEqual(scene.summary.errors,[],'no mesh errors');
  console.log(`Island: ${flies.length} flies, ${scene.sim.actors.filter(b=>b.summary.classic).length} bound, ${drawn.binding.summary.actor} lit (${drawn.binding.summary.lighting?.lights} lights) and drawn.`);
  scene.dispose();
}
console.log('PASS validate-umesh-play');
