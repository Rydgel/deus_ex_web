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
const {hud}=game,runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor;
assert.deepEqual(hud.rect(hud.hit),{x:0,y:0,width:84,height:106});
assert.deepEqual(hud.rect(hud.compass),{x:0,y:110,width:73,height:40});
assert.equal(hud.windows.length,15);
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
game.reset();hud.tick(1/120);assert.equal(hud.snapshot().health.legLeft.health,100);assert.equal(hud.snapshot().energy,100);
const text=await createHudText(assets,['DeusExUI.FontTiny','DeusExUI.FontMenuHeaders_DS','DeusExUI.FontFixedWidthSmall_DS']);
const glyphs=[];text.draw(c=>glyphs.push(c),{font:'DeusExUI.FontMenuHeaders_DS',text:'Jaime Reyes',x:94,y:15,width:293,height:15,vAlign:1});
assert.equal(glyphs.length,11);assert.equal(glyphs[0].image.key,'DeusExUI.FontMenuHeaders_DS.Texture17');
assert.deepEqual([glyphs[0].x,glyphs[0].y,glyphs[0].width,glyphs[0].height],[94,17,7,11]);
assert.ok(glyphs.every(c=>c.x>=94&&c.x+c.width<=387&&c.y>=15&&c.y+c.height<=30));
const shell=await game.doors.scriptRuntime.infoLinkShell();
assert.deepEqual(hud.decorationCommands(shell.object).map(c=>[c.x,c.width,c.height]),[[0,256,114],[256,175,114],[0,256,114],[256,175,114]]);
console.log('Play HUD passed: original Init/Tick/Draw scripts, six live health fields, damage flash, energy, compass, reset, InfoLink frame crops and original bitmap-font glyph output.');
