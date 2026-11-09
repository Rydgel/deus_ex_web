// The one-hour session (docs/stage-7-exit-criteria.md decision D5, row 7.4.3; docs/long-session.md): one browser, one page and one
// simulation process for --minutes. The session opens the Island from the debugging page's map list, then travels with the console's
// `open` (the engine's command chain, a travel that keeps the script process) through the other nine maps of the frame-time set
// (frame-time-maps.mjs) and back to the Island: ten map changes. On each map it runs the frame-time route with placed walks: the census
// scan (the authored view, then three more 60 degrees apart, 15 s each, standing), then four walks of 20 s from the map's start at
// headings 90 degrees apart (placeProbe puts the player back at the start; a jump when stuck). Every --save-every minutes it presses
// the Quick Save key, walks away, presses the Quick Load key and answers the original's confirm box (DeusExPlayer.QuickSave and
// QuickLoad, the save written to and read from the page's storage). The player has `god` (the console's cheat) so the hostile maps
// cannot end the session in a death.
//
// It records: every frame of the hitch log (?hitchlog=1, read in pieces with deusExHitch.since), the heaps after forced garbage
// collections (Chromium: HeapProfiler.collectGarbage three times in the page and the worker, then Runtime.getHeapUsage; Firefox: a
// Gecko memory report after its minimize, the SIGRTMIN+1 of profile-firefox-memory.mjs, Linux only: the JS heap, GC things with their
// slots and elements, as V8's usedSize counts it, with ArrayBuffer and Wasm memory and the rest kept apart) after each scan and at
// each map's end, the browser's process tree RSS (Linux) every 10 s, and every runtime error. Host measurement only.
//
// Before the hour, a warm-up pass: the route's maps but the last (the Island and the nine), --warmup minutes each, the same steps,
// no save. D5's first plateau is the Island after it (the user's reading, 2026-11-04: a cold start's first visit measures the
// process filling its classes, the packages they hold and its caches, which the original's startup loads at once; docs/long-session.md).
//
// D5 passes with no runtime error, the heap after each forced GC on the last Island visit within 10% of the first measured visit's
// plateau (the same map at the same route steps: the median of that visit's readings), and the median frame work of the last five
// minutes (the last Island visit) within 5% of the first five (the first measured one): the page's (`animate`) and, in worker mode,
// the worker's (`w.dur`). Every other map's readings are reported (row 7.4.2's figures).
//
//   node scripts/session-hour.mjs [--browser chromium|firefox] [--minutes 60] [--edge 5] (the first and last visits, minutes)
//     [--warmup 1.5] (minutes a map in the warm-up pass; 0: none, the first visit is a cold start's)
//     [--save-every 10] [--maps a,b,...] (the visits between the two Island ones) [--out .cache/perf/session/<browser>]
//     [--url URL] (else a dev server for this tree is started in process) [--size 1440x960] [--query k=v&k=v] [--headed] [--cdp-port 9341]
//     [--snapshots] (Chromium: heap snapshots of the page and the worker at the end of the first and the last Island visit,
//     <out>-<visit>-page.heapsnapshot and -worker.heapsnapshot, for scripts/heap-families.mjs)
//   node scripts/session-hour.mjs --summary <out>.json   (the verdict of a saved run again)
// Writes <out>.json (the frames, readings, events and verdict) and <out>.log (the progress lines).
import {chromium,firefox} from '@playwright/test';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,appendFileSync} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {lockedMove} from '../browser-tests/menu-cursor.mjs';
import {FRAME_TIME_SET} from './frame-time-maps.mjs';
import {debugUrl} from './page-url.mjs';
import {geckoReportPrefs,requestGeckoReport,forgetGeckoReportFifo} from './gecko-report-trigger.mjs';

