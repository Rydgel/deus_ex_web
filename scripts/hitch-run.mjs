// A Play session recorded by the in-page hitch log (?hitchlog=1, docs/hitch-log.md), in Chromium or Firefox: the harness opens a map,
// drives the player, samples memory, and saves the recorder's full dump with the run's settings to <out>.json. Host measurement only
// (the Stage 7 frame-time and hitch rows, docs/stage-7-exit-criteria.md; scripts/hitch-summary.mjs reads the file).
//
//   node scripts/hitch-run.mjs --map 01_NYC_UNATCOIsland --seconds 120 --mode roam [--browser chromium|firefox] [--out PREFIX]
//     [--url http://127.0.0.1:5173] (else a dev server for this tree is started in process, as the validators do; --vite-port N gives it that port)
//     [--via MAP] (opened first; MAP is then reached through the map list) [--settle 3000] [--size 1440x960] [--dpr 1]
//     [--query k=v&k=v] [--place JSON] (placeProbe before the settle) [--god] (the console's god mode before the settle)
//     [--headed] [--no-hitchlog] [--worker-patch FILE]
//     [--screenshot FILE] (a PNG of the page at the end of the run)
//     [--show-ui] (the page bars stay; by default they are hidden and the canvas is the whole --size)
//   Modes: roam (forward, turning when stuck or at random), walk (forward), idle, scan (the census route: four headings 60 degrees
//     apart, each held for a quarter of --seconds, set through placeProbe's ViewRotation write; the first is the authored view).
//   Chromium: [--angle metal|gl] (default metal on macOS, gl elsewhere) [--exe PATH] [--throttle 4] [--trace] (V8 GC events in the JSON's
//     `gc`: `pageMs` is the page's performance.now(), `logMs` the hitch log's time, the clock of its rows' `t` and `w.start`)
//     [--heap-sampling promoted|all|live] [--heap-interval 16384] [--heap-steps 8] [--heap-leaves 25] [--heap-depth 5] (frames per site) (<out>.heap.json: the totals by site, leaf, sim-session step and
//     file, and `byStep`: each of the N largest steps' top M leaves and top 5-frame sites; the KB a frame is printed) [--worker-profile] [--sample-us 500] (<out>.worker.cpuprofile, for
//     scripts/hitch-frame-profile.mjs) [--load-profile [FRAMES]] (the same profile taken from the end of the --map load to the worker's FRAMES-th frame,
//     60 by default: the first frames of Play, which --worker-profile starts too late for; the dump also keeps the page's `loadTimings`) [--stall MS --stall-every S] (the worker paused by the debugger) [--cdp-port 9336]
//     [--js-flags FLAGS] (V8 flags, e.g. '--trace-gc --trace-incremental-marking'; V8 prints to the browser's stdout, which
//     DEBUG=pw:browser forwards to this process's stderr)
//   Firefox: [--gclog] (javascript.options.mem.log lines) [--profile FILE] (a Gecko profile at shutdown, for scripts/gecko-gc.mjs)
//     [--ff-asyncstack] (keep the async stack capture Playwright's driver turns on; off by default since 2026-11-04)
// The browser's process tree RSS is sampled on Linux only (/proc). Moved from .work/hitch/run.mjs and run-ff.mjs (2026-10-28).
import {chromium,firefox} from '@playwright/test';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const option=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i<0?f:process.argv[i+1];};
const flag=n=>process.argv.includes(`--${n}`);
const engine=option('browser','chromium');
if(engine!=='chromium'&&engine!=='firefox')throw new Error('--browser must be chromium or firefox');
const isChromium=engine==='chromium';
const map=option('map','01_NYC_UNATCOIsland'),via=option('via',null),seconds=Number(option('seconds',60)),mode=option('mode','roam');
if(!['roam','walk','idle','scan'].includes(mode))throw new Error('--mode must be roam, walk, idle or scan');
const out=option('out',`.cache/perf/hitch/${engine}-${map}-${mode}`),settle=Number(option('settle',3000));
const [width,height]=option('size','1440x960').split('x').map(Number),dpr=Number(option('dpr',1));
const throttle=Number(option('throttle',1)),cdpPort=Number(option('cdp-port',9336)),traced=isChromium&&flag('trace');

