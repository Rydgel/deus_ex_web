/**
 * What Play keeps alive in Chromium (docs/live-heap.md): opens the debugging page against a running dev server, loads --map from the
 * map list, walks forward for --seconds, forces V8's GC three times in each realm and writes a heap snapshot of the page and, in worker
 * mode, of the simulation worker, with each realm's heap usage. Host measurement only. scripts/heap-families.mjs reads the snapshots.
 *
 *   node scripts/profile-live-heap.mjs [--url http://127.0.0.1:5173] [--map 01_NYC_UNATCOIsland] [--sim worker|inline] [--seconds 30]
 *     [--out .cache/perf/heap-island] [--cdp-port 9372]
 *
 * Writes <out>-<sim>-page.heapsnapshot, <out>-<sim>-worker.heapsnapshot (worker mode) and <out>-<sim>.json (outside Git: a snapshot of
 * the Island's worker is about 2 GB).
 */
import {chromium} from '@playwright/test';
import {appendFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import { debugUrl } from './page-url.mjs';

const option=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i<0?f:process.argv[i+1];};
const url=option('url','http://127.0.0.1:5173'),map=option('map','01_NYC_UNATCOIsland'),sim=option('sim','worker');
const seconds=Number(option('seconds',30)),out=option('out','.cache/perf/heap-island'),port=Number(option('cdp-port',9372));
mkdirSync(dirname(out),{recursive:true});
const browser=await chromium.launch({args:[`--use-angle=${process.platform==='darwin'?'metal':'gl'}`,`--remote-debugging-port=${port}`]});
const page=await (await browser.newContext({viewport:{width:1440,height:960},deviceScaleFactor:1})).newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const target=new URL(debugUrl(`${url}/`));target.searchParams.set('sim',sim);
await page.goto(target.href);
await page.waitForFunction(()=>window.deusExViewer?.status().ready,{}, {timeout:300000});
await page.locator('#map').selectOption(map);
await page.waitForFunction(m=>{const s=window.deusExViewer?.status();return s?.ready&&s.map===m;},map,{timeout:300000});
await page.locator('#scene').click({position:{x:576,y:345}});
await page.keyboard.down('KeyW');await page.waitForTimeout(seconds*1000);await page.keyboard.up('KeyW');
const status=await page.evaluate(()=>{const s=window.deusExViewer.status();return {map:s.map,sim:s.sim,paused:s.paused,runtimeError:s.runtimeError?.message??null};});
const {webSocketDebuggerUrl}=await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws=new WebSocket(webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let next=1,snapFile=null;const waiting=new Map();
ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}
  else if(m.method==='HeapProfiler.addHeapSnapshotChunk'&&snapFile)appendFileSync(snapFile,m.params.chunk);});
const send=(method,params={},sessionId)=>new Promise(r=>{const id=next++;waiting.set(id,r);ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
const {result:{targetInfos}}=await send('Target.getTargets');
const realms=[['page',targetInfos.find(t=>t.type==='page'&&t.url.startsWith(url))]];
if(sim==='worker')realms.push(['worker',targetInfos.find(t=>t.type==='worker'&&t.url.includes('sim-worker'))]);
const report={map,sim,seconds,status,errors,heaps:{}};
for(const [name,info] of realms){
  if(!info){console.log(`no ${name} target`);continue;}
  const {result:{sessionId}}=await send('Target.attachToTarget',{targetId:info.targetId,flatten:true});
  await send('HeapProfiler.enable',{},sessionId);
  for(let i=0;i<3;i++){await send('HeapProfiler.collectGarbage',{},sessionId);await new Promise(r=>setTimeout(r,500));}
  const usage=(await send('Runtime.getHeapUsage',{},sessionId)).result;
  report.heaps[name]=usage;
  console.log(`${name}: heap used ${(usage.usedSize/1048576).toFixed(0)} MB of ${(usage.totalSize/1048576).toFixed(0)} MB`);
  snapFile=`${out}-${sim}-${name}.heapsnapshot`;writeFileSync(snapFile,'');
  await send('HeapProfiler.takeHeapSnapshot',{reportProgress:false,captureNumericValue:false},sessionId);
  console.log(`  ${snapFile}`);snapFile=null;
}
writeFileSync(`${out}-${sim}.json`,JSON.stringify(report,null,1));
console.log('status',JSON.stringify(status),'page errors',errors.length);
await browser.close();