const option=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i<0?f:process.argv[i+1];};
const flag=n=>process.argv.includes(`--${n}`);
const q=(a,p)=>{if(!a.length)return NaN;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
const f1=v=>Number.isFinite(v)?v.toFixed(1):'-';
const HOME='01_NYC_UNATCOIsland',HEAP_BOUND=1.10,FRAME_BOUND=1.05,SKIP_S=5;

/** The verdict of a run's record: the D5 checks and each visit's figures. */
export function verdict(run){
  const frames=run.frames,ci=Object.fromEntries(frames.columns.map((c,i)=>[c,i]));
  const rowsBetween=(a,b)=>frames.rows.slice(Math.max(0,a-frames.base),Math.max(0,b-frames.base));
  const work=rows=>{
    const page=rows.map(r=>r[ci.animate]),seen=new Set(),worker=[];
    for(const r of rows){const d=r[ci['w.dur']];if(!(d>=0)||seen.has(r[ci['w.start']]))continue;seen.add(r[ci['w.start']]);worker.push(d);}
    return {frames:rows.length,page:q(page,.5),worker:worker.length?q(worker,.5):null};
  };
  // each page phase's mean (ms) over a window: what a change of the page's frame work is made of
  const phases=rows=>Object.fromEntries(frames.columns.filter(c=>c.startsWith('p.')||c==='gpu').map(c=>[c,rows.reduce((n,r)=>n+Math.max(0,r[ci[c]]),0)/Math.max(1,rows.length)]));
  const visits=run.visits.map(v=>({...v,work:v.window?work(rowsBetween(v.window[0],v.window[1])):null,
    phases:v.window&&frames.columns.includes('p.render')?phases(rowsBetween(v.window[0],v.window[1])):null,
    heap:v.readings.map(r=>r.totalMB)}));
  // (the warm-up pass's visits are reported, not judged)
  const measured=visits.filter(v=>!v.warmup),first=measured[0],last=measured.at(-1),checks=[];
  checks.push({check:'no runtime error',pass:!run.errors.length&&!run.ended,value:run.ended??`${run.errors.length} errors`});
  const sameMap=first&&last&&measured.length>1&&first.map===last.map;
  checks.push({check:`${measured.length-1} map changes in the measured hour`,pass:measured.length-1>=10,value:measured.length-1});
  checks.push({check:'saves and loads',pass:run.saves.length>0&&run.saves.every(s=>s.loaded),value:`${run.saves.filter(s=>s.loaded).length} of ${run.saves.length}`});
  if(sameMap&&first.heap.length&&last.heap.length){
    const plateau=q(first.heap,.5),worst=Math.max(...last.heap);
    // (the same split for each part: which one grew)
    const split=['page','worker'].flatMap(owner=>['js','buffers'].map(k=>{
      const at=v=>v.readings.map(r=>r.parts?.[owner]?.[k]).filter(Number.isFinite);
      const a=at(first),b=at(last);return a.length&&b.length&&q(a,.5)>1?`${owner} ${k} ${f1(q(a,.5))} -> ${f1(Math.max(...b))}`:null;})).filter(Boolean);
    checks.push({check:'heap after forced GC: last visit within 10% of the first plateau',pass:worst<=plateau*HEAP_BOUND,
      value:`plateau ${f1(plateau)} MB, last visit ${last.heap.map(f1).join(', ')} MB (${f1((worst/plateau-1)*100)}%; ${split.join(', ')})`});
  }else checks.push({check:'heap after forced GC',pass:false,value:'no readings on the same map at both ends'});
  if(sameMap&&first.work&&last.work){
    const ratio=(a,b)=>b/a;
    const page=ratio(first.work.page,last.work.page);
    checks.push({check:'page median frame work: last five minutes within 5% of the first five',pass:page<=FRAME_BOUND,
      value:`${f1(first.work.page)} -> ${f1(last.work.page)} ms (${f1((page-1)*100)}%)`+(first.phases&&last.phases?`; phase means that moved most: ${
        Object.keys(first.phases).map(k=>[k,last.phases[k]-first.phases[k]]).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,4)
          .map(([k,d])=>`${k} ${first.phases[k].toFixed(2)} -> ${last.phases[k].toFixed(2)}`).join(', ')}`:'')});
    if(first.work.worker!==null){const worker=ratio(first.work.worker,last.work.worker);
      checks.push({check:'worker median frame work: last five minutes within 5% of the first five',pass:worker<=FRAME_BOUND,
        value:`${f1(first.work.worker)} -> ${f1(last.work.worker)} ms (${f1((worker-1)*100)}%)`});}
  }else checks.push({check:'median frame work',pass:false,value:'no window on the same map at both ends'});
  return {pass:checks.every(c=>c.pass),checks,visits:visits.map(v=>({map:v.map,warmup:Boolean(v.warmup),arrivalS:v.arrivalS,loadS:v.loadS,work:v.work,
    heapMB:v.heap,pageMB:v.readings.map(r=>r.pageMB),workerMB:v.readings.map(r=>r.workerMB),rssMB:v.readings.map(r=>r.rssMB)}))};
}
function printVerdict(v,log=console.log){
  log('\n| Visit | map | arrival (min) | load (s) | page p50 | worker p50 | heap after GC (MB) | RSS (MB) |\n|---:|---|---:|---:|---:|---:|---|---|');
  v.visits.forEach((x,i)=>log(`| ${i} | ${x.map}${x.warmup?' (warm-up)':''} | ${f1(x.arrivalS/60)} | ${f1(x.loadS)} | ${f1(x.work?.page)} | ${f1(x.work?.worker)} | ${x.heapMB.map(f1).join(', ')} | ${x.rssMB.map(v=>v??'-').join(', ')} |`));
  log('');for(const c of v.checks)log(`${c.pass?'PASS':'FAIL'}  ${c.check}: ${c.value}`);
  log(`\nD5 ${v.pass?'PASS':'FAIL'}`);
}
if(flag('summary')){printVerdict(verdict(JSON.parse(readFileSync(option('summary'),'utf8'))));process.exit(0);}

const engine=option('browser','chromium');
if(engine!=='chromium'&&engine!=='firefox')throw new Error('--browser must be chromium or firefox');
const isChromium=engine==='chromium';
// (Firefox's forced GC: the memory report's signal on Linux, its FIFO on macOS, gecko-report-trigger.mjs)
if(!isChromium&&process.platform!=='linux'&&process.platform!=='darwin')throw new Error('Firefox\'s forced GC (the memory report signal or FIFO) is Linux and macOS only');
const minutes=Number(option('minutes',60)),edge=Number(option('edge',5)),saveEvery=Number(option('save-every',10)),warmup=Number(option('warmup',1.5));
const middle=option('maps',null)?.split(',').filter(Boolean)??FRAME_TIME_SET.filter(m=>m!==HOME);
const route=[HOME,...middle,HOME];
// The visits in order: the warm-up pass (every map of the route but the last), then the measured route.
const plan=[...(warmup>0?route.slice(0,-1).map(map=>({map,kind:'warmup'})):[]),
  ...route.map((map,k)=>({map,k,kind:k===0?'first':k===route.length-1?'last':'middle'}))];
// The visits between the two edges share what is left of the session.
const middleS=(minutes-2*edge)*60/middle.length;
if(!(middleS>60))throw new Error(`--minutes ${minutes} leaves ${f1(middleS)} s a visit between the edges`);
const out=option('out',`.cache/perf/session/${engine}`),cdpPort=Number(option('cdp-port',9341));
const [width,height]=option('size','1440x960').split('x').map(Number);
mkdirSync(dirname(out),{recursive:true});writeFileSync(`${out}.log`,'');
const started=Date.now();
const say=line=>{const text=`[${f1((Date.now()-started)/60000).padStart(5)} min] ${line}`;console.log(text);appendFileSync(`${out}.log`,text+'\n');};

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

// ---- the browser (Firefox through a server, for its process id: the memory report's signal goes to this run's browser only)
let browser,ffServer=null,browserPid=0;
if(isChromium)browser=await chromium.launch({headless:!flag('headed'),args:[`--use-angle=${process.platform==='darwin'?'metal':'gl'}`,
  '--enable-precise-memory-info','--mute-audio',`--remote-debugging-port=${cdpPort}`]});
else{ffServer=await firefox.launchServer({headless:!flag('headed'),firefoxUserPrefs:{...geckoReportPrefs(),'media.volume_scale':'0.0'}});
  browserPid=ffServer.process().pid;browser=await firefox.connect(ffServer.wsEndpoint());}
const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1});
await context.addInitScript(()=>{try{localStorage.setItem('deusex.uiHidden','1');}catch{/* storage unavailable */}});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>{errors.push({atS:(Date.now()-started)/1000,message:e.message});say(`page error: ${e.message}`);});
page.on('console',m=>{const t=m.text();if(m.type()==='error'&&!/vite|Failed to load resource/.test(t)){errors.push({atS:(Date.now()-started)/1000,message:'console: '+t});say(`console error: ${t}`);}});
page.on('crash',()=>{errors.push({atS:(Date.now()-started)/1000,message:'the page crashed'});say('the page crashed');});

