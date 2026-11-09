/**
 * Map load time in Chromium or Firefox against a running dev server or a production preview (Stage 7 rows 7.3.1 to 7.3.3,
 * docs/load-time.md). Opens the debugging page (or, with --start original, the page as the original starts: the logo map DX.dx),
 * times the first map's load from navigation, then each load it is asked for:
 *   --maps: each entry chosen from the map list (a new process), or with --travel reached by the console's `open <map>` (a travel: its
 *     level attaches to the script process of the level left, src/runtime/script-process.mjs);
 *   --saves: the folder's SaveNNNN slots imported through the Saves window, then each --slots entry loaded by the console's
 *     `loadgame N` (DeusExPlayer.LoadGame's exec: ClientTravel("?loadgame=N"), the Load Game screen's own call).
 * A load is timed from navigation (the first) or from the command to the first frame drawn after it (the first tick and the first use
 * of the shader programs included): the page's load timeline that starts after the command (deusExViewer.loadTimings: the page's
 * steps, the simulation side's in the worker or inline, the first drawn frame), its start plus its first draw, on the page's clock.
 * The loading screen's progress messages are kept with their times. Host measurement only.
 *
 *   node scripts/profile-map-load.mjs [--url http://127.0.0.1:5173] [--browser chromium|firefox] [--start original]
 *     [--maps 01_NYC_UNATCOIsland,02_NYC_BatteryPark | all] (all: the 83 single-player maps, every map but DXMP_*) [--sim worker|inline]
 *     [--travel] [--process new] (the page's ?process=new: a new script process for every level, travels included)
 *     [--saves <Save folder> --slots 1,2,3 | all]
 *     [--folder] (a production preview, this tree's dist/ unless --url names one: the game folder given to the gate's picker as soon
 *       as it is there, the load timed from navigation as well; pickedAtMs is when it was given)
 *     [--profile] (Chromium: a CPU profile of the page per load: with --sim inline it covers the simulation side too)
 *     [--gecko-profile file.json] (Firefox: a Gecko profile of the whole run, written when the browser closes)
 *     [--tag name] [--size 1440x960] [--headed] [--out file.json]
 *
 * The raw .cpuprofile files go to .cache/perf/<tag>-<map>.cpuprofile (outside Git).
 */
import {chromium,firefox} from '@playwright/test';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import { debugUrl } from './page-url.mjs';
import { gameDirectory } from './game-directory.mjs';

