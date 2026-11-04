// The Stage 7 frame-time set (docs/stage-7-exit-criteria.md 7.2): each map of the October 2 census (docs/play-frame-cost.md) through
// the census route (scripts/hitch-run.mjs --mode scan: four headings 60 degrees apart), one session per map against one dev server,
// then each session's figures and row verdicts (scripts/hitch-summary.mjs). A number is the reference machine's only (Apple M2 Pro,
// 1440x960); elsewhere the table is indicative.
//
//   node scripts/frame-time-set.mjs [--browser chromium|firefox] [--seconds 60] [--maps a,b,...] [--dir .cache/perf/frame-time-set]
//     [--query k=v] [--url URL]
import {spawn} from 'node:child_process';
import {readFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {summarize} from './hitch-summary.mjs';
import {FRAME_TIME_SET} from './frame-time-maps.mjs';

export {FRAME_TIME_SET};

const option=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i<0?f:process.argv[i+1];};
const engine=option('browser','chromium'),seconds=option('seconds','60'),dir=option('dir','.cache/perf/frame-time-set');
const maps=option('maps',null)?.split(',')??FRAME_TIME_SET;
mkdirSync(dir,{recursive:true});

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
const f1=v=>Number.isFinite(v)?v.toFixed(1):'-';
const results=[];
try{
  for(const map of maps){
    const out=`${dir}/${engine}-${map}`;
    const args=['scripts/hitch-run.mjs','--browser',engine,'--map',map,'--mode','scan','--seconds',seconds,'--url',url,'--out',out,
      ...(option('query',null)?['--query',option('query',null)]:[])];
    const code=await new Promise(resolve=>spawn(process.execPath,args,{stdio:'inherit'}).on('exit',resolve));
    if(code){results.push({map,failed:`exit ${code}`});continue;}
    results.push({map,...summarize(JSON.parse(readFileSync(`${out}.json`,'utf8')),{file:`${out}.json`})});
  }
}finally{await server?.close();}
console.log(`\n| Map | page p50 | worker p50 | interval p95 | gaps >100 | programs | ${['7.2.1','7.2.2','7.2.5'].join(' | ')} |\n|---|---:|---:|---:|---:|---:|---|---|---|`);
for(const r of results){
  if(r.failed){console.log(`| ${r.map} | ${r.failed} |`);continue;}
  console.log(`| ${r.map} | ${f1(r.page.p50)} | ${f1(r.worker?.p50)} | ${f1(r.interval.p95)} | ${r.over[100]} | ${r.programs} | ${['7.2.1','7.2.2','7.2.5'].map(id=>r.rows[id].pass?'PASS':'FAIL').join(' | ')} |`);
}
const machine=results.find(r=>r.machine)?.machine;
if(machine)console.log(`\n${engine}, ${machine.gl}, ${machine.cores} cores, canvas ${machine.canvas}`);