// ---- Chromium: CDP sessions on the page and the simulation worker (found again when its target changes)
let send=null,snapFile=null;
const sessions={page:null,worker:null,workerTarget:null};
async function openCdp(){
  const {webSocketDebuggerUrl}=await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
  const ws=new WebSocket(webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let next=1;const waiting=new Map();
  ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}
    else if(m.method==='HeapProfiler.addHeapSnapshotChunk'&&snapFile)appendFileSync(snapFile,m.params.chunk);});
  send=(method,params={},sessionId)=>new Promise(r=>{const id=next++;waiting.set(id,r);ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
}
async function cdpTargets(){
  const {result:{targetInfos}}=await send('Target.getTargets');
  if(!sessions.page){const info=targetInfos.find(t=>t.type==='page'&&t.url.startsWith(url));
    if(info)sessions.page=(await send('Target.attachToTarget',{targetId:info.targetId,flatten:true})).result.sessionId;}
  const worker=targetInfos.find(t=>t.type==='worker'&&t.url.includes('sim-worker'));
  if(worker&&worker.targetId!==sessions.workerTarget){sessions.workerTarget=worker.targetId;
    sessions.worker=(await send('Target.attachToTarget',{targetId:worker.targetId,flatten:true})).result.sessionId;}
  if(!worker){sessions.worker=null;sessions.workerTarget=null;}
}
// V8's heap (usedSize) and, apart, the ArrayBuffer backing stores (Wasm memories among them) it leaves out (backingStorageSize).
async function heapUsage(session){if(!session)return null;const r=(await send('Runtime.getHeapUsage',{},session)).result;
  return r?{js:r.usedSize/1048576,buffers:Number.isFinite(r.backingStorageSize)?r.backingStorageSize/1048576:null}:null;}

// ---- the process tree's RSS (Linux)
async function findBrowserPid(){
  if(process.platform!=='linux'||browserPid)return;
  for(const d of await readdir('/proc')){if(!/^\d+$/.test(d))continue;
    try{const cmd=await readFile(`/proc/${d}/cmdline`,'utf8');if(cmd.includes(`--remote-debugging-port=${cdpPort}`)&&!cmd.includes('--type='))browserPid=Number(d);}catch{}}
}
async function treeRss(){
  if(!browserPid||process.platform!=='linux')return null;
  const kids=new Map();
  for(const d of await readdir('/proc')){if(!/^\d+$/.test(d))continue;
    try{const st=await readFile(`/proc/${d}/stat`,'utf8');const ppid=Number(st.slice(st.lastIndexOf(')')+2).split(' ')[1]);
      (kids.get(ppid)??kids.set(ppid,[]).get(ppid)).push(Number(d));}catch{}}
  const stack=[browserPid],seen=new Set();let rss=0;
  while(stack.length){const p=stack.pop();if(seen.has(p))continue;seen.add(p);
    try{rss+=Number((await readFile(`/proc/${p}/statm`,'utf8')).split(' ')[1])*4096;}catch{}
    for(const k of kids.get(p)??[])stack.push(k);}
  return Math.round(rss/1048576);
}

// ---- Firefox: the memory report after Gecko's minimize (GC and CC), the content process that holds the page
function geckoTotals(file){
  const {reports}=JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
  const proc=reports.find(r=>r.process.startsWith('web')&&/top\(http/.test(r.path))?.process;
  if(!proc)throw new Error(`${file}: no web content process with the page`);
  // Each owner's memory in profile-firefox-memory.mjs's parts: GC things (what a major GC marks) with their out-of-line slots and
  // elements, the JS heap V8's usedSize also counts; ArrayBuffer and Wasm memory, which V8's leaves out; and the rest (DOM, layout).
  const parts={page:{js:0,buffers:0,other:0},worker:{js:0,buffers:0,other:0}};
  for(const r of reports){if(r.process!==proc||!r.path.startsWith('explicit/')||r.units!==0)continue;
    const path=r.path.replace(/worker\([^)]*sim-worker[^)]*\)/,'worker(sim)').replace(/\((http|blob)[^)]*\)/g,'(page)');
    const owner=path.includes('worker(sim)')?'worker':path.includes('top(page)')?'page':null;if(!owner)continue;
    const part=/array-buffer|\/wasm/.test(path)?'buffers':/\/gc-heap|unused-gc-things|gc-heap-arena-admin|\/gc-buffers/.test(path)?'js':'other';
    parts[owner][part]+=r.amount;}
  const mb=n=>n/1048576;
  return Object.fromEntries(Object.entries(parts).map(([owner,p])=>[owner,Object.fromEntries(Object.entries(p).map(([k,v])=>[k,mb(v)]))]));
}
async function geckoReading(){
  const before=new Set(readdirSync(tmpdir()));
  await requestGeckoReport(browserPid,true);  // Linux: SIGRTMIN+1 (glibc's SIGRTMIN is 34); macOS: the FIFO's "minimize memory report"
  for(let i=0;i<180;i++){
    await page.waitForTimeout(1000);
    const file=readdirSync(tmpdir()).find(f=>!before.has(f)&&f.startsWith('unified-memory-report-')&&f.endsWith(`-${browserPid}.json.gz`));
    // (the file appears once it is complete: Gecko writes a temporary name first and renames it)
    if(file){await page.waitForTimeout(500);const totals=geckoTotals(`${tmpdir()}/${file}`);rmSync(`${tmpdir()}/${file}`);return totals;}
  }
  throw new Error('no memory report from Firefox');
}

