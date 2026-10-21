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
 *     [--no-profile] (wall-clock phases without CPU sampling overhead)
 *     [--draw-counts] (count submitted mesh groups after timing)
 *     [--fixed-dt seconds] (explicit fixed-step comparison workload, not live FPS)
 *     [--query gpuMesh=1] (viewer URL switches, e.g. the GPU mesh path)
 *     [--preview weapon] (a viewer preview after the start click, e.g. Training's crowbar)
 *     [--place '{"location":[x,y,z],"rotation":[p,y,r]}'] (the player placed before the settle)
 *     [--lod-settings '{"shapeLOD":10}'] (URender's MLOD/MLMODE/MLFIX on the simulation side)
 *     [--angle metal|gl|vulkan] (ANGLE backend: metal on macOS, gl elsewhere;
 *       Linux headless Chromium ignores metal and falls back to SwiftShader)
 *     [--headed] [--executable /usr/bin/chromium] (a visible window, another Chromium)
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
import { debugUrl } from './page-url.mjs';

const option=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const url=option('url','http://127.0.0.1:5173'),frames=Number(option('frames',300)),tag=option('tag','play');
const map=option('map',null);
const [width,height]=option('size','1440x960').split('x').map(Number),dpr=Number(option('dpr',1));
const walk=process.argv.includes('--walk'),alloc=process.argv.includes('--alloc'),counts=process.argv.includes('--counts');
const profiled=!process.argv.includes('--no-profile');
const drawCounts=process.argv.includes('--draw-counts');
const fixedDt=Number(option('fixed-dt',0));
if(!Number.isFinite(fixedDt)||fixedDt<0||process.argv.includes('--fixed-dt')&&fixedDt===0)
  throw new Error('--fixed-dt must be a finite positive number');
const noMirrors=process.argv.includes('--no-mirrors'),noMeshLighting=process.argv.includes('--no-mesh-lighting');
const noSky=process.argv.includes('--no-sky'),noSimulation=process.argv.includes('--no-simulation');
const bypass=process.argv.includes('--bypass'),settle=Number(option('settle',3000));
// --gpu: the viewer's ?gpuTimer=1 (EXT_disjoint_timer_query_webgl2 around the
// frame's GL work); phases.gpu is then GPU ms per measured frame, valid when
// phases.gpuFrames is near 1 and phases.gpuDisjoint is 0.
const gpu=process.argv.includes('--gpu');
const label=frame=>`${frame.functionName||'(anon)'} ${frame.url.split('/').at(-1).split('?')[0]}:${frame.lineNumber+1}`;
let perFrameCount=frames;
const perFrame=ms=>+(ms/perFrameCount).toFixed(2);

const angle=option('angle',process.platform==='darwin'?'metal':'gl');
const browser=await chromium.launch({args:[`--use-angle=${angle}`],headless:!process.argv.includes('--headed'),
  executablePath:option('executable',undefined)});
try {
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:dpr});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  if(noMirrors||noMeshLighting||noSky||noSimulation||fixedDt)await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/,async route=>{
    const response=await route.fetch();let body=await response.text();
    if(fixedDt){
      const original='const dt = Math.max(0, (time - lastTime) / 1000);';
      if(!body.includes(original))throw new Error('Fixed-step measurement patch no longer matches animate()');
      body=body.replace(original,`const dt = ${fixedDt};`);
    }
    // Each switch patches one line of animate(); a patch that no longer
    // matches fails instead of measuring the unpatched frame.
    const patch=(from,to,what)=>{
      if(!body.includes(from))throw new Error(`${what} measurement patch no longer matches animate()`);
      body=body.replace(from,to);
    };
    if(noMirrors)patch('world.mirrors.render(renderer, scene, camera, { markers: world.markers, sky: world.sky,',
      'false && world.mirrors.render(renderer, scene, camera, { markers: world.markers, sky: world.sky,','--no-mirrors');
    if(noMeshLighting)patch('if(meshLighting&&!runtimeError){','if(false&&meshLighting&&!runtimeError){','--no-mesh-lighting');
    if(noSky)patch('const sky = drawWorld ? skyFrame() : null;','const sky = null;','--no-sky');
    if(noSimulation)patch('if (!paused && !runtimeError && !document.hidden) {',
      'if (false && !paused && !runtimeError && !document.hidden) {','--no-simulation');
    await route.fulfill({response,body});
  });
  if(bypass)for(const [pattern,from,to] of BYPASS_PATCHES)await page.route(
    new RegExp(`${pattern.source.replace(/\$$/,'')}(?:\\?|$)`),async route=>{
      const response=await route.fetch();const body=await response.text();
      if(!body.includes(from))throw new Error(`Bypass patch no longer matches ${route.request().url()}`);
      await route.fulfill({response,body:body.replace(from,to)});
    });
  const target=new URL(url);if(gpu)target.searchParams.set('gpuTimer','1');
  // --query gpuMesh=1: extra viewer switches (A/B of a render path).
  for(const [key,value] of new URLSearchParams(option('query','')))target.searchParams.set(key,value);
  await page.goto(debugUrl(target.href));
  await page.waitForFunction(()=>window.deusExViewer?.status().ready,{}, {timeout:180000});
  if(map){await page.locator('#map').selectOption(map);
    await page.waitForFunction(map=>{const s=window.deusExViewer?.status();return s?.ready&&s.map===map;},map,{timeout:180000});}
  await page.waitForFunction(noSimulation=>{const s=window.deusExViewer?.status();
    return noSimulation?Boolean(s?.gameplay?.hud):s?.gameplay?.hud?.health?.head?.displayedHealth===100;},
    noSimulation,{timeout:180000});
  await page.locator('#scene').click({position:{x:600,y:350}});
  if(option('preview',null))await page.evaluate(name=>{const menu=document.getElementById('preview');menu.value=name;
    menu.dispatchEvent(new Event('change'));},option('preview',null));
  // --place '{"location":[x,y,z],"rotation":[p,y,r]}': the player moved
  // there (decal-probe.mjs placeProbe) before the settle.
  if(option('place',null))await page.evaluate(args=>window.deusExViewer.placeProbe(JSON.parse(args)),option('place',null));
  // --lod-settings '{"shapeLOD":10}': URender's MLOD, MLMODE or MLFIX, set on the simulation side
  // (lod-probe.mjs; validation), e.g. to make mirror frames draw other LOD states than the main frame.
  if(option('lod-settings',null))await page.evaluate(args=>window.deusExViewer.lodProbe({settings:JSON.parse(args)}),option('lod-settings',null));
  await page.waitForTimeout(settle);
  if(walk)await page.keyboard.down('KeyW');
  await page.evaluate(()=>window.deusExViewer.framePhases(true));
  const cdp=await page.context().newCDPSession(page);
  if(profiled){
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval',{interval:200});
    await cdp.send('Profiler.start');
  }
  const intervals=await page.evaluate(async frames=>{
    const samples=[];let last=performance.now();
    for(let i=0;i<frames;i++){const now=await new Promise(requestAnimationFrame);samples.push(now-last);last=now;
      if(window.deusExViewer.framePhases(false).runtimeError)break;}
    return samples;
  },frames);
  const phaseTotals=await page.evaluate(()=>window.deusExViewer.framePhases(true));
  perFrameCount=Math.max(1,intervals.length);
  const profile=profiled?(await cdp.send('Profiler.stop')).profile:null;
  if(profile){
    await mkdir('.cache/perf',{recursive:true});
    await writeFile(`.cache/perf/${tag}.cpuprofile`,JSON.stringify(profile));
  }

  // Inclusive time per animate() callee; samples outside animate keep their
  // top-level frame, e.g. (garbage collector) or (program).
  const byId=new Map((profile?.nodes??[]).map(node=>[node.id,node])),parent=new Map();
  for(const node of profile?.nodes??[])for(const child of node.children??[])parent.set(child,node.id);
  const buckets=new Map();let sampled=0;
  for(let i=0;i<(profile?.samples.length??0);i++){
    const ms=profile.timeDeltas[i]/1000,path=[];sampled+=ms;
    for(let id=profile.samples[i];id!==undefined;id=parent.get(id))path.unshift(byId.get(id));
    const at=path.findIndex(node=>node.callFrame.functionName==='animate'&&node.callFrame.url.includes('main.mjs'));
    const key=at<0?label(path[1]?.callFrame??path.at(-1).callFrame):path[at+1]?label(path[at+1].callFrame):'animate (self)';
    buckets.set(key,(buckets.get(key)??0)+ms);
  }
  const sorted=intervals.toSorted((a,b)=>a-b),pct=p=>+sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))].toFixed(1);
  const measured=intervals.length;
  const report={tag,url,map,walk,frames:measured,profiled,stoppedAt:phaseTotals.runtimeError,bypass,
    size:`${width}x${height}`,dpr,noMirrors,noMeshLighting,noSky,noSimulation,fixedDt:fixedDt||null,
    intervalMs:{mean:+(intervals.reduce((a,b)=>a+b,0)/measured).toFixed(2),median:pct(.5),p95:pct(.95),max:pct(1),
      missedVsync:intervals.filter(ms=>ms>20).length},
    // Drawn frames (deusExViewer.framePhases draws): with ?sim=worker a
    // display frame without a new snapshot draws nothing.
    drawIntervalMs:phaseTotals.draws?+(intervals.reduce((a,b)=>a+b,0)/phaseTotals.draws).toFixed(2):null,
    phases:Object.fromEntries(Object.entries(phaseTotals).filter(([key,value])=>typeof value==='number'&&key!=='frames')
      .map(([key,value])=>[key,+(value/Math.max(1,phaseTotals.frames)).toFixed(2)])),
    cpuMsPerFrame:profile?{sampled:perFrame(sampled),...Object.fromEntries([...buckets].sort((a,b)=>b[1]-a[1])
      .filter(([,ms])=>perFrame(ms)>=.05).map(([key,ms])=>[key,perFrame(ms)]))}:null};

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
  if(drawCounts){
    // Inspect actual submissions after timing; this diagnostic callback must
    // not inflate the measured render cost. A double-sided transparent mesh
    // can produce two WebGL calls for one onBeforeRender callback.
    report.meshSubmissions=await page.evaluate(async()=>{
      const source=performance.getEntriesByType('resource').map(entry=>entry.name)
        .find(name=>/\/three(?:\.js|\/)/.test(name));
      if(!source)throw new Error('Cannot locate the renderer module for draw counts');
      const {Mesh}=await import(source),original=Mesh.prototype.onBeforeRender;
      const totals={};let frames=0;
      Mesh.prototype.onBeforeRender=function(renderer,scene,camera,geometry,material,group){
        const kind=camera.isOrthographicCamera?'hud':this.userData.model?
          (this.userData.actor?'movers':'world'):this.userData.actor||this.userData.actorBatch?'actors':'other';
        const row=totals[kind]??={groups:0,triangles:0};row.groups++;
        row.triangles+=Math.min(geometry.drawRange.count,group?.count??Infinity,
          geometry.index?.count??geometry.attributes.position.count)/3;
        return original.apply(this,arguments);
      };
      try{while(frames<30){
        await new Promise(requestAnimationFrame);frames++;
        if(window.deusExViewer.framePhases(false).runtimeError)break;
      }}finally{Mesh.prototype.onBeforeRender=original;}
      return {frames,...Object.fromEntries(Object.entries(totals).map(([kind,row])=>[kind,
        Object.fromEntries(Object.entries(row).map(([key,total])=>[key,+(total/Math.max(1,frames)).toFixed(1)]))]))};
    });
  }
  if(walk)await page.keyboard.up('KeyW');
  const state=await page.evaluate(()=>{const s=window.deusExViewer.status();
    const gl=document.getElementById('scene').getContext('webgl2'),debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {mode:s.mode,paused:s.paused,runtimeError:s.runtimeError,drawCalls:s.calls,mirrors:s.mirrors,
      gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};});
  console.log(JSON.stringify({...report,state,errors},null,1));
  // Keep partial diagnostics, but do not let a stopped/paused workload pass
  // as a successful performance check (a frozen simulation can look fast).
  if(errors.length||state.runtimeError||state.paused||state.mode!=='play'||measured!==frames)process.exitCode=1;
} finally {await browser.close();}
