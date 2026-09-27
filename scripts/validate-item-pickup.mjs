/** Public Play item pickup over the original frob path. World inventory items
 * enter their auto Pickup state at LoadMap startup, and a frobbed item runs
 * DeusExPlayer.ParseRightClick -> HandleItemPickup (inventory-grid slot) ->
 * DoFrob -> the item's real Inventory.Pickup.Frob give. Research placement moves
 * the player next to each item and sets the frob target; it never adds inventory,
 * owns items or assigns slots directly. docs/script-item-pickup.md. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createActorMeshScene} from '../src/viewer/npc-mesh-preview.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const root=gameDirectory(),files=[];
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
  files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const runtime=game.doors.scriptRuntime.runtime;
const input=createPlayerInputFixture(game);
// Player start logs in a new player; re-read it after every reset.
let player=game.player.collisionActor;const level=runtime.levelFor(player);
const get=(o,k)=>runtime.namedReference(o,k).get();
const live=name=>level.actors.find(a=>a?.name===name);
const frobPose=item=>item.name==='Candybar0'
  ? {position:[get(item,'Location')[0],get(item,'Location')[1]-64,get(item,'Location')[2]]}
  : item.name==='Multitool0'
    ? {position:[get(item,'Location')[0]-40,get(item,'Location')[1],get(item,'Location')[2]]}
    : undefined;
const invNames=()=>{const a=[];let it=get(player,'Inventory');for(let n=0;it&&n<64;it=get(it,'Inventory'),n++)a.push(it.name);return a;};
const stateKey=o=>runtime.instance(o).state?.stateNode?.record?.key??'none';
const before=structuredClone(game.player.status());

// Startup put the world inventory items into their auto Pickup state, so their
// Frob resolves to the give path, not the empty base Actor.Frob.
for(const [name,expectState] of [['WeaponCrowbar1','engine.inventory.pickup'],
  ['WeaponCombatKnife0','engine.inventory.pickup'],['Ammo10mm2','engine.pickup.pickup'],
  ['Multitool0','deusex.deusexpickup.pickup'],['Candybar0','deusex.deusexpickup.pickup'],
  ['NanoKey0','deusex.deusexpickup.pickup']]){
  const item=live(name);
  assert.ok(item,`${name} is a live actor`);
  assert.equal(stateKey(item),expectState,`${name} enters its auto Pickup state at startup`);
  assert.match(runtime.lookup(item,'Frob').key,/\.pickup\.frob$/,`${name} Frob resolves to the pickup give`);
}
assert.deepEqual(game.player.status(),before,'startup pickup preparation does not move or tick JC');

// Build the actor mesh scene while the pickups are still visible; update() must
// later hide the ones taken, through their own bHidden path.
const scene=await createActorMeshScene(runtime,assets,asset,{kernel:null,player});
scene.update([0,0,0]);
for(const name of ['WeaponCrowbar1','Candybar0','CrateBreakableMedGeneral1'])
  assert.equal(scene.propActors.find(p=>p.summary.actor===name)?.root.visible,true,`${name} renders before pickup`);

// Weapons/ammo/tools/food are taken into JC's inventory, owned and hidden,
// through the public game.use() frob path (frob target set as the highlight
// would). Grid-slot assignment is item-type-specific and left to the original
// HandleItemPickup; a weapon receives a real grid slot.
for(const name of ['WeaponCrowbar1','WeaponCombatKnife0','Ammo10mm2','Candybar0','HazMatSuit2','Multitool0']){
  const item=live(name);
  // Original Inventory.BecomeItem calls SetPhysics(PHYS_None), whose native
  // tail zeroes Velocity and Acceleration (0x103c9676). Seed a nonzero value
  // before the public frob to expose a map native/VM acceleration split.
  if(name==='WeaponCrowbar1'){
    assert.equal(get(item,'Physics'),2,'the map crowbar starts Falling');
    runtime.writeNamed(item,'Acceleration',[7,-11,13]);
    assert.deepEqual(item.acceleration,[7,-11,13],'script acceleration reaches the map native member');
  }
  const beforeInv=invNames().length;
  const result=await input.frob(item,frobPose(item));
  assert.equal(result.ok,true,`${name} pickup reports success: ${JSON.stringify(result)}`);
  assert.ok(get(item,'Owner')===player,`${name} is now owned by JC`);
  assert.equal(get(item,'bHidden'),true,`${name} is removed from the world`);
  assert.ok(invNames().includes(name),`${name} is linked into JC's inventory list`);
  assert.ok(invNames().length>beforeInv,`${name} grew the inventory list`);
  if(name==='WeaponCrowbar1'){
    assert.equal(get(item,'Physics'),0,'original BecomeItem changes the crowbar to PHYS_None');
    assert.deepEqual(item.acceleration,[0,0,0],'native SetPhysics clears map acceleration');
    assert.deepEqual(get(item,'Acceleration'),[0,0,0],'the VM observes native SetPhysics acceleration clearing');
  }
}
// A weapon takes a real inventory-grid slot through HandleItemPickup's search.
assert.ok(get(live('WeaponCrowbar1'),'invPosX')>=0&&get(live('WeaponCrowbar1'),'invPosY')>=0,
  'the crowbar received an inventory-grid slot');

// GiveTo's SetBase(Frobber) makes each picked-up item a based rider on the
// player, so walking runs the recovered based-rider MoveActor for a held item
// (Inventory ancestry, no collision, PHYS_None). Before this the first player
// move raised "MoveActor for a non-spawned rider"; now the held item commits
// Location += delta and tracks the player. docs/script-item-pickup.md.
{
  const crowbar=live('WeaponCrowbar1');
  assert.ok(get(crowbar,'Base')===player,'the picked-up crowbar is based on the player');
  const beforePlayer=game.player.position.slice(),beforeItem=get(crowbar,'Location').slice();
  input.driveLegacy({forward:1});input.tick(20);input.driveLegacy({forward:0});
  const dPlayer=game.player.position.map((v,i)=>v-beforePlayer[i]);
  const dItem=get(crowbar,'Location').map((v,i)=>v-beforeItem[i]);
  assert.ok(Math.hypot(...dPlayer)>1,'the player can walk while carrying the crowbar without pausing');
  for(let i=0;i<3;i++)assert.ok(Math.abs(dPlayer[i]-dItem[i])<0.01,`the carried crowbar tracks the player on axis ${i}`);
  assert.equal(game.doors.scriptRuntime.npcFailures.size,0,'walking with a carried item raises no failure');
}

// A frobbed world NanoKey enters the key ring, not the inventory grid.
{
  const nk=live('NanoKey0'),beforeKeys=get(player,'KeyList');
  const result=await input.frob(nk);
  assert.equal(result.ok,true,'NanoKey pickup reports success');
  const keys=get(player,'KeyList');
  assert.ok(keys&&keys!==beforeKeys,'the NanoKey entered the key ring (KeyList)');
}

// The picked-up items stop drawing through the actor mesh scene's own world
// pass — no separate host removal. BecomeItem swapped each Mesh to its POV
// mesh and hid the item, so the world-mesh resource is retired and a hidden
// actor is not admitted again.
scene.update([0,0,0]);
for(const name of ['WeaponCrowbar1','Candybar0']){
  const item=live(name),view=scene.propActors.find(p=>p.actor===item);
  assert.equal(get(item,'bHidden'),true,`${name} is hidden once picked up`);
  assert.ok(!view||view.root.visible===false,`${name} mesh no longer draws once picked up`);
}
// An untouched prop still draws.
assert.equal(scene.propActors.find(p=>p.summary.actor==='CrateBreakableMedGeneral1')?.root.visible,true,
  'an untouched crate still renders');
scene.dispose();

// Player start reloads the map: picked-up serialized items return to the world
// un-owned and back in their Pickup state, and JC's inventory returns to the
// spawned key ring alone. The reload then supports picking the item up again.
const carried=invNames().length;
assert.ok(carried>1,'JC carries the picked-up items before reset');
game.reset();player=game.player.collisionActor;
const crowbar=live('WeaponCrowbar1');
assert.equal(get(crowbar,'Owner'),null,'reset returns the crowbar to the world un-owned');
assert.equal(get(crowbar,'bHidden'),false,'reset makes the crowbar visible again');
assert.equal(stateKey(crowbar),'engine.inventory.pickup','reset restores the crowbar Pickup state');
assert.deepEqual(get(crowbar,'Acceleration'),[0,0,0],'reset restores the authored map acceleration');
const reset=invNames();
assert.equal(reset.length,1,`reset restores JC inventory to one item, got ${reset.join(', ')}`);
assert.match(reset[0],/^NanoKeyRing/,'the one remaining item is the re-spawned key ring');
assert.equal((await input.frob(crowbar)).ok,true,'the crowbar can be picked up again after reset');
assert.ok(get(crowbar,'Owner')===player,'the re-picked crowbar is owned again');

console.log(`item pickup: crowbar/knife/ammo/candybar/hazmat/multitool taken, NanoKey enters the ring, `+
  `picked-up meshes hide, Player start returns items to the world and inventory to the ring.`);
