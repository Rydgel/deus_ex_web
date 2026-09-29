/**
 * Real-Play frame profile in Chromium (Metal backend) against a running dev
 * server. Measures what the player sees: rAF intervals, a CPU profile bucketed
 * by animate()'s direct callees, optional allocation sampling and per-frame
 * ScriptRuntime work counts. Host measurement only; see docs/play-frame-cost.md.
 *
 *   node scripts/profile-play-browser.mjs [--url http://127.0.0.1:5173]
 *     [--map 01_NYC_UNATCOIsland] [--walk] [--frames 300] [--tag name] [--alloc] [--counts]
 *     [--no-mirrors] [--no-mesh-lighting] [--no-sky] [--no-simulation]
 *     [--size 1440x960] [--dpr 1] [--settle 3000] [--bypass]
 *
 * The raw .cpuprofile is written to .cache/perf/<tag>.cpuprofile (outside Git).
 * `phases` is deusExViewer.framePhases(): wall ms per animate() phase.
 * --bypass applies scripts/bench-sim-hooks.mjs BYPASS_PATCHES so a map whose
 * simulation reaches an explicit unimplemented boundary within seconds keeps
 * running; frames after a bypass are a timing workload only. The list is
 * currently empty, so --bypass serves every module unchanged.
 * Measurement stops early at a runtime error, reported as `stoppedAt`.
 */
import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {BYPASS_PATCHES} from './bench-sim-hooks.mjs';

const option=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const url=option('url','http://127.0.0.1:5173'),frames=Number(option('frames',300)),tag=option('tag','play');
const map=option('map',null);
const [width,height]=option('size','1440x960').split('x').map(Number),dpr=Number(option('dpr',1));
const walk=process.argv.includes('--walk'),alloc=process.argv.includes('--alloc'),counts=process.argv.includes('--counts');
const noMirrors=process.argv.includes('--no-mirrors'),noMeshLighting=process.argv.includes('--no-mesh-lighting');
const noSky=process.argv.includes('--no-sky'),noSimulation=process.argv.includes('--no-simulation');
const bypass=process.argv.includes('--bypass'),settle=Number(option('settle',3000));
const label=frame=>`${frame.functionName||'(anon)'} ${frame.url.split('/').at(-1).split('?')[0]}:${frame.lineNumber+1}`;
let perFrameCount=frames;
const perFrame=ms=>+(ms/perFrameCount).toFixed(2);

