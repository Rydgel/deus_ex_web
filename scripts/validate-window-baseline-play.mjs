/** Bounded Stage 3 integration: both Training bot Frobs cross native1484 and native1439.
 * Full screen completion retains explicit bot sound and scroll draw/input boundaries.
 * See docs/script-window-baseline.md and docs/script-window-accelerator-text.md. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

// A fresh Play host for each bot preserves startup and modal state isolation.
if(!process.argv[2]){
  const {execFileSync}=await import('node:child_process');
  for(const bot of ['MedicalBot','RepairBot'])
    execFileSync(process.execPath,[new URL(import.meta.url).pathname,bot],{stdio:'inherit'});
  process.exit(0);
}
const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, host = game.hud.host, W = host.W;

const player=game.player.collisionActor,level=runtime.levelFor(player);
const native=runtime.invokeNative.bind(runtime),calls=[],completed=[],accelerators=[],sizing=[],configured=[];
const originalConfiguration=W.v.configurationChanged;
W.v.configurationChanged=(win)=>{const result=originalConfiguration(win);configured.push(win);return result;};
const keys=new Map([...runtime.functions.values()].map(record=>[record.function,record.key]));
const executeScript=runtime.executeScript.bind(runtime);
runtime.executeScript=(fn,receiver,...rest)=>{
  const value=executeScript(fn,receiver,...rest);
  completed.push({key:keys.get(fn),receiver});
  return value;
};
runtime.invokeNative=call=>{
  const value=native(call);
  if(call.index===1465&&runtime.instance(call.receiver).cls.record.key==='deusex.personascrollareawindow'){
    const clip=W.ptr(call.receiver,0x16c);
    sizing.push({receiver:call.receiver,width:W.f32(clip,0xac),height:W.f32(clip,0xb0)});
  }
  if(call.index===1484){
    const gc=W.ptr(call.receiver,0x130);
    calls.push({receiver:call.receiver,name:runtime.instance(call.receiver).cls.record.name,
      args:[runtime.namedReference(call.receiver,'fontBaseLine').get(),runtime.namedReference(call.receiver,'fontAcceleratorLineHeight').get()],
      fields:[W.f32(gc,0x8c),W.f32(gc,0x88)]});
  }
  if(call.index===1439)accelerators.push({receiver:call.receiver,
    text:runtime.namedReference(call.receiver,'buttonText').get(),key:W.u32(call.receiver,0xb4)});
  return value;
};
const target=process.argv[2]??'MedicalBot';
const bot=level.actors.find(actor=>actor&&runtime.instance(actor).cls.record.name===target);
assert.ok(bot,`Training contains ${target}`);
// Run the original Frob, without suppressing a later native boundary.
assert.throws(()=>runtime.processEvent(bot,'Frob',[player,null]),
  target==='MedicalBot'
    ? /Unsupported original door native 264 PlaySound from hudmedbothealthscreen.setmedicalbot/
    : /Unsupported original door native 264 PlaySound from hudrechargewindow.setrepairbot/);
assert.equal(calls.length,target==='MedicalBot'?16:2);
const initialCalls=calls.slice(0,target==='MedicalBot'?3:2);
for(const call of calls){
  assert.ok((target==='MedicalBot'?['PersonaNavButtonWindow','PersonaHealthActionButtonWindow','PersonaActionButtonWindow']:['PersonaActionButtonWindow']).includes(call.name));
  assert.deepEqual(call.args,[1,1],'installed button defaults');
  assert.deepEqual(call.fields,call.args,'original InitWindow arguments reach its existing GC');
  assert.ok(completed.some(row=>row.receiver===call.receiver&&row.key.endsWith('.stylechanged')),
    'original StyleChanged returns after SetBaselineData');
  assert.ok(completed.some(row=>row.receiver===call.receiver&&row.key==='deusex.personaborderbuttonwindow.initwindow'),
    'original PersonaBorderButtonWindow.InitWindow returns');
}
assert.equal(accelerators.length,calls.length);
for(const call of accelerators)assert.ok(completed.some(row=>row.receiver===call.receiver&&row.key==='deusex.personaborderbuttonwindow.setbuttontext'),
  'original SetButtonText returns after accelerator registration and reconfiguration');
// Installed DeusEx.int: HUDRechargeWindow labels and PersonaNavBarBaseWindow
// and HUDMedBotNavBarWindow labels. Preserve authored case, spaces and marker position.
assert.deepEqual(accelerators.slice(0,initialCalls.length).map(({text,key})=>({text,key})),target==='MedicalBot'?
  [{text:'   |&Augmentations   ',key:65},{text:' |&Health   ',key:72},{text:'E|&xit',key:120}]:
  [{text:'  |&Close  ',key:67},{text:'  |&Recharge  ',key:82}]);
if(target==='MedicalBot'){
  const areas=completed.filter(row=>row.key==='deusex.personascrollareawindow.initwindow');
  assert.equal(areas.length,1,'original PersonaScrollAreaWindow.InitWindow returns');
  const area=areas[0].receiver,child=off=>W.ptr(area,off);
  assert.ok(sizing.some(row=>row.receiver===area&&row.width>0&&row.height>0),
    'original medical script returns from QueryPreferredSize with a nonempty clip rectangle');
  const expected=['ScaleManagerWindow','ScaleManagerWindow','ScaleWindow','ScaleWindow','ButtonWindow','ButtonWindow','ButtonWindow','ButtonWindow','ClipWindow'];
  expected.forEach((name,i)=>assert.equal(runtime.instance(child(0x14c+4*i)).cls.record.name,name));
  for(const [offset,parentOffset] of [[0x14c,null],[0x150,null],[0x16c,null],[0x154,0x14c],[0x15c,0x14c],[0x160,0x14c],[0x158,0x150],[0x164,0x150],[0x168,0x150]])
    assert.equal(W.ptr(child(offset),0x138),parentOffset===null?area:child(parentOffset));
  assert.equal(W.ptr(child(0x14c),0x158),child(0x154));
  assert.equal(W.ptr(child(0x150),0x158),child(0x158));
  assert.equal(W.u8(child(0x14c),0x30)&1,0);assert.equal(W.u8(child(0x150),0x30)&1,1);
  assert.equal(W.u32(child(0x16c),0x184)&3,1);
  const scale=child(0x158);
  assert.equal(W.u8(scale,0x14c),1);
  const clip=child(0x16c);
  assert.equal(W.i32(scale,0x1c4),Math.max(1,W.i32(clip,0x194)),'clip row count reaches vertical scale');
  assert.equal(W.i32(scale,0x1cc),Math.max(1,W.i32(clip,0x18c)),'visible rows reach thumb span');
  for(const win of [area,clip,scale,child(0x150)])assert.ok(configured.includes(win),'each reached family returns from configuration');
  assert.ok(W.f32(clip,0x80)>0&&W.f32(clip,0x84)>0,'clip has actual configured dimensions');
  assert.ok(W.f32(scale,0x254)>=W.f32(scale,0x250),'configured thumb range is ordered');
  assert.equal(W.u8(child(0x164),0x30)&2,0,'up button is insensitive at the first row');
  assert.equal(W.u32(scale,0x164)&27,27);assert.equal(W.i32(scale,0x1d0),10);
  assert.deepEqual([W.f32(scale,0x18c),W.f32(scale,0x190),W.f32(scale,0x194),W.f32(scale,0x198)],[11,2,7,2]);
  assert.equal(W.f32(scale,0x114),0.25);
  assert.ok(completed.some(row=>row.receiver===area&&row.key==='deusex.personascrollareawindow.stylechanged'));
  assert.equal(completed.filter(row=>row.key==='deusex.personahealthactionbuttonwindow.initwindow').length,12,
    'both authored sets of six health-region controls initialize');
  // Native vtable slots are guarded instead of inheriting a base implementation.
  assert.throws(()=>W.v.draw(scale,null),/scalewindow.draw native override/);
  W.v.tick(scale,0); // No repeat active: original native returns without script Tick.
  // Exercise the recovered removal virtual on the real constructed manager.
  // This isolates notification dispatch; full recursive screen cleanup remains guarded.
  const manager=child(0x150),first=W.ptr(manager,0x14c),last=W.ptr(manager,0x150);
  const initialPosition=W.i32(scale,0x1c8),limit=Math.max(0,W.i32(scale,0x1c4)-W.i32(scale,0x1cc));
  assert.equal(W.v.buttonActivated(manager,last),true,'original scrollbar down-button route is consumed');
  assert.equal(W.i32(scale,0x1c8),Math.min(limit,initialPosition+W.i32(scale,0x1d0)),'button moves the thumb by its authored step');
  assert.equal(W.i32(clip,0x178),W.i32(scale,0x1c8),'range callback synchronizes clip row');
  assert.equal(W.v.buttonActivated(manager,first),true,'original scrollbar up-button route is consumed');
  assert.equal(W.i32(scale,0x1c8),0,'up button returns to the first row');
  assert.equal(W.i32(clip,0x178),0,'clip feedback agrees at the first row');
  const thumbX=W.f32(scale,0x210)+0.5,thumbY=W.f32(scale,0x214)+0.5;
  assert.equal(W.v.mouseButtonPressed(scale,thumbX,thumbY,1,1),true);
  assert.equal(W.u8(scale,0x258)&1,1,'press inside the original thumb starts dragging');
  W.v.mouseMoved(scale,thumbX,thumbY+40);
  assert.equal(W.i32(clip,0x178),W.i32(scale,0x1c8),'drag keeps actual clip and scale synchronized');
  assert.equal(W.v.mouseButtonReleased(scale,thumbX,thumbY+40,1,1),true);
  assert.equal(W.u8(scale,0x258)&1,0,'release clears drag state');
  assert.equal(W.u8(scale,0x260),0,'release clears repeat state');
  W.v.childRequestedShowArea(clip,W.ptr(clip,0x140),0,0,1,1);
  assert.equal(W.i32(clip,0x178),0,'show-area brings the content origin back into view');
  assert.equal(W.i32(scale,0x1c8),0,'show-area synchronizes the scrollbar');
  W.v.childRemoved(manager,first);
  assert.equal(W.ptr(manager,0x14c),null,'manager clears the removed first button');
  assert.equal(W.ptr(manager,0x150),last,'unrelated second button is preserved');
  assert.equal(W.ptr(manager,0x158),scale,'unrelated scale is preserved');
  W.v.childRemoved(manager,scale);
  assert.equal(W.ptr(manager,0x158),null,'manager clears the removed scale');
  const beforeRemovalEvents=completed.length;
  W.v.descendantRemoved(area,first);
  assert.equal(child(0x164),null,'area clears its removed up-button reference');
  assert.equal(child(0x168),last,'area preserves the down-button reference');
  W.v.descendantRemoved(area,scale);
  assert.equal(child(0x158),null,'area clears its removed vertical scale');
  assert.equal(child(0x150),manager,'area preserves the vertical manager');
  assert.equal(child(0x16c),clip,'area preserves the clip');
  assert.equal(completed.length,beforeRemovalEvents,'area removal emits no script event');
  // Restore the isolated notification fixtures before exercising actual recursive cleanup.
  W.setPtr(manager,0x14c,first);W.setPtr(manager,0x158,scale);
  W.setPtr(area,0x164,first);W.setPtr(area,0x158,scale);
  const subtree=[];
  const collect=win=>{subtree.push(win);for(let child=W.ptr(win,0x140);child;child=W.ptr(child,0x144))collect(child);};
  collect(area);
  W.native.safeDestroy(area);
  assert.ok(subtree.length>=10,'real scroll subtree includes all native families');
  for(const win of subtree)assert.equal(host.isDestroyed(win),true,'recursive cleanup destroys every descendant');
  assert.equal(W.ptr(area,0x138),null,'destroyed area is unlinked from its parent');
  assert.equal(W.i32(scale,0x26c),0,'scale label array is empty');
  assert.equal(W.heap.read(scale,0x1dc,'string'),'','scale format string is destroyed');
}
console.log(`window-baseline-play: ${target} completes button baseline and accelerator initialization; next explicit boundary is ${target==='MedicalBot'?'MedicalBot PlaySound (scroll-area layout complete)':'RepairBot PlaySound'}`);
