import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';import{promisify}from'node:util';import path from'node:path';
import {AssetStore}from'../src/unreal/assets.mjs';import{ClassDefaults}from'../src/unreal/classes.mjs';import{decodeMap}from'../src/unreal/map.mjs';import{readModel}from'../src/unreal/model.mjs';
import{nativeModel}from'./native-model.mjs';import{gameDirectory}from'./game-directory.mjs';import{brushCollisionBounds}from'../src/runtime/brush-bounds.mjs';import{moveTranslatingMover}from'../src/runtime/mover-move.mjs';
const root=gameDirectory(),files=[];for(const dir of ['Maps','System'])for(const name of await readdir(path.join(root,dir)))files.push({path:`${dir}/${name}`,read:()=>readFile(path.join(root,dir,name))});
const assets=new AssetStore(files),defaults=new ClassDefaults(assets),asset=await assets.get('00_Training'),map=decodeMap(asset.bytes),actors=[];
for(const actor of map.actors.filter(a=>['DeusExMover16','DeusExMover17'].includes(a.name))){const values=await defaults.forActor(asset,actor);actors.push({id:actor.name,kind:'Mover',values,collisionBits:1|(values.bCollideWorld?2:0)|(values.bBlockActors?4:0)|(values.bBlockPlayers?8:0),model:nativeModel(readModel(asset.pkg,asset.bytes,values.Brush))});}
const b=brushCollisionBounds(actors[0].model,actors[0].values),center=b.min.map((v,i)=>Math.fround((v+b.max[i])/2));
actors.push({id:'$pawn',kind:'Pawn',values:{Location:center,CollisionRadius:17,CollisionHeight:42},collisionBits:15});
const scene={model:nativeModel(map.model),actors},cases=[[0,0,0],[0,0,.00009],[0,0,1],[1,0,0],[-1,0,0],[64,0,0],[-64,0,0]].map(delta=>({actor:actors[0].id,delta}));
cases.push({actor:actors[0].id,delta:[0,0,1],reject:1},{actor:actors[0].id,delta:[0,0,1],pawnPosition:[-1000,0,0]});
const dir=path.resolve('reports/movement/mover-move');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'scene.json'),JSON.stringify(scene));await writeFile(path.join(dir,'cases.json'),JSON.stringify(cases));
const {stdout}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',['scripts/native-mover-move-oracle.py',root,path.join(dir,'scene.json'),path.join(dir,'cases.json')],{maxBuffer:16*1024*1024,timeout:120000});await writeFile(path.join(dir,'original.json'),stdout);const native=JSON.parse(stdout),mismatches=[];
for(let i=0;i<cases.length;i++){
 const c=cases[i],expected=native.results[i],objects=new Map(actors.map(a=>[a.id,{id:a.id,position:[...a.values.Location],rotation:a.values.Rotation??[0,0,0],movingBrush:a.kind==='Mover',isPawn:a.kind==='Pawn',collideWorld:!!(a.collisionBits&2),collideActors:true,blockPlayers:true,blockActors:true,movable:true,standingCount:0}]));
 if(c.pawnPosition)objects.get('$pawn').position=c.pawnPosition;
 const mover=objects.get(c.actor),boundary=expected.trace.filter(e=>e.query||e.smooth||e.event||e.hash&&e.actor===c.actor),actual=[];let cursor=0;
 const next=()=>boundary[cursor++];
 const result=moveTranslatingMover(mover,c.delta,{
  encroachmentCheck:(actor,position)=>{const e=next();assert.equal(e.query,actor.id);assert.deepEqual(position,e.vector);assert.deepEqual(actor.position,e.moverPosition);actual.push(e);return e.hits.map(id=>objects.get(id));},
  moveSmooth:(actor,delta)=>{const e=next();assert.equal(e.smooth,actor.id);assert.deepEqual(delta,e.vector);assert.deepEqual(mover.position,e.moverPosition);actor.position=e.positionAfter;actual.push(e);},
  dispatch:(actor,event)=>{const e={event,actor:actor.id};assert.deepEqual(e,next());actual.push(e);return !!c.reject&&event==='EncroachingOn';},
  removeActor:actor=>{const e={hash:'remove',actor:actor.id};assert.deepEqual(e,next());actual.push(e);},
  addActor:actor=>{const e={hash:'add',actor:actor.id};assert.deepEqual(e,next());actual.push(e);}
 });
 try{assert.equal(result,!!expected.result);assert.deepEqual(mover.position,expected.position);assert.equal(cursor,boundary.length);for(const [id,actor]of objects)assert.deepEqual(actor.position,expected.actors[id]);}catch(e){mismatches.push({i,message:e.message});}
}
await writeFile(path.join(dir,'comparison.json'),JSON.stringify({cases:cases.length,mismatches,hashes:native.hashes},null,2));console.log({cases:cases.length,mismatches});assert.equal(mismatches.length,0);
