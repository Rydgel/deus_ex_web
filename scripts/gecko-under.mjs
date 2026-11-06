// What a Firefox inline run's slow ticks hold: the hitch log's drawn frames (scripts/hitch-run.mjs --browser firefox --profile FILE)
// joined with the Gecko profile of the page's main thread, the slowest tenth of frames by the page's tick phase (`p.tick`) against
// the rest. For each group, the milliseconds a frame spends (samples x interval / frames) under the level tick (game.mjs `tick`):
// by leaf function (self), by named frame (inclusive), by the Rust core's import the sample is under (the outermost `js_*` call
// from Wasm), and in collector work (GC and CC frames, and the GCSlice/GCMinor markers inside the frame's window). Sorted by what
// the slow frames add. Host measurement only (docs/firefox-60fps-plan.md step 0).
//
//   node scripts/gecko-slow-ticks.mjs RUN.json PROFILE.json [--skip 5] [--slow 0.1] [--top 25] [--json OUT]
//     [--children REGEX [--innermost]] (also: the first two named callees under the outermost, or innermost, frame matching REGEX, frames matching it skipped,
//     e.g. '^invokeNative ')
//
// The clocks are joined as scripts/gecko-gaps.mjs joins them: the rows count from the page's `meta.started` (a system-clock date),
// the samples from the content process's `meta.startTime`; the offset (within 5 s) whose per-frame count of level-tick samples
// inside the frame's window [t, t + animate] correlates best with the frame's tick phase wins.
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),option=(n,f)=>{const i=args.indexOf(`--${n}`);return i<0?f:args[i+1];};
const [runFile,profFile]=args.filter((a,i)=>!a.startsWith('--')&&!args[i-1]?.startsWith('--'));
const anchorRe=new RegExp(option('anchor')),depth=Number(option('depth',3)),skip=Number(option('skip',0)),above=args.includes('--above'),pathRe=option('only',null)?new RegExp(option('only')):null;
const skipS=Number(option('skip',5)),slowShare=Number(option('slow',0.1)),top=Number(option('top',25));
const run=JSON.parse(readFileSync(runFile,'utf8')),prof=JSON.parse(readFileSync(profFile,'utf8'));
const d=run.dump,ci=Object.fromEntries(d.columns.map((c,i)=>[c,i])),started=Date.parse(d.meta.started);
const mapAt=d.events.filter(e=>e.kind==='map').at(-1)?.t??0;
const frames=d.rows.filter(r=>r[ci.drawn]&&r[ci.t]>=mapAt+skipS*1000).map(r=>({t:r[ci.t],animate:r[ci.animate],tick:r[ci['p.tick']]}));

// the page's main thread: the Web Content process's GeckoMain with the most samples
let thread=null,base=0;
const walk=q=>{for(const t of q.threads??[])if(t.name==='GeckoMain'&&t.processName==='Web Content'&&(!thread||t.samples.data.length>thread.samples.data.length)){thread=t;base=q.meta.startTime;}
  for(const c of q.processes??[])walk(c);};
