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
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const files=[],root=gameDirectory();
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
  files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor,level=runtime.levelFor(player);
const input=createPlayerInputFixture(game);
const get=(o,k)=>runtime.namedReference(o,k).get(),set=(o,k,v)=>runtime.namedReference(o,k).set(v);
const crowbar=level.actors.find(a=>a?.name==='WeaponCrowbar1');
assert.equal((await input.frob(crowbar)).ok,true);
assert.equal((await game.selectWeaponGroup(10)).ok,true);
// Standalone display harness may supply the already recovered held-item native
// adapter; Play installs the same relocation service at its host boundary.
runtime.relocation??={actorFor:actor=>actor,
  farMoveActor:(_level,actor,destination,test,noCheck)=>runtime.farMoveActor(actor,destination,test,noCheck)};
// Player start logs a new player in, so the view follows the current one.
const view=await createWeaponViewModel(runtime,assets,()=>game.player.collisionActor);
await view.ready();
const camera=new THREE.PerspectiveCamera(75,4/3,1,65536),draws=[];let clears=0;
// Render.dll clears Z once before the viewing actor's RenderOverlays; the
// script's Canvas.DrawActor omits its optional ClearZ (default false).
const renderer={render(scene,usedCamera){
  draws.push(scene);assert.equal(usedCamera,camera,'original Canvas uses the world frame');
},clearDepth(){clears++;}};
assert.equal(get(player,'ShowFlags'),0x480c,'SpawnPlayActor ShowFlags');
const native=runtime.native,boundaries=[...runtime.boundaryNatives];
const pose=()=>[get(crowbar,'AnimSequence'),get(crowbar,'AnimFrame'),get(crowbar,'AnimRate')];
const before=pose();
const offset=runtime.callFunction(runtime.lookup(crowbar,'CalcDrawOffset'),crowbar);
const expected=get(player,'Location').map((n,i)=>Math.fround(n+offset[i]));
view.render(renderer,camera);
assert.equal(view.summary.draws,1);assert.equal(view.summary.loading,false);
assert.equal(clears,1,'one RenDev ClearZ precedes RenderOverlays');
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
// Render's own gates: bBehindView selects no target; SHOW_Actors is required.
clears=0;set(player,'bBehindView',true);view.render(renderer,camera);
assert.equal(view.summary.draws,0);assert.equal(clears,0);set(player,'bBehindView',false);
set(player,'ShowFlags',0x480c&~8);view.render(renderer,camera);
assert.equal(view.summary.draws,0);assert.equal(clears,0);set(player,'ShowFlags',0x480c);

// Observe the shared ticked selection animation through persistent GPU buffers.
// All actor time advances exclusively through game.tick, without calling Fire.
const mesh=preview.children[0],positions=mesh.geometry.getAttribute('position'),old=[...positions.array];
input.tick(5);
view.render(renderer,camera);
assert.equal(mesh.geometry.getAttribute('position'),positions,'persistent geometry buffer');
assert.ok(old.some((v,i)=>v!==positions.array[i]),'ticked Select animation changes the view pose');
assert.equal(game.doors.scriptRuntime.npcFailures.size,0);

// DeusExPlayer.RenderOverlays draws a non-Weapon inHand through its inherited
// Inventory.RenderOverlays: the key ring from belt slot 0.
const ring=get(player,'KeyRing');assert.ok(ring);
assert.equal((await game.activateBelt(0)).ok,true);
for(let i=0;i<120&&get(player,'inHand')!==ring;i++)
  input.tick(1);
assert.equal(get(player,'inHand'),ring);assert.equal(get(player,'Weapon'),null);
assert.equal(get(ring,'Mesh'),get(ring,'PlayerViewMesh'),'carried ring uses its PlayerViewMesh');
await view.ready();
const ringPose=[get(ring,'AnimSequence'),get(ring,'AnimFrame')];
const ringOffset=runtime.callFunction(runtime.lookup(ring,'CalcDrawOffset'),ring);
const ringAt=get(player,'Location').map((n,i)=>Math.fround(n+ringOffset[i]));
view.render(renderer,camera);
assert.equal(view.summary.draws,1,'the key ring is drawn');assert.equal(view.summary.actor,ring.name);
assert.equal(view.summary.mesh,get(ring,'PlayerViewMesh').key);
assert.deepEqual(get(ring,'Location'),ringAt,'Inventory.CalcDrawOffset reaches SetLocation');
assert.deepEqual(get(ring,'Rotation'),get(player,'ViewRotation'),'Inventory.RenderOverlays copies ViewRotation');
assert.deepEqual([get(ring,'AnimSequence'),get(ring,'AnimFrame')],ringPose,'drawing does not animate the ring');
const ringPreview=view.scene.children.find(root=>root.visible);
assert.ok(ringPreview&&ringPreview.children.every(m=>[...m.geometry.getAttribute('position').array].every(Number.isFinite)));

game.reset();view.render(renderer,camera);
assert.equal(view.summary.draws,0,'Player start clears the drawn weapon');
view.dispose();
console.log('player view model: Render ClearZ + RenderOverlays gates, original crowbar overlay placement, live ticked Select pose, hidden/FOV gates, key ring inHand overlay and reset pass');