// ---- the page
const status=()=>page.evaluate(()=>{const s=window.deusExViewer.status();
  return {ready:s.ready,map:s.map,sim:s.sim,paused:s.paused,error:s.runtimeError?.message??null,position:s.position};});
const frameCount=()=>page.evaluate(()=>window.deusExHitch?.status().frames??0);
const probe=step=>page.evaluate(step=>window.deusExViewer.settingsProbe(step),step);
const exec=commands=>page.evaluate(exec=>window.deusExViewer.viewProbe({exec}),commands);
const menu=async()=>(await probe({op:'state'}))?.top??null;
const sameMap=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const waitFor=async(test,{timeout,step=1000,what})=>{
  for(const end=Date.now()+timeout;Date.now()<end;){const value=await test();if(value)return value;await page.waitForTimeout(step);}
  throw new Error(`timed out (${timeout/1000} s): ${what}`);
};
const arrived=async map=>{const s=await status();if(s.error)throw new Error(`runtime error: ${s.error}`);return s.ready&&sameMap(s.map,map)?s:null;};

// The hitch log's frames, read every 15 s (its ring keeps the last 96000).
// (with the page's phases, hitch-log.mjs PAGE_KEYS, so a change of the page's frame work can be placed)
const PAGE_PHASES=['p.tick','p.lighting','p.sprites','p.actors','p.lightAnimation','p.textures','p.lightUpload','p.fog','p.mirrors','p.render',
  'p.coronas','p.weapon','p.hud','p.ramp','p.audio','gpu'];
