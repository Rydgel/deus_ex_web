/**
 * Real-Play frame profile in Chromium (Metal backend) against a running dev
 * server. Measures what the player sees: rAF intervals, a CPU profile bucketed
 * by animate()'s direct callees, optional allocation sampling and per-frame
 * ScriptRuntime work counts. Host measurement only; see docs/play-frame-cost.md.
 *
 *   node scripts/profile-play-browser.mjs [--url http://127.0.0.1:5173]
 *     [--walk] [--frames 300] [--tag name] [--alloc] [--counts]
 *
 * The raw .cpuprofile is written to .cache/perf/<tag>.cpuprofile (outside Git).
 */
import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';

const option=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const url=option('url','http://127.0.0.1:5173'),frames=Number(option('frames',300)),tag=option('tag','play');
const walk=process.argv.includes('--walk'),alloc=process.argv.includes('--alloc'),counts=process.argv.includes('--counts');
const label=frame=>`${frame.functionName||'(anon)'} ${frame.url.split('/').at(-1).split('?')[0]}:${frame.lineNumber+1}`;
const perFrame=ms=>+(ms/frames).toFixed(2);

const browser=await chromium.launch({args:['--use-angle=metal']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(()=>window.deusExViewer?.status().gameplay?.hud?.health?.head?.displayedHealth===100,
    {},{timeout:180000});
  await page.locator('#scene').click({position:{x:600,y:350}});
  await page.waitForTimeout(3000);
  if(walk)await page.keyboard.down('KeyW');
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval',{interval:200});
  await cdp.send('Profiler.start');
  const intervals=await page.evaluate(async frames=>{
    const samples=[];let last=performance.now();
    for(let i=0;i<frames;i++){const now=await new Promise(requestAnimationFrame);samples.push(now-last);last=now;}
    return samples;
  },frames);
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
  const report={tag,url,walk,frames,
    intervalMs:{mean:+(intervals.reduce((a,b)=>a+b,0)/frames).toFixed(2),median:pct(.5),p95:pct(.95),max:pct(1),
      missedVsync:intervals.filter(ms=>ms>20).length},
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
    return {mode:s.mode,paused:s.paused,runtimeError:s.runtimeError,drawCalls:s.calls};});
  console.log(JSON.stringify({...report,state,errors},null,1));
} finally {await browser.close();}
