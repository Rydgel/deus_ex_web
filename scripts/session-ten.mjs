// The ten-minute session (docs/stage-7-exit-criteria.md 7.1: "a ten-minute session runs without a runtime error. The session starts
// from the original start, loads Training, makes a map change, saves, loads and plays sound"; docs/long-session.md "The ten-minute
// session"). One browser, one page, about --minutes of wall time (10), in the browser's default simulation mode (worker in Chromium
// and WebKit, inline in Firefox: no ?sim= is given, and the first step checks which one the page took). Host tooling only: nothing
// here changes what the simulation computes.
//
// It passes only when every step below happens and no runtime error (`status().runtimeError`), page error or console error occurs.
// Each step prints a verdict line; the last line is the overall PASS or FAIL (exit code 0 or 1).
//
//   start             the original start (the page without ?debug=1) reaches the logo map DX in Play, in the default simulation mode
//   pointer-lock      the first click takes the pointer (the original's CaptureMouse), not the screen, and reaches no binding
//   logo-music        the music starts after that click: the page's AudioContext runs, Galaxy's worklet opens the library, the song
//                     plays and the worklet's quanta advance (344 a second at 44.1 kHz; muted output still renders them)
//   training-menu     Esc opens the original MenuMain; the menu's cursor, driven by relative motion (browser-tests/menu-cursor.mjs, the
//                     portable driver), clicks Training; 00_Training loads and the pointer is held again
//   training-music    Training's song plays
//   training-walk     the movement keys walk the player (W, then A and D, a jump when stuck)
//   training-look     the mouse turns the view (pointer lock + relative motion), and so does the turn key (C: DefUser.ini's TurnRight)
//   training-sound    the game's own sound: footsteps start effect voices that Galaxy's worklet applies (browser-tests/audio-resume.spec.mjs)
//   save-game         Esc, Save Game, the new-save row's Save: Save0001 appears in the browser's storage in the original's format
//   load-game         the player walks away; Esc, Load Game, the slot's row, Load (and the confirm box when it asks): the player stands
//                     where the save left it
//   map-change        the MAP CHANGE is a travel by the console's `open 01_NYC_UNATCOIsland` through the engine's command chain (as
//                     scripts/session-hour.mjs does), NOT Training's own exit; the new map is ready in Play, the pointer is kept
//   island-sound      the game's sound on the new map, and its song plays
//   quick-save-load   the Quick Save key (pressed until the game takes it: a DataLink refuses it), a walk away, the Quick Load key and
//                     the original's confirm box answered Yes with the menu cursor: the player stands where the save left it
//   session-length    the player goes on walking and looking (placed walks from the map's start, as session-hour.mjs does) until the
//                     wall time reaches --minutes, with the runtime error checked every second and the frames still being drawn
//   final-sound       the music still plays, its worklet's quanta still advance, and it reports no fault or error
//   no-errors         no runtime error, page error or console error in the whole session
//
//   node scripts/session-ten.mjs [--browser chromium|firefox|webkit] [--minutes 10]
//     [--url URL] (else a dev server for this tree is started in process, with the game folder it serves)
//     [--out .cache/session-ten/<browser>.json] [--size 1280x800]
//
// Chromium runs in its full headless build (channel "chromium": the new headless mode grants the pointer lock) with --mute-audio;
// Firefox with media.volume_scale 0.0. Playwright's WebKit has no mute switch and, headless, refuses the pointer lock without window
// focus and gives a synthetic mouse move no movementX: there the pointer-lock and training-look steps cannot pass (the tool reports
// them as the harness limit), the menus are driven with the free mouse at its own position, and the rest is as in the other browsers.
// The game folder is the one the dev server serves (the production gate's folder picker is scripts/profile-map-load.mjs --folder).
import {chromium,firefox,webkit} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lockedMove} from '../browser-tests/menu-cursor.mjs';

const option=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i<0?f:process.argv[i+1];};
const f1=v=>Number.isFinite(v)?v.toFixed(1):'-';
const engine=option('browser','chromium');
if(!['chromium','firefox','webkit'].includes(engine))throw new Error('--browser must be chromium, firefox or webkit');
const minutes=Number(option('minutes',10)),[width,height]=option('size','1280x800').split('x').map(Number);
const out=option('out',`.cache/session-ten/${engine}.json`);
const TRAVEL_MAP='01_NYC_UNATCOIsland',TRAINING='00_Training';
const expectedSim=engine==='firefox'?'inline':'worker';
mkdirSync(dirname(out),{recursive:true});

