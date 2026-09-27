/** Original fresh-mission setup -> unconscious body -> search/key/carry/drop.
 * Evidence: docs/script-training-mission-entry.md. Placement isolates this
 * exercise; no flags, health, corpse, key or door state are injected. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createActorMeshScene} from '../src/viewer/npc-mesh-preview.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const root=gameDirectory(),files=[];
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
 files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const host=game.doors.scriptRuntime,runtime=host.runtime;
let player=game.player.collisionActor;
const level=runtime.levelFor(player),get=(actor,name)=>runtime.readNamed(actor,name);
const cadet=level.actors.find(actor=>actor?.name==='UNATCOTroop2');
const bodies=()=>level.actors.filter(actor=>actor?.lineage?.includes('deusex.deusexcarcass')&&
 get(actor,'CarcassName')===cadet.name);
const fixture=createPlayerInputFixture(game);
// Explicit angles here are fixture setup; all action edges use public input.
const tick=(frames,input={})=>{
 const {yaw,pitch,...keys}=input;
 if(yaw!==undefined||pitch!==undefined)fixture.place([...game.player.position],{yaw:yaw??0,pitch:pitch??0,zeroVelocity:false});
 fixture.driveLegacy(keys);fixture.tick(frames);
};
const place=position=>game.collision.queries.changeActor(player,()=>{
 game.player.position=position;game.player.velocity=[0,0,0];
});
function aim(actor,position){
 fixture.aim(actor,{position});
 assert.ok(game.interaction.frobTarget===actor,`original trace selects ${actor.name}`);
}

assert.equal(get(cadet,'Health'),100,'the map loads its authored living pawn');
const flags=get(player,'FlagBase');
assert.equal(flags.getEntry('PlayerTraveling').value,true);
assert.equal(flags.getEntry('PlayerTraveling').expiration,0,'fresh-entry marker never expires');
const key=get(cadet,'Inventory');
assert.equal(get(key,'KeyID'),'Body_Search_Room','original distributor gave the cadet the key');
assert.equal(bodies().length,0,'the host does not pre-create a replacement body');
tick(300);
assert.equal(flags.getEntry('PlayerTraveling'),null,'original FirstFrame consumed the marker');
assert.equal(flags.calls.filter(call=>call.method==='DeleteFlag'&&call.name==='PlayerTraveling').length,1);
assert.ok(!level.actors.includes(cadet),'original Dying/SpawnCarcass/Destroy retired the cadet');
assert.equal(get(cadet,'bStunned'),true);
assert.equal(bodies().length,1);
const body=bodies()[0];
assert.equal(get(body,'bNotDead'),true,'this is an unconscious person');
assert.equal(get(body,'ItemName'),get(body,'msgNotDead'));
assert.ok(get(body,'Inventory')===key,'the same distributed key moved to the body');
assert.ok(get(key,'Owner')===body);
assert.equal(get(player,'SkillPointsTotal'),0);
assert.equal(get(player,'SkillPointsAvail'),0);
const meshes=await createActorMeshScene(runtime,assets,asset,{player});
const previewFor=actor=>meshes.actors.find(preview=>preview.actor===actor);
meshes.update();
assert.ok(previewFor(body)?.root.visible,'the original carcass mesh is visible');
assert.equal(previewFor(cadet),undefined,'the standing pawn is no longer drawn');

const bodyPos=get(body,'Location');
const besideBody=[bodyPos[0]-44,bodyPos[1],-128+43+0.2];
aim(body,besideBody);
assert.equal(game.use().ok,true);
assert.equal(get(body,'Inventory'),null,'search removed the key from the body');
assert.equal(get(get(player,'KeyList'),'KeyID'),'Body_Search_Room');
assert.equal(get(get(player,'KeyList'),'Description'),'Medical Room');

// The collected key operates the original locked medical-room mover.
assert.equal((await game.activateBelt(0)).ok,true);
tick(30);
assert.ok(get(player,'inHand')===get(player,'KeyRing'));
const door=level.actors.find(actor=>actor?.name==='DeusExMover50'),doorPos=get(door,'Location');
assert.equal(get(door,'KeyIDNeeded'),'Body_Search_Room');
assert.equal(get(door,'bLocked'),true);
aim(door,[doorPos[0],doorPos[1]+68,-128+43+0.2]);
game.pressFire();game.releaseFire();
assert.equal(get(door,'bLocked'),false,'public key use unlocks the medical room');
assert.equal(game.use().ok,true);
tick(150);
assert.equal(game.collision.movers.find(mover=>mover.name===door.name).interpolation.key,1);
game.inputKey('Backspace',true);game.inputKey('Backspace',false);tick(30);
assert.equal(get(player,'inHand'),null,'put the key ring away before carrying the cadet');

aim(body,besideBody);
assert.equal(game.use().ok,true);tick(60);
const carried=get(player,'inHand');
assert.equal(runtime.instance(carried).cls.record.key,'deusex.povcorpse');
assert.equal(get(carried,'bNotDead'),true);
assert.equal(get(carried,'carcClassString'),'DeusEx.UNATCOTroopCarcass',
 'original ObjectToString preserves the class package for dropping');
assert.ok(!level.actors.includes(body));
const table=level.actors.find(actor=>actor?.name==='Trigger0'),tablePos=get(table,'Location');
const exitDoors=level.actors.filter(actor=>actor?.lineage?.includes('deusex.deusexmover')&&
 get(actor,'Tag')==='bodydoorsopen');
assert.equal(exitDoors.length,2);
place([tablePos[0],tablePos[1]+100,-128+43+0.2]);
tick(5,{yaw:-Math.PI/2,pitch:0});
game.inputKey('Tab',true);game.inputKey('Tab',false);
tick(180,{yaw:-Math.PI/2,pitch:0});
assert.equal(get(player,'inHand'),null,'installed Tab/DropItem binding drops the body');
assert.equal(bodies().length,1);
assert.notEqual(bodies()[0].name,body.name,'original DropItem respawns the carcass class');
assert.equal(get(bodies()[0],'bNotDead'),true);
assert.ok(exitDoors.every(door=>get(door,'KeyNum')===1),
 'the dropped Carcass triggers the authored medical-table exit doors');
meshes.update();await meshes.ready();meshes.update();
assert.ok(previewFor(bodies()[0])?.root.visible);
assert.equal(host.npcFailures.size,0);

game.reset();player=game.player.collisionActor;
assert.ok(level.actors.includes(cadet));
assert.equal(get(cadet,'Health'),100);
assert.equal(get(player,'KeyList'),null);
assert.equal(bodies().length,0);
assert.equal(get(player,'FlagBase').getBool('PlayerTraveling'),true);
tick(300);
assert.equal(bodies().length,1,'reset repeats original mission setup once');
assert.equal(get(bodies()[0],'bNotDead'),true);
assert.equal(get(get(bodies()[0],'Inventory'),'KeyID'),'Body_Search_Room');
assert.equal(host.npcFailures.size,0);
meshes.dispose();
console.log('Training cadet passed: original FirstFrame knockout, same distributed key, visible unconscious body, public search/key unlock/carry/drop, medical-table trigger and reset.');
