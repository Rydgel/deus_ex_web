/** Mission00.Timer inventory enforcement through the live Play scheduler.
 *
 * DeusExLevelInfo.SpawnScript spawns the Mission00 actor; its
 * PostPostBeginPlay SetTimer(checkTime, True) fires Mission00.Timer through the
 * shared Actor.Tick scheduler. On the first tick InitStateMachine sets
 * localURL/flags; then Timer removes the player's remaining inventory while
 * MunitionsTrooperReady is true. Verifies: the mission actor is a canonical
 * live actor, a nonempty inventory survives while Ready is false, walking into
 * the authored FlagTrigger sets Ready, the timer then confiscates and destroys
 * the inventory (ownership cleared), and Player start re-spawns a single fresh
 * mission actor. No frobTarget, Ready, timer or participant state is assigned. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import {createGame} from '../src/viewer/game.mjs';

const root=gameDirectory(),files=[];
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
  files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training'),map=decodeMap(asset.bytes);
const game=await createGame(map,asset,assets,{randomSeed:1,presentation:true});
const host=game.doors.scriptRuntime,runtime=host.runtime;
// Player start logs in a new player; re-read it after every reset.
let player=game.player.collisionActor;const level=runtime.levelFor(player);
const get=(o,k)=>runtime.namedReference(o,k).get(),live=n=>level.actors.find(a=>a?.name===n);
const fixture=createPlayerInputFixture(game),idle={};
const tick=(n=1,input=idle)=>{
 const {yaw,pitch,...keys}=input;
 if(yaw!==undefined||pitch!==undefined)fixture.place([...game.player.position],{yaw:yaw??0,pitch:pitch??0,zeroVelocity:false});
 fixture.driveLegacy(keys);fixture.tick(n);
};
const ready=()=>get(player,'flagBase').getBool('MunitionsTrooperReady');
function place(p){game.collision.queries.changeActor(player,()=>{game.player.position=p;game.player.velocity=[0,0,0];});}
function isMissionScript(a){try{for(let c=runtime.instance(a).cls;c;c=c.base)if(c.record.key==='deusex.missionscript')return true;}catch{}return false;}
const missionActors=()=>level.actors.filter(a=>a&&isMissionScript(a));

tick(200);
// The mission actor is spawned through DeusExLevelInfo.SpawnScript, not injected.
const mission=host.liveMission.active();
assert.ok(mission,'DeusExLevelInfo.SpawnScript spawned the Mission00 actor');
assert.equal(runtime.instance(mission).cls.record.key,'deusex.mission00','the spawned actor is Mission00');
assert.ok(level.actors.includes(mission),'the mission actor is a canonical Level.Actors entry');
assert.equal(missionActors().length,1,'exactly one MissionScript actor exists');
assert.equal(ready(),false,'MunitionsTrooperReady starts false');

// A nonempty player inventory (Spawn/GiveTo, as in the instructor fixture).
const dx=await assets.get('DeusEx'),lockpickClass=await runtime.loadClass(dx,dx.exportsByPath.get('lockpick'));
const item=runtime.invokeNative({index:278,receiver:player,argumentCount:1,evaluateArgument:()=>lockpickClass.record});
runtime.processEvent(item,'GiveTo',[player]);
assert.equal(get(player,'Inventory'),item,'the item is in the player inventory');
assert.equal(get(item,'Owner'),player,'the item is owned by the player');

// While Ready is false the timer runs but confiscates nothing (>2 timer cycles).
tick(130);
assert.equal(get(player,'Inventory'),item,'inventory survives while MunitionsTrooperReady is false');
assert.equal(runtime.instance(item).pendingKill,false,'the item is not destroyed while Ready is false');

// Walk into the authored FlagTrigger to set Ready (natural TT_PlayerProximity).
const troop=live('UNATCOTroop3'),v=get(troop,'Location');
place([v[0]-333,v[1]-60,v[2]+40]);tick(40,{...idle,pitch:0});
let entered=0;while(!ready()&&entered++<300)tick(1,{...idle,forward:1,pitch:0});
assert.ok(entered<300,'walking enters the instructor FlagTrigger');
assert.equal(ready(),true,'standing in the FlagTrigger sets MunitionsTrooperReady');

// Standing at the instructor (Ready true, no conversation): the mission timer
// removes and destroys displayable inventory within its next cycle.
// RemoveAllInventory skips items that are not bDisplayableInv and not Ammo,
// so the NanoKeyRing CreateKeyRing spawned stays on the chain.
const ring=get(player,'KeyRing');
let removedAt=-1;for(let i=0;i<130&&removedAt<0;i++){tick(1,{...idle,pitch:0});if(runtime.instance(item).pendingKill)removedAt=i;}
assert.ok(removedAt>=0,'Mission00.Timer removed the displayable inventory while Ready is true');
assert.equal(get(player,'Inventory'),ring,'the non-displayable key ring remains');
assert.equal(runtime.instance(ring).pendingKill,false,'RemoveAllInventory does not destroy the key ring');
assert.equal(runtime.instance(item).pendingKill,true,'the confiscated item is destroyed (DeleteInventory + Destroy)');
assert.equal(get(item,'Owner'),null,'the destroyed item is no longer owned by the player');
assert.equal(host.npcFailures.size,0,'no actor tick failures');

// Player start re-spawns a single fresh mission actor and clears Ready.
game.reset();player=game.player.collisionActor;tick(60);
const fresh=host.liveMission.active();
assert.ok(fresh&&fresh!==mission,'reset re-spawned a fresh mission actor');
assert.equal(missionActors().length,1,'reset leaves exactly one MissionScript actor (SpawnScript dedup)');
assert.equal(ready(),false,'reset clears MunitionsTrooperReady');
assert.equal(host.npcFailures.size,0,'no failures after reset');

console.log(`Mission00 timer passed: canonical SpawnScript actor ticks through the shared scheduler; inventory survives while Ready false, then Mission00.Timer confiscates and destroys it (removed at tick ${removedAt}) once the FlagTrigger sets Ready; Player start re-spawns one fresh mission actor.`);