const started=Date.now();
const since=()=>(Date.now()-started)/1000;
const say=line=>console.log(`[${f1(since()/60).padStart(5)} min] ${line}`);

// ---- the tree's dev server (the game folder it serves is this tree's), unless --url names one
let server=null,url=option('url',null);
if(!url){
  const root=fileURLToPath(new URL('..',import.meta.url));
  const {createServer}=await import('vite');
  const {default:base}=await import('../vite.config.mjs');
  const deny=base.server.fs.deny.filter(pattern=>!(pattern.includes('.work')&&root.includes('/.work/'))
    &&!(pattern.includes('.claude/worktrees')&&root.includes('/.claude/worktrees/')));
  server=await createServer({...base,configFile:false,root,logLevel:'error',
    server:{...base.server,port:0,strictPort:false,host:'127.0.0.1',fs:{...base.server.fs,deny},watch:null}});
  await server.listen();url=server.resolvedUrls.local[0].replace(/\/$/,'');
}

// ---- the browser, muted
let browser;
if(engine==='chromium')browser=await chromium.launch({channel:'chromium',headless:true,args:['--use-angle=gl','--mute-audio']});
else if(engine==='firefox')browser=await firefox.launch({headless:true,firefoxUserPrefs:{'media.volume_scale':'0.0'}});
else browser=await webkit.launch({headless:true});
const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1});
const page=await context.newPage();

// ---- the errors: runtime errors (the page's Play pause), page errors, console errors; failed requests are kept apart as notes
const errors=[],notes=[];
const fail=(kind,message)=>{errors.push({kind,atS:Math.round(since()*10)/10,message});say(`${kind} error: ${message}`);};
page.on('pageerror',e=>fail('page',e.message));
page.on('console',m=>{if(m.type()!=='error')return;const t=m.text();
  if(/Failed to load resource/.test(t))notes.push({kind:'resource',atS:Math.round(since()*10)/10,message:`${t} (${m.location().url})`});
  else fail('console',t);});
page.on('crash',()=>fail('page','the page crashed'));

// ---- the page's probes (the same ones the specs and session-hour.mjs use)
class Abort extends Error{}
const status=async()=>{
  const s=await page.evaluate(()=>{const s=window.deusExViewer.status();
    return {ready:s.ready,map:s.map,sim:s.sim,mode:s.mode,frame:s.frame,position:s.position,error:s.runtimeError?.message??null};});
  if(s.error){if(!errors.some(e=>e.kind==='runtime'&&e.message===s.error))fail('runtime',s.error);throw new Abort(`runtime error: ${s.error}`);}
  return s;
};
const probe=step=>page.evaluate(step=>window.deusExViewer.settingsProbe(step),step);
const menu=async()=>(await probe({op:'state'}))?.top??null;
const exec=commands=>page.evaluate(exec=>window.deusExViewer.viewProbe({exec}),commands);
const music=()=>page.evaluate(()=>window.deusExViewer.musicStatus());
const worklet=s=>s.output?.worklet??null;
const slots=()=>page.evaluate(()=>window.deusExViewer.saves.list());
const where=async()=>(await page.evaluate(()=>window.deusExViewer.placeProbe({}))).location;
const view=async()=>(await page.evaluate(()=>window.deusExViewer.viewProbe({}))).viewRotation;
const locked=()=>page.evaluate(()=>document.pointerLockElement?.id??null);
const sameMap=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const hold=async ms=>{for(const end=Date.now()+ms;Date.now()<end;){await page.waitForTimeout(Math.min(500,Math.max(1,end-Date.now())));await status();}};
const waitFor=async(test,{timeout,step=250,what})=>{
  for(const end=Date.now()+timeout;Date.now()<end;){const value=await test();if(value)return value;await status();await page.waitForTimeout(step);}
  throw new Error(`timed out (${timeout/1000} s): ${what}`);
};
const waitMusic=(predicate,what,timeout=60000)=>waitFor(async()=>predicate(await music())&&true,{timeout,what});
const arrived=map=>waitFor(async()=>{const s=await status();return s.ready&&sameMap(s.map,map)?s:null;},{timeout:300000,step:500,what:`arrival on ${map}`});

