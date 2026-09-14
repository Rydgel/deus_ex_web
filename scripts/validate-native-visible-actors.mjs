import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createVisibleActorsIterator} from '../src/runtime/script-iterators.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/actor-queries';await mkdir(directory,{recursive:true});
// The oracle fabricates native Class chains (Mover->Brush->Actor, Pawn->Actor,
// LevelInfo->Actor); the host instance carries the attached cls chain whose
// records are the shared class-record objects.
const ACTOR={key:'engine.actor'},PAWN={key:'engine.pawn'},MOVER={key:'engine.mover'},
 BRUSH={key:'engine.brush'},LEVELINFO={key:'engine.levelinfo'};
const CHAIN={Actor:{record:ACTOR,base:null},
 Pawn:{record:PAWN,base:{record:ACTOR,base:null}},
 Mover:{record:MOVER,base:{record:BRUSH,base:{record:ACTOR,base:null}}},
 Brush:{record:BRUSH,base:{record:ACTOR,base:null}},
 LevelInfo:{record:LEVELINFO,base:{record:ACTOR,base:null}}};
const RECORD={actor:ACTOR,pawn:PAWN,mover:MOVER,brush:BRUSH,levelinfo:LEVELINFO};
const f32=Math.fround;
const cases=[
 {array:['a','b','c'],sourcePosition:[0,0,0],radius:0,visible:['a','b','c'],
  actors:[{id:'a',position:[50,0,0]},{id:'b',position:[200,0,0],flags:2},{id:'c',position:[5000,0,0]}]},
 {array:['a','b','c'],sourcePosition:[0,0,0],radius:100,visible:['a','b','c'],
  actors:[{id:'a',position:[50,0,0]},{id:'b',position:[200,0,0]},{id:'c',position:[30,0,0]}]},
 {array:['a','b'],sourcePosition:[0,0,0],radius:100,visible:['a','b'],
  actors:[{id:'a',position:[100,0,0]},{id:'b',position:[99.9,0,0]}]},
 {array:['a','b','c'],sourcePosition:[0,0,0],radius:100,visible:['a','c'],
  actors:[{id:'a',position:[10,0,0]},{id:'b',position:[20,0,0]},{id:'c',position:[30,0,0]}]},
 {array:['a','b'],sourcePosition:[0,0,0],radius:100,baseClass:'Mover',visible:['a','b'],
  actors:[{id:'a',position:[50,0,0],kind:'Mover'},{id:'b',position:[50,0,0],kind:'Actor'}]},
 {array:['a','b'],sourcePosition:[0,0,0],loc:[500,0,0],visible:['a','b'],
  actors:[{id:'a',position:[50,0,0]},{id:'b',position:[480,0,0]}]},
 {array:['a','b','c'],sourcePosition:[0,0,0],visible:['a','b','c'],breakAfter:2,
  actors:[{id:'a',position:[10,0,0]},{id:'b',position:[20,0,0]},{id:'c',position:[30,0,0]}]},
 {array:['a','b'],sourcePosition:[0,0,0],radius:-100,visible:['a','b'],
  actors:[{id:'a',position:[50,0,0]},{id:'b',position:[150,0,0]}]},
 {array:['a','b'],sourcePosition:[0,0,0],visible:['a','b'],
  actors:[{id:'a',position:[50,0,0],kind:'Mover'},{id:'b',position:[60,0,0],kind:'Pawn'}]},
];
await writeFile(`${directory}/visible-actors-cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-visible-actors-oracle.py',gameDirectory(),`${directory}/visible-actors-cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/visible-actors.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/visible-actors.json`,'utf8'));let mismatches=0;
const isA=(actor,base)=>{for(let cls=actor?.cls;cls;cls=cls.base)if(cls.record===base)return true;return false;};
for(const [index,c] of cases.entries()){
 const source={id:'self',position:c.sourcePosition??[10,20,30],actorFlags:0,cls:CHAIN.Actor};
 const objects={self:source},byPosition=new Map();
 for(const a of c.actors??[]){
  const position=a.position??[0,0,0];
  const object={id:a.id,position,actorFlags:a.flags??0,cls:CHAIN[a.kind??'Actor']};
  objects[a.id]=object;byPosition.set(position.map(f32).join(),a.id);
 }
 byPosition.set(source.position.map(f32).join(),'self');
 const level={actors:c.array.map(id=>id===null?null:objects[id]),model:{}};
 const visible=new Set(c.visible??[]);
 const run=()=>{
  const out={actor:null},yields=[],queries=[],evalOrder=[];
  level.fastLineCheck=(model,first,second)=>{queries.push({first,second});
   return visible.has(byPosition.get(first.join()))?1:0;};
  const sink={reference:true,get:()=>out.actor,set:v=>{out.actor=v;}};
  const base=c.baseClass?RECORD[c.baseClass.toLowerCase()]:null;
  const args=[base,sink,c.radius,c.loc];
  const iterator=createVisibleActorsIterator({receiver:source,argumentCount:4,
   evaluateArgument:i=>{evalOrder.push(i);return args[i];},actorClass:ACTOR,levelFor:()=>level,isA});
  while(iterator.next()){yields.push(out.actor.id);if(yields.length===c.breakAfter)break;}
  return {yields,queries,finalActor:out.actor?.id??null,evalOrder};
 };
 const actual=run();
 const expected={...reference.results[index],evalOrder:[0,1,2,3]};
 // Binding level through ScriptRuntime.createIterator(311).
 const boundOut={actor:null},boundYields=[],boundQueries=[];
 const boundSink={reference:true,get:()=>boundOut.actor,set:v=>{boundOut.actor=v;}};
 level.fastLineCheck=(model,first,second)=>{boundQueries.push({first,second});
  return visible.has(byPosition.get(first.join()))?1:0;};
 const runtime=Object.create(ScriptRuntime.prototype);
 runtime.actorClass={record:ACTOR};runtime.levelFor=()=>level;
 runtime.instances=new WeakMap();
 for(const o of level.actors)if(o)runtime.instances.set(o,{cls:o.cls});
 runtime.instances.set(source,{cls:source.cls});
 const base=c.baseClass?RECORD[c.baseClass.toLowerCase()]:null;
 const bound=runtime.createIterator({index:311,receiver:source,argumentCount:4,
  evaluateArgument:i=>[base,boundSink,c.radius,c.loc][i]});
 while(bound.next()){boundYields.push(boundOut.actor?.id??null);if(boundYields.length===c.breakAfter)break;}
 const boundActual={yields:boundYields,queries:boundQueries,finalActor:boundOut.actor?.id??null};
 try{assert.deepEqual(actual,expected);}catch{mismatches++;console.log(JSON.stringify({index,actual,expected}));}
 try{assert.deepEqual(boundActual,reference.results[index]);}catch{mismatches++;console.log(JSON.stringify({index,boundActual,expected:reference.results[index]}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
