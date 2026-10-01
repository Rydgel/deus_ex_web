import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';import{promisify}from'node:util';import path from'node:path';
import {AssetStore}from'../src/unreal/assets.mjs';import{ClassDefaults}from'../src/unreal/classes.mjs';import{decodeMap}from'../src/unreal/map.mjs';import{readModel}from'../src/unreal/model.mjs';
import{nativeModel}from'./native-model.mjs';import{gameDirectory}from'./game-directory.mjs';import{brushCollisionBounds}from'../src/runtime/brush-bounds.mjs';import{moveTranslatingMover}from'../src/runtime/mover-move.mjs';import{checkMoverEncroachment}from'../src/runtime/check-encroachment.mjs';import{farMoveActor}from'../src/runtime/relocation.mjs';
const root=gameDirectory(),files=[];for(const dir of ['Maps','System'])for(const name of await readdir(path.join(root,dir)))files.push({path:`${dir}/${name}`,read:()=>readFile(path.join(root,dir,name))});
const assets=new AssetStore(files),defaults=new ClassDefaults(assets),asset=await assets.get('00_Training'),map=decodeMap(asset.bytes),actors=[];
for(const actor of map.actors.filter(a=>['DeusExMover16','DeusExMover17'].includes(a.name))){const values=await defaults.forActor(asset,actor);actors.push({id:actor.name,kind:'Mover',values,collisionBits:1|(values.bCollideWorld?2:0)|(values.bBlockActors?4:0)|(values.bBlockPlayers?8:0),model:nativeModel(readModel(asset.pkg,asset.bytes,values.Brush))});}
const b=brushCollisionBounds(actors[0].model,actors[0].values),center=b.min.map((v,i)=>Math.fround((v+b.max[i])/2));
actors.push({id:'$pawn',kind:'Pawn',values:{Location:center,CollisionRadius:17,CollisionHeight:42},collisionBits:15});
// A non-blocking cylinder (bCollideActors only) for FarMoveActor's notify Touch pass.
actors.push({id:'$toucher',kind:'Actor',values:{Location:[-1000,-1000,0],CollisionRadius:8,CollisionHeight:8},collisionBits:1});
const scene={model:nativeModel(map.model),actors},cases=[[0,0,0],[0,0,.00009],[0,0,1],[1,0,0],[-1,0,0],[64,0,0],[-64,0,0]].map(delta=>({actor:actors[0].id,delta}));
cases.push({actor:actors[0].id,delta:[0,0,1],reject:1},{actor:actors[0].id,delta:[0,0,1],pawnPosition:[-1000,0,0]});
// Rotation (Mover.BeginPlay's SetRotation, rotating doors), a bCollideWorld
// source, and a based rider (StandingCount) moved before CheckEncroachment.
for(const rotation of [[0,8192,0],[0,-16384,0],[1024,512,-256]])for(const pawnPosition of [undefined,[-1000,0,0]])
 cases.push({actor:actors[0].id,delta:[0,0,0],rotation,...(pawnPosition?{pawnPosition}:{})});