const frames={columns:['t','drawn','animate','w.start','w.dur',...PAGE_PHASES],base:0,rows:[],lost:0};
let nextFrame=0,pulling=true;
async function pull(){
  const piece=await page.evaluate(([from,names])=>window.deusExHitch.since(from,names),[nextFrame,frames.columns]);
  if(piece.from>nextFrame)frames.lost+=piece.from-nextFrame;
  for(const row of piece.rows)frames.rows.push(row);nextFrame=piece.next;
}
// The unforced samples: RSS and heaps every 10 s.
const samples=[];
async function sample(){
  const row={atS:(Date.now()-started)/1000,rssMB:await treeRss()};
  if(isChromium){row.page=await heapUsage(sessions.page).catch(()=>null);row.worker=await heapUsage(sessions.worker).catch(()=>null);}
  samples.push(row);
}
const background=(async()=>{let k=0;while(pulling){await new Promise(r=>setTimeout(r,5000));if(!pulling)break;
  try{if(++k%3===0)await pull();if(k%2===0)await sample();}catch(e){say(`background: ${e.message}`);}}})();

/** The heaps after forced collections, page and worker (MB): each realm's JS heap (`js`) and ArrayBuffer and Wasm memory (`buffers`),
 * in Firefox also the rest the report gives its window or worker (`other`), with the tree's RSS. A realm's figure (pageMB, workerMB)
 * is its JS heap and buffers. V8's backingStorageSize leaves Wasm memories out (measured: a 64 MB memory adds nothing), so in
 * Chromium each realm's live Wasm memories (hitch-wasm.mjs, after the collections) are added to its buffers; Gecko's report has them. */
