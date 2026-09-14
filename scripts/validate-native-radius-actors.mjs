import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createRadiusActorsIterator} from '../src/runtime/script-iterators.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/actor-queries';await mkdir(directory,{recursive:true});
// The original ancestry chains fabricated by the oracle: Mover->Brush->Actor,
// Pawn->Actor, LevelInfo->Actor. The host instance carries the same as the
// attached cls chain whose records are the shared class-record objects.
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
 {array:['a','b','self'],sourcePosition:[0,0,0],radius:100,
  actors:[{id:'a',position:[50,0,0],collisionRadius:5,kind:'Actor'},
   {id:'b',position:[200,0,0],collisionRadius:5,kind:'Actor'}]},
 {array:['a','b'],sourcePosition:[0,0,0],radius:100,baseClass:'Mover',
  actors:[{id:'a',position:[50,0,0],collisionRadius:5,kind:'Mover'},
   {id:'b',position:[50,0,0],collisionRadius:5,kind:'Actor'}]},
 {array:['a','b'],sourcePosition:[0,0,0],radius:100,loc:[500,0,0],
  actors:[{id:'a',position:[50,0,0],collisionRadius:5},
   {id:'b',position:[480,0,0],collisionRadius:5}]},
 {array:['a','b'],sourcePosition:[0,0,0],radius:100,
  actors:[{id:'a',position:[105,0,0],collisionRadius:5},
   {id:'b',position:[104.9,0,0],collisionRadius:5}]},
 {array:[null,'a'],sourcePosition:[0,0,0],radius:100,
  actors:[{id:'a',position:[50,0,0],collisionRadius:5}]},
 {array:['a','b','c'],sourcePosition:[0,0,0],radius:100,breakAfter:2,
  actors:[{id:'a',position:[10,0,0]},{id:'b',position:[20,0,0]},{id:'c',position:[30,0,0]}]},
 {array:['a','b'],sourcePosition:[0,0,0],radius:100,
  actors:[{id:'a',position:[10,0,0],kind:'Mover'},{id:'b',position:[10,0,0],kind:'LevelInfo'}]},
 {array:['a'],sourcePosition:[0,0,0],radius:100,
  actors:[{id:'a',position:[0,0,150],collisionRadius:0}]},
 {array:['a'],sourcePosition:[0,0,0],radius:100,
  actors:[{id:'a',position:[100,0,0],collisionRadius:0}]},
 {array:['a','b'],sourcePosition:[0,0,0],radius:-10,
  actors:[{id:'a',position:[5,0,0],collisionRadius:0},{id:'b',position:[15,0,0],collisionRadius:0}]},
];
await writeFile(`${directory}/radius-actors-cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-radius-actors-oracle.py',gameDirectory(),`${directory}/radius-actors-cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/radius-actors.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/radius-actors.json`,'utf8'));let mismatches=0;
for(const [index,c] of cases.entries()){
 const source={id:'self',position:c.sourcePosition??[10,20,30],radius:0,cls:CHAIN.Actor};
 const objects={self:source};
 for(const a of c.actors??[])objects[a.id]={id:a.id,position:a.position??[0,0,0],
  radius:a.collisionRadius??0,actorFlags:a.flags??0,cls:CHAIN[a.kind??'Actor']};
 const level={actors:c.array.map(id=>id===null?null:objects[id])};
 const base=c.baseClass?RECORD[c.baseClass.toLowerCase()]:null;
 // VM-level controller: the out slot is a reference sink; yields are ids.
 const out={actor:null},yields=[],evalOrder=[];
 const sink={reference:true,get:()=>out.actor,set:v=>{out.actor=v;}};
 const args=[base,sink,c.radius,c.loc];
 const iterator=createRadiusActorsIterator({receiver:source,argumentCount:4,
  evaluateArgument:i=>{evalOrder.push(i);return args[i];},actorClass:ACTOR,levelFor:()=>level,isA});
 while(iterator.next()){yields.push(out.actor.id);if(yields.length===c.breakAfter)break;}
 const actual={yields,finalActor:out.actor?.id??null,evalOrder};
 const expected={...reference.results[index],evalOrder:[0,1,2,3]};
 // Binding level: ScriptRuntime.createIterator(310) must satisfy the same
 // contract through the real dispatch — including the instance cls walk.
 const boundOut={actor:null},boundYields=[];
 const boundSink={reference:true,get:()=>boundOut.actor,set:v=>{boundOut.actor=v;}};
 const runtime=Object.create(ScriptRuntime.prototype);
 runtime.actorClass={record:ACTOR};runtime.levelFor=()=>level;
 runtime.instances=new WeakMap();
 for(const o of level.actors)if(o)runtime.instances.set(o,{cls:o.cls});
 runtime.instances.set(source,{cls:source.cls});
 const bound=runtime.createIterator({index:310,receiver:source,argumentCount:4,
  evaluateArgument:i=>[base,boundSink,c.radius,c.loc][i]});
 while(bound.next()){boundYields.push(boundOut.actor?.id??null);if(boundYields.length===c.breakAfter)break;}
 const boundActual={yields:boundYields,finalActor:boundOut.actor?.id??null};
 try{assert.deepEqual(actual,expected);}catch{mismatches++;console.log(JSON.stringify({index,actual,expected}));}
 try{assert.deepEqual(boundActual,reference.results[index]);}catch{mismatches++;console.log(JSON.stringify({index,boundActual,expected:reference.results[index]}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
