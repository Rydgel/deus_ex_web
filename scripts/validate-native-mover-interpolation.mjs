import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {tickMoverInterpolation} from '../src/runtime/mover-interpolation.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/doors';await mkdir(directory,{recursive:true});
const cases=[];
const basic={rate:.5,position:[-220,800,-64],rotation:[0,16384,0],oldPosition:[-220,800,-64],basePosition:[-220,800,-64],keyPosition:[0,-56,0]};
for(const alpha of [0,.25,.5,.75,.99,1])for(const dt of [0,.000001,.01,.5])cases.push({...basic,alpha,dt});
for(const override of [{alpha:.99,dt:.1,responses:[false,false]},{alpha:0,dt:1/120},{alpha:0,dt:.5,interpolating:false},{alpha:.25,dt:.125,glideType:0},{alpha:.75,dt:.125,keyPosition:[0,0,0],oldPosition:[-220,744,-64],position:[-220,791.25,-64]}])cases.push({...basic,...override});
await writeFile(`${directory}/cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-mover-interpolation-oracle.py',gameDirectory(),`${directory}/cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/original.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));
let mismatches=0;
for(const [index,c] of cases.entries()){
 const events=[],responses=(c.responses??[]).slice(),mover={...c,alpha:Math.fround(c.alpha),position:c.position.slice(),key:1,previousKey:0,keyPositions:[[0,0,0],c.keyPosition],interpolating:c.interpolating??true,glideType:c.glideType??1};
 mover.move=(delta,rotation)=>{const success=responses.length?responses.shift():true;events.push({move:delta,rotation,success});if(success)mover.position=mover.position.map((v,i)=>Math.fround(v+delta[i]));return success;};
 mover.onInterpolateEnd=()=>events.push({interpolateEnd:true});
 tickMoverInterpolation(mover,c.dt);
 const actual={events,position:mover.position,alpha:mover.alpha,interpolating:mover.interpolating};
 try{assert.deepEqual(actual,reference.results[index]);}catch{mismatches++;console.log(JSON.stringify({index,actual,expected:reference.results[index]}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