async function reading(label,{snapshot=null}={}){
  const row={label,atS:(Date.now()-started)/1000,frame:await frameCount()};
  if(isChromium){
    await cdpTargets();
    for(const s of [sessions.page,sessions.worker])if(s){await send('HeapProfiler.enable',{},s);for(let i=0;i<3;i++){await send('HeapProfiler.collectGarbage',{},s);await page.waitForTimeout(300);}}
    row.parts={page:await heapUsage(sessions.page),worker:await heapUsage(sessions.worker)};
  }else row.parts=await geckoReading();
  // the live Wasm memories on each side: the page's now, the worker's as its next frames count them (hitch-wasm.mjs)
  await page.waitForTimeout(1200);
  row.wasm=await page.evaluate(()=>{const s=window.deusExHitch.seconds().at(-1),pageList=window.deusExHitch.wasmMemories();
    return {pageMB:pageList.reduce((n,m)=>n+m.mb,0),page:pageList.length,workerMB:s?.wasmWorkerMB??0,worker:s?.wasmWorkerMems??0,pageList};});
  if(isChromium){if(row.parts.page)row.parts.page.buffers=(row.parts.page.buffers??0)+row.wasm.pageMB;
    if(row.parts.worker)row.parts.worker.buffers=(row.parts.worker.buffers??0)+row.wasm.workerMB;}
  if(isChromium&&snapshot)for(const [name,s] of [['page',sessions.page],['worker',sessions.worker]])if(s){
    snapFile=`${out}-${snapshot}-${name}.heapsnapshot`;writeFileSync(snapFile,'');
    await send('HeapProfiler.takeHeapSnapshot',{reportProgress:false,captureNumericValue:false},s);snapFile=null;}
  const realm=p=>p?p.js+(p.buffers??0):null;
  row.pageMB=realm(row.parts.page);row.workerMB=realm(row.parts.worker);
  row.totalMB=(row.pageMB??0)+(row.workerMB??0);row.rssMB=await treeRss();
  // the page's asset store: the packages it holds and its released cache (main.mjs assetsProbe)
  row.pageAssets=await page.evaluate(()=>window.deusExViewer.assetsProbe?.()??null).catch(()=>null);
  if(row.pageAssets)say(`    page asset store: ${row.pageAssets.ready} packages ${f1(row.pageAssets.readyBytes/1048576)} MB, released cache ${row.pageAssets.released} (${f1(row.pageAssets.releasedBytes/1048576)} MB)`);
  // the page's script-VM kernel's block allocator (script-vm-kernel.mjs blockStats): live and freed bytes
  row.kernel=await page.evaluate(async()=>{const k=(await import('/src/runtime/script-vm-kernel.mjs')).scriptVmKernel;return k?.blockStats?.()??null;}).catch(()=>null);
  if(row.kernel)say(`    page kernel blocks: ${row.kernel.blocks} live ${f1(row.kernel.usedBytes/1048576)} MB, ${row.kernel.freed} freed ${f1(row.kernel.freeBytes/1048576)} MB, top ${f1(row.kernel.top/1048576)} of ${f1(row.kernel.memoryBytes/1048576)} MB`);
  const part=p=>p?`${f1(p.js)} + ${f1(p.buffers)}${p.other!==undefined?` (other ${f1(p.other)})`:''}`:'-';
  say(`  heap after GC (${label}): total ${f1(row.totalMB)} MB: page ${part(row.parts.page)}, worker ${part(row.parts.worker)} MB (JS + buffers), RSS ${row.rssMB??'-'} MB`+
    `; Wasm page ${row.wasm.page} memories ${row.wasm.pageMB} MB, worker ${row.wasm.worker} memories ${row.wasm.workerMB} MB`);
  return row;
}

