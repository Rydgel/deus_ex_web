import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {walkingInput,healthyWalkingGroundSpeed} from '../src/runtime/player-input.mjs';
const cases=[];
for(const yaw of [0,1,3,4,7001,16384,-1,65535])for(const input of [[0,0],[6000,0],[-6000,6000],[1.234,-567.8]])for(const currentGroundSpeed of [320,320.9,100,333])
 cases.push({rotation:[0,yaw,0],aForward:input[0],aStrafe:input[1],currentGroundSpeed});
for(const rotation of [[16384,0,0],[8193,7001,0],[0,-4,4097],[0,65536,0]])cases.push({rotation,aForward:6000,aStrafe:0,currentGroundSpeed:320});
const directory=path.resolve('reports/movement/player-input');await mkdir(directory,{recursive:true});
const file=path.join(directory,'cases.json');await writeFile(file,JSON.stringify(cases));
const {stdout}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',['scripts/native-player-input-oracle.py',gameDirectory(),file],{maxBuffer:8*1024*1024,timeout:120000});
await writeFile(path.join(directory,'original.json'),stdout);const native=JSON.parse(stdout),mismatches=[];
for(let index=0;index<cases.length;index++){
 const c=cases[index],{aForward,aStrafe,newAccel}=walkingInput(c),actual={aForward,aStrafe,newAccel,groundSpeed:healthyWalkingGroundSpeed(c.currentGroundSpeed,aForward)};
 try{assert.deepEqual(actual,native.results[index]);}catch{mismatches.push({index,actual,expected:native.results[index]});}
}
await writeFile(path.join(directory,'comparison.json'),JSON.stringify({cases:cases.length,hashes:native.hashes,mismatches},null,2));
console.log(JSON.stringify({cases:cases.length,mismatches},null,2));assert.equal(mismatches.length,0);
