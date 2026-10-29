// The worker's major GC cycles and long frames of a scripts/hitch-run.mjs --trace run, from the trace alone (no V8 log needed):
// per cycle the main-thread incremental marking (V8.GC_MC_INCREMENTAL events on the worker thread since the previous MajorGC) and
// the atomic pause (the MajorGC event); then the worker frames over LIMIT ms (w.start/w.dur, the hitch log's clock) with the
// worker-thread GC time inside each, split into GC frames (at least 20 ms of incremental or atomic work inside) and others.
// docs/live-heap.md "Steps 2, 3 and 4 on two cores". Host measurement only.
//   node scripts/gc-trace-cycles.mjs [--frames LIMIT] [--list] RUN.json [RUN2.json ...]
import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);
let limit=100,list=false;const files=[];
for(let i=0;i<args.length;i++){
  if(args[i]==='--frames')limit=Number(args[++i]);
  else if(args[i]==='--list')list=true;
  else files.push(args[i]);
}
const STARTUP_S=20;
for(const file of files){
  const run=JSON.parse(readFileSync(file,'utf8'));
  const columns=run.dump.columns??run.dump.meta.columns,rows=run.dump.rows;
  const iStart=columns.indexOf('w.start'),iDur=columns.indexOf('w.dur');
  const phases=columns.map((name,i)=>[name,i]).filter(([name])=>/^w\.(tick|lighting|sprites|actors|mirrors|coronas|hud)$/.test(name));
  const events=run.gc.filter(e=>e.thread==='DedicatedWorker thread').sort((a,b)=>a.ts-b.ts);
  const cycles=[];let incremental=0,steps=0;
  for(const e of events){
    if(e.name==='V8.GC_MC_INCREMENTAL'){incremental+=e.dur/1000;steps++;}
    else if(e.name==='MajorGC'){cycles.push({at:e.logMs/1000,incremental,steps,atomic:e.dur/1000});incremental=0;steps=0;}
  }
  const work=events.filter(e=>e.name==='V8.GC_MC_INCREMENTAL'||e.name==='MajorGC');
  const frames=[];
  for(const row of rows){
    const dur=row[iDur];if(!(typeof dur==='number'))continue;
    const start=row[iStart];
    if(!(dur>limit)){frames.push({dur});continue;}
    let gc=0;for(const e of work)if(e.logMs>=start&&e.logMs<=start+dur)gc+=e.dur/1000;
    frames.push({dur,start,gc,phases:phases.map(([name,i])=>[name,row[i]]).filter(([,v])=>typeof v==='number'&&v>5)});
  }
  const long=frames.filter(f=>f.dur>limit),startup=long.filter(f=>f.start/1000<STARTUP_S);
  const gcFrames=long.filter(f=>f.start/1000>=STARTUP_S&&f.gc>=20),other=long.filter(f=>f.start/1000>=STARTUP_S&&f.gc<20);
  const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN,max=a=>a.length?Math.max(...a):NaN;
  console.log(`${file}: ${frames.length} worker frames; ${cycles.length} worker major GCs, main-thread marking a cycle mean ${mean(cycles.map(c=>c.incremental)).toFixed(0)} ms `+
    `(max ${max(cycles.map(c=>c.incremental)).toFixed(0)}), atomic mean ${mean(cycles.map(c=>c.atomic)).toFixed(0)} ms; frames over ${limit} ms: `+
    `GC ${gcFrames.length} (longest ${max(gcFrames.map(f=>f.dur)).toFixed(0)}), other ${other.length} (longest ${max(other.map(f=>f.dur)).toFixed(0)}), `+
    `first ${STARTUP_S} s ${startup.length} (longest ${max(startup.map(f=>f.dur)).toFixed(0)})`);
  for(const c of cycles)console.log(`  major at ${c.at.toFixed(1)} s: incremental ${c.incremental.toFixed(0)} ms in ${c.steps} steps, atomic ${c.atomic.toFixed(0)} ms`);
  if(list)for(const f of long)console.log(`  frame at ${(f.start/1000).toFixed(1)} s ${f.dur.toFixed(0)} ms: GC ${f.gc.toFixed(0)} ms | ${f.phases.map(([n,v])=>`${n} ${v.toFixed(0)}`).join(' ')}`);
}
