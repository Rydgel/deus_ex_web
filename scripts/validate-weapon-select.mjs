/** Public Play weapon selection over the original PutInHand path. After a world
 * weapon is frobbed into JC's inventory (validate-item-pickup.mjs), selecting it
 * runs DeusExPlayer.PutInHand -> UpdateInHand -> SwitchWeapon -> ChangedWeapon ->
 * Weapon.RaiseUp -> BringUp -> PlaySelect, drawing the weapon's first-person
 * (player-view) mesh. Research placement moves the player next to the crowbar and
 * sets the frob target; selection is the original bytecode. Nothing forces
 * inHand/Weapon/mesh state. docs/script-weapon-equip.md. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createGame} from '../src/viewer/game.mjs';

const root=gameDirectory(),files=[];
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
  files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor,level=runtime.levelFor(player);
const get=(o,k)=>runtime.namedReference(o,k).get();
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

// Before selection nothing is in hand, and the crowbar carries its own belt
// Icon so the HUD has real art to draw once it is selected.
assert.equal(get(player,'inHand'),null,'nothing is in hand before selection');
assert.equal(get(crowbar,'InventoryGroup'),10,'the crowbar is in weapon group 10');
assert.ok(get(crowbar,'Icon')?.key,'the crowbar has an original belt Icon');

// A number key resolves the weapon by its InventoryGroup through the original
// Inventory.WeaponChange walk, then selects it via PutInHand/UpdateInHand.
const selected=await game.selectWeaponGroup(10);
assert.equal(selected.ok,true,`group-10 selection puts the crowbar in hand: ${JSON.stringify(selected)}`);
assert.equal(selected.name,'WeaponCrowbar1','group 10 resolves the crowbar');

// The original bytecode ran end to end: the crowbar is in hand, the selected
// item, the drawn weapon, and its state advanced to the DeusExWeapon Active state.
assert.equal(get(player,'inHand'),crowbar,'inHand is the crowbar');
assert.equal(get(player,'SelectedItem'),crowbar,'SelectedItem is the crowbar');
assert.equal(get(player,'Weapon'),crowbar,'the crowbar is the drawn Weapon');
assert.equal(get(player,'PendingWeapon'),null,'the weapon switch completed (no PendingWeapon)');
assert.equal(stateKey(crowbar),'deusex.deusexweapon.active','the crowbar advanced to its Active state');

// The bring-up drew the player-view mesh: its LodMesh resource is now decoded,
// so the synchronous PlayAnim('Select') boundary that the pickup path left
// unprepared no longer throws.
const meshRef=get(crowbar,'Mesh');
assert.equal(meshRef.key,'deusexitems.crowbar','the in-hand crowbar draws its player-view mesh');
assert.equal(runtime.meshResource(meshRef).payloadStatus,'decoded-lodmesh',
  'the crowbar player-view mesh resource is prepared');

// Walking while carrying the equipped crowbar runs the based-rider MoveActor
// for a held item (Inventory ancestry, no collision, PHYS_None): before this,
// the picked-up item as a based rider raised "MoveActor for a non-spawned
// rider". The recovered light body commits Location += delta and the item
// tracks the player. (The world crowbar and the player start ~48u apart in x.)
const beforeWalk=game.player.position.slice();
const crowbarBefore=get(crowbar,'Location').slice();
for(let i=0;i<20;i++)game.tick(1/60,{forward:1,right:0,yaw:game.player.yaw,pitch:0,jump:false,crouch:false,walk:false});
const playerDelta=game.player.position.map((v,i)=>v-beforeWalk[i]);
assert.ok(Math.hypot(...playerDelta)>1,`the player walks while carrying the crowbar (moved ${Math.hypot(...playerDelta).toFixed(1)}u)`);
assert.ok(crowbarBefore.some((v,i)=>v!==get(crowbar,'Location')[i]),'the drawn crowbar moved with its owner');
// Actor.Tick's pawn tail FarMoveActor(Weapon, Location, 0, 0) places the drawn
// weapon at its owner's Location after every player tick (the based-rider
// MoveActor carries it during the move itself).
for(let i=0;i<3;i++)assert.equal(get(crowbar,'Location')[i],Math.fround(game.player.position[i]),
  `the drawn crowbar sits at the player's Location on axis ${i}`);
assert.equal(game.doors.scriptRuntime.npcFailures.size,0,'no actor failures while walking with the weapon');

// selectItem toggles: re-selecting the in-hand item requests it be put away.
// A weapon in its Active state needs the per-frame UpdateInHand tick to finish
// the put-away animation (Active -> DownWeapon -> Weapon None), so inHand only
// clears across later frames; the pending target flips immediately. Assert the
// request was honored (inHandPending cleared), not that the weapon vanished in
// one call. The native HUD integration test checks the per-frame drive-down.
await game.selectItem(crowbar);
assert.equal(get(player,'inHandPending'),null,'re-selecting the in-hand crowbar requests it be put away');
assert.equal(get(player,'inHand'),crowbar,'the crowbar stays drawn until the put-away animation ticks down');

// No startup or tick failures were introduced.
assert.equal(game.doors.scriptRuntime.npcFailures.size,0,'no actor failures after selection');

// The legacy nanokey ring research helper still works through the shared path.
game.reset();
assert.equal(game.selectNanoKeyRing(),true,'the nanokey ring still selects into hand after reset');

console.log('weapon select: crowbar picked up, group-10 selection draws it through PutInHand -> '+
  'SwitchWeapon -> BringUp -> PlaySelect, player-view mesh prepared, Active state reached, '+
  'toggle-away requested, nanokey ring unaffected.');
