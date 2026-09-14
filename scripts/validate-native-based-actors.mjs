import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createBasedActorsIterator} from '../src/runtime/script-iterators.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/actor-queries';await mkdir(directory,{recursive:true});
// The oracle fabricates native Class chains (Mover->Brush->Actor, Pawn->Actor,
// LevelInfo->Actor); the host instance carries the attached cls chain whose
// records are the shared class-record objects. `base` is the actor's +0xc4
// Base field — 'self' points at the receiver.
const ACTOR={key:'engine.actor'},PAWN={key:'engine.pawn'},MOVER={key:'engine.mover'},
 BRUSH={key:'engine.brush'},LEVELINFO={key:'engine.levelinfo'};
const CHAIN={Actor:{record:ACTOR,base:null},
 Pawn:{record:PAWN,base:{record:ACTOR,base:null}},
 Mover:{record:MOVER,base:{record:BRUSH,base:{record:ACTOR,base:null}}},
 Brush:{record:BRUSH,base:{record:ACTOR,base:null}},
 LevelInfo:{record:LEVELINFO,base:{record:ACTOR,base:null}}};
const RECORD={actor:ACTOR,pawn:PAWN,mover:MOVER,brush:BRUSH,levelinfo:LEVELINFO};
const isA=(actor,base)=>{for(let cls=actor?.cls;cls;cls=cls.base)if(cls.record===base)return true;return false;};
const cases=[
 {array:['a','b','c'],actors:[{id:'a',base:'self'},{id:'b'},{id:'c',base:'self'}]},
 {array:['a','b'],actors:[{id:'a',base:'self'},{id:'b',base:'a'}]},
 {array:['a','b'],baseClass:'Mover',actors:[{id:'a',base:'self',kind:'Mover'},{id:'b',base:'self'}]},
 {array:[null,'a',null,'b'],actors:[{id:'a',base:'self'},{id:'b',base:'self'}]},
 {array:['a','b','c'],breakAfter:2,actors:[{id:'a',base:'self'},{id:'b',base:'self'},{id:'c',base:'self'}]},
 {array:['a'],actors:[{id:'a',base:'self',kind:'LevelInfo'}]},
 {array:['self'],actors:[]},
 {array:['a','b'],actors:[{id:'a',base:'self'},{id:'b',base:'world'}]},
];
await writeFile(`${directory}/based-actors-cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-based-actors-oracle.py',gameDirectory(),`${directory}/based-actors-cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/based-actors.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/based-actors.json`,'utf8'));let mismatches=0;
for(const [index,c] of cases.entries()){
 const world={id:'world',base:null,cls:CHAIN.LevelInfo};
 const source={id:'self',base:null,cls:CHAIN.Actor};
 const objects={self:source,world};
 for(const a of c.actors??[])objects[a.id]={id:a.id,base:null,cls:CHAIN[a.kind??'Actor']};
 const level={actors:c.array.map(id=>id===null?null:objects[id])};
 // baseOf resolves the +0xc4 Base field to the same script identities.
 const baseOf=actor=>actor.baseId==='self'?source:actor.baseId==='world'?world:objects[actor.baseId]??null;
 for(const a of c.actors??[])objects[a.id].baseId=a.base;
 const base=c.baseClass?RECORD[c.baseClass.toLowerCase()]:null;
 // VM-level controller: the out slot is a reference sink; yields are ids.
 const out={actor:null},yields=[],evalOrder=[];
 const sink={reference:true,get:()=>out.actor,set:v=>{out.actor=v;}};
 const args=[base,sink];
 const iterator=createBasedActorsIterator({receiver:source,argumentCount:2,
  evaluateArgument:i=>{evalOrder.push(i);return args[i];},actorClass:ACTOR,
  levelFor:()=>level,isA,baseOf});
 while(iterator.next()){yields.push(out.actor.id);if(yields.length===c.breakAfter)break;}
 const actual={yields,finalActor:out.actor?.id??null,evalOrder};
 const expected={...reference.results[index],evalOrder:[0,1]};
 // Binding level: ScriptRuntime.createIterator(306) through the real
 // dispatch — the instance cls walk and the fieldReference Base read.
 const boundOut={actor:null},boundYields=[];
 const boundSink={reference:true,get:()=>boundOut.actor,set:v=>{boundOut.actor=v;}};
 const runtime=Object.create(ScriptRuntime.prototype);
 runtime.actorClass={record:ACTOR};runtime.levelFor=()=>level;
 runtime.instances=new WeakMap();
 for(const o of level.actors)if(o)runtime.instances.set(o,{cls:o.cls});
 runtime.instances.set(source,{cls:source.cls});
 const baseField={key:'engine.actor.base'};
 runtime.lookupMember=(cls,kind,name)=>name==='Base'?baseField:null;
 runtime.fieldReference=(actor,field)=>({get:()=>actor.baseId==='self'?source:
  actor.baseId==='world'?world:objects[actor.baseId]??null,set(){}});
 const bound=runtime.createIterator({index:306,receiver:source,argumentCount:2,
  evaluateArgument:i=>[base,boundSink][i]});
 while(bound.next()){boundYields.push(boundOut.actor?.id??null);if(boundYields.length===c.breakAfter)break;}
 const boundActual={yields:boundYields,finalActor:boundOut.actor?.id??null};
 try{assert.deepEqual(actual,expected);}catch{mismatches++;console.log(JSON.stringify({index,actual,expected}));}
 try{assert.deepEqual(boundActual,reference.results[index]);}catch{mismatches++;console.log(JSON.stringify({index,boundActual,expected:reference.results[index]}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
