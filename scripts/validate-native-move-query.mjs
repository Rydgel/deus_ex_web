import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
const cases=[];
for(const start of [[0,0,0],[100.125,-234.5,1000.75]]) for(const delta of [[0,0,0],[.00009,0,0],[.0001,0,0],[.000101,0,0],[1,2,3],[-13.67,24.987,-5.03],[3,0,0],[0,0,-7]])
for(const time of [null,0,.01,.25,.4,.7,.99999,1]) cases.push({start,delta,hits:time===null?[]:[{kind:'world',time}]});
for(const sourceFlags of [0,1,2,3,7,11,15]) for(const kind of ['self','actor','player','projectile','mover']) for(const flags of [0,3,7,11,15]) {
 cases.push({start:[1,2,3],delta:[7.25,-1.87,.625],sourceFlags,hits:[{kind,flags,time:.2},{kind:'world',time:.8}]});
}
cases.push({start:[0,0,0],delta:[10,0,0],hits:[{kind:'actor',basedOnSource:true,time:.1},{kind:'world',time:.8}]});
let seed=97131;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
for(let i=0;i<96;i++)cases.push({start:Array.from({length:3},()=>Math.fround((random()*2-1)*10000)),
 delta:Array.from({length:3},()=>Math.fround((random()*2-1)*100)),hits:[{kind:'world',time:Math.fround(random())}]});
for(const delta of [[0,0,0],[10,0,0]])for(const traits of [{static:true},{movable:false}])cases.push({start:[1,2,3],delta,hits:[],...traits});
// Decoration-source cases (sourceControlledPlayer:false): a pushed Plant-sized
// cylinder under physFalling. MoveActor must match the controlled-player math, so
// physFalling can reuse moveQuery for a decoration (docs/script-plant-contact.md).
for(const delta of [[10,0,-40],[60,0,-5],[5,0,-30],[-24,12,-60],[0,0,-950]])
 for(const hit of [null,{kind:'world',normal:[0,0,1],time:.5},{kind:'world',normal:[-1,0,0],time:.4},{kind:'actor',flags:15,normal:[-1,0,0],time:.3}])
  cases.push({start:[-804.27,1125.16,-84.02],delta,extent:[23.26,43.88],sourceFlags:15,sourceControlledPlayer:false,hits:hit?[hit]:[]});
const directory=path.resolve('reports/movement/native-move-query');await mkdir(directory,{recursive:true});
const file=path.join(directory,'cases.json');await writeFile(file,JSON.stringify(cases));
const {stdout}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',['scripts/native-move-query-oracle.py',gameDirectory(),file],{maxBuffer:32*1024*1024,timeout:120000});
await writeFile(path.join(directory,'original.json'),stdout);const native=JSON.parse(stdout);
if(process.argv.includes('--capture-only')) console.log(JSON.stringify({captured:cases.length,hashes:native.hashes}));
else {
 const {moveQuery}=await import('../src/runtime/move-query.mjs');const mismatches=[];
 cases.forEach((c,index)=>{
  const controlled=c.sourceControlledPlayer!==false;
  const world={world:true},source={controlledPlayer:controlled,decoration:!controlled,flags:c.sourceFlags??15,static:c.static,movable:c.movable};
  const hits=c.hits.map((h,item)=>({time:Math.fround(h.time),actor:h.kind==='world'?world:h.kind==='self'?source:{
   flags:h.flags??15,controlledPlayer:h.kind==='player',projectile:h.kind==='projectile',movingBrush:h.kind==='mover',base:h.basedOnSource?source:null},
   location:[10,20,30],normal:h.normal??[-1,0,0],item}));
  const ext=c.extent?[c.extent[0],c.extent[0],c.extent[1]]:[17,17,42];
  let query=null;
  const result=moveQuery({source,worldActor:world,start:c.start,delta:c.delta,extent:ext,
   multiLineCheck:q=>{query={end:q.end,start:q.start,extent:q.extent,checkActors:q.checkActors,world:!!q.worldActor,extra:q.extra};return hits;}});
  const actual={success:result.success,query,delta:result.delta,position:result.position,time:result.time,selected:result.hit?.item??null};
  try{assert.deepEqual(actual,native.results[index]);}catch{mismatches.push({index,actual,expected:native.results[index]});}
 });
 const summary={cases:cases.length,hashes:native.hashes,mismatches};await writeFile(path.join(directory,'comparison.json'),JSON.stringify(summary,null,2));
 console.log(JSON.stringify({...summary,mismatches:mismatches.slice(0,4),mismatchCount:mismatches.length},null,2));assert.equal(mismatches.length,0);
}
