// The allocation route's synthetic check (docs/live-heap.md "Allocation sets the long frame"): a dedicated worker holding a
// pointer-rich heap like the simulation worker's (12 M objects of 4 references by default, about 370 MB), driven at 60 Hz by the
// page as main.mjs drives the simulation (a post per display frame unless one is in flight). Each frame allocates --alloc MB of
// short-lived six-field objects, keeps --promo KB in a ring dropped every 20 s (so the old generation grows and major GCs run),
// and busy-works --work ms. The worker records each frame's handler time; V8's log, which DEBUG=pw:browser forwards to stderr,
// gives the marking steps (scripts/gc-marking-cycles.mjs reads both). Host measurement only.
//   DEBUG=pw:browser taskset -c 0,1 node scripts/gc-allocation-synth.mjs --alloc 2.5 --promo 200 --seconds 120 --out RUN.json 2> RUN.v8.log
//     [--objects 12e6] [--work 10]
import {chromium} from '@playwright/test';
import {writeFileSync} from 'node:fs';
const option=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i<0?f:process.argv[i+1];};
const alloc=Number(option('alloc',2.5)),seconds=Number(option('seconds',90)),objects=Number(option('objects',12e6));
const work=Number(option('work',10)),promo=Number(option('promo',400)),out=option('out',null);
const worker=`
const OBJECTS=${objects},ALLOC=${alloc},WORK=${work},PROMO=${promo};
// The live heap: a graph of 4-reference objects (random links, so marking walks it all).
const nodes=new Array(OBJECTS);
for(let i=0;i<OBJECTS;i++)nodes[i]={a:null,b:null,c:null,d:null};
let seed=1;const rnd=()=>(seed=(seed*1103515245+12345)>>>0)%OBJECTS;
for(let i=0;i<OBJECTS;i++){const n=nodes[i];n.a=nodes[rnd()];n.b=nodes[rnd()];n.c=nodes[rnd()];n.d=nodes[rnd()];}
// Six-field objects: 12 + 6*4 = 36 bytes with pointer compression, so ALLOC MB is ALLOC*2^20/36 of them.
const perFrame=Math.round(ALLOC*1048576/36),keepPer=Math.round(PROMO*1024/36);
let ring=[],ringStart=performance.now(),sink=null;
const frames=[];
onmessage=e=>{
  if(e.data==='dump'){postMessage({frames});return;}
  const t0=performance.now();
  let prev=null;
  for(let i=0;i<perFrame;i++){const o={x:i,y:prev,z:null,w:null,v:null,u:null};prev=(i&15)?o:null;}
  for(let i=0;i<keepPer;i++)ring.push({x:i,y:null,z:null,w:null,v:null,u:null});
  sink=prev;
  if(t0-ringStart>20000){ring=[];ringStart=t0;}
  const end=performance.now()+WORK;let x=0;while(performance.now()<end)x++;
  frames.push([t0,performance.now()-t0]);
  postMessage(0);
};
postMessage('ready');`;
const html=`<script>
const w=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}],{type:'text/javascript'})));
let busy=false,ready=false;window.result=null;
w.onmessage=e=>{if(e.data==='ready'){ready=true;document.title='ready';return;}if(e.data&&e.data.frames){window.result=e.data.frames;return;}busy=false;};
// Like main.mjs: post each display frame unless the last is still in flight.
const tick=()=>{if(ready&&!busy&&!window.halted){busy=true;w.postMessage(0);}requestAnimationFrame(tick);};requestAnimationFrame(tick);
window.dump=()=>{window.halted=true;w.postMessage('dump');};
</script>`;
const browser=await chromium.launch({args:['--js-flags=--trace-gc --trace-incremental-marking']});
const page=await browser.newPage();
await page.setContent(html);
await page.waitForFunction(()=>document.title==='ready',{}, {timeout:180000});
await page.waitForTimeout(seconds*1000);
await page.evaluate(()=>window.dump());
const frames=await page.waitForFunction(()=>window.result,{}, {timeout:60000}).then(h=>h.jsonValue());
await browser.close();
const after=frames.filter(([t])=>t>frames[0][0]+5000),durs=after.map(([,d])=>d).sort((a,b)=>a-b);
const gaps=[];for(let i=1;i<after.length;i++)gaps.push(after[i][0]-after[i-1][0]);
const q=p=>durs[Math.min(durs.length-1,Math.floor(p*durs.length))];
const summary={alloc,work,promo,objects,frames:after.length,p50:q(.5),p99:q(.99),max:durs.at(-1),
  over50:durs.filter(d=>d>50).length,over100:durs.filter(d=>d>100).length,gapMax:Math.max(...gaps),gapsOver100:gaps.filter(g=>g>100).length};
console.log(JSON.stringify(summary));
if(out)writeFileSync(out,JSON.stringify({summary,frames}));
