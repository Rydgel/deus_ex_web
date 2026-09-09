import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {scriptTrace} from '../src/runtime/script-trace.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/stance-trace';await mkdir(directory,{recursive:true});
const cases=[];
for(const collisionFlags of [0,1])for(const traceActors of [undefined,0,1])for(const hit of [false,true])for(const explicit of [false,true]){
 const c={collisionFlags,end:[40,50,60],hit};if(traceActors!==undefined)c.traceActors=traceActors;
 if(explicit)Object.assign(c,{start:[1,2,3],extent:[20,20,1]});cases.push(c);
}
await writeFile(`${directory}/cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-script-trace-oracle.py',gameDirectory(),`${directory}/cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/original.json`,native.stdout);
}
const original=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));
assert.equal(original.results.length,cases.length);
for(const [index,c] of cases.entries()){
 let query;const source={position:c.position??[10,20,30],flags:c.collisionFlags},other={};
 const queries={lineCheck(start,end,extent,flags,extra,caller){query={source:caller===source,end,start,flags,extent,extra};return {actor:c.hit?other:null,location:[9,8,7],normal:[0,0,1]};}};
 const result=scriptTrace(queries,source,c.end,c.start,c.traceActors,c.extent);
 assert.deepEqual({query,hit:result.actor===other,location:result.location,normal:result.normal},original.results[index],`case ${index}`);
}
console.log(JSON.stringify({cases:cases.length,mismatches:0}));