let server=null,url=option('url',null);
if(!url){
  const root=fileURLToPath(new URL('..',import.meta.url));
  const {createServer}=await import('vite');
  const {default:base}=await import('../vite.config.mjs');
  const deny=base.server.fs.deny.filter(pattern=>!(pattern.includes('.work')&&root.includes('/.work/'))
    &&!(pattern.includes('.claude/worktrees')&&root.includes('/.claude/worktrees/')));
  server=await createServer({...base,configFile:false,root,logLevel:'error',
    server:{...base.server,port:Number(option('vite-port',0)),strictPort:Boolean(option('vite-port',0)),host:'127.0.0.1',fs:{...base.server.fs,deny},watch:null}});
  await server.listen();url=server.resolvedUrls.local[0].replace(/\/$/,'');
}

const profOut=option('profile',null);
const browser=isChromium
  ?await chromium.launch({args:[`--use-angle=${option('angle',process.platform==='darwin'?'metal':'gl')}`,'--enable-precise-memory-info','--mute-audio',
    `--remote-debugging-port=${cdpPort}`,...(option('js-flags',null)?[`--js-flags=${option('js-flags',null)}`]:[])],headless:!flag('headed'),executablePath:option('exe',undefined)})
  // Firefox captures an async stack at every promise and await only for a page under a debugger, which Playwright's driver makes
  // every page (docs/load-time.md "Firefox under Playwright"): off, as in a player's Firefox, unless --ff-asyncstack keeps it.
  :await firefox.launch({headless:!flag('headed'),firefoxUserPrefs:{...(flag('gclog')?{'javascript.options.mem.log':true}:{}),
    ...(flag('ff-asyncstack')?{}:{'javascript.options.asyncstack':false})},
    env:profOut?{...process.env,MOZ_PROFILER_STARTUP:'1',MOZ_PROFILER_STARTUP_FEATURES:'js,threads,markers',
      MOZ_PROFILER_STARTUP_FILTERS:'GeckoMain,DOM Worker',MOZ_PROFILER_STARTUP_ENTRIES:'40000000',MOZ_PROFILER_SHUTDOWN:profOut}:process.env});
const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:dpr});
// The page bars hidden (main.mjs setUiHidden), so the canvas is the whole --size, as in the validators; --show-ui keeps them.
if(!flag('show-ui'))await context.addInitScript(()=>{try{localStorage.setItem('deusex.uiHidden','1');}catch{/* storage unavailable */}});
const page=await context.newPage();
const errors=[],gclog=[];page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{const t=m.text();if(m.type()==='error'&&!/vite|Failed to load resource/.test(t))errors.push('console: '+t);if(/^GC\(/.test(t))gclog.push(t);});
// --worker-patch FILE: a script prepended to the simulation worker's module (an allocation counter, a probe).
// --load-profile [FRAMES] (Chromium): a CPU profile of the simulation worker from the end of the --map load to its FRAMES-th frame (default 60),
// saved as <out>.worker.cpuprofile with the clock join scripts/hitch-frame-profile.mjs reads (the first frames of Play, which --worker-profile
// starts too late to see). The harness attaches to the worker when it is created; a patch of the worker's module starts and stops the profile
// with console.profile at the `loaded` and the FRAMES-th `frame` messages, after a 20 ms marker function at a known epoch time.
const loadProfile=isChromium&&flag('load-profile')?(Number(option('load-profile',60))||60):0;
let patchText=option('worker-patch',null)?await readFile(option('worker-patch',null),'utf8'):'';
if(loadProfile)patchText=`(()=>{const MAP=${JSON.stringify(map)},FRAMES=${loadProfile};let lastMap=null,seen=-1;
  self.addEventListener('message',e=>{if(e.data?.type==='load')lastMap=e.data.map;});
  const post=self.postMessage.bind(self);
  self.postMessage=(message,transfer)=>{
    if(message?.type==='loaded'&&lastMap===MAP){
      console.profile('load');
      console.info('LOADPROFILE '+JSON.stringify({workerEpochMs:__hitchSync()}));seen=0;
    }else if(message?.type==='frame'&&seen>=0&&++seen>=FRAMES){seen=-1;console.profileEnd('load');}
    return post(message,transfer);
  };
  // (a named function the marker's samples are found by)
  function __hitchSync(){const t=performance.timeOrigin+performance.now(),e=performance.now()+20;while(performance.now()<e);return t;}})();\n`+patchText;
