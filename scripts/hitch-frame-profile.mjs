// node scripts/hitch-frame-profile.mjs <run prefix> [minMs=60] [top=40]: for each worker frame of the hitch log over minMs, the functions with the most
// inclusive time in that frame's window of <prefix>.worker.cpuprofile (clocks joined by hitch-run.mjs --worker-profile's __hitchSync marker), and the same summed
// over all those frames. `--all-frames` prints the sum over every frame instead (the average frame's profile).
// Moved from .work/hitch/frame-profile.mjs (2026-10-28).
import {readFileSync} from 'node:fs';
const [prefix,minArg='60',topArg='40']=process.argv.slice(2).filter(a=>!a.startsWith('--')),min=Number(minArg),top=Number(topArg);
const run=JSON.parse(readFileSync(`${prefix}.json`,'utf8')),p=JSON.parse(readFileSync(`${prefix}.worker.cpuprofile`,'utf8'));
const d=run.dump,ci=Object.fromEntries(d.columns.map((c,i)=>[c,i]));
const byId=new Map(p.nodes.map(n=>[n.id,n])),parent=new Map();
for(const n of p.nodes)for(const c of n.children??[])parent.set(c,n.id);
const name=n=>`${n.callFrame.functionName||'(anon)'} ${n.callFrame.url.split('/').pop().split('?')[0]}:${n.callFrame.lineNumber+1}`;
let t=p.startTime;const times=p.timeDeltas.map(x=>t+=x);
const sync=times[p.samples.findIndex(id=>byId.get(id).callFrame.functionName==='__hitchSync')];
if(sync==null)throw new Error('no __hitchSync samples');
// profile us = worker epoch ms * 1000 + offset
const offset=sync-run.profileSync.workerEpochMs*1000;
const toProfile=epochMs=>epochMs*1000+offset;
const frames=[],seen=new Set();
for(const r of d.rows){const dur=r[ci['w.dur']];if(!(dur>0))continue;const key=r[ci['w.start']];if(seen.has(key))continue;seen.add(key);
  const epoch=r[ci['w.start']]+d.meta.originMs+run.profileSync.pageTimeOrigin;frames.push({t:r[ci.t]/1000,dur,from:toProfile(epoch),to:toProfile(epoch+dur)});}
const pick=process.argv.includes('--all-frames')?frames:frames.filter(f=>f.dur>=min);
const total=new Map(),self=new Map();let sampled=0;
const report=(label,incl,ms)=>{console.log(`\n${label}: ${ms.toFixed(0)} ms sampled`);for(const [k,us] of [...incl].sort((x,y)=>y[1]-x[1]).slice(0,top))console.log(`  ${(us/1000).toFixed(1).padStart(8)}  ${k}`);};
let i=0;
for(const f of pick.sort((a,b)=>a.from-b.from)){
  while(i<times.length&&times[i]<f.from)i++;
  const incl=new Map();let ms=0;
  for(let j=i;j<times.length&&times[j]<f.to;j++){const dt=(times[j+1]??times[j])-times[j];ms+=dt/1000;const seenK=new Set();
    const leaf=name(byId.get(p.samples[j]));self.set(leaf,(self.get(leaf)??0)+dt);
    for(let id=p.samples[j];id!=null;id=parent.get(id)){const k=name(byId.get(id));if(seenK.has(k))continue;seenK.add(k);incl.set(k,(incl.get(k)??0)+dt);total.set(k,(total.get(k)??0)+dt);}}
  sampled+=ms;
  if(!process.argv.includes('--all-frames'))report(`t=${f.t.toFixed(2)} s frame ${f.dur.toFixed(0)} ms`,incl,ms);
}
report(`sum over ${pick.length} frames`,total,sampled);
console.log('\nself time, top:');for(const [k,us] of [...self].sort((x,y)=>y[1]-x[1]).slice(0,top))console.log(`  ${(us/1000).toFixed(1).padStart(8)}  ${k}`);