// The original's menus under the pointer lock (browser-tests/load-game.spec.mjs clickWindow): the cursor parked at the corner, then
// moved by the window's drawing-buffer position.
async function clickWindow(field){
  const box=await page.locator('#scene').boundingBox();
  const buffer=await page.evaluate(()=>{const c=document.querySelector('#scene');return {w:c.width,h:c.height};});
  const target=(await probe({op:'center',field})).result;
  let at={x:box.x+box.width/2,y:box.y+box.height/2};
  const go=async(x,y,steps=20)=>{await lockedMove(page,at,{x,y},steps);at={x,y};await page.waitForTimeout(150);};
  if(await page.evaluate(()=>Boolean(document.pointerLockElement)))
    for(let k=0;k<4;k++){await go(at.x-box.width/2,at.y-box.height/2);await go(at.x+0.001,at.y+0.001,1);}
  else at={x:box.x,y:box.y};
  await go(at.x+box.width*target.x/buffer.w,at.y+box.height*target.y/buffer.h);
  await page.mouse.down();await page.waitForTimeout(100);await page.mouse.up();
}
const takePointer=()=>page.locator('#scene').click({position:{x:Math.round(width*.4),y:Math.round(height*.36)}});
/** God mode (the console's cheats: `set` then the toggle `god`), only when the player does not have it. */
async function cheats(){
  let c=(await page.evaluate(()=>window.deusExViewer.windowProbe())).cheats;
  if(!c.enabled)await exec(['set DeusEx.JCDentonMale bCheatsEnabled True']);
  c=(await page.evaluate(()=>window.deusExViewer.windowProbe())).cheats;
  if(String(c.reducedDamageType).toLowerCase()!=='all')await exec(['god']);
  c=(await page.evaluate(()=>window.deusExViewer.windowProbe())).cheats;
  if(!c.enabled||String(c.reducedDamageType).toLowerCase()!=='all')throw new Error(`god mode not set: ${JSON.stringify(c)}`);
}
const releaseKeys=async()=>{for(const k of ['KeyW','ArrowLeft','ArrowRight'])await page.keyboard.up(k).catch(()=>{});};

/** Quick Save, a walk away, Quick Load and its Yes: the loaded game's player stands where the save left it. */
const saves=[];
async function saveAndLoad(map){
  const save={atS:(Date.now()-started)/1000,map,loaded:false};saves.push(save);
  await releaseKeys();
  const info=()=>page.evaluate(async()=>{const list=window.deusExViewer.saves.list();if(!list.some(s=>s.dir==='QuickSave'))return null;
    const bytes=await window.deusExViewer.saves.read('QuickSave','SaveInfo.dxs');let h=0;for(const b of bytes)h=(h*31+b)>>>0;return h;});
  const before=await info();
  // (a DataLink or a conversation refuses a quick save: the key is pressed until the game takes it)
  await waitFor(async()=>{await page.keyboard.press('NumpadAdd');await page.waitForTimeout(1500);const now=await info();return now!==null&&now!==before;},
    {timeout:120000,step:0,what:'the Quick Save key wrote QuickSave'});
  const at=(await page.evaluate(()=>window.deusExViewer.placeProbe({}))).location;
  save.location=at;save.savedS=(Date.now()-started)/1000;
  await page.keyboard.down('KeyW');await page.waitForTimeout(3000);await page.keyboard.up('KeyW');
  await page.keyboard.press('NumpadDivide');
  await waitFor(async()=>await menu()==='deusex.menuuimessageboxwindow',{timeout:30000,step:500,what:'the Quick Load confirm box'});
  await clickWindow('btnYes');
  const near=p=>Math.abs(p[0]-at[0])<2&&Math.abs(p[1]-at[1])<2&&Math.abs(p[2]-at[2])<2;
  await waitFor(async()=>{if(!(await arrived(map)))return false;return near((await page.evaluate(()=>window.deusExViewer.placeProbe({}))).location);},
    {timeout:300000,what:`the loaded game stands at ${at.map(Math.round)}`});
  save.loaded=true;save.loadS=(Date.now()-started)/1000-save.savedS-3;
  await page.waitForTimeout(1000);await takePointer();await cheats();
  say(`  quick save and quick load on ${map}: back at ${at.map(Math.round).join(' ')} (${f1(save.loadS)} s after the walk)`);
}