cases.push({actor:actors[0].id,delta:[4,0,0],rotation:[0,512,0],pawnPosition:[-1000,0,0]},{actor:actors[0].id,delta:[0,0,.00009],rotation:[0,1,0]});
for(const delta of [[0,0,1],[0,0,-1],[16,0,0]])cases.push({actor:actors[0].id,delta,collideWorld:1},{actor:actors[0].id,delta,collideWorld:1,pawnPosition:[-1000,0,0]});
for(const delta of [[0,0,2],[0,0,-2],[3,0,0]])cases.push({actor:actors[0].id,delta,rider:'$pawn'});
// FarMoveActor of the mover (CheckEncroachment notify 1): DeusExMover.BlowItUp's
// SetLocation(Location + vect(0,0,20000)), with and without touches to end,
// into the pawn (accepted and rejected), onto a non-blocking toucher, and the
// test/noCheck branches.
const moverLocation=actors[0].values.Location,offset=d=>moverLocation.map((v,i)=>Math.fround(v+d[i]));
const away={pawnPosition:[-1000,0,0]};
cases.push({actor:actors[0].id,destination:offset([0,0,20000]),...away});
cases.push({actor:actors[0].id,destination:offset([0,0,20000]),touching:['$toucher'],...away});
cases.push({actor:actors[0].id,destination:offset([0,0,20000]),touching:['$toucher','$pawn']});
cases.push({actor:actors[0].id,destination:offset([0,0,1])});
cases.push({actor:actors[0].id,destination:offset([0,0,1]),reject:1});
cases.push({actor:actors[0].id,destination:offset([0,0,1]),positions:{$toucher:center},...away});
cases.push({actor:actors[0].id,destination:offset([0,0,1]),positions:{$toucher:center.map((v,i)=>i===2?v+20:v)}});
cases.push({actor:actors[0].id,destination:offset([0,0,1]),positions:{$toucher:center},touching:['$toucher'],...away});
for(const flags of [{test:1},{noCheck:1},{test:1,noCheck:1}])cases.push({actor:actors[0].id,destination:offset([0,0,1]),...flags});
const dir=path.resolve('reports/movement/mover-move');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'scene.json'),JSON.stringify(scene));await writeFile(path.join(dir,'cases.json'),JSON.stringify(cases));
const {stdout}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',['scripts/native-mover-move-oracle.py',root,path.join(dir,'scene.json'),path.join(dir,'cases.json')],{maxBuffer:16*1024*1024,timeout:300000});await writeFile(path.join(dir,'original.json'),stdout);const native=JSON.parse(stdout),mismatches=[];
for(let i=0;i<cases.length;i++){
 if('destination' in cases[i]){farCase(i);continue;}
 const c=cases[i],expected=native.results[i],objects=new Map(actors.map(a=>[a.id,{id:a.id,position:[...a.values.Location],rotation:a.values.Rotation??[0,0,0],movingBrush:a.kind==='Mover',isPawn:a.kind==='Pawn',collideWorld:!!(a.collisionBits&2),collideActors:true,blockPlayers:true,blockActors:true,movable:true,standingCount:0}]));
 if(c.pawnPosition)objects.get('$pawn').position=c.pawnPosition;
 if(c.collideWorld)objects.get(c.actor).collideWorld=true;
 if(c.rider){objects.get(c.actor).standingCount=1;objects.get(c.rider).base=objects.get(c.actor);}
 const mover=objects.get(c.actor),boundary=expected.trace.filter(e=>e.query||e.smooth||e.event||e.hash&&e.actor===c.actor),actual=[];let cursor=0;
 const encroachStart=expected.trace.find(e=>e.checkEncroachment);
 const next=()=>boundary[cursor++];
 const result=moveTranslatingMover(mover,c.delta,{
  encroachmentCheck:(actor,position)=>{const e=next();assert.equal(e.query,actor.id);assert.deepEqual(position,e.vector);assert.deepEqual(actor.position,e.moverPosition);actual.push(e);return e.hits.map(id=>objects.get(id));},
  moveSmooth:(actor,delta)=>{const e=next();assert.equal(e.smooth,actor.id);assert.deepEqual(delta,e.vector);assert.deepEqual(mover.position,e.moverPosition);actor.position=e.positionAfter;actual.push(e);},
  dispatch:(actor,event)=>{const e={event,actor:actor.id};assert.deepEqual(e,next());actual.push(e);return !!c.reject&&event==='EncroachingOn';},
  removeActor:actor=>{const e={hash:'remove',actor:actor.id};assert.deepEqual(e,next());actual.push(e);},
  addActor:actor=>{const e={hash:'add',actor:actor.id};assert.deepEqual(e,next());actual.push(e);},
  // The original rider pass is its own recovered MoveActor (move-riders.mjs);
  // here it must run before CheckEncroachment, and the rider must stand where
  // the native left it when the encroachment query begins.
  moveRiders:(riderDelta)=>{const rider=objects.get(c.rider);assert.ok(rider,'rider pass without a based actor');
   assert.equal(cursor,0,'riders move before CheckEncroachment');rider.position=rider.position.map((v,i)=>Math.fround(v+riderDelta[i]));
   assert.deepEqual(rider.position,encroachStart.actors[c.rider]);},
  rotation:c.rotation??null,
 });
 try{assert.equal(result,!!expected.result);assert.deepEqual(mover.position,expected.position);assert.deepEqual(mover.rotation,expected.rotation);assert.equal(cursor,boundary.length);for(const [id,actor]of objects)assert.deepEqual(actor.position,expected.actors[id]);}catch(e){mismatches.push({i,message:e.message});}
}
function farCase(i){
 const c=cases[i],expected=native.results[i];
 const objects=new Map(actors.map(a=>[a.id,{id:a.id,position:[...a.values.Location],rotation:a.values.Rotation??[0,0,0],
  movingBrush:a.kind==='Mover',isPawn:a.kind==='Pawn',flags:a.collisionBits,actorFlags:0x80000,radius:a.values.CollisionRadius??0,
  height:a.values.CollisionHeight??0,touching:[null,null,null,null],standingCount:0,motionFlags:0}]));
 for(const [id,position] of Object.entries({...(c.positions??{}),...(c.pawnPosition?{$pawn:c.pawnPosition}:{})}))objects.get(id).position=position;
 const mover=objects.get(c.actor);
 (c.touching??[]).forEach((id,index)=>{mover.touching[index]=objects.get(id);objects.get(id).touching[0]=mover;});
 const boundary=expected.trace.filter(e=>e.query||e.smooth||e.event||e.zoneBoundary===c.actor||e.hash&&e.actor===c.actor);let cursor=0;
 const next=()=>boundary[cursor++];
 const dispatch=(actor,event)=>{const e={event,actor:actor.id};assert.deepEqual(e,next());return !!c.reject&&event==='EncroachingOn';};
 const level={editor:false,netMode:0,actors:[...objects.values()],
  hash:{removeActor:actor=>assert.deepEqual({hash:'remove',actor:actor.id},next()),addActor:actor=>assert.deepEqual({hash:'add',actor:actor.id},next())},
  findSpot:()=>{throw Error('FindSpot is not reached for a mover');},
  checkEncroachment:(actor,position,rotation,notify)=>checkMoverEncroachment(actor,position,rotation,notify,{worldActor:null,dispatch,
   encroachmentCheck:(source,position)=>{const e=next();assert.equal(e.query,source.id);assert.deepEqual(position,e.vector);assert.deepEqual(source.position,e.moverPosition);return e.hits.map(id=>objects.get(id));},
   moveSmooth:(actor,delta)=>{const e=next();assert.equal(e.smooth,actor.id);assert.deepEqual(delta,e.vector);assert.deepEqual(mover.position,e.moverPosition);actor.position=e.positionAfter;}}),
  setBase:()=>{throw Error('no based children');},
  setActorZone:actor=>assert.deepEqual({zoneBoundary:actor.id},next()),
 };
 try{
  const result=farMoveActor(level,mover,c.destination,c.test??0,c.noCheck??0);
  assert.equal(result,!!expected.result);assert.deepEqual(mover.position,expected.position);
  if(expected.result&&!c.test)assert.deepEqual(mover.oldLocation,expected.oldLocation);
  assert.equal(Boolean(mover.motionFlags&0x100),Boolean(expected.motion&0x100),'bJustTeleported');
  assert.equal(cursor,boundary.length,'every original boundary was reached');
  for(const [id,actor] of objects){assert.deepEqual(actor.position,expected.actors[id]);assert.deepEqual(actor.touching.map(t=>t?.id??null),expected.touching[id]);}
 }catch(e){mismatches.push({i,message:e.message});}
}
await writeFile(path.join(dir,'comparison.json'),JSON.stringify({cases:cases.length,mismatches,hashes:native.hashes},null,2));console.log({cases:cases.length,mismatches});assert.equal(mismatches.length,0);
