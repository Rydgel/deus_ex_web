import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {setActorCollisionSize} from '../src/runtime/script-actor-collision.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/actor-queries';await mkdir(directory,{recursive:true});
const cases=[
 {radius:16,height:32,collide:true,hash:true,oldRadius:4,oldHeight:8},
 {radius:16.1,height:32.7,collide:true,hash:true,oldRadius:4,oldHeight:8},
 {radius:16,height:32,collide:false,hash:true,oldRadius:4,oldHeight:8},
 {radius:-5,height:32,collide:true,hash:false,oldRadius:4,oldHeight:8},
 {radius:0,height:0,collide:true,hash:true,oldRadius:-1,oldHeight:9},
];
await writeFile(`${directory}/set-collision-size-cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-set-collision-size-oracle.py',gameDirectory(),`${directory}/set-collision-size-cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/set-collision-size.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/set-collision-size.json`,'utf8'));let mismatches=0;
for(const [index,c] of cases.entries()){
 // Helper level: AActor::SetCollisionSize — the hash slots record the actor's
 // live CollisionRadius/Height at call time, so remove must observe the old
 // size and add the new.
 const actor={flags:c.collide?1:0,radius:c.oldRadius??4,height:c.oldHeight??8};
 const events=[];
 const hash={removeActor:a=>{events.push({slot:'remove',radius:a.radius,height:a.height});},
  addActor:a=>{events.push({slot:'add',radius:a.radius,height:a.height});}};
 const result=setActorCollisionSize(actor,c.radius,c.height,{level:{hash:c.hash?hash:null}});
 const actual={events,radius:actor.radius,height:actor.height,result:result?1:0};
 // Binding level: invokeNative(283) on a collision-view receiver evaluates
 // radius then height, calls the body and publishes the unconditional 1.
 const boundEvents=[];const evalOrder=[];
 const boundActor={flags:c.collide?1:0,radius:c.oldRadius??4,height:c.oldHeight??8};
 const boundHash={removeActor:a=>{boundEvents.push({slot:'remove',radius:a.radius,height:a.height});},
  addActor:a=>{boundEvents.push({slot:'add',radius:a.radius,height:a.height});}};
 const runtime=Object.create(ScriptRuntime.prototype);
 runtime.boundaryNatives=new Set();runtime.collisionViewActors=new WeakSet([boundActor]);
 runtime.levelFor=()=>({hash:c.hash?boundHash:null});
 const args=[c.radius,c.height];
 const bound=runtime.invokeNative({index:283,argumentCount:2,receiver:boundActor,
  evaluateArgument:i=>{evalOrder.push(i);return args[i];}});
 const boundActual={events:boundEvents,radius:boundActor.radius,height:boundActor.height,result:bound?1:0,evalOrder};
 const expected={...reference.results[index],evalOrder:[0,1]};
 try{assert.deepEqual(actual,reference.results[index]);}catch{mismatches++;console.log(JSON.stringify({index,actual,expected:reference.results[index]}));}
 try{assert.deepEqual(boundActual,expected);}catch{mismatches++;console.log(JSON.stringify({index,boundActual,expected}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
