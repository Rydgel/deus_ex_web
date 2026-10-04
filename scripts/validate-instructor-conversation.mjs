/** Public Play targeting/use over original conversation bytecode and objects.
 * Research setup repositions the player; it never sets frobTarget, Ready,
 * conversation labels, timers, speech completion or participant state. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createHudRenderer} from '../src/viewer/hud.mjs';
import {plainHudCommands} from '../src/viewer/sim-session.mjs';
import {createTrainingNpcPreview} from '../src/viewer/npc-mesh-preview.mjs';
import {WINDOW_TEXT_OFFSETS} from '../src/runtime/script-window-text.mjs';
import {WINDOW_DESTROY_OFFSETS} from '../src/runtime/script-window-destroy.mjs';
const root=gameDirectory(),files=[];
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
  files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training'),map=decodeMap(asset.bytes),audio=[];
const game=await createGame(map,asset,assets,{randomSeed:1,presentation:true,onConversationSpeech:e=>audio.push(e)});
const host=game.doors.scriptRuntime,runtime=host.runtime;
// Player start logs in a new player; re-read it after every reset.
let player=game.player.collisionActor;const level=runtime.levelFor(player);
const get=(o,k)=>runtime.namedReference(o,k).get(),live=name=>level.actors.find(a=>a?.name===name);
const fixture=createPlayerInputFixture(game),idle={};
const tick=(n=1,input=idle)=>{
 const {yaw,pitch,...keys}=input;
 if(yaw!==undefined||pitch!==undefined)fixture.place([...game.player.position],{yaw:yaw??0,pitch:pitch??0,zeroVelocity:false});
 fixture.driveLegacy(keys);fixture.tick(n);
};
const shell=await host.infoLinkShell(),hud=await createHudRenderer({assets});
// The simulation paints the window tree; the page draws its plain commands.
const render=()=>hud.render({clearDepth(){},render(){}},1000,700,plainHudCommands(game.hud.commands(1000,700,
 {location:game.player.eye,rotation:game.player.viewRotation,fov:75})));
const preview=await createTrainingNpcPreview(runtime,assets,asset,{kernel:null});
assert.equal(preview.summary.errors.length,0,JSON.stringify(preview.summary.errors));
assert.equal(preview.actors.length,18);
const ready=()=>get(player,'flagBase').getBool('MunitionsTrooperReady');
function place(p){game.collision.queries.changeActor(player,()=>{game.player.position=p;game.player.velocity=[0,0,0];});}
function aim(t){const p=get(t,'Location');fixture.releaseAll();fixture.aim(t,{position:[p[0]-80,p[1],p[2]]});
 assert.ok(game.interaction.frobTarget===t,'original HighlightCenterObject selects the instructor');}
const events=[];const call=runtime.callFunction.bind(runtime);
runtime.callFunction=(record,receiver,count,evaluate,context)=>{
 if(record?.key.startsWith('deusex.conplaybase.setupevent'))events.push(record.key.split('.').at(-1));
 return call(record,receiver,count,evaluate,context);
};
function start(t,name){
 aim(t);assert.equal(game.use().ok,true);
 const p=get(player,'conPlay');assert.ok(p);assert.equal(get(get(p,'con'),'conName'),name);
 assert.equal(get(p,'startActor'),t);assert.equal(get(p,'player'),player);
 assert.equal(game.interaction.stateName,'PlayerWalking'); // authored first-person/non-interactive path
 tick();render();preview.update(game.player.eye);
 return {p,window:get(p,'conWinFirst')};
}
function finish({p,window}){
 let frames=0;while(get(player,'conPlay')&&frames++<1000){tick();render();}
 assert.ok(frames<1000,'original Timer/Sleep/End terminates');
 assert.equal(get(player,'conPlay'),null);assert.equal(runtime.instance(p).pendingKill,true);
 assert.equal(shell.isDestroyed(window),true);assert.equal(game.interaction.stateName,'PlayerWalking');
 assert.equal(host.npcFailures.size,0);
 return frames;
}
tick(200);
for(const name of ['UNATCOTroop3','UNATCOTroop0']){
 const t=live(name),bound=[];
 for(let item=get(t,'ConListItems');item;item=get(item,'next'))bound.push(get(get(item,'con'),'conName'));
 assert.deepEqual(bound,['MunitionsTrooperFrob','MunitionsTrooperTake']);
 const flow=start(t,'MunitionsTrooperFrob');
 assert.equal(audio.filter(e=>e.kind==='speech').at(-1).emitter,t);
 assert.equal(audio.filter(e=>e.kind==='speech').at(-1).audio.soundId,name.endsWith('3')?19:20);
 finish(flow);
}
// Fresh reset is directly observable, with no post-reset mutation.
game.reset();player=game.player.collisionActor;assert.equal(ready(),false);assert.equal(get(player,'conHistory'),null);
const frob=host.faceConversations.conversations.find(c=>c.conName==='MunitionsTrooperFrob').conversation;
assert.equal(get(get(frob,'eventList'),'cycleIndex'),0);tick(200);
const troop=live('UNATCOTroop3'),position=get(troop,'Location');
// Original Spawn/GiveTo creates a nonempty player inventory fixture.
const dx=await assets.get('DeusEx'),lockpickClass=await runtime.loadClass(dx,dx.exportsByPath.get('lockpick'));
const heldItem=runtime.invokeNative({index:278,receiver:player,argumentCount:1,evaluateArgument:()=>lockpickClass.record});
runtime.processEvent(heldItem,'GiveTo',[player]);
assert.equal(get(heldItem,'Owner'),player);assert.equal(get(player,'Inventory'),heldItem);
place([position[0]-333,position[1]-60,position[2]+40]);tick(40,{...idle,pitch:0});
assert.equal(ready(),false);
let entered=0;while(!ready()&&entered++<300)tick(1,{...idle,forward:1,pitch:0});
assert.ok(entered<300,'walking enters the authored FlagTrigger');
const before=events.length,take=start(troop,'MunitionsTrooperTake');
assert.equal(ready(),false,'authored SetFlag clears Ready');
assert.equal(events.slice(before).filter(e=>e==='setupeventtransferobject').length,29);
assert.ok(events.slice(before).includes('setupeventjump'));
assert.ok(get(troop,'Inventory'),'original transfers populate recipient inventory');
finish(take);
assert.equal(get(player,'Inventory'),get(player,'KeyRing'),'the non-transferred key ring stays');
assert.equal(get(heldItem,'Owner'),troop);
// This research-created fixture was outside the Play spawn scheduler.
runtime.destroyActor(heldItem);
// Allow the original participant state to finish returning to idle.
tick(70);
// Repeat while still inside: Frob again, original first greeting after reset.
const fresh=start(troop,'MunitionsTrooperFrob');
assert.equal(audio.filter(e=>e.kind==='speech').at(-1).audio.soundId,19);
const activeAudio=audio.at(-1);assert.equal(activeAudio.kind,'speech');
game.reset();player=game.player.collisionActor;assert.equal(get(player,'conPlay'),null);assert.equal(get(player,'conHistory'),null);
assert.equal(shell.isDestroyed(fresh.window),true);assert.equal(audio.at(-1).kind,'stop');
assert.equal(ready(),false);assert.equal(get(get(frob,'eventList'),'cycleIndex'),0);
tick(200);finish(start(live('UNATCOTroop3'),'MunitionsTrooperFrob'));
assert.equal(host.npcFailures.size,0);

// Subtitle presentation. ConPlay.SetupEventSpeechPost shows the first-person
// panel when player.bSubtitles is on and hides it (speech audio still plays)
// when off. Read the live original HUDConWindowFirst tree so a hidden or empty
// panel cannot pass as subtitle rendering.
const T=WINDOW_TEXT_OFFSETS,Wo=WINDOW_DESTROY_OFFSETS;
function panel(){
 const play=get(player,'conPlay');if(!play)return null;
 const win=get(play,'conWinFirst');if(!win||shell.isDestroyed(win))return null;
 const tile=get(win,'lowerConWindow'),texts=[];
 for(let c=shell.readNative(tile,Wo.firstChild,'ptr');c;c=shell.readNative(c,Wo.nextSibling,'ptr'))
  if(runtime.instance(c).cls.record.key==='extension.textwindow')texts.push(shell.readNative(c,T.text,'string'));
 return {visible:Boolean(shell.readNative(win,Wo.windowFlags,'u32')&1),texts};
}
function greet(subtitlesOn){ // fresh reset, set preference, drive one greeting; snapshot at first speech
 game.reset();player=game.player.collisionActor;assert.equal(ready(),false);
 game.subtitles=subtitlesOn;assert.equal(game.subtitles,subtitlesOn);
 tick(200); // let the instructor reach its idle/standing state (bCanConverse)
 const before=audio.length; // before the first tick so start()'s own tick is covered
 const flow=start(live('UNATCOTroop3'),'MunitionsTrooperFrob');
 const spoke=()=>audio.slice(before).some(e=>e.kind==='speech');
 let snap=spoke()?panel():null;
 for(let i=0;i<200&&!snap&&get(player,'conPlay');i++){tick();render();if(spoke())snap=panel();}
 return {flow,snap,spoke:spoke()};
}
const troopName=get(live('UNATCOTroop3'),'UnfamiliarName');
assert.ok(troopName.length>0,'the instructor has a non-empty display name');
// The player viewport listener resolves the speaker name — an unset one made it "".
assert.ok(get(player,'Player'),'PlayerPawn.Player (viewport listener) is bound');

// Disabled (the class default): the panel stays hidden while speech plays.
const off=greet(false);
assert.ok(off.spoke,'speech plays with subtitles off');
assert.ok(off.snap,'conWinFirst exists with subtitles off');
assert.equal(off.snap.visible,false,'subtitles off hides the panel (original Hide branch)');
finish(off.flow);

// Enabled through the same DeusExPlayer.bSubtitles preference the viewer toggle drives.
const on=greet(true);
assert.ok(on.snap&&on.snap.visible,'subtitles on shows the panel');
assert.equal(on.snap.texts[0],troopName,'name window shows the original speaker display name');
assert.ok(on.snap.texts.slice(1).some(t=>typeof t==='string'&&t.length>0),
  'a speech line is rendered, not an empty panel');
assert.ok(audio.filter(e=>e.kind==='speech').at(-1),'original speech still plays with subtitles on');
finish(on.flow);

// Toggling the preference back off hides the panel again (on/off semantics).
const back=greet(false);
assert.ok(back.snap,'conWinFirst exists after toggling subtitles off');
assert.equal(back.snap.visible,false,'toggling subtitles off hides the panel again');
finish(back.flow);
assert.equal(host.npcFailures.size,0);hud.dispose();preview.dispose();
console.log('Instructor Play flow passed: both owners, Frob/Take, natural FlagTrigger, 29 transfers, original speech/history/timing, visible guard materials, repeat and active reset. Subtitles: hidden-by-default panel, enabled panel with original speaker name "'+troopName+'" and speech text, and toggle-off hiding — all with speech playing.');
