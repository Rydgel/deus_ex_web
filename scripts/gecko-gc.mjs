// node scripts/gecko-gc.mjs <profile.json> [minMs] -- GC markers of the worker thread(s) in a Gecko profile (format 36)
// A Gecko profile is what scripts/hitch-run.mjs --browser firefox --profile FILE writes; FF_GC_THREADS (a pattern, default Worker) picks
// the threads whose GC markers are listed ('Web Content' for the inline page). Moved from .work/hitch/ff-gc.mjs (2026-10-28).
import {readFileSync} from 'node:fs';
const prof=JSON.parse(readFileSync(process.argv[2],'utf8')),minMs=Number(process.argv[3]??15);
const all=[];const walk=p=>{for(const t of p.threads??[])all.push({t,meta:p.meta});for(const q of p.processes??[])walk(q);};walk(prof);
console.log('threads:',all.map(({t})=>`${t.name}/${t.processName}/${t.pid}.${t.tid}`).join(', '));
for(const {t,meta} of all){
  const S=t.stringTable,m=t.markers,sc=m.schema;
  const kinds={};for(const r of m.data){const nm=S[r[sc.name]];kinds[nm]=(kinds[nm]??0)+1;}
  const gcKinds=Object.entries(kinds).filter(([k])=>/GC|CC|Cycle/i.test(k));
  console.log(`thread ${t.name} ${t.pid}.${t.tid}: ${m.data.length} markers; GC kinds ${JSON.stringify(gcKinds)}`);
  if(!new RegExp(process.env.FF_GC_THREADS??'Worker','i').test(t.name+' '+(t.processName??'')))continue;
  let shown=0;const majors=[];
  for(const r of m.data){const nm=S[r[sc.name]];if(!/^GC/.test(nm))continue;const dur=(r[sc.endTime]||0)-r[sc.startTime];
    if(nm==='GCMajor')majors.push({start:r[sc.startTime],dur,data:r[sc.data]});
    if(dur<minMs&&nm!=='GCMajor')continue;
    if(shown++<100)console.log(`  ${(r[sc.startTime]/1000).toFixed(2)}s ${nm} ${dur.toFixed(1)} ms ${JSON.stringify(r[sc.data]).slice(0,300)}`);}
  console.log(`  majors: ${majors.length}; spacing s: ${majors.slice(1).map((x,i)=>((x.start-majors[i].start)/1000).toFixed(1)).join(' ')}`);
}