// The menu's cursor follows relative motion under the pointer lock; clamp it at the root's corner, then move by the control's
// drawing-buffer position (browser-tests/save-game.spec.mjs cursor). A free pointer reaches the menu at its own position.
async function cursor(){
  const box=await page.locator('#scene').boundingBox();
  let at={x:box.x+box.width/2,y:box.y+box.height/2};
  const go=async(x,y,steps=20)=>{await lockedMove(page,at,{x,y},steps);at={x,y};await page.waitForTimeout(120);};
  let ref=null;
  const park=async()=>{for(let k=0;k<4;k++){await go(at.x-box.width/2,at.y-box.height/2);await go(at.x+0.001,at.y+0.001,1);}ref={...at};};
  if(await locked())await park();
  const buffer=await page.evaluate(()=>{const c=document.querySelector('#scene');return {w:c.width,h:c.height};});
  return {async click(spec){
    const b=await page.locator('#scene').boundingBox();
    if(!(await locked()))ref=null;else if(!ref)await park();
    const target=(await probe({op:'center',...spec})).result,origin=ref??{x:b.x,y:b.y};
    await go(origin.x+b.width*target.x/buffer.w,origin.y+b.height*target.y/buffer.h);
    await page.mouse.down();await page.waitForTimeout(100);await page.mouse.up();await page.waitForTimeout(250);
  }};
}
/** Esc, MenuMain, the button at `index`, and the screen it opens; on a failure the message says what the menu looked like. */
async function describeMenu(){
  try{
    const top=await menu();if(!top)return 'no menu open';
    const c=(await probe({op:'controls'})).result;
    return `menu ${top}: `+(c?.menu?.buttons??[]).map(b=>`${b.text??b.action}${c.windows?.[b.window]?.sensitive===false?' (insensitive)':''}`).join(', ');
  }catch(error){return `(menu not described: ${error.message})`;}
}
const buttonSensitive=async index=>{const c=(await probe({op:'controls'})).result;const b=c?.menu?.buttons?.[index];return b?c.windows?.[b.window]?.sensitive!==false:false;};
async function mainMenuTo(index,expected,what,{patient=false}={}){
  // MenuMain.UpdateButtonStatus: "Don't allow saving if a datalink is playing" (Save Game is insensitive while one plays): with
  // `patient` the menu is closed again (Esc) and opened again every few seconds until the button takes clicks, as a player waits
  for(const end=Date.now()+(patient?240000:0);;){
    await page.keyboard.press('Escape');
    await waitFor(async()=>await menu()==='deusex.menumain',{timeout:20000,what:'MenuMain after Esc'});
    if(!patient||await buttonSensitive(index))break;
    if(Date.now()>end)throw new Error(`the ${what} button stayed insensitive for 240 s (a DataLink playing?); ${await describeMenu()}`);
    await page.keyboard.press('Escape');
    await waitFor(async()=>await menu()===null,{timeout:20000,what:'MenuMain closed by Esc'});
    await hold(5000);
  }
  const mouse=await cursor();
  await mouse.click({field:'winButtons',index});
  try{await waitFor(async()=>await menu()===expected,{timeout:30000,what:`the ${what} screen (${expected})`});}
  catch(error){throw new Error(`${error.message}; ${await describeMenu()}`);}
  return mouse;
}
/** A click on the picture takes the pointer when it is free (the first click reaches no binding). */
async function takePointer(){
  if(await locked())return true;
  const box=await page.locator('#scene').boundingBox();
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  for(let i=0;i<20&&!(await locked());i++)await page.waitForTimeout(250);
  await page.waitForTimeout(300);
  return Boolean(await locked());
}
const releaseKeys=async()=>{for(const k of ['KeyW','KeyA','KeyD','KeyS','KeyC','KeyR','KeyV'])await page.keyboard.up(k).catch(()=>{});};

