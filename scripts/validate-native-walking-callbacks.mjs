import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {setBase,setSupportBase,setWalkingPhysics,processPlayerHitWall} from '../src/runtime/walking-callbacks.mjs';
const cases=[];
for(const base of [null,1,2])for(const target of [null,1,2,3,0])cases.push({type:'base',base,target});
for(const physics of [1,2])for(const next of [1,2])for(const base of [null,1,2])cases.push({type:'physics',physics,next,base,target:3});
for(const target of [null,1,3])cases.push({type:'support',base:2,target});
for(const physics of [1,2])for(const probing of [false,true])for(const wallPawn of [false,true])for(const normal of [[-1,0,.5],[1,0,0]])
 cases.push({type:'wall',physics,probing,wallPawn,normal});
for(const acceleration of [[0,0,0],[0,0,1]])for(const destination of [[0,0,0],[3,4,5]])for(const normal of [[-1,0,0],[0,-1,0]])
 cases.push({type:'wall',physics:1,probing:false,acceleration,destination,normal});
const directory=path.resolve('reports/movement/walking-callbacks');await mkdir(directory,{recursive:true});
const file=path.join(directory,'cases.json');await writeFile(file,JSON.stringify(cases));
const {stdout}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',['scripts/native-walking-callbacks-oracle.py',gameDirectory(),file],{maxBuffer:8*1024*1024,timeout:120000});
await writeFile(path.join(directory,'original.json'),stdout);const native=JSON.parse(stdout),mismatches=[];
cases.forEach((c,index)=>{
 const actors=Array.from({length:4},()=>({standingCount:7,base:null})),pawn=actors[0];actors[3].isPawn=!!c.wallPawn;
 Object.assign(pawn,{worldActor:actors[1],base:actors[c.base]??null,physics:c.physics??1,pawnFlags:0x24,justTeleported:true,
  acceleration:c.acceleration??[1,0,0],destination:c.destination??[10,0,0],position:[0,0,0],moveTimer:3,minHitWall:Math.fround(-.6)});
 const events=[],dispatch=(target,event,args)=>{const value={event,target:actors.indexOf(target),base:pawn.base?actors.indexOf(pawn.base):null,physics:pawn.physics};
  if(event==='HitWall')value.normal=args[0];events.push(value);};
 const target=actors[c.target]??null;
 if(c.type==='base')setBase(pawn,target,dispatch);
 else if(c.type==='support')setSupportBase(pawn,target,dispatch);
 else if(c.type==='physics')setWalkingPhysics(pawn,c.next,target,{dispatch,findBase:()=>{throw Error('Uncaptured FindBase');}});
 else processPlayerHitWall(pawn,c.normal,actors[3],{dispatch,isProbing:()=>!!c.probing});
 const actual={base:pawn.base?actors.indexOf(pawn.base):null,physics:pawn.physics,counts:actors.map(a=>a.standingCount),events,
  moveTimer:pawn.moveTimer,pawnFlags:pawn.pawnFlags,justTeleported:pawn.justTeleported};
 try{assert.deepEqual(actual,native.results[index]);}catch{mismatches.push({index,actual,expected:native.results[index]});}
});
await writeFile(path.join(directory,'comparison.json'),JSON.stringify({cases:cases.length,hashes:native.hashes,mismatches},null,2));
console.log(JSON.stringify({cases:cases.length,mismatches},null,2));assert.equal(mismatches.length,0);