const browser=await chromium.launch({args:['--use-angle=metal']});
try {
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:dpr});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  if(noMirrors||noMeshLighting||noSky||noSimulation)await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/,async route=>{
    const response=await route.fetch();let body=await response.text();
    if(noMirrors)body=body.replace('world.mirrors.render(renderer, scene, camera, { markers: world.markers, sky: world.sky,',
      'false && world.mirrors.render(renderer, scene, camera, { markers: world.markers, sky: world.sky,');
    if(noMeshLighting)body=body.replace('if(meshLighting&&!runtimeError){','if(false&&meshLighting&&!runtimeError){');
    if(noSky)body=body.replace('if (world.sky) {','if (false && world.sky) {');
    if(noSimulation)body=body.replace('if (!paused && !runtimeError && !document.hidden) {',
      'if (false && !paused && !runtimeError && !document.hidden) {');
    await route.fulfill({response,body});
  });
  if(bypass)for(const [pattern,from,to] of BYPASS_PATCHES)await page.route(
    new RegExp(`${pattern.source.replace(/\$$/,'')}(?:\\?|$)`),async route=>{
      const response=await route.fetch();const body=await response.text();
      if(!body.includes(from))throw new Error(`Bypass patch no longer matches ${route.request().url()}`);
      await route.fulfill({response,body:body.replace(from,to)});
    });
  await page.goto(url);
  await page.waitForFunction(()=>window.deusExViewer?.status().ready,{}, {timeout:180000});
  if(map){await page.locator('#map').selectOption(map);
    await page.waitForFunction(map=>{const s=window.deusExViewer?.status();return s?.ready&&s.map===map;},map,{timeout:180000});}
  await page.waitForFunction(noSimulation=>{const s=window.deusExViewer?.status();
    return noSimulation?Boolean(s?.gameplay?.hud):s?.gameplay?.hud?.health?.head?.displayedHealth===100;},
    noSimulation,{timeout:180000});
  await page.locator('#scene').click({position:{x:600,y:350}});
  await page.waitForTimeout(settle);
  if(walk)await page.keyboard.down('KeyW');
  await page.evaluate(()=>window.deusExViewer.framePhases(true));
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval',{interval:200});
  await cdp.send('Profiler.start');
  const intervals=await page.evaluate(async frames=>{
    const samples=[];let last=performance.now();
    for(let i=0;i<frames;i++){const now=await new Promise(requestAnimationFrame);samples.push(now-last);last=now;
      if(window.deusExViewer.framePhases(false).runtimeError)break;}
    return samples;
  },frames);
  const phaseTotals=await page.evaluate(()=>window.deusExViewer.framePhases(true));
  perFrameCount=Math.max(1,intervals.length);
  const {profile}=await cdp.send('Profiler.stop');
  await mkdir('.cache/perf',{recursive:true});
  await writeFile(`.cache/perf/${tag}.cpuprofile`,JSON.stringify(profile));

  // Inclusive time per animate() callee; samples outside animate keep their
  // top-level frame, e.g. (garbage collector) or (program).
  const byId=new Map(profile.nodes.map(node=>[node.id,node])),parent=new Map();
  for(const node of profile.nodes)for(const child of node.children??[])parent.set(child,node.id);
  const buckets=new Map();let sampled=0;
  for(let i=0;i<profile.samples.length;i++){
    const ms=profile.timeDeltas[i]/1000,path=[];sampled+=ms;
    for(let id=profile.samples[i];id!==undefined;id=parent.get(id))path.unshift(byId.get(id));
    const at=path.findIndex(node=>node.callFrame.functionName==='animate'&&node.callFrame.url.includes('main.mjs'));
    const key=at<0?label(path[1]?.callFrame??path.at(-1).callFrame):path[at+1]?label(path[at+1].callFrame):'animate (self)';
    buckets.set(key,(buckets.get(key)??0)+ms);
  }
  const sorted=intervals.toSorted((a,b)=>a-b),pct=p=>+sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))].toFixed(1);
  const measured=intervals.length;
  const report={tag,url,map,walk,frames:measured,stoppedAt:phaseTotals.runtimeError,bypass,
    size:`${width}x${height}`,dpr,noMirrors,noMeshLighting,noSky,noSimulation,
    intervalMs:{mean:+(intervals.reduce((a,b)=>a+b,0)/measured).toFixed(2),median:pct(.5),p95:pct(.95),max:pct(1),
      missedVsync:intervals.filter(ms=>ms>20).length},
    phases:Object.fromEntries(Object.entries(phaseTotals).filter(([key,value])=>typeof value==='number'&&key!=='frames')
      .map(([key,value])=>[key,+(value/Math.max(1,phaseTotals.frames)).toFixed(2)])),
    cpuMsPerFrame:{sampled:perFrame(sampled),...Object.fromEntries([...buckets].sort((a,b)=>b[1]-a[1])
      .filter(([,ms])=>perFrame(ms)>=.05).map(([key,ms])=>[key,perFrame(ms)]))}};

  if(alloc){
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling',{samplingInterval:8192,
      includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
    const measured=await page.evaluate(async()=>{for(let i=0;i<120;i++)await new Promise(requestAnimationFrame);return 120;});
    const {profile:heap}=await cdp.send('HeapProfiler.stopSampling');
    const sites=new Map();let total=0;
    (function visit(node){total+=node.selfSize;const key=label(node.callFrame);
      sites.set(key,(sites.get(key)??0)+node.selfSize);for(const child of node.children)visit(child);})(heap.head);
    await cdp.send('HeapProfiler.collectGarbage');
    report.allocation={mbPerFrame:+(total/measured/1048576).toFixed(2),
      retainedMb:+((await cdp.send('Runtime.getHeapUsage')).usedSize/1048576).toFixed(0),
      topKbPerFrame:Object.fromEntries([...sites].sort((a,b)=>b[1]-a[1]).slice(0,15)
        .map(([key,bytes])=>[key,Math.round(bytes/measured/1024)]))};
  }
  if(counts){
    // Wrapping the prototype perturbs timing, so it runs after the timed phase.
    report.runtimeCallsPerFrame=await page.evaluate(async()=>{
      const source=performance.getEntriesByType('resource').map(entry=>entry.name)
        .find(name=>name.includes('/src/runtime/script-runtime.mjs'));
      const {ScriptRuntime}=await import(source??'/src/runtime/script-runtime.mjs');
      const prototype=ScriptRuntime.prototype,calls={};
      for(const name of ['namedReference','fieldReference','lookupMember','defaultValue','executeScript','invokeNative','processEvent']){
        const original=prototype[name];
        prototype[name]=function(...args){calls[name]=(calls[name]??0)+1;return original.apply(this,args);};
      }
      for(let i=0;i<60;i++)await new Promise(requestAnimationFrame);
      return Object.fromEntries(Object.entries(calls).map(([name,count])=>[name,Math.round(count/60)]));
    });
  }
  if(walk)await page.keyboard.up('KeyW');
  const state=await page.evaluate(()=>{const s=window.deusExViewer.status();
    return {mode:s.mode,paused:s.paused,runtimeError:s.runtimeError,drawCalls:s.calls,mirrors:s.mirrors};});
  console.log(JSON.stringify({...report,state,errors},null,1));
} finally {await browser.close();}