// ---- the session
const visits=[];let ended=null;
let nextSave=saveEvery*60;
try{
  await page.goto(debugUrl(`${url}/?hitchlog=1${option('query',null)?'&'+option('query',null):''}`));
  await page.waitForFunction(()=>window.deusExViewer?.status().ready,{}, {timeout:300000});
  if(isChromium){await openCdp();await findBrowserPid();}
  // t0: the measured hour's start, the first measured visit's arrival
  let t0=null;
  for(let i=0;i<plan.length;i++){
    const {map,kind,k}=plan[i],asked=Date.now(),warm=kind==='warmup';
    say(`visit ${i}: ${map}${warm?' (warm-up)':''}`);
    await releaseKeys();
    if(i===0)await page.evaluate(map=>{const menu=document.getElementById('map');menu.value=map;menu.dispatchEvent(new Event('change'));},map);
    else await exec([`open ${map}`]);
    await waitFor(()=>arrived(map),{timeout:300000,what:`arrival on ${map}`});
    const arrival=Date.now();if(kind==='first')t0=arrival;
    await page.waitForTimeout(1000);await takePointer();await cheats();
    const visit={map,warmup:warm,arrivalS:(arrival-started)/1000,loadS:(arrival-asked)/1000,readings:[],steps:0,window:null};visits.push(visit);
    if(isChromium)await cdpTargets();
    const start=await page.evaluate(()=>window.deusExViewer.placeProbe({})),view=(await page.evaluate(()=>window.deusExViewer.viewProbe({}))).viewRotation;
    say(`  arrived in ${f1(visit.loadS)} s at ${start.location.map(Math.round).join(' ')}`);
    const edgeVisit=kind==='first'||kind==='last';
    const ends=warm?arrival+warmup*60000:edgeVisit?arrival+edge*60000:t0+(edge*60+k*middleS)*1000;
    await page.waitForTimeout(SKIP_S*1000);
    const windowStart=await frameCount();
    const left=()=>ends-Date.now();
    const hold=async ms=>{for(const end=Date.now()+ms;Date.now()<end&&left()>0;){await page.waitForTimeout(500);const s=await status();if(s.error)throw new Error(`runtime error: ${s.error}`);}};
    while(left()>0){
      // the census scan: four headings 60 degrees apart, standing at the start
      for(let k=0;k<4&&left()>0;k++){
        await page.evaluate(([location,rotation])=>window.deusExViewer.placeProbe({location,rotation}),[start.location,[view[0],(view[1]+k*10923)%65536,view[2]]]);
        await hold(15000);visit.steps++;
      }
      if(left()>0&&kind==='middle'&&(Date.now()-t0)/1000>=nextSave){await saveAndLoad(map);nextSave+=saveEvery*60;}
      if(left()>20000&&!warm)visit.readings.push(await reading(`${map} ${visit.readings.length}`));
      // the placed walks: from the start, four headings 90 degrees apart, a jump when stuck
      for(let k=0;k<4&&left()>0;k++){
        await page.evaluate(([location,rotation])=>window.deusExViewer.placeProbe({location,rotation}),[start.location,[0,(view[1]+k*16384)%65536,0]]);
        await page.keyboard.down('KeyW');
        let last=(await status()).position;
        for(const end=Date.now()+20000;Date.now()<end&&left()>0;){
          await page.waitForTimeout(1000);const s=await status();if(s.error)throw new Error(`runtime error: ${s.error}`);
          if(Math.hypot(...s.position.map((v,j)=>v-last[j]))<30)await page.keyboard.press('Space');last=s.position;
        }
        await page.keyboard.up('KeyW');visit.steps++;
      }
    }
    await releaseKeys();
    visit.window=[windowStart,await frameCount()];
    visit.readings.push(await reading(`${map}${warm?' (warm-up)':''} end`,{snapshot:isChromium&&flag('snapshots')&&edgeVisit?`visit${i}`:null}));
    await pull();
  }
}catch(error){ended=error.message;say(`ended: ${error.message}`);}
pulling=false;await background;
try{await pull();}catch{}
const run={browser:engine,args:process.argv.slice(2),started:new Date(started).toISOString(),minutes:(Date.now()-started)/60000,
  sim:await page.evaluate(()=>window.deusExViewer.status().sim).catch(()=>null),route,warmup,visits,saves,samples,errors,ended,frames};
run.verdict=verdict(run);
writeFileSync(`${out}.json`,JSON.stringify(run));
printVerdict(run.verdict,say);
say(`saved ${out}.json: ${frames.rows.length} frames (${frames.lost} lost), ${samples.length} samples`);
await browser.close().catch(()=>{});await ffServer?.close();await server?.close();forgetGeckoReportFifo();
process.exit(run.verdict.pass?0:1);
