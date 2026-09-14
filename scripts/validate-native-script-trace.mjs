import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {scriptTrace} from '../src/runtime/script-trace.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
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
 // Binding level: invokeNative(277) must evaluate the six arguments in order,
 // pre-store the optional defaults (Start=Location, bTraceActors=collision bit,
 // Extent=zero) before each optional expression runs, forward the recovered
 // SingleLineCheck call and copy hit.Location/Normal into the out slots while
 // returning hit.Actor.
 const evalOrder=[],out={location:[0,0,0],normal:[0,0,0]};
 const slot=name=>({reference:true,get:()=>out[name],set:value=>{out[name]=value;}});
 const runtime=Object.create(ScriptRuntime.prototype);
 runtime.boundaryNatives=new Set();runtime.levelFor=()=>({hash:queries});
 const args=[slot('location'),slot('normal'),c.end,c.start,c.traceActors,c.extent];
 const bound=runtime.invokeNative({index:277,argumentCount:6,receiver:source,evaluateArgument:i=>{evalOrder.push(i);return args[i];}});
 assert.deepEqual(evalOrder,[0,1,2,3,4,5],`eval order case ${index}`);
 assert.deepEqual({query,hit:bound===other,location:out.location,normal:out.normal},original.results[index],`bound case ${index}`);
}
console.log(JSON.stringify({cases:cases.length,mismatches:0}));
