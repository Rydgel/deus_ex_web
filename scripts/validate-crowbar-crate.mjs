/** Training original-bytecode integration: public input -> ticked notify ->
 * damage/fragment/content lifecycle. Native contracts and remaining branches:
 * docs/script-crate-destruction.md. Never call weapon Fire/TraceFire/notify
 * directly here: latent execution belongs to the per-frame scheduler. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createActorMeshScene} from '../src/viewer/npc-mesh-preview.mjs';

const root=gameDirectory(),files=[];
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
  files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor,level=runtime.levelFor(player);
const get=(o,k)=>runtime.namedReference(o,k).get();
const meshes=await createActorMeshScene(runtime,assets,asset,{player});
const previewFor=actor=>meshes.actors.find(preview=>preview.actor===actor);
const live=name=>level.actors.find(a=>a?.name===name);
const stateKey=o=>runtime.instance(o).state?.stateNode?.record?.key??'none';
function place(item){const loc=get(item,'Location');
  game.collision.queries.changeActor(player,()=>{game.player.position=[loc[0]-40,loc[1],loc[2]];game.player.velocity=[0,0,0];});}

// Pick up the crowbar through the public frob path (the covered pickup slice).
const crowbar=live('WeaponCrowbar1');
assert.ok(crowbar,'WeaponCrowbar1 is a live actor');
place(crowbar);game.interaction.frobTarget=crowbar;
assert.equal(game.use().ok,true,'the crowbar is taken into inventory');
assert.equal(get(crowbar,'Owner'),player,'the crowbar is owned by JC before selection');

await game.selectWeaponGroup(10);
const crate=live('CrateBreakableMedGeneral1'),upper=live('CrateBreakableMedGeneral2');
const cl=get(crate,'Location');
const px=[cl[0],cl[1]+64,-128+43+0.2];
game.collision.queries.changeActor(player,()=>{game.player.position=px;game.player.velocity=[0,0,0];});
const input={forward:0,right:0,yaw:-Math.PI/2,pitch:Math.atan2(cl[2]-(px[2]+40),px[1]-cl[1]),jump:false,crouch:false,walk:false};
const traces=new Set(),fragments=new Set();
const tick=n=>{for(let i=0;i<n;i++){
 game.tick(1/60,input);
 for(const actor of level.actors){
  if(!actor)continue;
  const cls=runtime.instance(actor).cls;
  if(cls.record.key==='deusex.tracehithandnonpenspawner')traces.add(actor);
  if(cls.record.key==='deusex.woodfragment')fragments.add(actor);
 }
 assert.equal(game.doors.scriptRuntime.npcFailures.size,0,
  [...game.doors.scriptRuntime.npcFailures.values()].join('\n'));
}};
tick(40);
const originalPosition=get(upper,'Location').slice();
const hp=get(upper,'HitPoints'),damage=get(crowbar,'HitDamage');
const radius=get(upper,'CollisionRadius'),height=get(upper,'CollisionHeight');
const expectedFragments=Math.trunc((radius+height)/2/5+1);
const skin=runtime.callFunction(runtime.lookup(upper,'GetMeshTexture'),upper,[]);
const swing=()=>{game.pressFire();tick(5);game.releaseFire();tick(60);};
swing();
assert.equal(get(upper,'HitPoints'),hp-damage,'first original notify applies authored damage');
assert.equal(get(upper,'ScaleGlow'),Math.fround(Math.fround(Math.fround((hp-damage)/hp)*Math.fround(0.9))+Math.fround(0.1)),'ResetScaleGlow darkens surviving crate');
assert.equal(runtime.instance(upper).pendingKill,false);
meshes.update();
assert.ok(previewFor(upper).root.children.every(mesh=>mesh.material.color.r===get(upper,'ScaleGlow')),
 'first-hit damage glow reaches crate materials');
assert.ok(traces.size>0,'original hit-effect actor is spawned');
assert.ok([...traces].every(actor=>runtime.instance(actor).pendingKill),'0.1-second Timer destroys hit effects');
swing();
assert.equal(get(upper,'HitPoints'),hp-2*damage,'second notify applies damage before destruction');
assert.equal(runtime.instance(upper).pendingKill,true,'second original hit destroys crate');
assert.ok(!level.actors.includes(upper),'destroyed crate leaves Level.Actors');
assert.equal(fragments.size,expectedFragments,'Frag count comes from original dimensions');
assert.ok([...fragments].every(actor=>get(actor,'Skin')===skin),'fragments inherit crate mesh texture');
assert.ok([...fragments].some(actor=>get(actor,'Location').some((v,i)=>v!==originalPosition[i])),
 'spawned fragments move through original falling/bounce');
const lockpick=level.actors.find(a=>a&&runtime.instance(a).cls.record.key==='deusex.lockpick'&&a.scriptView);
assert.ok(lockpick,'Containers.Destroyed spawns the authored Lockpick contents');
assert.equal(get(lockpick,'Physics'),0,'Inventory landing settles lockpick');
assert.ok(get(lockpick,'Base'),'landing assigns support base');
assert.equal(stateKey(lockpick),'deusex.deusexpickup.pickup','dropped lockpick enters Pickup state');
// The browser regression occurred when walking into the dropped contents
// before frobbing them: the spawned collision view's class marker is
// intentionally read-only and must only be observed by player physics.
const beforeContentsMove=game.player.position.slice();
input.forward=1;
assert.doesNotThrow(()=>tick(30),'walking beside dropped contents must not mutate their class identity');
input.forward=0;
assert.notDeepEqual(game.player.position,beforeContentsMove,'the public walking path advances after crate destruction');
assert.equal(lockpick.isPawn,false,'the dropped Inventory retains its canonical non-Pawn classification');
assert.ok(level.actors.includes(lockpick),'movement does not implicitly pick up the Lockpick');
meshes.update();await meshes.ready();meshes.update();
assert.equal(previewFor(upper),undefined,'destroyed crate releases its draw resource');
for(const actor of [...fragments,lockpick]){
 const preview=previewFor(actor);assert.ok(preview,`${actor.name} has a dynamic mesh`);
 assert.ok(preview.root.visible,`${actor.name} draws at its live location`);
 assert.ok(preview.root.children.every(mesh=>[...mesh.geometry.getAttribute('position').array].every(Number.isFinite)));
 if(fragments.has(actor))assert.ok(preview.summary.textures.includes(skin.key),'fragment renders inherited crate skin');
}
assert.deepEqual(meshes.summary.errors,[]);
let faded=false;
const maxLife=Math.max(...[...fragments].map(actor=>get(actor,'LifeSpan')));
for(let frame=0;frame<Math.ceil((maxLife+0.1)*60);frame++){
 tick(1);meshes.update();
 for(const actor of fragments)if(!runtime.instance(actor).pendingKill&&get(actor,'LifeSpan')<1.5){
  assert.equal(get(actor,'Style'),3,'fragment Tick selects STY_Translucent');
  assert.ok(get(actor,'ScaleGlow')<1,'fragment Tick fades before expiry');
  assert.ok(previewFor(actor).root.children.every(mesh=>mesh.material.transparent&&
   mesh.material.color.r===get(actor,'ScaleGlow')),'fragment fade reaches its live draw materials');faded=true;
 }
}
assert.ok(faded,'fragment fade executed');
assert.ok([...fragments].every(actor=>runtime.instance(actor).pendingKill),'LifeSpan destroys every fragment');
game.reset();
assert.ok(level.actors.includes(upper),'reset restores serialized crate identity');
assert.equal(runtime.instance(upper).pendingKill,false);
assert.equal(get(upper,'HitPoints'),hp);
assert.equal(get(upper,'ScaleGlow'),1);
assert.equal(stateKey(upper),'deusex.deusexdecoration.active');
assert.ok(!level.actors.includes(lockpick),'reset destroys spawned contents');
assert.ok([...fragments,...traces].every(a=>!level.actors.includes(a)),'reset leaves no spawned effects');
assert.equal(game.doors.scriptRuntime.npcFailures.size,0);
meshes.update();await meshes.ready();meshes.update();
assert.ok(previewFor(upper)?.root.visible,'reset redraws the restored crate');
assert.ok([...fragments,lockpick].every(actor=>!previewFor(actor)),'reset releases spawned draw resources');
meshes.dispose();
console.log('crowbar crate: ticked hits, original damage, six fragments/bounce/fade/expiry, dropped Lockpick landing, dynamic meshes/glow, effect timers and reset passed.');
