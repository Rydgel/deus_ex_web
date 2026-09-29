import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {createLevelQueries} from '../src/runtime/level-queries.mjs';
import {traceExtent} from '../src/runtime/extent-trace.mjs';
import {moveTranslatingMover} from '../src/runtime/mover-move.mjs';
import {moveSmooth} from '../src/runtime/move-smooth.mjs';
import {moveActorRiders} from '../src/runtime/move-riders.mjs';
import {playerMove} from '../src/runtime/player-move.mjs';
import {playerBlockedBy} from '../src/runtime/check-encroachment.mjs';
import {beginTouch,endTouch,isOverlapping} from '../src/runtime/actor-touch.mjs';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
await loadTraceKernel(); // Rust BSP traces; TRACE_KERNEL=js runs the JavaScript bodies
const dir='reports/movement/mover-move';
if(!process.argv.includes('--reuse')){
 const result=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-mover-scene-oracle.py',gameDirectory(),`${dir}/scene.json`,`${dir}/cases.json`],{encoding:'utf8',maxBuffer:16*1024*1024});
 if(result.status!==0)throw Error(result.stderr);await writeFile(`${dir}/controlled-original.json`,result.stdout);
}
const raw=await Promise.all(['scene','cases','controlled-original'].map(key=>readFile(`${dir}/${key}.json`)));
const [saved,cases,native]=raw.map(b=>JSON.parse(b)),mismatches=[];
for(const [i,key]of ['scene','cases'].entries())assert.equal(native[key+'Sha256'],createHash('sha256').update(raw[i]).digest('hex'));
if(process.argv.includes('--capture-only')){console.log(cases.length,'controlled-player original mover scenes captured');process.exit(0);}
for(let index=0;index<cases.length;index++){
 const c=cases[index],scene=structuredClone(saved),actors=scene.actors;
 const bits=new DataView(new ArrayBuffer(4));
 for(const model of [scene.model,...actors.map(a=>a.model).filter(Boolean)])for(const node of model.nodes)if(node.planeBits)node.plane=node.planeBits.map(w=>{bits.setUint32(0,w,true);return bits.getFloat32(0,true);});
 for(const a of actors){
  a.flags=a.collisionBits;a.actorFlags=0x80000;a.static=false;a.movable=true;a.movingBrush=Boolean(a.model);a.isPawn=a.kind==='Pawn';a.controlledPlayer=a.isPawn;a.pawnFlags=a.isPawn?2:0;a.collideActors=Boolean(a.flags&1);a.collideWorld=Boolean(a.flags&2);a.blockActors=Boolean(a.flags&4);a.blockPlayers=Boolean(a.flags&8);a.standingCount=0;a.touching=[null,null,null,null];a.physics=0;a.rotation=a.values.Rotation??[0,0,0];a.lineage=['engine.actor',...(a.movingBrush?['engine.mover','engine.brush']:['engine.pawn'])];
  for(const [key,value]of [['position','Location'],['radius','CollisionRadius'],['height','CollisionHeight']])Object.defineProperty(a,key,{get(){return this.values[value]??0;},set(v){this.values[value]=v;}});
  Object.defineProperty(a,'rotation',{get(){return this.values.Rotation??[0,0,0];},set(v){this.values.Rotation=v;}});
 }
 const queries=createLevelQueries(scene.model,actors,{extentCheck:traceExtent}),mover=actors.find(a=>a.id===c.actor),trace=[];
 if(c.collideWorld){mover.flags|=2;mover.collideWorld=true;}
 const rider=c.rider?actors.find(a=>a.id===c.rider):null;
 if(rider){rider.base=mover;mover.standingCount=1;}
 for(const a of actors)a.worldActor=queries.levelInfo;
 if(c.pawnPosition){const pawn=actors.find(a=>a.id==='$pawn');queries.changeActor(pawn,()=>pawn.position=c.pawnPosition);}
 const dispatch=(a,event)=>{trace.push({event,actor:a.id});return event==='EncroachingOn'&&Boolean(c.reject);};
 const removeActor=a=>{trace.push({hash:'remove',actor:a.id});queries.removeActor(a);},addActor=a=>{trace.push({hash:'add',actor:a.id});queries.addActor(a);};
 let first=true;
 const moveOptions=(extra={})=>({worldActor:queries.levelInfo,multiLineCheck:queries.multiLineCheck,removeActor,addActor,dispatch,isBlockedBy:playerBlockedBy,isOverlapping,beginTouch:(a,b)=>beginTouch(a,b,dispatch),endTouch:(a,b,s)=>endTouch(a,b,s,dispatch),setActorZone:a=>trace.push({zoneBoundary:a.id}),...extra});
 const result=moveTranslatingMover(mover,c.delta,{rotation:c.rotation??null,
  // The recovered rider pass: each based actor's recursive MoveActor
  // (bIgnoreBases=1) through the same composed player move body.
  moveRiders:(riderDelta,riderRotation)=>moveActorRiders(mover,riderDelta,riderRotation,{actors,baseOf:o=>o.base??null,
   location:o=>o.position,rotation:o=>o.rotation,isPawn:o=>o.isPawn,addViewRotationYaw:()=>{},
   moveActor:(other,d,r)=>playerMove(other,d,moveOptions({ignoreBases:true}),r).success,
   actorLocation:()=>mover.position,actorRotation:()=>mover.rotation}),
  encroachmentCheck(a,position,rotation,extra){
   if(first){trace.push({checkEncroachment:a.id,position:[...position],actors:Object.fromEntries(actors.map(x=>[x.id,[...x.position]]))});first=false;}
   const entry={query:a.id,vector:[...position],moverPosition:[...mover.position]};trace.push(entry);
   const hits=queries.actorEncroachmentCheck(a,position,rotation,extra).map(h=>h.actor);entry.hits=hits.map(a=>a.id);return hits;
  },
  moveSmooth(a,delta){
   const entry={smooth:a.id,vector:[...delta],moverPosition:[...mover.position]};trace.push(entry);
   const result=moveSmooth(a,delta,{dispatch,moveActor(source,delta){

     const r=playerMove(source,delta,moveOptions());
     return {result:r.success,time:r.time,normal:r.hit?.normal??[0,0,0],actor:r.hit?.actor??null};
   }});entry.positionAfter=[...a.position];return result;
  },dispatch,removeActor,addActor,
 });
 if(result&&!first)trace.push({boundary:'after pose/hash commit; before Bump/touch/zone'});
 const actual={result:Number(result),position:mover.position,rotation:mover.rotation,trace,actors:Object.fromEntries(actors.map(a=>[a.id,a.position])),
  rotations:Object.fromEntries(actors.map(a=>[a.id,a.rotation]))};
 try{assert.deepEqual(actual,native.results[index]);}catch(error){mismatches.push({index,input:c,actual,expected:native.results[index],message:error.message.slice(0,800)});}
}
const evidenceSha256=Object.fromEntries(['scene','cases','original'].map((key,i)=>[key,createHash('sha256').update(raw[i]).digest('hex')]));
await writeFile(`${dir}/scene-comparison.json`,JSON.stringify({cases:cases.length,evidenceSha256,mismatches},null,2));
console.log(JSON.stringify({cases:cases.length,mismatchCount:mismatches.length,examples:mismatches.slice(0,2)}));assert.equal(mismatches.length,0);