/** Walk with a movement key for `ms`: a jump when the position barely changes, then a turn if it is still stuck. Returns the distance
 * from the start of the walk. */
async function walk(ms,key='KeyW'){
  const from=(await status()).position;let last=from,stuck=0;
  await page.keyboard.down(key);
  try{
    for(const end=Date.now()+ms;Date.now()<end;){
      await page.waitForTimeout(Math.min(1000,Math.max(1,end-Date.now())));const s=await status();
      if(Math.hypot(...s.position.map((v,j)=>v-last[j]))<20){
        await page.keyboard.press('Space');
        if(++stuck>=2){await turnRight(600);stuck=0;}
      }else stuck=0;
      last=s.position;
    }
  }finally{await page.keyboard.up(key);}
  return Math.hypot(...last.map((v,j)=>v-from[j]));
}
/** The original's own key for a turn (DefUser.ini: C=TurnRight; the arrow keys strafe). */
const turnRight=async ms=>{await page.keyboard.down('KeyC');await page.waitForTimeout(ms);await page.keyboard.up('KeyC');};
const turned=(a,b)=>{const d=Math.abs(a-b)%65536;return Math.min(d,65536-d);};

// ---- the steps
const steps=[];
async function step(name,what,fn,{needs=[]}={}){
  const missing=needs.filter(n=>!steps.find(s=>s.name===n)?.pass);
  const record={name,what,pass:false,detail:'',startS:since(),endS:0};steps.push(record);
  say(`step ${name}: ${what}`);
  if(missing.length){record.detail=`not run: needs ${missing.join(', ')}`;}
  else try{const detail=await fn();record.pass=true;record.detail=detail??'';}
  catch(error){record.detail=error.message;
    await page.screenshot({path:out.replace(/\.json$/,'')+`-${name}.png`}).catch(()=>{});
    if(error instanceof Abort){record.endS=since();say(`  ${name}: ${record.detail}`);throw error;}}
  record.endS=since();say(`  ${record.pass?'ok':'FAILED'}: ${record.detail}`);
  return record.pass;
}

let ended=null,sim=null,saveAt=null,quickAt=null;
const musicLine=m=>{const w=worklet(m);return `context ${m.context}, quanta ${w?.quanta}, underruns ${w?.underruns}, fault ${w?.fault}, error ${w?.error}`;};
/** The game's own sound (browser-tests/audio-resume.spec.mjs walk): footsteps are effect voices; Galaxy's Update posts a batch when the
 * sound changes and the worklet acknowledges it. */
async function footsteps(){
  const before=(await music()).library;
  let distance=0;
  for(let k=0;k<4&&distance<50;k++){if(k)await turnRight(700);distance=await walk(2500);}
  if(distance<50)throw new Error(`the player walked ${f1(distance)} units in four tries`);
  await waitMusic(s=>s.library.voiceOps>before.voiceOps&&s.library.issued>before.issued,'footsteps start effect voices',20000);
  const issued=(await music()).library.issued;
  await waitMusic(s=>s.library.acknowledged>=issued,'the worklet applies their batches',15000);
  const after=(await music()).library;
  return `walked ${f1(distance)}; effect voice ops ${before.voiceOps} -> ${after.voiceOps}, batches issued ${before.issued} -> ${after.issued}, acknowledged ${after.acknowledged}`;
}
/** Quick-load style check: the player stands where a save left it (within 2 units on each axis). */
const near=(p,at)=>Math.abs(p[0]-at[0])<2&&Math.abs(p[1]-at[1])<2&&Math.abs(p[2]-at[2])<2;
/** Walk until the player is at least 50 units from `at`, so that finding it back at `at` proves a load. */
async function walkAwayFrom(at){
  for(const key of ['KeyW','KeyS','KeyA','KeyD','KeyW']){
    await walk(2500,key);
    const p=await where();if(!near(p,at)&&Math.hypot(p[0]-at[0],p[1]-at[1],p[2]-at[2])>=50)return p;
  }
  throw new Error(`the player could not be walked 50 units from ${at.map(Math.round)}`);
}
const lookRounds=[];

