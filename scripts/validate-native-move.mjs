import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {execMove} from '../src/runtime/script-move.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/actor-queries';await mkdir(directory,{recursive:true});
// The oracle stubs ULevel::MoveActor at the XLevel vtable +0x88 and records
// the call shape; `return` is the dword the stub hands back.
const cases=[
 {delta:[1.5,-2.25,3.0],rotation:[16384,32768,0],return:1},
 {delta:[0.0,0.0,0.0],rotation:[0,0,0],return:0},
 {delta:[-100.5,0.001,1e10],rotation:[65535,-1,2147483647],return:4294967295},
 {delta:[1e-30,-1e30,8388608.0],rotation:[-2147483648,2147483647,-65536],return:2},
];
await writeFile(`${directory}/move-cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-move-oracle.py',gameDirectory(),`${directory}/move-cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/move.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/move.json`,'utf8'));let mismatches=0;
for(const [index,c] of cases.entries()){
 const expected={move:{actorIsReceiver:true,levelIsXLevel:true,
  delta:c.delta.map(Math.fround),rotation:c.rotation,
  hit:[0,0,0,0,0,0,0,0,0,1,-1],zeros:[0,0,0,0]},result:c.return};
 // Helper level: execMove against a recorded service boundary.
 const receiver={id:'self',fields:{Rotation:c.rotation.slice()}};
 const level={};
 const calls=[];
 level.moveActor=function(...args){calls.push({self:this,args});return c.return;};
 const services={
  read:(actor,name)=>name==='XLevel'?level:actor.fields[name],
  moveActor:level.moveActor.bind(level),
 };
 const helperResult=execMove({receiver,argumentCount:1,evaluateArgument:i=>c.delta},services);
 const actual={move:{actorIsReceiver:calls[0].args[0]===receiver,
  levelIsXLevel:calls[0].self===level,delta:calls[0].args[1],
  rotation:calls[0].args[2],hit:calls[0].args[3],zeros:calls[0].args.slice(4)},
  result:helperResult?1:0};
 const expectedBool={...expected,result:c.return!==0?1:0};
 try{assert.deepEqual(actual,expectedBool);}catch{mismatches++;console.log(JSON.stringify({index,actual,expected:expectedBool}));}
 // Binding level: invokeNative(266) resolves Rotation via soundField and the
 // MoveActor boundary via levelFor's moveActor slot.
 const boundReceiver={id:'self',fields:{Rotation:c.rotation.slice()}};
 const boundLevel={};const boundCalls=[];
 boundLevel.moveActor=function(...args){boundCalls.push({self:this,args});return c.return;};
 const runtime=Object.create(ScriptRuntime.prototype);
 runtime.boundaryNatives=new Set();runtime.levelFor=()=>boundLevel;
 // The receiver stands for an attached actor, as in Play: soundField's reflected read answers only for attached instances since
 // the bunker bundle (4ed50f0a).
 runtime.instances=new WeakMap();runtime.instances.set(boundReceiver,{cls:null});
 runtime.collisionViewActors=new WeakSet();
 runtime.namedReference=(actor,name)=>({get:()=>actor.fields[name],set:v=>{actor.fields[name]=v;}});
 runtime.readNamed=(actor,name)=>runtime.namedReference(actor,name).get();
 runtime.writeNamed=(actor,name,value)=>runtime.namedReference(actor,name).set(value);
 const boundResult=runtime.invokeNative({index:266,argumentCount:1,receiver:boundReceiver,
  evaluateArgument:i=>c.delta});
 const boundActual={move:{actorIsReceiver:boundCalls[0].args[0]===boundReceiver,
  levelIsXLevel:boundCalls[0].self===boundLevel,delta:boundCalls[0].args[1],
  rotation:boundCalls[0].args[2],hit:boundCalls[0].args[3],zeros:boundCalls[0].args.slice(4)},
  result:boundResult?1:0};
 try{assert.deepEqual(boundActual,expectedBool);}catch{mismatches++;console.log(JSON.stringify({index,boundActual,expected:expectedBool}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
