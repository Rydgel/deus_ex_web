/**
 * What Play keeps alive in Firefox (docs/live-heap.md): opens the debugging page in headless Firefox against a running dev server,
 * loads --map from the map list, walks forward for --seconds, then has Gecko minimize memory (GC and CC) and write its memory
 * report: the parent process gets SIGRTMIN+1 (nsMemoryInfoDumper on Linux; Playwright's Firefox cannot open about:memory), and the
 * report (about:memory's JSON, every process) lands in the temp directory as unified-memory-report-<id>-<pid>.json.gz. The signal
 * goes to this run's own browser process only. Linux only. Host measurement only.
 *
 *   node scripts/profile-firefox-memory.mjs [--url http://127.0.0.1:5173] [--map 01_NYC_UNATCOIsland] [--sim inline|worker]
 *     [--seconds 30] [--out .cache/perf/ffmem-island]   (writes <out>-<sim>.json.gz and prints its summary)
 *   node scripts/profile-firefox-memory.mjs --summary report.json.gz
 *
 * The summary is the content process that holds the page: its JS memory per owner (the page's realm and zone, and the simulation
 * worker's zone), split into GC things (gc-heap: what a major GC marks), their out-of-line slots and elements (gc-buffers),
 * ArrayBuffer and Wasm memory (not traced element by element) and the rest, then the largest kinds (class(Array)/objects/gc-heap...).
 */
import {firefox} from '@playwright/test';
import {readdirSync,copyFileSync,rmSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname} from 'node:path';
import {gunzipSync} from 'node:zlib';
import { debugUrl } from './page-url.mjs';

const option=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i<0?f:process.argv[i+1];};

function summary(file) {
  const {reports}=JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
  const proc=reports.find(r=>r.process.startsWith('web')&&/top\(http/.test(r.path))?.process;
  if(!proc)throw new Error(`${file}: no web content process with the page`);
  const norm=path=>path.replace(/worker\([^)]*sim-worker[^)]*\)/,'worker(sim)').replace(/\(0x[0-9a-f]+\)/g,'').replace(/\((http|blob)[^)]*\)/g,'(page)');
  const ownerOf=path=>path.includes('worker(sim)')?'worker':path.includes('top(page)')?'page':null;
  const explicit=reports.filter(r=>r.process===proc&&r.path.startsWith('explicit/')&&r.units===0);
  const totals=new Map(),kinds=new Map();
  for(const r of explicit){
    const path=norm(r.path),owner=ownerOf(path);if(!owner)continue;
    const part=/array-buffer|\/wasm/.test(path)?'array-buffer+wasm':/\/gc-heap|unused-gc-things|gc-heap-arena-admin/.test(path)?'gc-heap'
      :/\/gc-buffers/.test(path)?'gc-buffers':'other';
    const key=`${owner} ${part}`;totals.set(key,(totals.get(key)??0)+r.amount);
    if(part==='gc-heap'||part==='gc-buffers'){const kind=`${owner} ${path.split('/').slice(-3).join('/')}`;kinds.set(kind,(kinds.get(kind)??0)+r.amount);}
  }
  const mb=n=>(n/1048576).toFixed(0).padStart(5);
  console.log(`${file}: ${proc}, explicit ${mb(explicit.reduce((a,r)=>a+r.amount,0))} MB`);
  for(const owner of ['page','worker']){const rows=[...totals].filter(([k])=>k.startsWith(owner+' '));
    if(rows.length)console.log(`  ${owner.padEnd(6)} ${rows.map(([k,v])=>`${k.slice(owner.length+1)} ${mb(v).trim()} MB`).join(', ')}`);}
  console.log('  largest GC kinds:');
  for(const [k,v] of [...kinds].sort((a,b)=>b[1]-a[1]).slice(0,14))console.log(`    ${mb(v)} MB ${k}`);
}

if(process.argv.includes('--summary')){summary(option('summary'));process.exit(0);}
if(process.platform!=='linux')throw new Error('the memory report signal is Linux only');
const url=option('url','http://127.0.0.1:5173'),map=option('map','01_NYC_UNATCOIsland'),sim=option('sim','inline');
const seconds=Number(option('seconds',30)),out=option('out','.cache/perf/ffmem-island');
mkdirSync(dirname(out),{recursive:true});
const server=await firefox.launchServer({headless:true});
const pid=server.process().pid;
const browser=await firefox.connect(server.wsEndpoint());
const page=await (await browser.newContext({viewport:{width:1440,height:960},deviceScaleFactor:1})).newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const target=new URL(debugUrl(`${url}/`));target.searchParams.set('sim',sim);
await page.goto(target.href);
await page.waitForFunction(()=>window.deusExViewer?.status().ready,{}, {timeout:300000});
await page.locator('#map').selectOption(map);
await page.waitForFunction(m=>{const s=window.deusExViewer?.status();return s?.ready&&s.map===m;},map,{timeout:300000});
await page.locator('#scene').click({position:{x:576,y:345}});
await page.keyboard.down('KeyW');await page.waitForTimeout(seconds*1000);await page.keyboard.up('KeyW');
const status=await page.evaluate(()=>{const s=window.deusExViewer.status();return {map:s.map,sim:s.sim,runtimeError:s.runtimeError?.message??null};});
console.log('status',JSON.stringify(status),'page errors',errors.length);
process.kill(pid,35); // SIGRTMIN+1 (glibc's SIGRTMIN is 34): minimize memory, then dump the reports
let file=null;
for(let i=0;i<120&&!file;i++){await page.waitForTimeout(1000);file=readdirSync(tmpdir()).find(f=>f.startsWith('unified-memory-report-')&&f.endsWith(`-${pid}.json.gz`));}
await page.waitForTimeout(2000);
await browser.close();await server.close();
if(!file)throw new Error(`no memory report from Firefox ${pid} in ${tmpdir()}`);
copyFileSync(`${tmpdir()}/${file}`,`${out}-${sim}.json.gz`);rmSync(`${tmpdir()}/${file}`);
summary(`${out}-${sim}.json.gz`);
