import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {traceActors,interactionDirection} from '../src/runtime/interaction.mjs';
import {createTraceActorsIterator} from '../src/runtime/script-iterators.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/interaction';await mkdir(directory,{recursive:true});
const base={end:[100,200,300],actors:[{id:'wrong',kind:'Actor'},{id:'owned',kind:'Mover',owner:'self'}],hits:[{actor:'self'},{actor:'wrong'},{actor:'world'},{actor:'owned'}]};
const cases=[base,{...base,baseClass:'Mover'},{...base,breakAfter:2},{...base,hits:[]},{...base,start:[1,2,3],extent:[20,20,43]}];
for(const rotation of [[0,0,0],[0,16384,0],[16384,0,0],[12345,23456,0],[12345,23456,45678],[-12345,-23456,9000],[-1,-1,-1],[1,1,1],[3,3,3],[4,4,4]])cases.push({rotation});
await writeFile(`${directory}/cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-trace-actors-oracle.py',gameDirectory(),`${directory}/cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/original.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));let mismatches=0;
for(const [index,c] of cases.entries()){
 let actual;
 if(c.rotation)actual={vector:interactionDirection(c.rotation)};
 else{
  let query;const out={actor:null,location:[9,9,9],normal:[8,8,8]},yields=[];
  const queries={levelInfo:'world',multiLineCheck(q){query={end:q.end,start:q.start,extent:q.extent,checkActors:q.checkActors,world:q.worldActor==='world',extra:q.extra};return c.hits.map((h,i)=>({actor:h.actor,location:h.location??[i,2,3],normal:h.normal??[0,0,1]}));}};
  for(const hit of traceActors(queries,{position:c.sourcePosition??[10,20,30]},c.end,c.start,c.extent,out)){yields.push(hit);if(yields.length===c.breakAfter)break;}
  actual={query,yields,finalActor:out.actor,finalLocation:out.location,finalNormal:out.normal};
  // The VM-level iterator controller (native 309 dispatch) must satisfy the
  // same recovered contract: identical query shape, hit order, early-break and
  // exhaustion out-parameter state — driven here through the argument-
  // evaluation and out-reference interface the VM hands it.
  let vmQuery;const vmOut={actor:'seed',location:[9,9,9],normal:[8,8,8]},vmYields=[];
  const vmQueries={multiLineCheck(q){vmQuery={end:q.end,start:q.start,extent:q.extent,checkActors:q.checkActors,world:q.worldActor==='world',extra:q.extra};return c.hits.map((h,i)=>({actor:h.actor,location:h.location??[i,2,3],normal:h.normal??[0,0,1]}));}};
  const sink=name=>({reference:true,get:()=>vmOut[name],set:value=>{vmOut[name]=value;}});
  const args=[c.baseClass??null,sink('actor'),sink('location'),sink('normal'),c.end,c.start,c.extent];
  const iterator=createTraceActorsIterator({receiver:{position:c.sourcePosition??[10,20,30],worldActor:'world'},argumentCount:7,evaluateArgument:i=>args[i],levelFor:()=>({hash:vmQueries})});
  while(iterator.next()){vmYields.push({actor:vmOut.actor,location:[...vmOut.location],normal:[...vmOut.normal]});if(vmYields.length===c.breakAfter)break;}
  const vmActual={query:vmQuery,yields:vmYields,finalActor:vmOut.actor,finalLocation:vmOut.location,finalNormal:vmOut.normal};
  try{assert.deepEqual(vmActual,reference.results[index]);}catch{mismatches++;console.log(JSON.stringify({index,vmActual,expected:reference.results[index]}));}
 }
 try{assert.deepEqual(actual,reference.results[index]);}catch{mismatches++;console.log(JSON.stringify({index,actual,expected:reference.results[index]}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
