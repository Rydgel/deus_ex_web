/** AActor::FindBase (Engine.dll 0x103c9470) against findActorBase: the SingleLineCheck the original asks for (start, end, flags, the extent (CollisionRadius,
 * CollisionRadius, CollisionHeight), the extra node flags) and what the answer does to Base, Physics, the standing counts and the Detach/Attach/BaseChange events.
 * The original body runs under Unicorn (scripts/native-find-base-oracle.py, NATIVE_PROBE_PYTHON); only the level's SingleLineCheck is a stub that answers a
 * chosen actor. findActorBase's extent was {radius, height, radius} until 2026-10-16: a standing player's trace never reached the floor, so SetPhysics(PHYS_None)
 * cleared its Base and Pawn.BaseChange put it back in PHYS_Falling (the intro's first tick, docs/conversation-camera.md). */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {findActorBase} from '../src/runtime/script-actor-collision.mjs';
const cases=[];
for(const [radius,height] of [[20,43],[17.5,39.25],[19,40.630001068115234],[1,2]])
 for(const location of [[1.2878822088241577,0.6435503959655762,-80.19999694824219],[10,20,30],[-1149.2435302734375,825.8439331054688,-65.1034927368164]])
  for(const base of [null,1,2])for(const hit of [null,1,2,3])cases.push({location,radius,height,base,hit});
const directory=path.resolve('reports/movement/find-base');await mkdir(directory,{recursive:true});
const file=path.join(directory,'cases.json');await writeFile(file,JSON.stringify(cases));
const {stdout}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',['scripts/native-find-base-oracle.py',gameDirectory(),file],{maxBuffer:8*1024*1024,timeout:120000});
await writeFile(path.join(directory,'original.json'),stdout);const native=JSON.parse(stdout),mismatches=[];
const f=Math.fround;
cases.forEach((c,index)=>{
 const actors=Array.from({length:4},()=>({standingCount:7,base:null})),pawn=actors[0];
 Object.assign(pawn,{worldActor:actors[1],base:actors[c.base]??null,physics:1,pawnFlags:0x24,justTeleported:true,position:c.location.map(f),radius:f(c.radius),height:f(c.height)});
 const events=[],calls=[],dispatch=(target,event,args)=>events.push({event,target:actors.indexOf(target),base:pawn.base?actors.indexOf(pawn.base):null,physics:pawn.physics});
 findActorBase(pawn,{dispatch,lineCheck:(start,end,extent,flags,extra,source)=>{
  calls.push({source:actors.indexOf(source),end,start,flags,extent,extra});
  return {actor:actors[c.hit]??null};
 }});
 const actual={calls,base:pawn.base?actors.indexOf(pawn.base):null,physics:pawn.physics,events:events.map(e=>e),counts:actors.map(a=>a.standingCount)};
 // the original's event records carry the names the host dispatches; compare the traces the walking-callback validator compares
 const expected=native.results[index];
 try{assert.deepEqual({calls:actual.calls,base:actual.base,physics:actual.physics,counts:actual.counts,events:actual.events},
  {calls:expected.calls,base:expected.base,physics:expected.physics,counts:expected.counts,events:expected.events});}catch{mismatches.push({index,case:c,actual,expected});}
});
await writeFile(path.join(directory,'comparison.json'),JSON.stringify({cases:cases.length,hashes:native.hashes,mismatches:mismatches.slice(0,5)},null,2));
console.log(JSON.stringify({cases:cases.length,mismatches:mismatches.slice(0,2)},null,2));assert.equal(mismatches.length,0);
