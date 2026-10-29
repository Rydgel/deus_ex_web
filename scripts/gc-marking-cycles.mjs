// Each major GC cycle of a worker, from V8's own log (--js-flags '--trace-gc --trace-incremental-marking', forwarded by
// DEBUG=pw:browser): how long it ran, its main-thread steps (on allocation, as tasks) and atomic pause, and the frames it
// overlapped with the steps inside each (docs/live-heap.md "Allocation sets the long frame"). The worker is the isolate with
// the largest estimated live heap. Host measurement only.
//   node scripts/gc-marking-cycles.mjs RUN.json RUN.v8.log [RUN2.json RUN2.v8.log ...]
// RUN.json: scripts/gc-allocation-synth.mjs output (frames in the worker's clock), or a scripts/hitch-run.mjs --trace run
// (worker frames w.start/w.dur in the hitch log's clock, aligned to V8's by the trace's worker mark-compacts).
import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);
for(let k=0;k<args.length;k+=2){
  const run=JSON.parse(readFileSync(args[k],'utf8'));
  const lines=readFileSync(args[k+1],'utf8').split('\n').map(l=>{const m=l.match(/\[out\] \[\d+:(0x[0-9a-f]+)(?::\d+)?\]\s+(\d+) ms: (.*)$/);return m&&{iso:m[1],t:+m[2],text:m[3]};}).filter(Boolean);
  const live=new Map();for(const l of lines){const m=l.text.match(/estimated live: (\d+)KB/);if(m)live.set(l.iso,Math.max(live.get(l.iso)??0,+m[1]));}
  if(!live.size)throw new Error(`${args[k+1]}: no V8 incremental-marking lines`);
  const wl=lines.filter(l=>l.iso===[...live].sort((a,b)=>b[1]-a[1])[0][0]);
  // Frames [start, duration] in the V8 log's clock, from the first 5 s of the run on.
  let frames,from,title,atomicAt=()=>null;
  if(run.frames){frames=run.frames;from=frames[0][0]+5000;const s=run.summary;title=`alloc ${s.alloc} MB + promo ${s.promo} KB a frame`;}
  else{
    const d=run.dump,ci=Object.fromEntries(d.columns.map((c,i)=>[c,i])),seen=new Set();frames=[];
    for(const row of d.rows){const s=row[ci['w.start']],u=row[ci['w.dur']];if(s==null||u==null||seen.has(s))continue;seen.add(s);frames.push([s,u]);}
    frames.sort((a,b)=>a[0]-b[0]);
    const mc=(run.gc??[]).filter(e=>/DedicatedWorker/.test(e.thread)&&e.name==='V8.GC_MARK_COMPACTOR'&&e.logMs!==null);
    const stops=wl.filter(l=>/Stopping: old generation/.test(l.text));
    if(!mc.length||!stops.length)throw new Error(`${args[k]}: a hitch-run needs --trace and a worker mark-compact`);
    // V8's clock = log clock - offset: the offset that puts most finalizations within 100 ms of a traced mark-compact
    const offsets=mc.flatMap(e=>stops.map(l=>e.logMs-l.t));
    const offset=offsets.map(o=>[o,mc.filter(e=>stops.some(l=>Math.abs(e.logMs-o-l.t)<100)).length]).sort((a,b)=>b[1]-a[1]||Math.abs(a[0])-Math.abs(b[0]))[0][0];
    frames=frames.map(([s,u])=>[s-offset,u]);
    from=(d.events?.filter(e=>e.kind==='map').at(-1)?.t??frames[0][0]+offset)+5000-offset;
    atomicAt=t=>mc.find(e=>Math.abs(e.logMs-offset-t)<100)?.dur/1000??null;title=`${run.settings?.map??run.map??'hitch-run'} (offset ${offset.toFixed(0)} ms)`;
  }
  // A cycle runs from its Start to its Stopping (the finalization); --trace-gc's summary line, when V8's output kept it, gives
  // the atomic pause, else the trace's mark-compact does.
  const cycles=[];let cur=null;
  for(const l of wl){
    if(/\[IncrementalMarking\] Start \(/.test(l.text)){cur={start:l.t,steps:[]};continue;}
    if(cur&&/Step: origin/.test(l.text))cur.steps.push({t:l.t,origin:l.text.match(/origin: (\w+)/)[1],ms:+l.text.match(/overall: ([\d.]+)ms/)[1]});
    if(cur&&/Stopping: old generation/.test(l.text)){cur.end=l.t;cur.atomic=atomicAt(l.t);if(cur.start>from&&cur.start<frames.at(-1)[0])cycles.push(cur);cur=null;continue;}
    const mc=l.text.match(/Mark-Compact.* ([\d.]+) \/ [\d.]+ ms \(\+ ([\d.]+) ms in (\d+) steps/),last=cycles.at(-1);
    if(mc&&last&&l.t-last.end<200)last.atomic=+mc[1];
  }
  const after=frames.filter(([s])=>s>=from),durs=after.map(([,u])=>u).sort((a,b)=>a-b);
  console.log(`${args[k]}: ${title}: ${after.length} frames, p50 ${durs[durs.length>>1].toFixed(1)} ms, max ${durs.at(-1).toFixed(0)} ms, `
    +`over 50 ms ${durs.filter(u=>u>50).length}, over 100 ms ${durs.filter(u=>u>100).length}; ${cycles.length} complete cycles`);
  for(const c of cycles){
    const inside=after.filter(([s,u])=>s+u>=c.start&&s<=c.end+5).map(([s,u])=>{
      const st=c.steps.filter(x=>x.t>=s&&x.t<=s+u+1&&x.origin==='V8');return {u,n:st.length,ms:st.reduce((a,x)=>a+x.ms,0)};});
    const top=[...inside].sort((a,b)=>b.u-a.u).slice(0,3).map(p=>`${p.u.toFixed(0)} ms (${p.n} steps, ${p.ms.toFixed(0)} ms)`).join(', ');
    const v8=c.steps.filter(x=>x.origin==='V8'),task=c.steps.filter(x=>x.origin!=='V8');
    const ms=xs=>xs.reduce((a,x)=>a+x.ms,0).toFixed(0);
    console.log(`  cycle at ${(c.start/1000).toFixed(1)} s: ${(c.end-c.start).toFixed(0)} ms, ${inside.length} frames; main-thread steps ${v8.length} on allocation `
      +`(${ms(v8)} ms), ${task.length} as tasks (${ms(task)} ms), atomic ${c.atomic?.toFixed(1)??'?'} ms; longest ${top}`);
  }
}
