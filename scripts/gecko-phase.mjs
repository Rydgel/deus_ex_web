// What one function of the page's frame spends in a Firefox inline run: the hitch log's drawn frames (scripts/hitch-run.mjs --browser
// firefox --profile FILE) joined with the Gecko profile of the page's main thread, then every sample whose stack holds a frame matching
// --entry is attributed: by leaf function (self), by named frame (inclusive), by the child frames directly under the entry, and by the
// Rust core's import the sample is under. Milliseconds a drawn frame spends (samples x interval / drawn frames from --skip seconds after
// the map). Host measurement only (docs/firefox-60fps-plan.md step 4).
//
//   node scripts/gecko-phase.mjs RUN.json PROFILE.json --entry REGEX [--within REGEX] [--skip 5] [--all] [--tree MS] [--top 30] [--depth 2] [--json OUT] [--where 'p.lightAnimation>3'] [--spot 140,143]
//     (--within: only samples with a frame matching it below the entry; the tallies are of what is under that frame)
//     (--entry matches the frame's profile label, e.g. '^hud \(src/viewer/sim-session' or 'hud\.mjs.*render')
//
// The clock join is gecko-slow-ticks.mjs's: the offset (within 5 s) whose per-frame count of level-tick samples correlates best with
// the frames' tick phase.
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),option=(n,f)=>{const i=args.indexOf(`--${n}`);return i<0?f:args[i+1];};
const [runFile,profFile]=args.filter((a,i)=>!a.startsWith('--')&&!args[i-1]?.startsWith('--'));
const entryRe=new RegExp(option('entry')),withinRe=option('within',null)?new RegExp(option('within')):null;
const treeMin=Number(option('tree',0)),wholeRun=args.includes('--all'),skipS=Number(option('skip',5)),top=Number(option('top',30)),depth=Number(option('depth',2));
const run=JSON.parse(readFileSync(runFile,'utf8')),prof=JSON.parse(readFileSync(profFile,'utf8'));
const d=run.dump,ci=Object.fromEntries(d.columns.map((c,i)=>[c,i])),started=Date.parse(d.meta.started);
const mapAt=d.events.filter(e=>e.kind==='map').at(-1)?.t??0;
// --where 'COLUMN>MIN' ('<' too): only the drawn frames whose hitch-log COLUMN (p.lightAnimation, animate, ...) satisfies it (a place's costly frames among a --places run's)
const where=option('where',null)?.match(/^(.+?)([<>])(-?[\d.]+)$/);
if(option('where',null)&&!where)throw new Error("--where takes COLUMN>NUMBER or COLUMN<NUMBER");
// --spot N[,N...]: only the drawn frames of those spots of a --places run (the window scripts/spot-census.mjs --figures reports: the rows between a spot's start and end)
const spotWindows=option('spot',null)?.split(',').map(Number).map(i=>run.spots?.[i]).filter(Boolean).map(spot=>[spot.start-d.meta.originMs,spot.end-d.meta.originMs]);
if(option('spot',null)&&!spotWindows?.length)throw new Error('--spot: no such spot in the run');
const keep=r=>(!where||(where[2]==='>'?r[ci[where[1]]]>Number(where[3]):r[ci[where[1]]]<Number(where[3])))&&(!spotWindows||spotWindows.some(([a,b])=>r[ci.t]>=a&&r[ci.t]<=b));
const frames=d.rows.filter(r=>r[ci.drawn]&&r[ci.t]>=mapAt+skipS*1000&&keep(r)).map(r=>({t:r[ci.t],animate:r[ci.animate],tick:r[ci['p.tick']],hud:r[ci['p.hud']]}));
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
const samples=thread.samples.data.filter(r=>r[ss.stack]!==null).map(r=>({at:base+r[ss.time],fr:framesOf(r[ss.stack])})).sort((a,b)=>a.at-b.at);
const tickSamples=samples.filter(s=>s.fr.some(f=>TICK.test(f)));
const lower=(arr,x)=>{let lo=0,hi=arr.length;while(lo<hi){const m=(lo+hi)>>1;if(arr[m].at<x)lo=m+1;else hi=m;}return lo;};
const corr=offset=>{let n=0,sx=0,sy=0,sxx=0,syy=0,sxy=0;for(const f of frames){const a=started+f.t+offset,c=lower(tickSamples,a+f.animate)-lower(tickSamples,a);
  n++;sx+=c;sy+=f.tick;sxx+=c*c;syy+=f.tick*f.tick;sxy+=c*f.tick;}
  const v=(n*sxx-sx*sx)*(n*syy-sy*sy);return v>0?(n*sxy-sx*sy)/Math.sqrt(v):0;};
