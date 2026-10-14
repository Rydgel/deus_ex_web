import fs from 'node:fs';
import {primitiveLineCheck,primitivePointCheck} from '../src/runtime/primitive-collision.mjs';
import {spawnSync} from 'node:child_process';
export function primitiveReferenceCases() {
 let seed=932;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const cases=[];
 for(const extent of [[0,0,0],[20,20,43],[20,20,16],[3,7,5]]){
  const r=10+extent[0],h=20+extent[2];
  for(const start of [[0,0,0],[5,0,0],[r,0,0],[-r,0,0],[0,r,0],[0,0,h],[0,0,-h],[r-1e-5,0,0],[r+1e-5,0,0],[0,0,h-1e-5],[40,40,40]]){
   for(const end of [[0,0,0],[100,0,0],[-100,0,0],[0,0,100],[0,0,-100],[100,100,100],start])cases.push({actor:{location:[0,0,0],radius:10,height:20},start,end,extent});
  }
 }
 // Directed near-center trajectories increase side/cap hits; free trajectories
 // exercise broad rejection. Shifted centers expose float store ordering.
 for(let i=0;i<5000;i++){
  const location=Array.from({length:3},()=>200*random()-100);
  const radius=1+40*random(),height=1+70*random();
  const start=location.map(v=>v+300*random()-150);
  const end=i%2?location.map(v=>v+40*random()-20):location.map(v=>v+300*random()-150);
  cases.push({actor:{location,radius,height},start,end,extent:[[0,0,0],[20,20,43],[20,20,16],[3,7,5]][i%4]});
 }
 for(const d of [0,.00001,.0001,.001,.01,.02,.021,-.02,-.021])for(const x of [0,5,9.99,10,10.001])cases.push({actor:{location:[0,0,0],radius:10,height:20},start:[x,0,0],end:[x+d,0,0],extent:[0,0,0]});
 cases.push(...shipFanBulbCases());
 return cases;
}

/** 09_NYC_ShipFan's fan2 view (docs/coronas.md "Lights inside a colliding
 * actor"): Lightbulb12's cylinder with Light34 inside it, 0.37 above the
 * bottom cap, and the camera 735 units away, in both directions; then the
 * neighbours of that case on long segments: a start inside heading out,
 * across or in (the horizontal dot around the -0.1 threshold), a far start
 * entering through the bottom cap with its end inside, on or just below it,
 * rays grazing the side, and a viewer cylinder holding the eye. */
export function shipFanBulbCases() {
 const f=Math.fround,v=a=>a.map(f),zero=[0,0,0],cases=[];
 const bulb={location:v([-271.79,274.31,87.67]),radius:f(1.6),height:f(2.9)};
 const [lx,ly,lz]=bulb.location,light=v([-272.30,273.81,85.14]),eye=v([236,-238,-55]);
 const line=(start,end,actor=bulb)=>cases.push({actor,start:v(start),end:v(end),extent:zero});
 line(eye,light);line(light,eye);
 // Light34's horizontal offset from the bulb's axis, its length and a perpendicular.
 const ox=light[0]-lx,oy=light[1]-ly,ol=Math.hypot(ox,oy),px=-oy/ol,py=ox/ol;
 for(const side of [1,-1])for(const dot of [-5,-.2,-.11,-.1,-.09,-.05,0,.05,5]){
  const k=dot/ol;line(light,[light[0]+side*720*px+k*ox/ol,light[1]+side*720*py+k*oy/ol,light[2]-140]);
 }
 for(const depth of [.4,.37,.01,.001,0,-.001,-.01]){
  const end=[lx+ox,ly+oy,lz-bulb.height+depth];
  line(eye,end);line([lx+3,ly,lz-15],[lx,ly,lz-bulb.height+depth]);
 }
 // Along the camera's horizontal direction, passing `distance` from the axis.
 const ux=(lx-eye[0])/Math.hypot(lx-eye[0],ly-eye[1]),uy=(ly-eye[1])/Math.hypot(lx-eye[0],ly-eye[1]);
 for(const distance of [1.59,1.599,1.6,1.601,1.61]){
  const s=[lx-700*ux-distance*uy,ly-700*uy+distance*ux,lz-1],e=[lx+50*ux-distance*uy,ly+50*uy+distance*ux,lz+.05];
  line(s,e);line(e,s);
 }
 const viewer={location:v([236,-238,-85]),radius:f(20),height:f(43)};
 line(light,eye,viewer);line(eye,light,viewer);
 return cases;
}

if(!process.argv[2]) {
 fs.mkdirSync('.cache/primitive',{recursive:true});
 fs.writeFileSync('.cache/primitive/cases.json',JSON.stringify(primitiveReferenceCases()));
 const run=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-primitive-oracle.py',process.env.DEUS_EX_ROOT??'Deus Ex GOTY Edition','.cache/primitive/cases.json'],{encoding:'utf8',maxBuffer:32*1024*1024});
 if(run.status!==0)throw new Error(run.stderr);
 fs.writeFileSync('.cache/primitive/native.json',run.stdout);
}
const cases=JSON.parse(fs.readFileSync(process.argv[2]??'.cache/primitive/cases.json'));
const ref=JSON.parse(fs.readFileSync(process.argv[3]??'.cache/primitive/native.json')).results;
let failures=[];
for(let i=0;i<cases.length;i++){
 const c=cases[i];
 for(const [kind,actual] of [['line',primitiveLineCheck(c.actor,c.start,c.end,c.extent)],['point',primitivePointCheck(c.actor,c.start,c.extent)]]){
  const expected=ref[i][kind];
  for(const field of ['outside','time','location','normal']){
   if(JSON.stringify(actual[field])!==JSON.stringify(expected[field]))failures.push({i,kind,field,actual:actual[field],expected:expected[field]});
  }
 }
 if(JSON.stringify(ref[i].line)!==JSON.stringify(ref[i].mesh))failures.push({i,kind:'mesh'});
}
fs.writeFileSync('.cache/primitive/comparison.json',JSON.stringify({cases:cases.length,failures},null,2));
console.log(JSON.stringify({cases:cases.length,failures:failures.length,first:failures.slice(0,20)},null,2));
process.exitCode=failures.length?1:0;
