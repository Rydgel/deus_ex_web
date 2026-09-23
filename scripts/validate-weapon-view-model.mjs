/** Focused boundary check: inherited original RenderOverlays and its original
 * CalcDrawOffset drive the visible crowbar pose. No weapon fire/state-machine
 * function is invoked outside the scheduler. Mesh/GetFrame fidelity is covered
 * by its existing native comparison; this checks only the display integration. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import * as THREE from 'three';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createWeaponViewModel} from '../src/viewer/weapon-view-model.mjs';
import {gameDirectory} from './game-directory.mjs';

const files=[],root=gameDirectory();
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
  files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor,level=runtime.levelFor(player);
const get=(o,k)=>runtime.namedReference(o,k).get(),set=(o,k,v)=>runtime.namedReference(o,k).set(v);
const crowbar=level.actors.find(a=>a?.name==='WeaponCrowbar1'),location=get(crowbar,'Location');
game.collision.queries.changeActor(player,()=>{
  game.player.position=[location[0]-40,location[1],location[2]];game.player.velocity=[0,0,0];
});
game.interaction.frobTarget=crowbar;assert.equal(game.use().ok,true);
assert.equal((await game.selectWeaponGroup(10)).ok,true);
// Standalone display harness may supply the already recovered held-item native
// adapter; Play installs the same relocation service at its host boundary.
runtime.relocation??={actorFor:actor=>actor,
  farMoveActor:(_level,actor,destination)=>runtime.relocateHeldItem(actor,destination)};
const view=await createWeaponViewModel(runtime,assets,player);
await view.ready();
const camera=new THREE.PerspectiveCamera(75,4/3,1,65536),draws=[];
const renderer={render(scene,usedCamera){
  draws.push(scene);assert.equal(usedCamera,camera,'original Canvas uses the world frame');
},clearDepth(){assert.fail('DrawActor omitted ClearZ; native optional default is false');}};
const native=runtime.native,boundaries=[...runtime.boundaryNatives];
const pose=()=>[get(crowbar,'AnimSequence'),get(crowbar,'AnimFrame'),get(crowbar,'AnimRate')];
const before=pose();
const offset=runtime.callFunction(runtime.lookup(crowbar,'CalcDrawOffset'),crowbar);
const expected=get(player,'Location').map((n,i)=>Math.fround(n+offset[i]));
view.render(renderer,camera);
assert.equal(view.summary.draws,1);assert.equal(view.summary.loading,false);
assert.equal(view.summary.mesh,'deusexitems.crowbar');
assert.deepEqual(get(crowbar,'Location'),expected,'original CalcDrawOffset reaches original SetLocation');
assert.deepEqual(get(crowbar,'Rotation'),[...get(player,'ViewRotation').slice(0,2),0]);
assert.deepEqual(pose(),before,'drawing must not advance or choose an animation');
assert.equal(runtime.native,native,'scoped Canvas native handler restored');
assert.deepEqual([...runtime.boundaryNatives],boundaries);
const preview=view.scene.children[0];
assert.equal(get(crowbar,'bHidden'),true,'carried weapon stays hidden from world visibility');
assert.equal(preview.visible,true,'Canvas.DrawActor draws the carried hidden weapon');
assert.ok(preview.children.every(m=>[...m.geometry.getAttribute('position').array].every(Number.isFinite)));

// The exact original visibility gates, not independently guessed viewer gates.
set(crowbar,'bHideWeapon',true);view.render(renderer,camera);assert.equal(view.summary.draws,0);
set(crowbar,'bHideWeapon',false);
const fov=get(player,'DesiredFOV');set(player,'DesiredFOV',fov+1);
view.render(renderer,camera);assert.equal(view.summary.draws,0);
set(player,'DesiredFOV',fov);

// Observe the shared ticked selection animation through persistent GPU buffers.
// All actor time advances exclusively through game.tick, without calling Fire.
const mesh=preview.children[0],positions=mesh.geometry.getAttribute('position'),old=[...positions.array];
for(let i=0;i<5;i++)game.tick(1/60,{forward:0,right:0,yaw:game.player.yaw,pitch:0,jump:false,crouch:false,walk:false});
view.render(renderer,camera);
assert.equal(mesh.geometry.getAttribute('position'),positions,'persistent geometry buffer');
assert.ok(old.some((v,i)=>v!==positions.array[i]),'ticked Select animation changes the view pose');
assert.equal(game.doors.scriptRuntime.npcFailures.size,0);

game.reset();view.render(renderer,camera);
assert.equal(view.summary.draws,0,'Player start clears the drawn weapon');
view.dispose();
console.log('weapon view model: original crowbar overlay placement, live ticked Select pose, hidden/FOV gates, shared camera/depth and reset pass');