try{
  await step('start','the original start (no ?debug=1) reaches the logo map DX in Play, in the default simulation mode',async()=>{
    await page.goto(`${url}/`);
    if(new URL(page.url()).searchParams.has('debug'))throw new Error('the page carries ?debug=1');
    const s=await waitFor(async()=>{const s=await status();return s.ready&&s.map==='DX'?s:null;},{timeout:240000,step:500,what:'the logo map DX ready'});
    sim=s.sim;
    if(s.mode!=='play')throw new Error(`mode ${s.mode}, not play`);
    if(s.sim!==expectedSim)throw new Error(`simulation mode ${s.sim}, expected the default ${expectedSim} for ${engine}`);
    return `map DX, mode ${s.mode}, simulation ${s.sim}, ready after ${f1(since())} s`;
  });

  await step('pointer-lock','the first click takes the pointer (not the screen) and reaches no binding',async()=>{
    const ctx=await page.evaluate(()=>window.deusExViewer.audioContextProbe());
    if(ctx!=='uninitialized')throw new Error(`the AudioContext is ${ctx} before any gesture`);
    await page.waitForTimeout(1000);
    const box=await page.locator('#scene').boundingBox();
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    for(let i=0;i<20&&!(await locked());i++)await page.waitForTimeout(250);
    await page.waitForTimeout(500);
    const state=await page.evaluate(async()=>({lock:document.pointerLockElement?.id??null,fullscreen:document.fullscreenElement?.id??null,
      menu:(await window.deusExViewer.settingsProbe({op:'state'}))?.top??null}));
    if(state.lock!=='scene')throw new Error(`document.pointerLockElement is ${state.lock}`+(engine==='webkit'?' (Playwright\'s headless WebKit refuses the lock without window focus: a harness limit)':''));
    if(state.fullscreen)throw new Error(`the click took the screen (${state.fullscreen})`);
    if(state.menu)throw new Error(`the click reached a binding: menu ${state.menu}`);
    return 'locked on #scene, windowed, no menu';
  },{needs:['start']});

  await step('logo-music','the first click starts the music on the logo map: the context runs, the worklet plays the song',async()=>{
    await waitMusic(s=>s.context==='running'&&worklet(s)?.open===true&&s.library?.live===true&&s.library.playing===true,
      'the context runs, the worklet opened the library and the song plays',90000);
    const a=worklet(await music());await page.waitForTimeout(1000);const b=worklet(await music());
    if(!(b.quanta-a.quanta>150))throw new Error(`the worklet rendered ${b.quanta-a.quanta} quanta in a second (a playing context renders about 344)`);
    return `${b.quanta-a.quanta} quanta in 1 s; ${musicLine(await music())}`;
  },{needs:['start']});

  await step('training-menu','Esc opens MenuMain; the menu cursor clicks Training; 00_Training loads and the pointer is held',async()=>{
    await page.keyboard.press('Escape');
    await waitFor(async()=>await menu()==='deusex.menumain',{timeout:20000,what:'MenuMain after Esc'});
    const asked=Date.now();
    await (await cursor()).click({field:'winButtons',index:4});   // MenuMain's fifth button, Training
    await arrived(TRAINING);
    const loadS=(Date.now()-asked)/1000;
    await page.waitForTimeout(1500);
    const held=await takePointer();
    if(await menu())throw new Error(`a menu is open on Training: ${await menu()}`);
    if(!held)throw new Error('the pointer could not be taken on Training');
    return `00_Training ready ${f1(loadS)} s after the click, pointer locked`;
  },{needs:['start']});

  await step('training-music','Training\'s song plays',async()=>{
    await waitMusic(s=>s.context==='running'&&s.library?.live===true&&s.library.playing===true,'Training\'s song plays',90000);
    const a=worklet(await music());await page.waitForTimeout(1000);const b=worklet(await music());
    if(!(b.quanta-a.quanta>150))throw new Error(`${b.quanta-a.quanta} quanta in a second`);
    return musicLine(await music());
  },{needs:['training-menu']});

  await step('training-walk','the movement keys walk the player: W, then D and A, a jump',async()=>{
    // (the player is given a few seconds after arrival: a DataLink plays, the scene settles)
    await hold(2000);
    const p0=await where();
    const forward=await walk(3500,'KeyW'),right=await walk(1200,'KeyD'),left=await walk(1200,'KeyA');
    await page.keyboard.press('Space');await hold(800);
    const p1=await where(),moved=Math.hypot(...p1.map((v,j)=>v-p0[j]));
    if(!(forward>=100))throw new Error(`W moved the player ${f1(forward)} units in 3.5 s`);
    return `W ${f1(forward)}, D ${f1(right)}, A ${f1(left)} units; from ${p0.map(Math.round)} to ${p1.map(Math.round)} (${f1(moved)})`;
  },{needs:['training-menu']});

  await step('training-look','the mouse turns the view (relative motion under the pointer lock), and so does the turn key C',async()=>{
    if(!(await takePointer()))throw new Error('no pointer lock: mouse look needs it'+(engine==='webkit'?' (Playwright\'s WebKit: harness limit)':''));
    const box=await page.locator('#scene').boundingBox();
    const centre={x:box.x+box.width/2,y:box.y+box.height/2};
    // (a mouse move under the lock carries the step from the previous move: put the mouse at the centre first)
    await page.mouse.move(centre.x,centre.y);await page.waitForTimeout(300);
    let at=centre;
    const b2=await view();await lockedMove(page,at,{x:at.x+240,y:at.y+60},12);at={x:at.x+240,y:at.y+60};await page.waitForTimeout(300);const a2=await view();
    const oneWay=turned(b2[1],a2[1]),pitch=turned(b2[0],a2[0]);
    await lockedMove(page,at,centre,12);await page.waitForTimeout(300);
    const k0=await view();await turnRight(600);await page.waitForTimeout(300);
    const k1=await view();const keyYaw=turned(k0[1],k1[1]);
    lookRounds.push({oneWay,pitch,keyYaw});
    if(!(oneWay>100))throw new Error(`a 240 px mouse move turned the view ${oneWay} units`+(engine==='webkit'?' (Playwright\'s WebKit: a synthetic move carries no movementX)':''));
    if(!(keyYaw>100))throw new Error(`the turn key (C, the original's TurnRight) turned the view ${keyYaw} units in 0.6 s`);
    return `a 240 px mouse move turned the view ${oneWay} units and tilted it ${pitch} (65536 a turn), the turn key (C) ${keyYaw} units in 0.6 s`;
  },{needs:['training-menu']});

  await step('training-sound','the game\'s own sound: footsteps start effect voices that the worklet applies',footsteps,{needs:['training-menu']});

  await step('save-game','Esc, Save Game, Save: Save0001 is written into the browser\'s storage',async()=>{
    // (the training keeps the player for a while: the rest of the planned time on Training, so the save is not the first thing a player does)
    await releaseKeys();
    saveAt=await where();
    const mouse=await mainMenuTo(1,'deusex.menuscreensavegame','Save Game',{patient:true});   // MenuMain's second button
    await page.waitForTimeout(1000);
    await mouse.click({actionKey:'SAVE'});
    await waitFor(async()=>(await slots()).some(s=>s.dir==='Save0001'),{timeout:30000,what:'Save0001 in the storage'});
    await waitFor(async()=>await menu()===null,{timeout:20000,what:'the Save Game screen closed'});
    const slot=(await slots()).find(s=>s.dir==='Save0001'),names=slot.files.map(f=>f.name).sort();
    const saveError=await page.evaluate(()=>window.deusExViewer.saves.status().saveError);
    if(saveError)throw new Error(`the storage refused the save: ${JSON.stringify(saveError)}`);
    if(!names.includes('SaveInfo.dxs')||!names.some(n=>/\.dxs$/i.test(n)&&n!=='SaveInfo.dxs'))throw new Error(`Save0001 holds ${names}`);
    await takePointer();
    return `Save0001: ${names.join(', ')}; saved at ${saveAt.map(Math.round)}`;
  },{needs:['training-menu']});

  await step('load-game','the player walks away; Esc, Load Game, the slot, Load: the player stands where the save left it',async()=>{
    const away=await walkAwayFrom(saveAt);
    const mouse=await mainMenuTo(2,'deusex.menuscreenloadgame','Load Game');   // MenuMain's third button
    await page.waitForTimeout(800);
    const list=(await probe({op:'list',field:'lstGames'})).result;
    const row=list.rows.findIndex(r=>r[0]==='UNATCO Training Course');
    if(row<0)throw new Error(`the Load Game screen lists ${JSON.stringify(list.rows.map(r=>r[0]))}`);
    await mouse.click({field:'lstGames',row});
    await mouse.click({actionKey:'LOAD'});
    // (the original asks first when it can: the confirm box, answered Yes)
    let asked=false;
    await waitFor(async()=>{
      if(await menu()==='deusex.menuuimessageboxwindow'&&!asked){asked=true;await mouse.click({field:'btnYes'});}
      const s=await status();return s.ready&&near(await where(),saveAt)&&await menu()===null;
    },{timeout:300000,step:500,what:`the loaded game stands at ${saveAt.map(Math.round)}`});
    await page.waitForTimeout(1000);await takePointer();
    return `walked to ${away.map(Math.round)}, loaded: back at ${saveAt.map(Math.round)}${asked?' (confirm box answered Yes)':' (no confirm box)'}`;
  },{needs:['save-game']});

  await step('map-change',`a travel by the console's open ${TRAVEL_MAP} (not Training's own exit); the new map is ready in Play`,async()=>{
    await hold(5000);   // (some play on Training after the load before leaving it)
    const asked=Date.now();
    await exec([`open ${TRAVEL_MAP}`]);
    await arrived(TRAVEL_MAP);
    const loadS=(Date.now()-asked)/1000;
    await page.waitForTimeout(1500);
    const s=await status(),kept=Boolean(await locked());
    if(s.mode!=='play')throw new Error(`mode ${s.mode} after the travel`);
    if(!kept)await takePointer();
    return `${s.map} ready ${f1(loadS)} s after the command; the travel ${kept?'kept':'did not keep'} the pointer`;
  },{needs:['load-game']});

  await step('island-sound',`the game's sound on the new map: its song plays and footsteps start effect voices`,async()=>{
    await waitMusic(s=>s.context==='running'&&s.library?.live===true&&s.library.playing===true,'the new map\'s song plays',90000);
    return `${await footsteps()}; ${musicLine(await music())}`;
  },{needs:['map-change']});

  await step('quick-save-load','the Quick Save key, a walk away, the Quick Load key and its confirm box answered Yes',async()=>{
    const info=()=>page.evaluate(async()=>{const list=window.deusExViewer.saves.list();if(!list.some(s=>s.dir==='QuickSave'))return null;
      const bytes=await window.deusExViewer.saves.read('QuickSave','SaveInfo.dxs');let h=0;for(const b of bytes)h=(h*31+b)>>>0;return h;});
    await releaseKeys();
    const before=await info();
    // (a DataLink or a conversation refuses a quick save: the key is pressed until the game takes it)
    await waitFor(async()=>{await page.keyboard.press('NumpadAdd');await page.waitForTimeout(1500);const now=await info();return now!==null&&now!==before;},
      {timeout:120000,step:0,what:'the Quick Save key wrote QuickSave'});
    quickAt=await where();
    const away=await walkAwayFrom(quickAt);
    await page.keyboard.press('NumpadDivide');
    await waitFor(async()=>await menu()==='deusex.menuuimessageboxwindow',{timeout:30000,step:500,what:'the Quick Load confirm box'});
    await (await cursor()).click({field:'btnYes'});
    await waitFor(async()=>{const s=await status();return s.ready&&sameMap(s.map,TRAVEL_MAP)&&near(await where(),quickAt)&&await menu()===null;},
      {timeout:300000,step:500,what:`the quick-loaded game stands at ${quickAt.map(Math.round)}`});
    await page.waitForTimeout(1000);await takePointer();
    const saveError=await page.evaluate(()=>window.deusExViewer.saves.status().saveError);
    if(saveError)throw new Error(`the storage reported a save error: ${JSON.stringify(saveError)}`);
    return `QuickSave at ${quickAt.map(Math.round)}, walked to ${away.map(Math.round)}, quick-loaded: back`;
  },{needs:['map-change']});

  // the rest of the wall time: placed walks from the map's start, a look and a scan, as session-hour.mjs does
  let framesFrom=null,framesTo=null;
  await step('session-length',`the player goes on walking and looking until the wall time reaches ${minutes} minutes`,async()=>{
    const deadline=started+minutes*60000;
    const start=await page.evaluate(()=>window.deusExViewer.placeProbe({})),v0=await view();
    framesFrom=(await status()).frame;
    let walks=0,looks=0;
    const left=()=>deadline-Date.now();
    while(left()>0){
      for(let k=0;k<4&&left()>0;k++){
        await page.evaluate(([location,rotation])=>window.deusExViewer.placeProbe({location,rotation}),[start.location,[0,(v0[1]+k*16384)%65536,0]]);
        await walk(Math.min(15000,Math.max(500,left())),'KeyW');walks++;
        if(left()>0){const box=await page.locator('#scene').boundingBox();const c={x:box.x+box.width/2,y:box.y+box.height/2};
          await page.mouse.move(c.x,c.y);await lockedMove(page,c,{x:c.x+160,y:c.y+20},8);await hold(Math.min(4000,Math.max(0,left())));looks++;}
      }
    }
    await releaseKeys();
    framesTo=(await status()).frame;
    if(walks&&!(framesTo>framesFrom))throw new Error(`no frame was drawn in the last stretch (frame counter ${framesFrom} -> ${framesTo})`);
    return `${walks} placed walks and ${looks} looks; frames drawn ${framesFrom} -> ${framesTo}; wall time ${f1(since()/60)} min`;
  },{needs:['training-menu']});

  await step('final-sound','the music still plays, its worklet still renders and reports no fault or error',async()=>{
    const a=worklet(await music());await page.waitForTimeout(1000);const m=await music(),b=worklet(m);
    if(m.context!=='running')throw new Error(`the AudioContext is ${m.context}`);
    if(!(m.library?.live&&m.library.playing))throw new Error(`the library is not playing: ${JSON.stringify(m.library)}`);
    if(!(b.quanta-a.quanta>150))throw new Error(`${b.quanta-a.quanta} quanta in a second`);
    if(b.fault||b.error)throw new Error(`the worklet reports fault ${b.fault}, error ${b.error}`);
    return musicLine(m);
  },{needs:['start']});
}catch(error){ended=error.message;say(`session ended: ${error.message}`);}

