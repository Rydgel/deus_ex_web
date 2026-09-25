/** Bounded original-bytecode-to-live-HUD and original-font-page checks. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createHudText} from '../src/viewer/hud-text.mjs';
import {gameDirectory} from './game-directory.mjs';
const root=gameDirectory(),files=[];
for(const d of ['System','Textures','Maps','Sounds','Music'])for(const n of await readdir(path.join(root,d)))
 files.push({path:`${d}/${n}`,read:()=>readFile(path.join(root,d,n))});
const assets=new AssetStore(files),a=await assets.get('00_Training');
const game=await createGame(decodeMap(a.bytes),a,assets,{randomSeed:1,presentation:true});
const {hud}=game,runtime=game.doors.scriptRuntime.runtime;
// Player start logs in a new player; re-read it after every reset.
let player=game.player.collisionActor;
const commands=hud.commands(960,600,{location:game.player.eye,rotation:game.player.viewRotation,fov:75});
assert.ok(commands.length>50,'Original native tree emits HUD tiles and glyphs');
assert.equal(hud.root,runtime.namedReference(player,'rootWindow').get());
assert.equal(hud.hud,(await game.doors.scriptRuntime.infoLinkShell()).hud);
assert.equal(hud.read(hud.read(hud.hud,'belt'),'objects').length,10);
assert.equal(hud.snapshot().belt[0],runtime.namedReference(player,'KeyRing').get().name);
assert.deepEqual(hud.rect(hud.hit),{x:0,y:0,width:84,height:106});
assert.deepEqual(hud.rect(hud.compass),{x:0,y:110,width:73,height:40});
assert.equal(hud.read(hud.read(hud.read(hud.hud,'activeItems'),'winAugsContainer'),'iconCount'),1);
assert.deepEqual(hud.decorationCommands(hud.hit).map(c=>[c.x,c.y,c.width,c.height,c.style]),[[11,11,60,76,3],[0,0,84,106,3]]);
for(let i=0;i<130;i++)hud.tick(1/120);
for(const part of Object.values(hud.snapshot().health))assert.deepEqual(part,{health:100,displayedHealth:100,color:[0,255,0]});
// Feed the shared live fields (no duplicate health model). Original SetHitColor
// supplies the white damage flash and the native VM's float/int/byte conversions.
runtime.namedReference(player,'HealthLegLeft').set(30);hud.tick(1/120);
assert.deepEqual(hud.snapshot().health.legLeft,{health:30,displayedHealth:30,color:[255,255,255]});
for(let i=0;i<50;i++)hud.tick(1/120);
assert.deepEqual(hud.snapshot().health.legLeft.color,[255,170,0]);
runtime.namedReference(player,'Energy').set(25);hud.tick(1/120);
assert.equal(hud.snapshot().energy,25);assert.equal(hud.read(hud.read(hud.hit,'winEnergy'),'barSize'),13);
const rotation=runtime.namedReference(player,'Rotation');rotation.set([0,16384,0]);hud.tick(1/120);
assert.equal(hud.snapshot().compass.yaw,16384);
assert.equal(hud.read(hud.compass,'UnitsPerPixel'),Math.fround(65536/240));
assert.equal(hud.snapshot().compass.drawPos,-32);assert.equal(hud.snapshot().compass.wrapPos,208);
// Source-owned frob projection, AddInventory -> belt, ActivateBelt -> weapon,
// and ammo read the same player/items as gameplay. No fire state is driven here.
const level=runtime.levelFor(player),crowbar=level.actors.find(actor=>actor?.name==='WeaponCrowbar1');
const at=runtime.namedReference(crowbar,'Location').get();
game.collision.queries.changeActor(player,()=>{game.player.position=[at[0]-48,at[1],at[2]];game.player.velocity=[0,0,0];});
runtime.namedReference(player,'FrobTarget').set(crowbar);
const view={location:game.player.eye,rotation:[0,0,0],fov:75};
console.log('HUD integration: frob draw');
const frobCommands=hud.commands(960,600,view);
assert.ok(frobCommands.filter(c=>c.texture.name==='Solid').length>=16,'Original frob DrawBox emits shadow and foreground corners');
assert.ok(frobCommands.every(c=>['x','y','width','height'].every(k=>Number.isFinite(c[k]))));
console.log('HUD integration: pickup');
game.interaction.frobTarget=crowbar;assert.equal(game.use().ok,true);
const slots=hud.read(hud.read(hud.hud,'belt'),'objects');
const slot=slots.findIndex(window=>hud.read(window,'item')===crowbar);
assert.equal(slot,1,'First eligible pickup enters original free belt slot1');
console.log('HUD integration: activate',slot);
assert.equal((await game.activateBelt(slot)).ok,true);
console.log('HUD integration: tick equip');
for(let i=0;i<40;i++)game.tick(1/60,{forward:0,right:0,yaw:game.player.yaw,pitch:0,jump:false,crouch:false,walk:false});
assert.ok(runtime.namedReference(player,'Weapon').get()===crowbar,'Belt-selected crowbar is the live Weapon');
hud.commands(960,600,view);assert.ok(hud.read(hud.read(hud.hud,'ammo'),'weapon')===crowbar,'Ammo widget reads live weapon');
await game.activateBelt(slot);
for(let i=0;i<40;i++)game.tick(1/60,{forward:0,right:0,yaw:game.player.yaw,pitch:0,jump:false,crouch:false,walk:false});
assert.ok(runtime.namedReference(player,'Weapon').get()===crowbar,'Original same-slot selection keeps the weapon in hand');
assert.equal((await game.activateBelt(2)).ok,false,'The next original belt slot is empty');
for(let i=0;i<40;i++)game.tick(1/60,{forward:0,right:0,yaw:game.player.yaw,pitch:0,jump:false,crouch:false,walk:false});
assert.ok(runtime.namedReference(player,'Weapon').get()===null,'Empty belt slot puts the weapon away under the scheduler');
console.log('HUD integration: log');
runtime.dispatchSpawnedEvent(player,'ClientMessage',['Native HUD log check','',false]);
const log=hud.read(hud.read(hud.hud,'msgLog'),'winLog');
assert.ok(hud.host.raw.read(log,0x17c,'i32')>0,'Original ClientMessage enters native TextLog rows');
game.reset();player=game.player.collisionActor;hud.tick(1/120);assert.equal(hud.snapshot().health.legLeft.health,100);assert.equal(hud.snapshot().energy,100);
const text=await createHudText(assets,['DeusExUI.FontTiny','DeusExUI.FontMenuHeaders_DS','DeusExUI.FontFixedWidthSmall_DS']);
const glyphs=[];text.draw(c=>glyphs.push(c),{font:'DeusExUI.FontMenuHeaders_DS',text:'Jaime Reyes',x:94,y:15,width:293,height:15,vAlign:1});
assert.equal(glyphs.length,11);assert.equal(glyphs[0].image.key,'DeusExUI.FontMenuHeaders_DS.Texture17');
assert.deepEqual([glyphs[0].x,glyphs[0].y,glyphs[0].width,glyphs[0].height],[94,17,7,11]);
assert.ok(glyphs.every(c=>c.x>=94&&c.x+c.width<=387&&c.y>=15&&c.y+c.height<=30));
// DataLinkPlay.StartConversation -> DeusExHUD.CreateInfoLinkWindow hides a
// visible msgLog; a message during the InfoLink waits (HUDLogDisplay.AddLog)
// rather than laying the display out below the log.
assert.equal((await game.doors.scriptRuntime.infoLinkShell()).object,null,'No InfoLink display exists before a DataLink');
runtime.dispatchSpawnedEvent(player,'ClientMessage',['Log before InfoLink','',false]);
const msgLog=hud.read(hud.hud,'msgLog');assert.equal(hud.visible(msgLog),true);
const walk={forward:1,right:0,yaw:game.player.yaw,pitch:0,jump:false,crouch:false,walk:false};
for(let i=0;i<240&&!game.doors.scriptRuntime.dataLinkActive();i++)game.tick(1/120,walk);
const shell=await game.doors.scriptRuntime.infoLinkShell();
assert.ok(shell.object,'Walking into DL_Start constructs the InfoLink display');
assert.equal(hud.read(hud.hud,'infolink'),shell.object);
assert.equal(hud.visible(msgLog),false,'Original CreateInfoLinkWindow hides the message log');
runtime.dispatchSpawnedEvent(player,'ClientMessage',['Log during InfoLink','',false]);
assert.equal(hud.visible(msgLog),false,'A message during the InfoLink waits');
assert.equal(hud.read(msgLog,'bMessagesWaiting'),true);
hud.commands(960,600,view);
assert.deepEqual(hud.decorationCommands(shell.object).map(c=>[c.x,c.width,c.height]),[[0,256,114],[256,175,114],[0,256,114],[256,175,114]]);
console.log('Play HUD passed: original Init/Tick/Draw, shared root, key ring/belt, pickup/equip/put-away, ammo, AugLight, frob, log, health/energy/compass, reset, CreateInfoLinkWindow log hiding, InfoLink crops and bitmap-font glyphs.');