walk(prof);
if(!thread)throw new Error('no Web Content main thread in the profile');
const S=thread.stringTable,ft=thread.frameTable,st=thread.stackTable,ss=thread.samples.schema,interval=prof.meta.interval;
const clean=s=>s.replace(/\[\d+\]$/,'').replace(/https?:\/\/[^/]+\//g,'').replace(/\?[^:)]*/g,'').replace(/:(\d+):\d+\)/,':$1)')
  .replace(/ \(src\/runtime\/script-vm-kernel\.mjs line \d+ > WebAssembly\.compile:\d+\)/,'');
const cache=new Map();
const framesOf=s=>{let r=cache.get(s);if(r)return r;r=[];for(let x=s;x!==null;x=st.data[x][st.schema.prefix])r.push(clean(S[ft.data[st.data[x][st.schema.frame]][ft.schema.location]]));cache.set(s,r);return r;};
const TICK=/^tick \(src\/viewer\/game\.mjs:/;
const named=f=>!/^0x[0-9a-f]+$/.test(f)&&!/trampoline|^js::RunScript|^JS::Call|^js::Call|^js::Interpret|Interpreter|BaselineCompile|^AsyncFunction/.test(f);
const gcFrame=f=>/Minor GC|GC slice|GCRuntime|Nursery::collect|js::gc::|CycleCollect|nsCycleCollector|GCMajor|markUntilBudget|sweep/i.test(f);
const samples=thread.samples.data.filter(r=>r[ss.stack]!==null).map(r=>({at:base+r[ss.time],fr:framesOf(r[ss.stack])})).sort((a,b)=>a.at-b.at);
const tickSamples=samples.filter(s=>s.fr.some(f=>TICK.test(f)));

// the clock join
const lower=(arr,x)=>{let lo=0,hi=arr.length;while(lo<hi){const m=(lo+hi)>>1;if(arr[m].at<x)lo=m+1;else hi=m;}return lo;};
// the offset whose per-frame count of level-tick samples correlates best with the frames' tick phase (frames run back to back,
// so a count of the samples inside any window is not sharp enough)
const corr=offset=>{let n=0,sx=0,sy=0,sxx=0,syy=0,sxy=0;for(const f of frames){const a=started+f.t+offset,c=lower(tickSamples,a+f.animate)-lower(tickSamples,a);
  n++;sx+=c;sy+=f.tick;sxx+=c*c;syy+=f.tick*f.tick;sxy+=c*f.tick;}
  const v=(n*sxx-sx*sx)*(n*syy-sy*sy);return v>0?(n*sxy-sx*sy)/Math.sqrt(v):0;};
let best=0,bestR=-2;
for(let off=-5000;off<=5000;off+=10){const r=corr(off);if(r>bestR){bestR=r;best=off;}}
for(let off=best-10;off<=best+10;off++){const r=corr(off);if(r>bestR){bestR=r;best=off;}}
const bestN=frames.reduce((n,f)=>{const a=started+f.t+best;return n+lower(tickSamples,a+f.animate)-lower(tickSamples,a);},0);

// GC markers on the main thread
const marks=[];{const ms=thread.markers.schema;for(const row of thread.markers.data){const kind=S[row[ms.name]];if(!['GCSlice','GCMinor','CCSlice'].includes(kind))continue;
  const a=base+row[ms.startTime],b=base+(row[ms.endTime]||row[ms.startTime]);marks.push({kind,a,b});}}

const ordered=[...frames].sort((a,b)=>b.tick-a.tick),nSlow=Math.max(1,Math.round(frames.length*slowShare));
const groups={slow:ordered.slice(0,nSlow),rest:ordered.slice(nSlow)};

const per=(n,list)=>n*interval/list.length;
for(const [g,list] of Object.entries(groups)){
  const paths=new Map(),leaves=new Map(),imps=new Map(),incl=new Map();let total=0;
  for(const f of list){
    const a=started+f.t+best,b=a+f.animate;
    for(let i=lower(samples,a);i<samples.length&&samples[i].at<b;i++){const fr=samples[i].fr,ti=fr.findIndex(x=>TICK.test(x));if(ti<0)continue;
      const under=fr.slice(0,ti);
      let j=-1;if(above){j=under.findIndex(x=>anchorRe.test(x));}else{for(let q=under.length-1;q>=0;q--)if(anchorRe.test(under[q])){j=q;break;}}
      if(j<0)continue;total++;
      const below=above?under.slice(j+1).filter(named):under.slice(0,j).reverse().filter(named);
      if(pathRe&&!below.some(x=>pathRe.test(x)))continue;const key=below.slice(skip,skip+depth).map(x=>x.replace(/ \(src\/runtime\//,' (').slice(0,60)).join(' > ')||'(self)';
      paths.set(key,(paths.get(key)??0)+1);
      for(const x of new Set(below))incl.set(x.replace(/ \(src\/runtime\//,' (').slice(0,100),(incl.get(x.replace(/ \(src\/runtime\//,' (').slice(0,100))??0)+1);const leaf=under.find(named)??under[0];leaves.set(leaf,(leaves.get(leaf)??0)+1);
      const js=[...under.slice(0,j)].find(x=>/^js_\w+ /.test(x));const k=js?js.split(' ')[0]:under.slice(0,j).some(x=>/wasm-function/.test(x))?'(in Wasm)':'(JS)';imps.set(k,(imps.get(k)??0)+1);}
  }
  g==='slow'?globalThis.S1={paths,leaves,imps,incl,list,total}:globalThis.S2={paths,leaves,imps,incl,list,total};
}
const tbl=(title,key)=>{const keys=new Set([...S1[key].keys(),...S2[key].keys()]);
  const rows=[...keys].map(k=>[k,per(S1[key].get(k)??0,S1.list),per(S2[key].get(k)??0,S2.list)]).map(([k,s,r])=>[k,s,r,s-r]).sort((a,b)=>b[3]-a[3]).slice(0,top);
  console.log('\n'+title+' (ms a frame: slow, rest, diff)');for(const [k,s,r,d] of rows)console.log(`${s.toFixed(2).padStart(6)} ${r.toFixed(3).padStart(6)} ${d.toFixed(2).padStart(6)}  ${k.slice(0,230)}`);};
console.log(`anchor ${anchorRe}: slow ${per(S1.total,S1.list).toFixed(2)} ms, rest ${per(S2.total,S2.list).toFixed(3)} ms a frame`);
tbl('paths below the anchor (depth '+depth+')','paths');tbl('leaves','leaves');tbl('inclusive named frames below the anchor','incl');tbl('first js_ import below the anchor','imps');
