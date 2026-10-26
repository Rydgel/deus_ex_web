/**
 * Map load time in Chromium (Metal backend) against a running dev server
 * (Stage 7, docs/roadmap.md "Measure loading time"). Opens the debugging page,
 * times the first map's load from navigation, then each --maps entry chosen
 * from the map list, from the list's change event until the page reports the
 * map ready, and on to the first frame drawn after it (the first tick and the
 * first use of the shader programs). `timings` is the viewer's load timeline
 * (deusExViewer.loadTimings: the page's steps, the simulation side's in the
 * worker or inline, the first drawn frame); the loading screen's progress
 * messages are kept with their times. Host measurement only.
 *
 *   node scripts/profile-map-load.mjs [--url http://127.0.0.1:5173]
 *     [--maps 01_NYC_UNATCOIsland,02_NYC_BatteryPark] [--sim worker|inline]
 *     [--profile] (a CPU profile of the page per load: with --sim inline it covers the simulation side too)
 *     [--tag name] [--size 1440x960] [--headed]
 *
 * The raw .cpuprofile files go to .cache/perf/<tag>-<map>.cpuprofile (outside Git).
 */
import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import { debugUrl } from './page-url.mjs';

const option=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const url=option('url','http://127.0.0.1:5173'),tag=option('tag','load'),sim=option('sim',null);
const maps=(option('maps','01_NYC_UNATCOIsland')).split(',').filter(Boolean);
const profiled=process.argv.includes('--profile');
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

const browser=await chromium.launch({args:[`--use-angle=${process.platform==='darwin'?'metal':'gl'}`],headless:!process.argv.includes('--headed')});
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
  const target=new URL(url);if(sim)target.searchParams.set('sim',sim);
  const cdp=await page.context().newCDPSession(page);
  if(profiled){await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:500});}
  const loads=[];
  const finish=async(name,start)=>{
    // the first frame drawn after the load (a failed load draws none: the wait gives up after 20 s)
    await page.waitForFunction(()=>window.deusExViewer.loadTimings()?.firstDraw!=null,{},{timeout:20000,polling:16}).catch(()=>{});
    const end=await page.evaluate(()=>performance.now());
    const log=await page.evaluate(()=>window.__loadLog.splice(0));
    // Each message's duration: until the next message (or the load's end).
    const steps=[];
    for(let i=0;i<log.length;i++){const [t,text]=log[i];if(t<start)continue;
      const next=log.slice(i+1).find(([t2])=>t2>=t)?.[0]??end;steps.push({at:Math.round(t-start),ms:Math.round(next-t),text});}
    const profile=profiled?(await cdp.send('Profiler.stop')).profile:null;
    if(profile){await mkdir('.cache/perf',{recursive:true});await writeFile(`.cache/perf/${tag}-${name}.cpuprofile`,JSON.stringify(profile));}
    const status=await page.evaluate(()=>{const s=window.deusExViewer.status();return {map:s.map,sim:s.sim,triangles:s.triangles,textures:s.textures,runtimeError:s.runtimeError?.message??null};});
    const timings=await page.evaluate(()=>window.deusExViewer.loadTimings());
    loads.push({map:name,wallMs:Math.round(end-start),status,timings,steps,cpu:profile?summarize(profile):null});
  };
  if(profiled)await cdp.send('Profiler.start');
  await page.goto(debugUrl(target.href));
  await page.waitForFunction(()=>window.deusExViewer?.status().ready,{},{timeout:300000,polling:50});
  const first=await page.evaluate(()=>window.deusExViewer.status().map);
  // from navigation start: module loading, the worker's start and the first map
  await finish(`first-${first}`,0);
  for(const name of maps){
    // a settled page before the next load
    await page.waitForTimeout(2000);
    if(profiled)await cdp.send('Profiler.start');
    const start=await page.evaluate(name=>{const t=performance.now();const menu=document.getElementById('map');menu.value=name;
      menu.dispatchEvent(new Event('change'));return t;},name);
    // a failed load leaves the previous map ready and says why on the loading screen: stop at that rather than the timeout
    await page.waitForFunction(name=>{const s=window.deusExViewer.status();
      return s.ready&&(s.map===name||!document.getElementById('gate').hidden);},name,{timeout:300000,polling:20});
    await finish(name,start);
  }
  console.log(JSON.stringify({tag,url:target.href,loads,errors},null,1));
}finally{await browser.close();}