const option=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
// --folder without --url: this tree's production build (dist/, `npm run build` first) served by Vite's preview server on a free port
let previewServer=null;
if(process.argv.includes('--folder')&&!option('url',null)){
  const {preview}=await import('vite');
  previewServer=await preview({preview:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'});
}
const url=option('url',previewServer?previewServer.resolvedUrls.local[0].replace(/\/$/,''):'http://127.0.0.1:5173'),tag=option('tag','load'),sim=option('sim',null),engine=option('browser','chromium');
const originalStart=option('start',null)==='original',savesDir=option('saves',null),folder=process.argv.includes('--folder');
const mapsOption=option('maps',savesDir?'':'01_NYC_UNATCOIsland');
const maps=mapsOption==='all'
  ?(await readdir(path.join(gameDirectory(),'Maps'))).filter(f=>/\.dx$/i.test(f)&&!/^DXMP_/i.test(f)).map(f=>f.replace(/\.dx$/i,'')).sort()
  :mapsOption.split(',').filter(Boolean);
const slots=!savesDir?[]:option('slots','all')==='all'
  ?(await readdir(savesDir)).filter(d=>/^Save\d+$/.test(d)).map(d=>Number(d.slice(4))).sort((a,b)=>a-b)
  :option('slots').split(',').map(Number);
const profiled=process.argv.includes('--profile')&&engine==='chromium',travel=process.argv.includes('--travel'),processMode=option('process',null);
const [width,height]=option('size','1440x960').split('x').map(Number);
const label=frame=>`${frame.functionName||'(anon)'} ${frame.url.split('/').at(-1).split('?')[0]}:${frame.lineNumber+1}`;

// Self and inclusive ms per function over one load's profile.
function summarize(profile){
  const byId=new Map(profile.nodes.map(node=>[node.id,node])),parent=new Map();
  for(const node of profile.nodes)for(const child of node.children??[])parent.set(child,node.id);
  const self=new Map(),inclusive=new Map();let sampled=0;
  for(let i=0;i<profile.samples.length;i++){
    const ms=profile.timeDeltas[i]/1000;sampled+=ms;
    const leaf=byId.get(profile.samples[i]);self.set(label(leaf.callFrame),(self.get(label(leaf.callFrame))??0)+ms);
    const seen=new Set();
    for(let id=profile.samples[i];id!==undefined;id=parent.get(id)){
      const key=label(byId.get(id).callFrame);if(seen.has(key))continue;seen.add(key);
      inclusive.set(key,(inclusive.get(key)??0)+ms);
    }
  }
  const top=(map,n)=>Object.fromEntries([...map].sort((a,b)=>b[1]-a[1]).slice(0,n).map(([key,ms])=>[key,Math.round(ms)]));
  return {sampledMs:Math.round(sampled),selfMs:top(self,40),inclusiveMs:top(inclusive,60)};
}

// Firefox: --gecko-profile FILE writes a Gecko profile of the whole run at shutdown (the page's main thread and the workers; gecko-self-time.mjs)
const geckoOut=option('gecko-profile',null);
const browser=engine==='firefox'
  ?await firefox.launch({headless:!process.argv.includes('--headed'),
    // Firefox captures an async stack at every promise and await only for a page under a debugger (javascript.options.
    // asyncstack_capture_debuggee_only, true by default), which Playwright's Firefox driver makes every page: 20 to 30% of a load's
    // time (docs/load-time.md). Off, as in a player's Firefox; --ff-prefs '{}' keeps the driver's state.
    firefoxUserPrefs:JSON.parse(option('ff-prefs','{"javascript.options.asyncstack":false}')),env:geckoOut?{...process.env,MOZ_PROFILER_STARTUP:'1',
    MOZ_PROFILER_STARTUP_FEATURES:'js,threads,markers',MOZ_PROFILER_STARTUP_FILTERS:'GeckoMain,DOM Worker',MOZ_PROFILER_STARTUP_INTERVAL:'1',
    MOZ_PROFILER_STARTUP_ENTRIES:'80000000',MOZ_PROFILER_SHUTDOWN:path.resolve(geckoOut)}:process.env})
  :await chromium.launch({args:[`--use-angle=${process.platform==='darwin'?'metal':'gl'}`],headless:!process.argv.includes('--headed')});
try{
  const page=await browser.newPage({viewport:{width,height}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // The loading screen's messages, timed on the page clock.
  await page.addInitScript(()=>{
    window.__loadLog=[];
    const watch=()=>{const node=document.getElementById('gate-message');if(!node)return requestAnimationFrame(watch);
      new MutationObserver(()=>window.__loadLog.push([performance.now(),node.textContent])).observe(node,{childList:true,characterData:true,subtree:true});};
    document.addEventListener('DOMContentLoaded',watch);
  });
  const target=new URL(url);if(sim)target.searchParams.set('sim',sim);if(processMode)target.searchParams.set('process',processMode);
  const cdp=engine==='chromium'?await page.context().newCDPSession(page):null;
  if(profiled){await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:500});}
  const loads=[];
  const finish=async(name,start)=>{
    // the first frame drawn after a load that began after `start` (a failed load draws none: the wait gives up)
    await page.waitForFunction(start=>{const t=window.deusExViewer?.loadTimings();return t&&t.start>=start&&t.firstDraw!=null;},start,
      {timeout:120000,polling:16}).catch(()=>{});
    const timeline=await page.evaluate(()=>window.deusExViewer.loadTimings());
    const end=timeline&&timeline.start>=start&&timeline.firstDraw!=null?timeline.start+timeline.firstDraw:await page.evaluate(()=>performance.now());
    const log=await page.evaluate(()=>window.__loadLog.splice(0));
    // Each message's duration: until the next message (or the load's end).
    const steps=[];
    for(let i=0;i<log.length;i++){const [t,text]=log[i];if(t<start)continue;
      const next=log.slice(i+1).find(([t2])=>t2>=t)?.[0]??end;steps.push({at:Math.round(t-start),ms:Math.round(next-t),text});}
    const profile=profiled?(await cdp.send('Profiler.stop')).profile:null;
    if(profile){await mkdir('.cache/perf',{recursive:true});await writeFile(`.cache/perf/${tag}-${name}.cpuprofile`,JSON.stringify(profile));}
    const status=await page.evaluate(()=>{const s=window.deusExViewer.status();return {map:s.map,sim:s.sim,mode:s.mode,triangles:s.triangles,textures:s.textures,
      runtimeError:s.runtimeError?.message??null,toast:s.mode==='play'?null:document.getElementById('toast')?.textContent||null};});
    // A load that left Play unavailable (its kernels did not load: the page falls back to the inspect camera) is not a load of the game: from
    // 2026-11-07 to 11-09 the production build had no script-vm.wasm and every load there drew the map in inspect mode, timed as a pass.
    const drawn=Boolean(timeline&&timeline.start>=start&&timeline.firstDraw!=null)&&status.mode==='play';
    loads.push({map:name,arrived:status.map,wallMs:Math.round(end-start),drawn,status,timings:timeline,steps,cpu:profile?summarize(profile):null});
    console.error(`${name.padEnd(34)} ${status.map??'-'} ${drawn?`${(Math.round(end-start)/1000).toFixed(2)} s`:status.mode!=='play'?`no Play (${status.toast??status.mode})`:'no first frame'}${status.runtimeError?` (error: ${status.runtimeError})`:''}`);
    // the report so far, so that a run the browser does not survive keeps its loads
    if(option('out',null)){await mkdir(path.dirname(option('out')),{recursive:true});
      await writeFile(option('out'),JSON.stringify({tag,browser:engine,url:target.href,originalStart,travel,loads,errors,partial:true},null,1));}
  };
  if(profiled)await cdp.send('Profiler.start');
  await page.goto(originalStart?target.href:debugUrl(target.href));
  let picked=0;
  if(folder){
    // a production preview: the gate asks for the game folder; the time to the picker, then the folder given at once
    await page.locator('#folder').waitFor({state:'attached',timeout:120000});
    picked=await page.evaluate(()=>performance.now());
    await page.locator('#folder').setInputFiles(gameDirectory());
  }
  await page.waitForFunction(()=>window.deusExViewer?.status().ready,{},{timeout:300000,polling:50});
  const first=await page.evaluate(()=>window.deusExViewer.status().map);
  // from navigation start: module loading, the worker's start and the first map
  await finish(`first-${first}`,0);
  if(folder)loads.at(-1).pickedAtMs=Math.round(picked);
  if(savesDir){
    // the slots into the browser's save storage, through the Saves window's import (load-game.spec.mjs)
    await page.locator('#saves-input').setInputFiles(savesDir);
    await page.waitForFunction(n=>Number(/\((\d+) saves?\)/.exec(document.getElementById('saves-status')?.textContent??'')?.[1]??0)>=n,
      slots.length,{timeout:120000});
    console.error(`imported: ${await page.locator('#saves-status').textContent()}`);
    await page.waitForTimeout(2000);
  }
  for(const slot of slots){
    await page.waitForTimeout(2000);
    const start=await page.evaluate(async slot=>{const t=performance.now();await window.deusExViewer.viewProbe({exec:[`loadgame ${slot}`]});return t;},slot);
    await finish(`Save${String(slot).padStart(4,'0')}`,start);
  }
  for(const name of maps){
    // a settled page before the next load
    await page.waitForTimeout(2000);
    if(profiled)await cdp.send('Profiler.start');
    const start=travel
      ?await page.evaluate(async name=>{const t=performance.now();await window.deusExViewer.viewProbe({exec:[`open ${name}`]});return t;},name)
      :await page.evaluate(name=>{const t=performance.now();const menu=document.getElementById('map');menu.value=name;
        menu.dispatchEvent(new Event('change'));return t;},name);
    // a failed load leaves the previous map ready and says why on the loading screen: stop at that rather than the timeout
    if(!travel)await page.waitForFunction(name=>{const s=window.deusExViewer.status();
      return s.ready&&(s.map===name||!document.getElementById('gate').hidden);},name,{timeout:300000,polling:20});
    await finish(name,start);
  }
  const report={tag,browser:engine,url:target.href,originalStart,travel,loads,errors};
  if(option('out',null)){await mkdir(path.dirname(option('out')),{recursive:true});await writeFile(option('out'),JSON.stringify(report,null,1));}
  else console.log(JSON.stringify(report,null,1));
  const timed=loads.filter(l=>l.drawn).map(l=>l.wallMs).sort((a,b)=>a-b);
  if(timed.length)console.error(`${timed.length} of ${loads.length} loads drew a first frame: median ${(timed[timed.length>>1]/1000).toFixed(2)} s, max ${(timed.at(-1)/1000).toFixed(2)} s; ${errors.length} page errors`);
}finally{await browser.close();await previewServer?.close();}
