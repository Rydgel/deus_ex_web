/** The first-person weapon's DrawLodMesh LOD (docs/script-lodmesh-lod.md "The
 * first-person weapon"): Canvas.DrawActor draws the carried weapon in the
 * world's master frame (UCanvas+0x7c; Engine.dll 0x10377fae -> Render.dll
 * URender::DrawActor 0x10b262c0 -> DrawActorSprite -> DrawMesh -> DrawLodMesh),
 * so DrawLodMesh selects its detail from that frame's Coords and FX, the
 * viewport actor's FovAngle and the weapon's own Location (SetLocation in
 * RenderOverlays), DrawScale and LODBias, like any other actor.
 *
 * This runs Training's crowbar through the overlay simulation
 * (weapon-overlay-sim.mjs, with the master frame's LOD inputs as Play's
 * sim-session passes them) on the JavaScript and the Wasm path, at the
 * shipped URender settings and at larger MLODs, and gives the original
 * Render.dll ranges (scripts/native-lodmesh-lod-oracle.py, control word
 * 0x007f) the same inputs: the detail bits, requested count, flags, morph
 * start, admitted faces and vertices must be the original's. A weapon given
 * no master frame (the earlier behaviour) is drawn without LOD, which the
 * run also asserts.
 *
 *   node scripts/validate-weapon-lod.mjs */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import * as THREE from 'three';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createWeaponOverlaySim} from '../src/viewer/weapon-overlay-sim.mjs';
import {loadLodMeshKernel} from '../src/runtime/lodmesh-wasm.mjs';
import {getAxes} from '../src/runtime/camera.mjs';
import {bitsFloat,floatBits,lodMeshTanArgument,RENDER_LOD_SETTINGS} from '../src/runtime/lodmesh-lod.mjs';
import {gameDirectory} from './game-directory.mjs';
import {meshOracleSpec} from './lodmesh-lod-cases.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

let root;
try{root=gameDirectory();}catch{console.log('SKIP validate-weapon-lod: no installed game data');process.exit(0);}
const python=process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python';
if(!existsSync(python)){console.log('SKIP validate-weapon-lod: no native probe environment');process.exit(0);}
const files=[];
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
  files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor,level=runtime.levelFor(player);
const input=createPlayerInputFixture(game);
const crowbar=level.actors.find(a=>a?.name==='WeaponCrowbar1');
assert.equal((await input.frob(crowbar)).ok,true);
assert.equal((await game.selectWeaponGroup(10)).ok,true);
runtime.relocation??={actorFor:actor=>actor,
  farMoveActor:(_level,actor,destination,test,noCheck)=>runtime.farMoveActor(actor,destination,test,noCheck)};
input.tick(3);

// The master frame as Play builds it: Frame->Coords (X right, Y down, Z
// forward) from the viewport actor's view, FX the float width, FovAngle the
// viewport actor's.
const f=Math.fround,view=game.view();
const [forward,right,up]=getAxes(view.rotation.map(value=>value|0));
const coords=[...view.location.map(f),...right.map(f),...up.map(value=>f(-value)),...forward.map(f)];
const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(
  new THREE.PerspectiveCamera(75,4/3,1,65536).projectionMatrix,new THREE.Matrix4()));
const lodInputs={coords,fx:1440,fov:view.fov};

