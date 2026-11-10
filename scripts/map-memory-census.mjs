// Memory per arrival over a travel census of distinct maps (Stage 7 rows 7.4.1 and 7.4.2, docs/map-memory.md): one browser, one page
// and one script process. The debugging page's first map, then the console's `open` (a travel that keeps the script process, as the
// original's `open` keeps the engine) to each map of --maps in turn. At each arrival, after --settle seconds: the heaps after forced
// collections, as session-hour.mjs reads them (Chromium: HeapProfiler.collectGarbage three times in the page and the worker, then
// Runtime.getHeapUsage, each realm's live Wasm memories from the hitch log added to its buffers; Firefox: a Gecko memory report after
// its minimize, the SIGRTMIN+1 of profile-firefox-memory.mjs, Linux only), the browser's process tree RSS (Linux), the page's asset
// store (assetsProbe) and the simulation side's process (processProbe: its classes, packages, released cache and the level runtimes
// still reachable). Host measurement only.
//
//   node scripts/map-memory-census.mjs [--browser chromium|firefox] [--sim worker|inline] [--maps a,b,... | all] [--from 0] [--count 30]
//     (all: the 83 single-player maps in name order, every map but DXMP_*; --from/--count take a slice of them)
//     [--no-hitchlog] (the page without ?hitchlog=1: no Wasm memory counts but Gecko's report's)
//     [--ff-prefs '{"name":value}'] (Firefox: more preferences, for experiments)
//     [--gc-logs 10] (Firefox: Gecko's GC and CC edge logs after those arrivals, into <out>-logs/<i>/)
//     [--gc minimize|report|none] (the forced collections; report: Firefox's memory report without its minimize; none: nothing forced)
//     [--settle 3] [--snapshots 5,29] (Chromium: heap snapshots of the page and the worker at those arrivals, <out>-<i>-page.heapsnapshot)
//     [--url URL] (else a dev server for this tree in process) [--size 1440x960] [--query k=v&k=v] [--cdp-port 9343] [--out .cache/perf/map-memory/<browser>]
//   node scripts/map-memory-census.mjs --summary <out>.json
// Writes <out>.json after every arrival (a run the browser does not survive keeps its readings).
import {chromium,firefox} from '@playwright/test';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,appendFileSync,statSync,renameSync} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {debugUrl} from './page-url.mjs';
import {geckoReportPrefs,requestGeckoReport,forgetGeckoReportFifo} from './gecko-report-trigger.mjs';

const option=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i<0?f:process.argv[i+1];};
const flag=n=>process.argv.includes(`--${n}`);
const f1=v=>Number.isFinite(v)?v.toFixed(1):'-';

/** The table of a run: one row per arrival, and the slope of the total over the second half (MB a map). */
function summarize(run){
  const rows=run.arrivals.filter(a=>a.reading);
  console.log('| # | map | load (s) | page JS | page buffers | worker JS | worker buffers | total | RSS before GC | RSS | page store | sim classes | sim packages | levels |');
  console.log('|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|');
  rows.forEach((a,i)=>{const r=a.reading,p=r.parts.page??{},w=r.parts.worker??{},s=r.process;
    console.log(`| ${i} | ${a.map} | ${f1(a.loadS)} | ${f1(p.js)} | ${f1(p.buffers)} | ${f1(w.js)} | ${f1(w.buffers)} | ${f1(r.totalMB)} | ${r.rssBeforeMB??'-'} | ${r.rssMB??'-'} | `+
      `${r.pageAssets?`${r.pageAssets.ready} ${f1(r.pageAssets.readyBytes/1048576)} MB`:'-'} | ${s?.classes??'-'} | ${s?`${s.packages} ${f1(s.packageMB)} MB`:'-'} | ${s?.levels??'-'} |`);});
  // least squares over the second half of the arrivals
  const half=rows.slice(rows.length>>1),fit=key=>{const xs=half.map((_,i)=>i),ys=half.map(key);if(ys.length<3)return NaN;
    const mx=xs.reduce((a,b)=>a+b)/xs.length,my=ys.reduce((a,b)=>a+b)/ys.length;
    return xs.reduce((n,x,i)=>n+(x-mx)*(ys[i]-my),0)/xs.reduce((n,x)=>n+(x-mx)**2,0);};
  console.log(`\nslope over the last ${half.length} arrivals (MB a map): total ${f1(fit(a=>a.reading.totalMB))}, RSS ${f1(fit(a=>a.reading.rssMB??NaN))} (before GC ${f1(fit(a=>a.reading.rssBeforeMB??NaN))})`+
    ['page','worker'].flatMap(o=>['js','buffers'].map(k=>`, ${o} ${k} ${f1(fit(a=>a.reading.parts[o]?.[k]??NaN))}`)).join(''));
  if(run.errors.length)console.log(`${run.errors.length} errors: ${run.errors.slice(0,5).map(e=>e.message).join(' | ')}`);
  if(run.ended)console.log(`ended: ${run.ended}`);
}
if(flag('summary')){summarize(JSON.parse(readFileSync(option('summary'),'utf8')));process.exit(0);}

