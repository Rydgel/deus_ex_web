// Summarizes hitch-log runs (scripts/hitch-run.mjs's <out>.json, or a dump the page saved, docs/hitch-log.md) and judges the Stage 7
// frame-time rows (docs/stage-7-exit-criteria.md 7.2) on each. Every figure counts from --skip seconds after the map became current
// (default 5): the page's frame work (`animate`) and the worker's frame (`w.dur`, one per worker frame) as p50 and p95; drawn-frame
// intervals (p95, p99, max) and the gaps between drawn frames over 50, 100 and 150 ms, also per minute; the drawn frame rate; the shader
// programs created in that window; and, beside a hitch-ab.mjs run, the CPU (cores) of its process tree over its last 50 s.
//
//   node scripts/hitch-summary.mjs RUN.json... [--skip 5] [--gaps LIMIT] (each drawn gap over LIMIT ms, with the worker's columns) [--json]
//
// The rows' verdicts (PASS or FAIL against the bound; a number is the reference machine's only, so a run elsewhere is indicative):
//   7.2.1  the larger of the page's and the worker's median frame work <= 8.3 ms (AGENTS.md: 120 fps)
//   7.2.2  drawn-frame interval p95 <= 16.7 ms (60 fps), with 0.5 ms for the frame timestamps' jitter (a 60 Hz display's intervals
//          scatter around 16.67 ms)
//   7.2.3  Chromium: no gap over 100 ms
//   7.2.4  Firefox: no gap over 150 ms, at most two over 50 ms a minute
//   7.2.5  no shader program created in the window
// Moved from .work/hitch/ff-summ.mjs and ff-gaps.mjs (2026-10-28).
import {readFileSync,existsSync} from 'node:fs';