const settingsList=[{name:'shipped',settings:RENDER_LOD_SETTINGS}];
for(const shapeLOD of [1,8,64,512,4096])settingsList.push({name:`MLOD ${shapeLOD}`,settings:{...RENDER_LOD_SETTINGS,shapeLOD}});
const rows=[];
for(const [backend,kernel] of [['javascript',null],['wasm',await loadLodMeshKernel()]]) {
  const sim=await createWeaponOverlaySim(runtime,assets,()=>game.player.collisionActor,{kernel,lighting:null,layout:null});
  await sim.ready();
  // The earlier behaviour: no master frame, no LOD.
  sim.frame({frustum});
  const bare=sim.all()[0]?.lodState();
  assert.ok(!bare?.updated,`${backend}: a weapon given no master frame selects nothing`);
  for(const {name,settings} of settingsList) {
    const frame=sim.frame({frustum,lodInputs,settings});
    assert.equal(frame.draws.length,1,`${backend} ${name}: the weapon is drawn`);
    const binding=sim.all()[0],state=binding.lodState();
    assert.ok(state?.updated,`${backend} ${name}: the weapon selected its LOD`);
    rows.push({backend,name,state});
  }
  sim.dispose();
}
// The same inputs through the original ranges.
const {state:first}=rows[0];
const doubleHex=value=>{const v=new DataView(new ArrayBuffer(8));v.setFloat64(0,value,true);return v.getBigUint64(0,true).toString(16).padStart(16,'0');};
const caseOf=({backend,name,state})=>({name:`${backend} ${name}`,settings:state.frame.settings,
  lodBiasBits:floatBits(state.inputs.lodBias),drawScaleBits:floatBits(state.inputs.drawScale),locationBits:state.inputs.location.map(floatBits),
  fovBits:floatBits(state.frame.fov),fxBits:floatBits(state.frame.fx),coordsBits:state.frame.coords.map(floatBits),
  tanBits:{[doubleHex(lodMeshTanArgument(state.frame.fov))]:floatBits(state.frame.tanFactor)},returnedCount:state.returned});
const {topology,spec}=await meshOracleSpec(root,first.meshPackage,first.meshIndex,rows.map(caseOf));
const reference=JSON.parse(execFileSync(python,['scripts/native-lodmesh-lod-oracle.py',root],
  {input:JSON.stringify([spec]),encoding:'utf8',maxBuffer:64<<20}));
const tally={rows:rows.length,reduced:0,morph:0,active:0,full:0};
for(const [i,{backend,name,state}] of rows.entries()) {
  const original=reference.meshes[0].cases[i],label=`${backend} ${name} (${spec.name})`;
  assert.equal(floatBits(state.selection.detail),original.selection.detailBits,`${label}: detail bits`);
  assert.equal(state.selection.requested,original.selection.requested,`${label}: requested count`);
  assert.equal(state.selection.active,Boolean(original.selection.active),`${label}: LOD flag`);
  assert.equal(state.selection.morph,Boolean(original.selection.morph),`${label}: morph flag`);
  const active=Boolean(original.state.active),morph=Boolean(original.state.morph);
  assert.equal(Boolean(state.state?.active),active,`${label}: LOD flag after the morph`);
  assert.equal(Boolean(state.state?.morph),morph,`${label}: morph flag after the morph`);
  if(morph)assert.equal(state.state.start,original.state.start,`${label}: morph start`);
  const admitted=original.faces.filter(face=>face.admitted);
  assert.equal(state.admitted,admitted.length,`${label}: admitted faces`);
  if(active&&state.vertices!==null)assert.equal(state.vertices,new Set(admitted.flatMap(face=>face.vertices)).size,`${label}: distinct vertices`);
  assert.equal(state.returned,original.state.count,`${label}: returned count`);
  tally.reduced+=state.returned<topology.modelVerts?1:0;tally.morph+=morph?1:0;tally.active+=active?1:0;tally.full+=!active&&!morph?1:0;
}
const shipped=rows.find(row=>row.name==='shipped').state;
const detail=bitsFloat(floatBits(shipped.selection.detail));
console.log(`validate-weapon-lod: PASS (${first.meshPackage}:${spec.name}, ${tally.rows} selections on the JavaScript and Wasm paths: ${tally.reduced} below ModelVerts, `+
  `${tally.morph} morphing, ${tally.active} with reduced topology, ${tally.full} at full detail; shipped settings: detail ${detail.toFixed(2)}, requested `+
  `${shipped.selection.requested} of ${topology.modelVerts} (the morph flag the selection sets, ${shipped.selection.morph}, is cleared after GetFrame: ${shipped.state?.morph ? 'no' : 'yes'}); `+
  `detail bits, counts, flags, start, admitted faces and vertices equal the original's)`);