if(patchText)await context.route(/\/sim-worker\.mjs/,async route=>{const r=await route.fetch();const body=await r.text();await route.fulfill({response:r,body:patchText+'\n'+body});});
// The browser's CDP socket, opened before the page when the load profile needs the worker as it is created.
let send=null,workerSession=null,cdp=null,loadProfileResult=null,loadSync=null;const attachedWorkers=new Set();
async function openBrowserCdp(){
  if(send)return;
  const {webSocketDebuggerUrl}=await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
  const ws=new WebSocket(webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let next=1;const waiting=new Map();
  ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}else if(m.method)onCdpEvent(m);});
  send=(method,params={},sessionId)=>new Promise(r=>{const id=next++;waiting.set(id,r);ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
}
function onCdpEvent(m){
  if(process.env.HITCH_CDP_DEBUG)console.error('cdp event',m.method,m.sessionId??'',JSON.stringify(m.params).slice(0,160));
  // (a worker's target is created with an empty url, which targetInfoChanged fills in)
  if((m.method==='Target.targetCreated'||m.method==='Target.targetInfoChanged')&&m.params.targetInfo.type==='worker'&&m.params.targetInfo.url.includes('sim-worker')
    &&!attachedWorkers.has(m.params.targetInfo.targetId)){attachedWorkers.add(m.params.targetInfo.targetId);attachWorker(m.params.targetInfo.targetId);}
  else if(m.method==='Profiler.consoleProfileFinished'&&m.sessionId===workerSession)loadProfileResult=m.params.profile;
  else if(m.method==='Runtime.consoleAPICalled'&&m.sessionId===workerSession){
    const text=m.params.args?.[0]?.value;if(typeof text==='string'&&text.startsWith('LOADPROFILE '))loadSync=JSON.parse(text.slice(12));}
}
async function attachWorker(targetId){
  workerSession=(await send('Target.attachToTarget',{targetId,flatten:true})).result.sessionId;
  if(loadProfile){await send('Profiler.enable',{},workerSession);await send('Profiler.setSamplingInterval',{interval:Number(option('sample-us',500))},workerSession);
    await send('Runtime.enable',{},workerSession);}
}
if(loadProfile){await openBrowserCdp();await send('Target.setDiscoverTargets',{discover:true});}
const target=new URL(url);target.searchParams.set('debug','1');if(!flag('no-hitchlog'))target.searchParams.set('hitchlog','1');
for(const [k,v] of new URLSearchParams(option('query','')))target.searchParams.set(k,v);
await page.goto(target.href);
await page.waitForFunction(()=>window.deusExViewer?.status().ready,{}, {timeout:300000});
const choose=async name=>{
  // (set through the DOM: the hidden bars' menu takes no clicks)
  await page.evaluate(map=>{const menu=document.getElementById('map');menu.value=map;menu.dispatchEvent(new Event('change'));},name);
  await page.waitForFunction(m=>{const s=window.deusExViewer?.status();return s?.ready&&s.map===m;},name,{timeout:300000});
};
if(via){await choose(via);await page.waitForTimeout(3000);}
await choose(map);
await page.waitForFunction(()=>window.deusExViewer.status().gameplay?.hud?.health?.head?.displayedHealth===100,{}, {timeout:240000}).catch(()=>{});
// (a click in 00_Intro skips it)
if(map!=='00_Intro')await page.locator('#scene').click({position:{x:Math.round(width*.4),y:Math.round(height*.36)}});
if(option('place',null))await page.evaluate(args=>window.deusExViewer.placeProbe(JSON.parse(args)),option('place',null));
// --god: the console's cheats (`set DeusEx.JCDentonMale bCheatsEnabled True`, then the toggle `god`, as session-hour.mjs gives them),
// so that a hostile map cannot end the session in a death (which leads to DXOnly); the NPCs still see, shoot and chase the player
if(flag('god'))await page.evaluate(exec=>window.deusExViewer.viewProbe({exec}),['set DeusEx.JCDentonMale bCheatsEnabled True','god']);
await page.waitForTimeout(settle);
await mkdir(dirname(out),{recursive:true});

// ---- Chromium: CDP for CPU throttling, the worker's heap and profiles; Linux: the process tree's RSS
if(isChromium){
  cdp=await context.newCDPSession(page);
  if(throttle>1)await cdp.send('Emulation.setCPUThrottlingRate',{rate:throttle});
  await openBrowserCdp();
  if(!workerSession){
    const {result:{targetInfos}}=await send('Target.getTargets');
    const worker=targetInfos.find(t=>t.type==='worker'&&t.url.includes('sim-worker'));
    if(worker)workerSession=(await send('Target.attachToTarget',{targetId:worker.targetId,flatten:true})).result.sessionId;
  }
}
let browserPid=0;
if(process.platform==='linux')for(const d of await readdir('/proc')){if(!/^\d+$/.test(d))continue;
  try{const cmd=await readFile(`/proc/${d}/cmdline`,'utf8');
    if(isChromium?cmd.includes(`--remote-debugging-port=${cdpPort}`)&&!cmd.includes('--type='):cmd.includes('ms-playwright')&&/firefox/.test(cmd)&&!cmd.includes('-contentproc'))
      browserPid=Number(d);}catch{}}
async function treeRss(){
  const kids=new Map();
  for(const d of await readdir('/proc')){if(!/^\d+$/.test(d))continue;
    try{const st=await readFile(`/proc/${d}/stat`,'utf8');const ppid=Number(st.slice(st.lastIndexOf(')')+2).split(' ')[1]);
      (kids.get(ppid)??kids.set(ppid,[]).get(ppid)).push(Number(d));}catch{}}
  const stack=[browserPid],seen=new Set();let rss=0;const procs=[];
  while(stack.length){const p=stack.pop();if(seen.has(p))continue;seen.add(p);
    try{const pages=Number((await readFile(`/proc/${p}/statm`,'utf8')).split(' ')[1]);const cmd=await readFile(`/proc/${p}/cmdline`,'utf8');
      const type=cmd.match(/--type=([a-z-]+)/)?.[1]??(cmd.includes('-contentproc')?'content':'browser');rss+=pages*4096;procs.push({pid:p,type,mb:Math.round(pages*4096/1048576)});}catch{}
    for(const k of kids.get(p)??[])stack.push(k);}
  return {rssMB:Math.round(rss/1048576),procs};
}
const samples=[];let sampling=true;
const sampler=(async()=>{while(sampling){
  const row={date:Date.now()};
  if(browserPid)try{Object.assign(row,await treeRss());}catch{}
  if(workerSession){const h=(await send('Runtime.getHeapUsage',{},workerSession)).result;if(h){row.workerHeapMB=Math.round(h.usedSize/1048576);row.workerHeapTotalMB=Math.round(h.totalSize/1048576);}}
  samples.push(row);await new Promise(r=>setTimeout(r,2000));}})();

const heapSampling=option('heap-sampling',null);  // 'promoted' | 'all' | 'live'
if(heapSampling&&workerSession){
  await send('HeapProfiler.enable',{},workerSession);
  await send('HeapProfiler.startSampling',{samplingInterval:Number(option('heap-interval',16384)),
    includeObjectsCollectedByMajorGC:heapSampling!=='live',includeObjectsCollectedByMinorGC:heapSampling==='all'},workerSession);
}
const workerProfiled=flag('worker-profile')&&workerSession;
let profileSync=null;
if(workerProfiled){await send('Profiler.enable',{},workerSession);await send('Profiler.setSamplingInterval',{interval:Number(option('sample-us',500))},workerSession);await send('Profiler.start',{},workerSession);
  // a 20 ms busy function at a known worker epoch time: its samples place the profile's clock against the hitch log's (hitch-frame-profile.mjs)
  const r=await send('Runtime.evaluate',{expression:'(function __hitchSync(){const t=performance.timeOrigin+performance.now(),e=performance.now()+20;while(performance.now()<e);return t;})()',returnByValue:true},workerSession);
  profileSync={workerEpochMs:r.result.result.value,pageTimeOrigin:await page.evaluate(()=>performance.timeOrigin)};}
let traceSyncPage=null;
if(traced){await browser.startTracing(page,{categories:['disabled-by-default-v8.gc','v8','blink.user_timing']});
  traceSyncPage=await page.evaluate(()=>{performance.mark('hitch-sync');return performance.now();});}

// ---- input
let stop=false;
const positionOf=()=>page.evaluate(()=>window.deusExViewer.status().position);
const headings=[];
async function driver(){
  if(mode==='idle')return;
  if(mode==='scan'){
    // The census route (docs/play-frame-cost.md "October 2"): the authored view, then three more 60 degrees apart (10923 of 65536).
    const start=(await page.evaluate(()=>window.deusExViewer.viewProbe({}))).viewRotation;
    for(let k=0;k<4&&!stop;k++){
      const rotation=[start[0],(start[1]+k*10923)%65536,start[2]];
      if(k)await page.evaluate(r=>window.deusExViewer.placeProbe({rotation:r}),rotation);
      headings.push({t:await page.evaluate(()=>performance.now()),rotation});
      for(const end=Date.now()+seconds*250;Date.now()<end&&!stop;)await page.waitForTimeout(200);
    }
    return;
  }
  await page.keyboard.down('KeyW');
  if(mode==='walk')return;
  let last=await positionOf(),turns=0;
  while(!stop){
    await page.waitForTimeout(1000);if(stop)break;
    const now=await positionOf();
    const moved=Math.hypot(now[0]-last[0],now[1]-last[1],now[2]-last[2]);last=now;
    const stuck=moved<30,random=Math.random()<.15;
    if(stuck||random){
      const key=(turns++%3===2)?'ArrowLeft':'ArrowRight';
      await page.keyboard.down(key);await page.waitForTimeout(stuck?500+Math.random()*700:200+Math.random()*400);await page.keyboard.up(key);
      if(stuck)await page.keyboard.press('Space');
    }
  }
}
// --stall MS --stall-every S (Chromium): the worker is paused (Debugger.pause) for MS every S seconds, to see what the frames after a stall cost.
const stallMs=Number(option('stall',0)),stallEvery=Number(option('stall-every',20)),stalls=[];
if(stallMs&&workerSession){
  await send('Debugger.enable',{},workerSession);
  (async()=>{while(!stop){await new Promise(r=>setTimeout(r,stallEvery*1000));if(stop)break;
    const at=Date.now();await send('Debugger.pause',{},workerSession);await new Promise(r=>setTimeout(r,stallMs));await send('Debugger.resume',{},workerSession);
    stalls.push({at,ms:stallMs});}})();
}
const t0=Date.now();
const driving=driver().catch(e=>errors.push('driver: '+e.message));
// A runtime error stops the run early.
let ended=null;
while(Date.now()-t0<seconds*1000){
  await new Promise(r=>setTimeout(r,1000));
  const err=await page.evaluate(()=>window.deusExViewer.status().runtimeError?.message??null);
  if(err){ended=err;break;}
}
stop=true;await driving;sampling=false;await sampler;
await page.keyboard.up('KeyW').catch(()=>{});
if(throttle>1&&cdp)await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
const status=await page.evaluate(()=>{const s=window.deusExViewer.status(),c=document.getElementById('scene');
  return {map:s.map,sim:s.sim,paused:s.paused,runtimeError:s.runtimeError?.message??s.runtimeError,position:s.position,canvas:[c.width,c.height]};});
// --screenshot FILE: the page as it is at the end of the run (the HUD drawn from the worker's snapshot)
if(option('screenshot',null))await page.screenshot({path:option('screenshot',null)});
const dump=await page.evaluate(()=>window.deusExHitch?window.deusExHitch.dump({full:true}):null);
// the map load's steps (main.mjs loadTimeline): the page's marks in ms from the load's start and the simulation worker's
const loadTimings=await page.evaluate(()=>window.deusExViewer.loadTimings?.()??null).catch(()=>null);
let gc=null;
if(traced){
  const buf=await browser.stopTracing();await writeFile(`${out}.trace.json`,buf);
  const trace=JSON.parse(buf);const events=trace.traceEvents??trace;const syncEvent=events.find(e=>e.name==='hitch-sync');
  const names=new Map();for(const e of events)if(e.ph==='M'&&e.name==='thread_name')names.set(`${e.pid}:${e.tid}`,e.args.name);
  gc=[];for(const e of events){if(e.ph!=='X'||!e.dur)continue;if(!/^(MajorGC|MinorGC|V8\.GC_.*)$/.test(e.name))continue;
    const pageMs=syncEvent?(e.ts-syncEvent.ts)/1000+traceSyncPage:null;
    // logMs: the hitch log counts from its own start (meta.originMs), so a GC event lines up with the rows' t only after that shift
    gc.push({name:e.name,ts:e.ts,pageMs,logMs:pageMs!==null&&dump?.meta?pageMs-dump.meta.originMs:null,dur:e.dur,thread:names.get(`${e.pid}:${e.tid}`)??`${e.pid}:${e.tid}`,before:e.args?.data?.usedHeapSizeBefore??null,after:e.args?.data?.usedHeapSizeAfter??null});}
}
if(heapSampling&&workerSession){
  const {result}=await send('HeapProfiler.stopSampling',{},workerSession);
  const sites=new Map(),leaf=new Map(),step=new Map(),file=new Map(),stepLeaf=new Map(),stepSites=new Map(),stepAudio=new Map();let total=0;
  const label=f=>`${f.functionName||'(anon)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber+1}`;
  const fn=f=>`${f.functionName||'(anon)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}`;
  const bump=(m,k,v)=>m.set(k,(m.get(k)??0)+v),siteDepth=Number(option("heap-depth",5));  // --heap-depth N: frames per site (default 5)
  // The step is the callee of sim-session's frame(): the first function below `frame viewer/sim-session.mjs` on the stack.
  (function visit(node,stack,stepName,inAudio){const here=[...stack,label(node.callFrame)];total+=node.selfSize;
    let st=stepName;
    // Galaxy's Update runs inside the HUD step (game.mjs wraps hud.commands): its share is kept apart (script-audio-live.mjs `update`)
    const audio=inAudio||/^update runtime\/script-audio-live\.mjs/.test(fn(node.callFrame));
    if(stack.length&&/^frame viewer\/sim-session\.mjs/.test(stack[stack.length-1]))st=fn(node.callFrame);
    if(node.selfSize){bump(sites,here.slice(-siteDepth).reverse().join(' < '),node.selfSize);bump(leaf,fn(node.callFrame),node.selfSize);
      bump(step,st??'(outside frame)',node.selfSize);bump(file,node.callFrame.url.split('/').slice(-2).join('/').split('?')[0]||'(native)',node.selfSize);
      // the step x leaf and step x 5-frame-site cells (the leaf's own file and function, so a step's allocation shows what builds it)
      if(audio)bump(stepAudio,st??'(outside frame)',node.selfSize);
      bump(stepLeaf,`${st??'(outside frame)'}\t${fn(node.callFrame)}`,node.selfSize);bump(stepSites,`${st??'(outside frame)'}\t${here.slice(-siteDepth).reverse().join(' < ')}`,node.selfSize);}
    for(const c of node.children)visit(c,here,st,audio);})(result.profile.head,[],null,false);
  const top=(m,n)=>[...m].sort((a,b)=>b[1]-a[1]).slice(0,n);
  // --heap-steps N (default 8): the N largest steps each get their top leaves and top 5-frame sites (byStep), and a KB-per-frame summary is printed.
  const frames=dump?.summary?.frames??null,stepCount=Number(option('heap-steps',8)),leafCount=Number(option('heap-leaves',25));
  const byStep={};
  for(const [name,bytes] of top(step,stepCount)){
    const cell=m=>top(new Map([...m].filter(([k])=>k.startsWith(`${name}\t`)).map(([k,v])=>[k.slice(name.length+1),v])),leafCount);
    byStep[name]={bytes,audioBytes:stepAudio.get(name)??0,leaf:cell(stepLeaf),sites:top(new Map([...stepSites].filter(([k])=>k.startsWith(`${name}\t`)).map(([k,v])=>[k.slice(name.length+1),v])),15)};
  }
  await writeFile(`${out}.heap.json`,JSON.stringify({mode:heapSampling,total,frames,sites:top(sites,400),leaf:top(leaf,150),step:top(step,60),file:top(file,60),byStep}));
  const kb=bytes=>frames?(bytes/1024/frames).toFixed(1):'-';
  console.log(`heap sampling ${heapSampling}: ${(total/1048576).toFixed(0)} MB over ${frames} frames = ${kb(total)} KB a frame`);
  for(const [name,entry] of Object.entries(byStep)){
    console.log(`  ${kb(entry.bytes).padStart(7)} KB/frame  ${name}${entry.audioBytes?` (Galaxy's Update inside it: ${kb(entry.audioBytes)})`:''}`);
    for(const [leafName,bytes] of entry.leaf.slice(0,6))console.log(`      ${kb(bytes).padStart(7)}  ${leafName}`);
  }
}
if(workerProfiled){const {result}=await send('Profiler.stop',{},workerSession);await writeFile(`${out}.worker.cpuprofile`,JSON.stringify(result.profile));}
if(loadProfile){
  if(!loadProfileResult)console.log('load profile: the worker did not reach its frame count (no profile)');
  else{await writeFile(`${out}.worker.cpuprofile`,JSON.stringify(loadProfileResult));
    profileSync={workerEpochMs:loadSync.workerEpochMs,pageTimeOrigin:await page.evaluate(()=>performance.timeOrigin)};}
}
await writeFile(`${out}.json`,JSON.stringify({browser:engine,mode,headings,profileSync,loadTimings,stalls,args:process.argv.slice(2),status,ended,errors,samples,dump,gc,gclog}));
await browser.close();await server?.close();
console.log(`saved ${out}.json ${engine} ${status.sim} frames ${dump?.summary?.frames} drawn ${dump?.summary?.drawn} rows ${dump?.rows?.length} map ${status.map} ended ${ended} errors ${errors.length}`);
if(errors.length)console.log(errors.slice(0,5).join('\n'));