const argv=process.argv.slice(2);
const option=(n,f)=>{const i=argv.indexOf(`--${n}`);return i<0?f:argv[i+1];};
const skipMs=Number(option('skip',5))*1000,gapLimit=option('gaps',null)===null?null:Number(option('gaps',null));
const files=argv.filter((a,i)=>!a.startsWith('--')&&!(i&&['--skip','--gaps'].includes(argv[i-1])));
const q=(a,p)=>{if(!a.length)return NaN;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
const f1=v=>Number.isFinite(v)?v.toFixed(1):'-';

/** One run's figures and verdicts. */
export function summarize(raw,{skip=skipMs,file=''}={}){
  const d=raw.dump??raw,ci=Object.fromEntries(d.columns.map((c,i)=>[c,i]));
  const from=(d.events.filter(e=>e.kind==='map').at(-1)?.t??0)+skip;
  const rows=d.rows.filter(r=>r[ci.t]>=from),drawn=rows.filter(r=>r[ci.drawn]);
  const page=rows.map(r=>r[ci.animate]);
  // A worker frame shows in each page frame until the next arrives: one per distinct start.
  const seen=new Set(),worker=[];
  for(const r of rows){const dur=r[ci['w.dur']];if(!(dur>=0)||seen.has(r[ci['w.start']]))continue;seen.add(r[ci['w.start']]);worker.push(dur);}
  const gaps=[];for(let i=1;i<drawn.length;i++)gaps.push(drawn[i][ci.t]-drawn[i-1][ci.t]);
  const span=drawn.length>1?(drawn.at(-1)[ci.t]-drawn[0][ci.t])/1000:NaN,minutes=span/60;
  const over=l=>gaps.filter(g=>g>l).length;
  const programs=(d.programs??[]).filter(p=>p.t>=from).length;
  let cores=null;const cpuFile=file.replace(/\.json$/,'.cpu');
  if(file&&existsSync(cpuFile)){const s=readFileSync(cpuFile,'utf8').trim().split('\n').map(l=>l.split(' ').map(Number)).filter(x=>x.length===2&&!isNaN(x[1]));
    const end=s.at(-1)?.[0],a=s.find(x=>x[0]>=end-55),b=s.filter(x=>x[0]<=end-5).at(-1);
    if(a&&b&&b[0]>a[0])cores=(b[1]-a[1])/(b[0]-a[0]);}
  const browser=raw.browser??(/Firefox/.test(d.meta.userAgent??'')?'firefox':'chromium');
  const fig={browser,sim:raw.status?.sim??null,map:raw.status?.map??d.events.filter(e=>e.kind==='map').at(-1)?.map??null,seconds:span,
    // (the recorder's meta.canvas is the size when it attached, before a map or the page bars resized it)
    machine:{gl:d.meta.glRenderer,cores:d.meta.hardwareConcurrency,canvas:raw.status?.canvas??d.meta.canvas},
    page:{p50:q(page,.5),p95:q(page,.95)},worker:worker.length?{p50:q(worker,.5),p95:q(worker,.95)}:null,
    interval:{p50:q(gaps,.5),p95:q(gaps,.95),p99:q(gaps,.99),max:gaps.length?Math.max(...gaps):NaN},
    over:{50:over(50),100:over(100),150:over(150)},perMinute:{50:over(50)/minutes,100:over(100)/minutes},
    fps:drawn.length/span,programs,cores,errors:raw.errors?.length??0,ended:raw.ended??null};
  const host=Math.max(fig.page.p50,fig.worker?.p50??0);
  fig.rows={
    '7.2.1':{value:`${f1(host)} ms`,pass:host<=8.3},
    '7.2.2':{value:`p95 ${f1(fig.interval.p95)} ms`,pass:fig.interval.p95<=16.7+0.5},
    ...(browser==='chromium'?{'7.2.3':{value:`${fig.over[100]} gaps over 100 ms`,pass:fig.over[100]===0}}
      :{'7.2.4':{value:`${fig.over[150]} over 150 ms, ${f1(fig.perMinute[50])} a minute over 50 ms`,pass:fig.over[150]===0&&fig.perMinute[50]<=2}}),
    '7.2.5':{value:`${programs} programs`,pass:programs===0}};
  fig.gapList=gapLimit===null?[]:drawn.slice(1).map((r,i)=>[drawn[i][ci.t],r[ci.t]-drawn[i][ci.t],r]).filter(([,g])=>g>gapLimit).slice(0,20).map(([t,g,r])=>({
    t:(t-from+skip)/1000,gap:g,next:Object.fromEntries(['w.dur','w.posts','w.lat','w.age','w.tick','outstanding','waiting'].map(k=>[k,r[ci[k]]])),
    events:d.events.filter(e=>e.t>=t-50&&e.t<=t+g+50&&!['loaf','longtask'].includes(e.kind)).slice(0,6).map(e=>`${e.kind}${e.ms?':'+Math.round(e.ms):''}${e.reason?':'+e.reason:''}`)}));
  return fig;
}

if(import.meta.url===`file://${process.argv[1]}`){
  if(!files.length){console.error('usage: node scripts/hitch-summary.mjs RUN.json... [--skip 5] [--gaps LIMIT] [--json]');process.exit(2);}
  const all=files.map(file=>({file,...summarize(JSON.parse(readFileSync(file,'utf8')),{file})}));
  if(argv.includes('--json'))console.log(JSON.stringify(all,null,1));
  else for(const s of all){
    console.log(`${s.file.split('/').pop()}: ${s.browser} ${s.sim??''} ${s.map} ${f1(s.seconds)} s | page p50 ${f1(s.page.p50)} p95 ${f1(s.page.p95)}`
      +(s.worker?` | worker p50 ${f1(s.worker.p50)} p95 ${f1(s.worker.p95)}`:'')
      +` | interval p95 ${f1(s.interval.p95)} p99 ${f1(s.interval.p99)} max ${f1(s.interval.max)} | gaps >50 ${s.over[50]} >100 ${s.over[100]} >150 ${s.over[150]}`
      +` | ${f1(s.fps)} fps | programs ${s.programs}${s.cores===null?'':` | ${s.cores.toFixed(2)} cores`} | errors ${s.errors} ended ${s.ended}`);
    console.log(`  ${s.machine.gl} | ${s.machine.cores} cores | ${Object.entries(s.rows).map(([id,r])=>`${id} ${r.pass?'PASS':'FAIL'} (${r.value})`).join(' | ')}`);
    for(const g of s.gapList)console.log(`  t ${g.t.toFixed(1)} s gap ${g.gap.toFixed(0)} next ${JSON.stringify(g.next)} ${g.events.join(' ')}`);
  }
}