// the verdict of the errors: a step of its own, last
{
  const record={name:'no-errors',what:'no runtime error, page error or console error in the whole session',pass:errors.length===0&&!ended?.startsWith('runtime error'),
    detail:errors.length?errors.map(e=>`${e.kind} at ${e.atS} s: ${e.message}`).join(' | '):`none (${notes.length} failed resource loads noted)`,startS:since(),endS:since()};
  steps.push(record);
}
const wallS=since();
try{await releaseKeys();}catch{/* the page is gone */}
const result={browser:engine,args:process.argv.slice(2),started:new Date(started).toISOString(),minutes:wallS/60,asked:minutes,sim,
  userAgent:await page.evaluate(()=>navigator.userAgent).catch(()=>null),travelMap:TRAVEL_MAP,mapChange:'the console\'s open <map>, not Training\'s own exit',
  steps,errors,notes,ended,lookRounds,pass:steps.every(s=>s.pass)&&wallS>=minutes*60-1};
console.log('\n| Step | Result | From (min) | To (min) | Detail |\n|---|---|---:|---:|---|');
for(const s of steps)console.log(`| ${s.name} | ${s.pass?'PASS':'FAIL'} | ${f1(s.startS/60)} | ${f1(s.endS/60)} | ${s.detail.replace(/\|/g,'/')} |`);
console.log('');
for(const s of steps)console.log(`${s.pass?'PASS':'FAIL'}  ${s.name}: ${s.detail}`);
if(wallS<minutes*60-1)console.log(`FAIL  wall time: ${f1(wallS/60)} min of ${minutes}`);
console.log(`\nsession-ten ${engine} (${sim??'-'} mode, ${f1(wallS/60)} min, ${errors.length} errors${notes.length?`, ${notes.length} failed resource loads`:''}): ${result.pass?'PASS':'FAIL'}`);
writeFileSync(out,JSON.stringify(result,null,1));say(`saved ${out}`);
await browser.close().catch(()=>{});await server?.close();
process.exit(result.pass?0:1);
