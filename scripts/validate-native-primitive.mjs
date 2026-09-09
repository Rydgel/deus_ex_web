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