const engine=option('browser','chromium');
if(engine!=='chromium'&&engine!=='firefox')throw new Error('--browser must be chromium or firefox');
const isChromium=engine==='chromium';
// (Firefox's forced GC: the memory report's signal on Linux, its FIFO on macOS, gecko-report-trigger.mjs)
if(!isChromium&&process.platform!=='linux'&&process.platform!=='darwin')throw new Error('Firefox\'s forced GC (the memory report signal or FIFO) is Linux and macOS only');
const mapsOption=option('maps','all');
const all=mapsOption==='all'
  ?(await readdir(path.join(gameDirectory(),'Maps'))).filter(f=>/\.dx$/i.test(f)&&!/^DXMP_/i.test(f)).map(f=>f.replace(/\.dx$/i,'')).sort()
  :mapsOption.split(',').filter(Boolean);
const from=Number(option('from',0)),maps=all.slice(from,from+Number(option('count',all.length)));
// --gc: minimize (the forced collections), report (Firefox: the memory report without Gecko's minimize), none (nothing forced: the RSS and
// Chromium's heap usage as they are)
const gc=option('gc','minimize');
if(!['minimize','report','none'].includes(gc))throw new Error('--gc must be minimize, report or none');
// --gc-logs i,j (Firefox): after those arrivals' readings, Gecko's GC and CC edge logs (SIGRTMIN+2, which runs a collection and a cycle
// collection to write them) into <out>-logs/<i>/
const gcLogs=new Set((option('gc-logs','')).split(',').filter(Boolean).map(Number)),logDir=`${option('out',`.cache/perf/map-memory/${option('browser','chromium')}`)}-logs`;
if(gcLogs.size&&process.platform!=='linux')throw new Error('--gc-logs: the GC and CC logs\' signal (SIGRTMIN+2) is Linux only');
const settle=Number(option('settle',3)),snapshots=new Set((option('snapshots','')).split(',').filter(Boolean).map(Number));
const out=option('out',`.cache/perf/map-memory/${engine}`),cdpPort=Number(option('cdp-port',9343)),sim=option('sim',null);
const [width,height]=option('size','1440x960').split('x').map(Number);
mkdirSync(path.dirname(out),{recursive:true});writeFileSync(`${out}.log`,'');
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
if(isChromium)browser=await chromium.launch({args:[`--use-angle=${process.platform==='darwin'?'metal':'gl'}`,
  '--enable-precise-memory-info','--mute-audio',`--remote-debugging-port=${cdpPort}`]});
else{ffServer=await firefox.launchServer({headless:true,firefoxUserPrefs:{...geckoReportPrefs(),'media.volume_scale':'0.0','javascript.options.asyncstack':false,...JSON.parse(option('ff-prefs','{}'))},
  ...(gcLogs.size?{env:{...process.env,MOZ_CC_LOG_DIRECTORY:path.resolve(logDir)}}:{})});
  browserPid=ffServer.process().pid;browser=await firefox.connect(ffServer.wsEndpoint());}
const page=await (await browser.newContext({viewport:{width,height},deviceScaleFactor:1})).newPage();
const errors=[];
page.on('pageerror',e=>{errors.push({atS:(Date.now()-started)/1000,message:e.message});say(`page error: ${e.message}`);});
page.on('console',m=>{const t=m.text();if(m.type()==='error'&&!/vite|Failed to load resource/.test(t)){errors.push({atS:(Date.now()-started)/1000,message:'console: '+t});say(`console error: ${t}`);}});
page.on('crash',()=>{errors.push({atS:(Date.now()-started)/1000,message:'the page crashed'});say('the page crashed');});

