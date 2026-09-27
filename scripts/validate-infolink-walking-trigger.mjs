/** Verify normal Training movement reaches the authored DL_Start trigger. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))files.push({
    path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`),
  });
const assets=new AssetStore(files),mapAsset=await assets.get('00_Training');
const events=[];
let game;
game=await createGame(decodeMap(mapAsset.bytes),mapAsset,assets,{randomSeed:1,
  onDataLinkTransmission:event=>events.push({...event,position:[...game.player.position]})});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor;
const trigger=runtime.levelFor(player).actors.find(actor=>actor?.name==='DataLinkTrigger23');
assert.ok(trigger);assert.equal(trigger.values.datalinkTag,'dl_start');
assert.deepEqual(trigger.values.Location,[-811.6166381835938,832.4313354492188,-75.06744384765625]);
assert.equal(trigger.values.CollisionRadius,300);assert.equal(trigger.values.CollisionHeight,20);
assert.equal(events.length,0);
const fixture=createPlayerInputFixture(game,{tickSeconds:1/120});
const input={forward:1},neutral={};
const tick=input=>{fixture.driveLegacy(input);fixture.tick();};
let frames=0;
while(!events.length&&frames++<240)tick(input);
assert.equal(events.length,1,'walking forward from PlayerStart enters DataLinkTrigger23');
assert.equal(events[0].kind,'started');
assert.equal(events[0].tag,'dl_start');assert.equal(events[0].trigger,trigger);
assert.equal(events[0].player,player);
assert.deepEqual(events[0].position,[-1133.0380859375,825.8439331054688,-80.19999694824219]);
const play=runtime.namedReference(player,'dataLinkPlay').get();
assert.ok(play,'the original player call spawned DataLinkPlay');
assert.equal(runtime.namedReference(play,'con').get()?.name,'Conversation57');
assert.equal(runtime.namedReference(play,'datalinkTrigger').get(),trigger);
assert.equal(runtime.namedReference(trigger,'bStartedViaTouch').get(),true,
  'the true transmission result lets original DataLinkTrigger.Touch retain its success state');
const rootWindow=runtime.namedReference(player,'rootWindow').get();
const hud=runtime.namedReference(rootWindow,'hud').get();
const firstShell=await game.doors.scriptRuntime.infoLinkShell();
assert.equal(firstShell.object,runtime.namedReference(play,'dataLink').get());
assert.equal(runtime.namedReference(hud,'infoLink').get(),runtime.namedReference(play,'dataLink').get(),
  'the spawned play object publishes the constructed InfoLink on the HUD graph');
for(let index=0;index<120;index++)tick(input);
assert.equal(events.length,1,'remaining inside the trigger does not retrigger presentation');
for(let index=0;index<1500;index++)tick(neutral);
assert.deepEqual(events.map(event=>event.kind),['started','speech','ending','destroyed']);
assert.equal(runtime.namedReference(player,'dataLinkPlay').get(),null);
assert.equal(runtime.namedReference(hud,'infoLink').get(),null);
assert.equal(firstShell.isDestroyed(firstShell.object),true,
  'the original DeusExHUD destroy path removes the completed InfoLink window');
for(const object of Object.values(firstShell.objects))assert.equal(firstShell.isDestroyed(object),true,
  `${object.name} follows the recursive native window destruction path`);
assert.equal(runtime.namedReference(play,'bDeleteMe').get(),true);
assert.equal(runtime.levelFor(player).actors.includes(play),false);
assert.equal(runtime.namedReference(trigger,'bCollideActors').get(),false);
assert.equal(trigger.collideActors,false);
assert.equal(game.doors.scriptRuntime.triggerActions.flagBase.getEntry('DL_Start_Played')?.value,true);
assert.equal(game.doors.scriptRuntime.dataLinkPresentation().phase,'destroyed');
// A later route starting after a normal finish (not queued) runs
// DataLinkPlay.StartConversation's DeusExHUD.CreateInfoLinkWindow again: a new
// display, published on the HUD, destroyed through the same end path.
const doorTrigger=runtime.levelFor(player).actors.find(actor=>actor?.name==='DataLinkTrigger24');
assert.equal(doorTrigger?.values.datalinkTag,'dl_door');
frames=0;
while(events.length===4&&frames++<480)tick(input);
assert.equal(events.at(-1)?.kind,'started','walking on enters DataLinkTrigger24 after DL_Start finished');
assert.equal(events.at(-1).tag,'dl_door');
const doorShell=await game.doors.scriptRuntime.infoLinkShell();
assert.notEqual(doorShell.object,firstShell.object,'a fresh route constructs its own HUDInfoLinkDisplay');
assert.equal(doorShell.isDestroyed(doorShell.object),false);
assert.equal(runtime.namedReference(hud,'infoLink').get(),doorShell.object);
assert.equal(runtime.namedReference(runtime.namedReference(player,'dataLinkPlay').get(),'dataLink').get(),doorShell.object);
for(let index=0;index<1500&&events.at(-1).kind!=='destroyed';index++)tick(neutral);
assert.deepEqual(events.slice(4).map(event=>event.kind),['started','speech','ending','destroyed']);
assert.equal(doorShell.isDestroyed(doorShell.object),true);
assert.equal(runtime.namedReference(hud,'infoLink').get(),null);
const firstEventCount=events.length;
game.reset();
const resetShell=await game.doors.scriptRuntime.infoLinkShell();
assert.equal(resetShell.object,null,'a reset session has no InfoLink display before its first DataLink');
assert.equal(runtime.namedReference(hud,'infoLink').get(),null);
assert.notEqual(resetShell.root,firstShell.root);assert.notEqual(resetShell.hud,firstShell.hud);
assert.equal(game.doors.scriptRuntime.triggerActions.flagBase.getEntry('DL_Start_Played'),null,
  'reset begins a fresh Training session with no played DataLink flag');
assert.equal(runtime.namedReference(trigger,'bCollideActors').get(),true);
assert.equal(trigger.collideActors,true);
frames=0;
while(events.length===firstEventCount&&frames++<240)tick(input);
assert.equal(events.length,firstEventCount+1,'reset permits the authored one-shot trigger in the new session');
assert.equal(events.at(-1).kind,'started');
// The reload destroyed the old player (LoadMap's viewport dissociation) and
// its collection released it; the new session belongs to the new Login.
assert.notEqual(game.player.collisionActor,player,'Player start logs a new player in');
assert.throws(()=>runtime.instance(player),/released/,'the retired player was released by the reload');
assert.notEqual(runtime.namedReference(game.player.collisionActor,'dataLinkPlay').get(),play,
  'the new session spawns a fresh DataLinkPlay object');
const sessionShell=await game.doors.scriptRuntime.infoLinkShell();
assert.ok(sessionShell.object&&![firstShell.object,doorShell.object].includes(sessionShell.object),
  'the new session constructs a fresh display at its first DataLink start');
console.log(`Live InfoLink lifecycle passed: normal movement entered DataLinkTrigger23 after ${frames} fixed frames, `+
  'spawned DataLinkPlay, published its HUD child, ran start/speech/end states, set DL_Start_Played, '+
  'called DatalinkFinished, disabled the one-shot trigger, recursively destroyed the HUD child, removed the play actor; '+
  'a later unqueued DL_Door constructed and destroyed its own display, and reset left no display until the next DataLink start.');
