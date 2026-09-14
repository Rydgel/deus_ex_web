import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {isOverlapping} from '../src/runtime/actor-touch.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/actor-queries';await mkdir(directory,{recursive:true});
// The native exclusion is Primitive!=0 with Brush class ancestry on either
// side; the host actor view carries exactly that conjunction as movingBrush.
const BRUSH_KINDS=new Set(['Mover','Brush']);
const spec=(s={})=>({position:s.position??[0,0,0],radius:s.radius??22,height:s.height??44,
 movingBrush:Boolean(s.primitive)&&BRUSH_KINDS.has(s.kind)});
const cases=[
 {source:{position:[0,0,0],radius:22,height:44},other:{position:[10,0,0],radius:22,height:44}},
 {source:{position:[0,0,0],radius:22,height:44},other:{position:[44,0,0],radius:22,height:44}},
 {source:{position:[0,0,0],radius:22,height:44},other:{position:[43.9,0,0],radius:22,height:44}},
 {source:{position:[0,0,0],radius:22,height:44},other:{position:[0,0,88],radius:22,height:44}},
 {source:{position:[0,0,0],radius:22,height:44},other:{position:[0,0,87.9],radius:22,height:44}},
 {source:{position:[0,0,0],radius:22,height:44},other:{position:[31.1,31.1,0],radius:22,height:44}},
 {source:{position:[0,0,0],radius:22,height:44},otherIsWorld:true},
 {source:{position:[0,0,0],radius:22,height:44},other:{position:[10,0,0],radius:22,height:44,primitive:true,kind:'Mover'}},
 {source:{position:[0,0,0],radius:22,height:44,primitive:true,kind:'Mover'},other:{position:[10,0,0],radius:22,height:44}},
 {source:{position:[0,0,0],radius:22,height:44},other:{position:[10,0,0],radius:22,height:44,primitive:true,kind:'Pawn'}},
 {source:{position:[0,0,0],radius:22,height:44},other:{position:[10,0,0],radius:22,height:44,kind:'Mover'}},
 {source:{position:[0,0,0],radius:22,height:44},null:true},
];
await writeFile(`${directory}/is-overlapping-cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-is-overlapping-oracle.py',gameDirectory(),`${directory}/is-overlapping-cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/is-overlapping.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/is-overlapping.json`,'utf8'));let mismatches=0;
for(const [index,c] of cases.entries()){
 const world={name:'world',position:[0,0,0],radius:22,height:44};
 const source={...spec(c.source),worldActor:world};
 const other=c.null?null:c.otherIsWorld?world:{...spec(c.other),worldActor:world};
 // The null-reference short circuit lives in the exec wrapper, not the body.
 const actual={result:c.null?0:(isOverlapping(source,other)?1:0)};
 // Binding level: execIsOverlapping evaluates checkActor, publishes 0 for a
 // null reference without reading the receiver, else runs the body.
 const evalOrder=[];
 const runtime=Object.create(ScriptRuntime.prototype);runtime.boundaryNatives=new Set();
 const bound=runtime.invokeNative({index:718,argumentCount:1,receiver:source,
  evaluateArgument:i=>{evalOrder.push(i);return other;}});
 const expected={...reference.results[index],evalOrder:[0]};
 try{assert.deepEqual(actual,reference.results[index]);}catch{mismatches++;console.log(JSON.stringify({index,actual,expected:reference.results[index]}));}
 try{assert.deepEqual({result:bound?1:0,evalOrder},expected);}catch{mismatches++;console.log(JSON.stringify({index,boundActual:{result:bound,evalOrder},expected}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
