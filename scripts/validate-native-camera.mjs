import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
const f=Math.fround, cases=[];
const eye={timeDilation:1,physics:1,justLanded:false,eyeHeight:38,baseEyeHeight:38,locationZ:100,oldLocationZ:100,shakeVert:0,joltMagnitude:0,bob:.02};
const rotations=[...[0,1,3,4,16383,16384,16385,32768,49152,65535,-1,-4,-16384].map(y=>[0,y,0]),
  [2049,-3191,4097],[16384,0,0],[0,0,16384],[-8192,23713,-9011]];
let seed=91617;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
for(let i=0;i<96;i++) rotations.push(Array.from({length:3},()=> (random()*131072-65536)|0));
for(const rotation of rotations) for(const velocity of [[0,0,0],[-123.456,72.345,31],[320.123,134.7,-900]]) {
  cases.push({rotation,velocity,dt:1/120,walkBob:[1,-2,3],eye});
}
for(const dt of [0,.001,1/120,1/60,.1,.2]) for(const physics of [1,2]) for(const justLanded of [false,true])
for(const timeDilation of [.5,1,2]) for(const delta of [-16,0,16]) cases.push({
  rotation:[0,7001,0],velocity:[44.5,-18.2,9],dt,walkBob:[.123,-.345,6.789],
  eye:{...eye,timeDilation,physics,justLanded,oldLocationZ:100-delta,baseEyeHeight:12,
    shakeVert:.75,joltMagnitude:.15},
});
const directory=path.resolve('reports/movement/native-camera');await mkdir(directory,{recursive:true});
const casesFile=path.join(directory,'cases.json');await writeFile(casesFile,JSON.stringify(cases));
const {stdout}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',
 ['scripts/native-camera-oracle.py',gameDirectory(),casesFile],{maxBuffer:32*1024*1024,timeout:120000});
await writeFile(path.join(directory,'original.json'),stdout);const native=JSON.parse(stdout);
if(process.argv.includes('--capture-only')) console.log(JSON.stringify({captured:cases.length,hashes:native.hashes}));
else {
 const {getAxes,walkingBobInputs,updateEyeHeight,decayWalkBob}=await import('../src/runtime/camera.mjs');
 const mismatches=[];
 cases.forEach((c,index)=>{
  const actual={axes:getAxes(c.rotation),speed2D:walkingBobInputs(c.dt,c.velocity,c.rotation).Speed2D,
   eye:updateEyeHeight(c.eye,c.dt),decay:decayWalkBob(c.walkBob,c.dt)};
  try{assert.deepEqual(actual,native.results[index]);}catch{mismatches.push({index,actual,expected:native.results[index]});}
 });
 const summary={cases:cases.length,hashes:native.hashes,mismatches};await writeFile(path.join(directory,'comparison.json'),JSON.stringify(summary,null,2));
 console.log(JSON.stringify({...summary,mismatches:mismatches.slice(0,3),mismatchCount:mismatches.length},null,2));
 assert.equal(mismatches.length,0);
}