let best=0,bestR=-2;
for(let off=-5000;off<=5000;off+=10){const r=corr(off);if(r>bestR){bestR=r;best=off;}}
for(let off=best-10;off<=best+10;off++){const r=corr(off);if(r>bestR){bestR=r;best=off;}}
const self=new Map(),incl=new Map(),kids=new Map(),imp=new Map();let n=0;const trie={n:0,kids:new Map()};
// --all: no per-frame windows, every sample from --skip seconds after the map (when the frames' clock join is weak, a short tick)
const windows=wholeRun?[{a:started+mapAt+skipS*1000+best,b:Infinity}]:frames.map(f=>({a:started+f.t+best,b:started+f.t+best+f.animate}));
for(const {a,b} of windows){
  {
  for(let i=lower(samples,a);i<samples.length&&samples[i].at<b;i++){
    const fr=samples[i].fr;let ei=-1;
    // the outermost matching frame (a match under another match counts once)
    for(let q=fr.length-1;q>=0;q--)if(entryRe.test(fr[q])){ei=q;break;}
    if(ei<0)continue;
    // --within: the tallies are of what is under the outermost frame matching it that lies below the entry
    let anchor=ei;
    if(withinRe){anchor=-1;for(let q=ei-1;q>=0;q--)if(withinRe.test(fr[q])){anchor=q;break;}if(anchor<0)continue;}
    n++;
    const under=fr.slice(0,anchor);
    const leaf=under.find(named)??'(the entry itself)';self.set(leaf,(self.get(leaf)??0)+1);
    for(const x of new Set(under.filter(named)))incl.set(x,(incl.get(x)??0)+1);
    const kid=under.slice().reverse().filter(named).slice(0,depth).join(' > ')||'(the entry itself)';kids.set(kid,(kids.get(kid)??0)+1);
    const js=[...under].reverse().find(x=>/^js_\w+ /.test(x));
    const k=js?js.split(' ')[0]:under.some(x=>/wasm-function/.test(x))?'(in Wasm)':'(JavaScript, no Wasm under it)';
    imp.set(k,(imp.get(k)??0)+1);
    if(treeMin>0){let node=trie;node.n++;for(const x of under.slice().reverse().filter(named)){let c=node.kids.get(x);if(!c)node.kids.set(x,c={n:0,kids:new Map()});c.n++;node=c;}}
  }
  }
}
const ms=v=>(v*interval/frames.length);
const mean=k=>frames.reduce((s,f)=>s+f[k],0)/frames.length;
console.log(`${runFile}: ${frames.length} drawn frames from ${skipS} s after the map; offset ${best} ms (corr ${bestR.toFixed(2)}); p.hud mean ${mean('hud').toFixed(2)} ms, p.tick ${mean('tick').toFixed(2)} ms; interval ${interval} ms`);
console.log(`entry /${entryRe.source}/: ${ms(n).toFixed(2)} ms a frame (${n} samples)`);
const show=(title,map)=>{console.log(`\n${title} (ms a frame)`);for(const [k,c] of [...map].sort((a,b)=>b[1]-a[1]).slice(0,top))console.log(`${ms(c).toFixed(2).padStart(7)}  ${k.slice(0,170)}`);};
show('by the Rust core\'s import',imp);show(`children (${depth} deep, outermost first)`,kids);show('by leaf (self)',self);show('by named frame (inclusive)',incl);
if(treeMin>0){
  // the top-down tree of named frames, root first; a node under --tree ms is left out; a chain that carries all of its parent's time is
  // printed on one line
  console.log(`\ncall tree (ms a frame, nodes of at least ${treeMin} ms)`);
  const out=(node,name,depth)=>{
    const kids=[...node.kids].filter(([,c])=>ms(c.n)>=treeMin).sort((a,b)=>b[1].n-a[1].n);
    if(name!==null)console.log(`${ms(node.n).toFixed(2).padStart(6)} ${'  '.repeat(Math.min(depth,40))}${name.slice(0,120)}`);
    for(const [k,c] of kids)out(c,k,depth+1);
  };
  out(trie,null,0);
}
if(option('json',null))writeFileSync(option('json'),JSON.stringify({entry:entryRe.source,frames:frames.length,ms:ms(n),imports:Object.fromEntries([...imp].map(([k,c])=>[k,ms(c)])),
  self:Object.fromEntries([...self].map(([k,c])=>[k,ms(c)])),incl:Object.fromEntries([...incl].map(([k,c])=>[k,ms(c)]))},null,1));
