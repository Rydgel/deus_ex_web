import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {setBase} from '../src/runtime/walking-callbacks.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/actor-queries';await mkdir(directory,{recursive:true});
// extraActors: fabricated non-base actors; chains: X->Base->Y sequences
// (entry 'self' is the receiver); old/new: the receiver's Base before and
// the SetBase argument — 'world' is the receiver's +0xa8 LevelInfo.
const cases=[
 {extraActors:2,old:0,new:1},
 {extraActors:2,old:0,new:0},
 {extraActors:1,new:null},
 {extraActors:1,new:'world'},
 {extraActors:2,old:0,new:null},
 {extraActors:1,chains:[[0,'self']],new:0},
 {extraActors:2,chains:[[0,1],[1,'self']],new:0},
 {extraActors:1,old:'world',new:0},
 {extraActors:2,old:0,new:1,countSeed:255},
];
await writeFile(`${directory}/set-base-cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-set-base-oracle.py',gameDirectory(),`${directory}/set-base-cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/set-base.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/set-base.json`,'utf8'));let mismatches=0;
for(const [index,c] of cases.entries()){
 const world={id:'world',base:null,standingCount:c.countSeed??7};
 const source={id:'self',base:null,standingCount:c.countSeed??7,worldActor:world};
 const cas=[];for(let i=0;i<(c.extraActors??0);i++)cas.push({id:i,base:null,standingCount:c.countSeed??7});
 for(const chain of c.chains??[]){let prev=null;
  for(const entry of chain){const a=entry==='self'?source:cas[entry];if(prev)prev.base=a;prev=a;}}
 source.base=c.old==='world'?world:c.old!=null?cas[c.old]:null;
 const target=c.new==='world'?world:c.new!=null?cas[c.new]:null;
 // Helper level: AActor::SetBase semantics through the ported body.
 const events=[];
 const dispatch=(actor,name,args)=>events.push({event:name,target:actor.id,
  base:source.base?.id??null,param:args[0]?.id??null});
 setBase(source,target,dispatch,true);
 const actual={base:source.base?.id??null,
  counts:[...cas.map(a=>a.standingCount),source.standingCount,world.standingCount],
  events,result:0};
 // Binding level: invokeNative(298) on a collision-view receiver evaluates
 // NewBase then calls the body with notify=1.
 const worldB={id:'world',base:null,standingCount:c.countSeed??7};
 const sourceB={id:'self',base:null,standingCount:c.countSeed??7,worldActor:worldB};
 const casB=[];for(let i=0;i<(c.extraActors??0);i++)casB.push({id:i,base:null,standingCount:c.countSeed??7});
 for(const chain of c.chains??[]){let prev=null;
  for(const entry of chain){const a=entry==='self'?sourceB:casB[entry];if(prev)prev.base=a;prev=a;}}
 sourceB.base=c.old==='world'?worldB:c.old!=null?casB[c.old]:null;
 const targetB=c.new==='world'?worldB:c.new!=null?casB[c.new]:null;
 const boundEvents=[];const evalOrder=[];
 const boundDispatch=(actor,name,args)=>boundEvents.push({event:name,target:actor.id,
  base:sourceB.base?.id??null,param:args[0]?.id??null});
 const runtime=Object.create(ScriptRuntime.prototype);
 runtime.boundaryNatives=new Set();runtime.collisionViewActors=new WeakSet([sourceB]);
 runtime.levelFor=()=>({hash:{levelInfo:worldB},actors:[worldB]});
 runtime.dispatchSpawnedEvent=boundDispatch;
 runtime.invokeNative({index:298,argumentCount:1,receiver:sourceB,
  evaluateArgument:i=>{evalOrder.push(i);return targetB;}});
 const boundActual={base:sourceB.base?.id??null,
  counts:[...casB.map(a=>a.standingCount),sourceB.standingCount,worldB.standingCount],
  events:boundEvents,result:0,evalOrder:[0]};
 const expected={...reference.results[index],evalOrder:[0]};
 try{assert.deepEqual(actual,reference.results[index]);}catch{mismatches++;console.log(JSON.stringify({index,actual,expected:reference.results[index]}));}
 try{assert.deepEqual(boundActual,expected);}catch{mismatches++;console.log(JSON.stringify({index,boundActual,expected}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