// ---- Chromium: CDP sessions on the page and the simulation worker (session-hour.mjs)
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
async function heapUsage(session){if(!session)return null;const r=(await send('Runtime.getHeapUsage',{},session)).result;
  return r?{js:r.usedSize/1048576,buffers:Number.isFinite(r.backingStorageSize)?r.backingStorageSize/1048576:null}:null;}

// ---- the process tree's RSS (Linux)
async function findBrowserPid(){
  if(process.platform!=='linux'||browserPid)return;
  for(const d of await readdir('/proc')){if(!/^\d+$/.test(d))continue;
    try{const cmd=await readFile(`/proc/${d}/cmdline`,'utf8');if(cmd.includes(`--remote-debugging-port=${cdpPort}`)&&!cmd.includes('--type='))browserPid=Number(d);}catch{}}
}
// (with each process kind's share: Chromium's --type, Firefox's content process kind; `rssKinds` keeps the last walk's)
let rssKinds=null;
const kindOf=cmd=>/--type=([\w-]+)/.exec(cmd)?.[1]??(/-contentproc/.test(cmd)?`content ${/ (tab|gpu|rdd|socket|utility|forkserver|web\w*)(?: |$)/.exec(cmd.replaceAll('\0',' '))?.[1]??''}`.trim():'browser');
async function treeRss(){
  if(!browserPid||process.platform!=='linux')return null;
  const kids=new Map();
  for(const d of await readdir('/proc')){if(!/^\d+$/.test(d))continue;
    try{const st=await readFile(`/proc/${d}/stat`,'utf8');const ppid=Number(st.slice(st.lastIndexOf(')')+2).split(' ')[1]);
      (kids.get(ppid)??kids.set(ppid,[]).get(ppid)).push(Number(d));}catch{}}
  const stack=[browserPid],seen=new Set();let rss=0;const kinds={};
  while(stack.length){const p=stack.pop();if(seen.has(p))continue;seen.add(p);
    try{const bytes=Number((await readFile(`/proc/${p}/statm`,'utf8')).split(' ')[1])*4096;rss+=bytes;
      const kind=kindOf(await readFile(`/proc/${p}/cmdline`,'utf8'));kinds[kind]=(kinds[kind]??0)+Math.round(bytes/1048576);}catch{}
    for(const k of kids.get(p)??[])stack.push(k);}
  rssKinds=kinds;
  return Math.round(rss/1048576);
}

