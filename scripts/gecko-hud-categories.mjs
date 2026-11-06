// Where the HUD paint's samples go in a Firefox inline run, by category: scripts/gecko-phase.mjs's join of the hitch log
// (scripts/hitch-run.mjs --browser firefox --profile FILE) and the Gecko profile, then every sample under --entry (default
// '^paintWindows \\(', or '^hud \\(src/viewer/sim-session' for the whole step) is put in the first category whose test its stack
// passes: gcDrawText (with its push and pop), a Rust-VM import that calls a script function, another js_eval, any other js_* import,
// the Rust VM's own code, the JavaScript around script events, the window host's family draws, the draw tree and heap access. The
// categories overlap in nature, not in count: each sample is counted once. Milliseconds a drawn frame spends. Host measurement only
// (docs/firefox-60fps-plan.md, the HUD phase).
//
//   node scripts/gecko-hud-categories.mjs RUN.json PROFILE.json [--entry REGEX] [--skip 5] [--all]
//
// (the join, the options and the tail are gecko-phase.mjs's)
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),option=(n,f)=>{const i=args.indexOf(`--${n}`);return i<0?f:args[i+1];};
const [runFile,profFile]=args.filter((a,i)=>!a.startsWith('--')&&!args[i-1]?.startsWith('--'));
const entryRe=new RegExp(option('entry')),withinRe=option('within',null)?new RegExp(option('within')):null;
const treeMin=Number(option('tree',0)),wholeRun=args.includes('--all'),skipS=Number(option('skip',5)),top=Number(option('top',30)),depth=Number(option('depth',2));
const run=JSON.parse(readFileSync(runFile,'utf8')),prof=JSON.parse(readFileSync(profFile,'utf8'));
const d=run.dump,ci=Object.fromEntries(d.columns.map((c,i)=>[c,i])),started=Date.parse(d.meta.started);
const mapAt=d.events.filter(e=>e.kind==='map').at(-1)?.t??0;
const frames=d.rows.filter(r=>r[ci.drawn]&&r[ci.t]>=mapAt+skipS*1000).map(r=>({t:r[ci.t],animate:r[ci.animate],tick:r[ci['p.tick']],hud:r[ci['p.hud']]}));
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

const RULES=[
  ['gcDrawText (incl. its push/pop)',s=>s.some(f=>/^gcDrawText /.test(f))],
  ['js_eval -> script call (callFunction)',s=>s.some(f=>/^js_eval /.test(f))&&s.some(f=>/^callFunction /.test(f))],
  ['js_eval other (natives, field reads)',s=>s.some(f=>/^js_eval /.test(f))],
  ['other js_* imports',s=>s.some(f=>/^js_\w+ /.test(f))],
  ['Rust VM own (wasm)',s=>s.some(f=>/wasm-function/.test(f))],
  ['event bookkeeping (JS)',s=>s.some(f=>/^(processEvent|processScript|executeScript|resumeFrame|resumeCompiled|resume|createFrameLocals|destroyFunctionLocals|setLocalCopy|getLocalCopy|loweringFor|frameLayout|init|acquire|lookup|lookupMember|instance|handleOf|scriptability) /.test(f))],
  ['family draws (JS)',s=>s.some(f=>/^(buttonDraw|textDraw|computerDraw|textLogDraw|checkboxDraw|draw) \(src\/runtime\/script-window-(host|family)/.test(f))],
  ['drawTree + heap (JS)',s=>s.some(f=>/^(drawTree|paintWindows) /.test(f))],
];
const cat=new Map();let n=0;const unk=new Map();
const entry=new RegExp(option('entry','^paintWindows \\('));
const windows=wholeRun?[{a:started+mapAt+skipS*1000+best,b:Infinity}]:frames.map(f=>({a:started+f.t+best,b:started+f.t+best+f.animate}));
for(const {a,b} of windows)for(let i=lower(samples,a);i<samples.length&&samples[i].at<b;i++){
  const fr=samples[i].fr;let ei=-1;for(let q=fr.length-1;q>=0;q--)if(entry.test(fr[q])){ei=q;break;}
  if(ei<0)continue;n++;const under=fr.slice(0,ei+1);
  let k='other';for(const [name,test] of RULES)if(test(under)){k=name;break;}
  cat.set(k,(cat.get(k)??0)+1);
  if(k==='other'){const l=under.find(named)??'?';unk.set(l,(unk.get(l)??0)+1);}
}
const ms=v=>(v*interval/frames.length);
console.log(`${runFile} entry ${entry.source}: ${ms(n).toFixed(2)} ms/frame`);
for(const [k,c] of [...cat].sort((a,b)=>b[1]-a[1]))console.log(`${ms(c).toFixed(2).padStart(7)}  ${k}`);
for(const [k,c] of [...unk].sort((a,b)=>b[1]-a[1]).slice(0,8))console.log(`   other: ${ms(c).toFixed(2)} ${k}`);