// ---- Firefox: the memory report after Gecko's minimize (GC and CC), the content process that holds the page (session-hour.mjs),
// with each owner's largest paths kept (the ones over 4 MB) for attribution
function geckoTotals(file){
  const {reports}=JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
  const proc=reports.find(r=>r.process.startsWith('web')&&/top\(http/.test(r.path))?.process;
  if(!proc)throw new Error(`${file}: no web content process with the page`);
  const parts={page:{js:0,buffers:0,other:0},worker:{js:0,buffers:0,other:0}},large=new Map();
  for(const r of reports){if(r.process!==proc||!r.path.startsWith('explicit/')||r.units!==0)continue;
    const path=r.path.replace(/worker\([^)]*sim-worker[^)]*\)/,'worker(sim)').replace(/\(0x[0-9a-f]+\)/g,'').replace(/\((http|blob)[^)]*\)/g,'(page)');
    const owner=path.includes('worker(sim)')?'worker':path.includes('top(page)')?'page':null;
    if(!owner){large.set(`(other) ${path}`,(large.get(`(other) ${path}`)??0)+r.amount);continue;}
    const part=/array-buffer|\/wasm/.test(path)?'buffers':/\/gc-heap|unused-gc-things|gc-heap-arena-admin|\/gc-buffers/.test(path)?'js':'other';
    parts[owner][part]+=r.amount;
    const key=`${owner} ${path.split('/').slice(-3).join('/')}`;large.set(key,(large.get(key)??0)+r.amount);}
  const mb=n=>n/1048576;
  const explicit=reports.filter(r=>r.process===proc&&r.path.startsWith('explicit/')&&r.units===0).reduce((n,r)=>n+r.amount,0);
  return {parts:Object.fromEntries(Object.entries(parts).map(([owner,p])=>[owner,Object.fromEntries(Object.entries(p).map(([k,v])=>[k,mb(v)]))])),
    explicitMB:mb(explicit),largest:Object.fromEntries([...large].filter(([,v])=>v>4*1048576).sort((a,b)=>b[1]-a[1]).slice(0,40).map(([k,v])=>[k,Math.round(mb(v))]))};
}
/** Gecko's GC and CC edge logs of every process (the signal's dump runs a GC and a CC first), moved to <logDir>/<label>/. */
async function geckoLogs(label){
  mkdirSync(logDir,{recursive:true});
  const before=new Set(readdirSync(logDir));
  process.kill(browserPid,36);  // SIGRTMIN+2
  let files=[],sizes='';
  // (written under a temporary name and renamed when complete; wait until the set and the sizes stop changing)
  for(let i=0;i<600;i++){
    await page.waitForTimeout(2000);
    const now=readdirSync(logDir).filter(f=>!before.has(f)&&/^(gc|cc)-edges.*\.log$/.test(f)).sort();
    const next=now.map(f=>`${f}:${statSync(path.join(logDir,f)).size}`).join(' ');
    if(now.length&&next===sizes)break;
    files=now;sizes=next;
  }
  const into=path.join(logDir,String(label));mkdirSync(into,{recursive:true});
  for(const f of files)renameSync(path.join(logDir,f),path.join(into,f));
  say(`  GC and CC logs: ${files.length} files in ${into}`);
}
async function geckoReading(minimize=true){
  const before=new Set(readdirSync(tmpdir()));
  await requestGeckoReport(browserPid,minimize);  // Linux: SIGRTMIN+1 (minimize, then report) or SIGRTMIN (the report as it is); macOS: the FIFO's same commands
  for(let i=0;i<180;i++){
    await page.waitForTimeout(1000);
    const file=readdirSync(tmpdir()).find(f=>!before.has(f)&&f.startsWith('unified-memory-report-')&&f.endsWith(`-${browserPid}.json.gz`));
    if(file){await page.waitForTimeout(500);const totals=geckoTotals(`${tmpdir()}/${file}`);rmSync(`${tmpdir()}/${file}`);return totals;}
  }
  throw new Error('no memory report from Firefox');
}

const status=()=>page.evaluate(()=>{const s=window.deusExViewer.status();return {ready:s.ready,map:s.map,sim:s.sim,error:s.runtimeError?.message??null};});
const sameMap=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();

/** The heaps after forced collections (MB), the tree's RSS, the page's asset store and the simulation side's process. */
async function reading(label,snapshot){
  // (the tree's RSS before the forced collections: what the browser holds when nothing forces it, garbage included)
  const row={label,atS:(Date.now()-started)/1000,rssBeforeMB:await treeRss(),rssBeforeKinds:rssKinds};
  if(isChromium){
    await cdpTargets();
    if(gc!=='none')for(const s of [sessions.page,sessions.worker])if(s){await send('HeapProfiler.enable',{},s);for(let i=0;i<3;i++){await send('HeapProfiler.collectGarbage',{},s);await page.waitForTimeout(300);}}
    row.parts={page:await heapUsage(sessions.page),worker:await heapUsage(sessions.worker)};
  }else if(gc==='none')row.parts={page:null,worker:null};
  else{const g=await geckoReading(gc==='minimize');row.parts=g.parts;row.explicitMB=g.explicitMB;row.largest=g.largest;}
  await page.waitForTimeout(1200);
  row.wasm=await page.evaluate(()=>{if(!window.deusExHitch)return {pageMB:0,page:0,workerMB:0,worker:0,pageList:[]};
    const s=window.deusExHitch.seconds().at(-1),pageList=window.deusExHitch.wasmMemories();
    return {pageMB:pageList.reduce((n,m)=>n+m.mb,0),page:pageList.length,workerMB:s?.wasmWorkerMB??0,worker:s?.wasmWorkerMems??0,pageList:pageList.map(m=>m.mb)};});
  if(isChromium){if(row.parts.page)row.parts.page.buffers=(row.parts.page.buffers??0)+row.wasm.pageMB;
    if(row.parts.worker)row.parts.worker.buffers=(row.parts.worker.buffers??0)+row.wasm.workerMB;}
  if(isChromium&&snapshot!==null)for(const [name,s] of [['page',sessions.page],['worker',sessions.worker]])if(s){
    snapFile=`${out}-${snapshot}-${name}.heapsnapshot`;writeFileSync(snapFile,'');
    await send('HeapProfiler.takeHeapSnapshot',{reportProgress:false,captureNumericValue:false},s);snapFile=null;}
  const realm=p=>p?p.js+(p.buffers??0):null;
  row.pageMB=realm(row.parts.page);row.workerMB=realm(row.parts.worker);
  row.totalMB=(row.pageMB??0)+(row.workerMB??0);row.rssMB=await treeRss();row.rssKinds=rssKinds;
  row.pageAssets=await page.evaluate(()=>window.deusExViewer.assetsProbe?.()??null).catch(()=>null);
  row.process=await page.evaluate(()=>window.deusExViewer.processProbe?.()??null).catch(()=>null);
  const part=p=>p?`${f1(p.js)} + ${f1(p.buffers)}${p.other!==undefined?` (other ${f1(p.other)})`:''}`:'-';
  say(`  ${label}: total ${f1(row.totalMB)} MB: page ${part(row.parts.page)}, worker ${part(row.parts.worker)} MB (JS + buffers), RSS ${row.rssBeforeMB??'-'} -> ${row.rssMB??'-'} MB; `+
    `Wasm page ${row.wasm.page} (${row.wasm.pageMB} MB) worker ${row.wasm.worker} (${row.wasm.workerMB} MB)`+
    (row.pageAssets?`; page store ${row.pageAssets.ready} packages ${f1(row.pageAssets.readyBytes/1048576)} MB + released ${f1(row.pageAssets.releasedBytes/1048576)}`:'')+
    (row.process?`; sim ${row.process.classes} classes, ${row.process.packages} packages ${f1(row.process.packageMB)} MB + released ${f1(row.process.releasedMB)}, ${row.process.levels} levels`:''));
  return row;
}

const arrivals=[];let ended=null;
const save=()=>writeFileSync(`${out}.json`,JSON.stringify({browser:engine,args:process.argv.slice(2),started:new Date(started).toISOString(),
  sim:arrivals[0]?.sim??null,maps,arrivals,errors,ended}));
try{
  // (--no-hitchlog: the page as a player opens it; the Wasm memories are then counted by Gecko's report only. The hitch log's WeakRef
  // reads keep every memory alive through Firefox's incremental collections, docs/map-memory.md)
  const query=[flag('no-hitchlog')?null:'hitchlog=1',option('query',null)].filter(Boolean).join('&');
  const target=new URL(debugUrl(`${url}/${query?`?${query}`:''}`));if(sim)target.searchParams.set('sim',sim);
  await page.goto(target.href);
  await page.waitForFunction(()=>window.deusExViewer?.status().ready,{},{timeout:300000});
  if(isChromium){await openCdp();await findBrowserPid();}
  const first=await status();
  await page.waitForTimeout(settle*1000);
  arrivals.push({map:first.map,sim:first.sim,loadS:null,reading:await reading(`0 ${first.map}`,snapshots.has(0)?0:null)});save();
  for(const [k,map] of maps.entries()){
    const asked=Date.now();
    await page.evaluate(map=>window.deusExViewer.viewProbe({exec:[`open ${map}`]}),map);
    for(const end=Date.now()+300000;;){
      const s=await status();if(s.error)throw new Error(`runtime error on ${map}: ${s.error}`);
      if(s.ready&&sameMap(s.map,map))break;
      if(Date.now()>end)throw new Error(`no arrival on ${map}`);
      await page.waitForTimeout(250);
    }
    const loadS=(Date.now()-asked)/1000;
    await page.waitForTimeout(settle*1000);
    const i=arrivals.length;
    arrivals.push({map,loadS,reading:await reading(`${i} ${map} (${f1(loadS)} s)`,snapshots.has(i)?i:null)});save();
    if(!isChromium&&gcLogs.has(i))await geckoLogs(i);
  }
}catch(error){ended=error.message;say(`ended: ${error.message}`);}
save();
summarize({arrivals,errors,ended});
await browser.close().catch(()=>{});await ffServer?.close();await server?.close();forgetGeckoReportFifo();
