/** A rotating moving brush: the original AActor::performPhysics -> physicsRotation -> fixedTurn -> ULevel::MoveActor of a brush source (with its
 * whole tail) -> CheckEncroachment, against the JavaScript composition Play runs (docs/rotating-brushes.md).
 *
 * The scene is 09_NYC_ShipFan's: DeusExMover1, 2 and 3 are the only brushes in the installed maps with a RotationRate (the AC fans: Physics 9,
 * bFixedRotationDir, yaw -20000 and pitch -+30000), plus pawn, decoration, pickup and toucher cylinders placed in the blades' sweep. The cases are
 * sequences of ticks (one performPhysics per entry of `dts`, one Unicorn process carrying the actor, the hash and the touch slots from tick to tick):
 * the stock fans (colliding), the fan as Save0021 holds it (a destroyed mover: bCollideActors clear, Location + 20000, Rotation yaw 19190), a source with
 * only bCollideWorld, held touches the tail ends, EncroachingOn rejections, and tick lengths from 1/120 to 0.1.
 *
 * The replay is Play's code over the recorded boundaries only where the original calls out of Engine.dll (script events, SetActorZone):
 * performActorPhysics (actor-physics.mjs), physicsRotation/fixedTurn (actor-rotation.mjs), setScriptRotation, moveTranslatingMover + moverMoveTail
 * (mover-move.mjs), checkMoverEncroachment, the level hash (createLevelQueries over the same models), moveSmoothActor / moveSmoothPawn for a pushed
 * actor, BeginTouch/EndTouch/IsOverlapping. Every tick compares Rotation, Location, OldLocation, Velocity, every actor's pose and touch slots and the
 * ordered trace (physicsRotation, MoveActor entry, CheckEncroachment, queries and their hits, moveSmooth, events, hash operations, zone boundary).
 *
 * runner-timeout: 1800
 *
 *   NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-rotating-brush.mjs [--reuse|--capture-only] [--cases N]
 */
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ClassDefaults} from '../src/unreal/classes.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {readModel} from '../src/unreal/model.mjs';
import {nativeModel} from './native-model.mjs';
import {gameDirectory} from './game-directory.mjs';
import {brushCollisionBounds} from '../src/runtime/brush-bounds.mjs';
import {createLevelQueries} from '../src/runtime/level-queries.mjs';
import {traceExtent} from '../src/runtime/extent-trace.mjs';
import {moveTranslatingMover,moverMoveTail} from '../src/runtime/mover-move.mjs';
import {moveSmoothActor,moveSmoothPawn} from '../src/runtime/move-smooth.mjs';
import {pawnPhysicsView} from '../src/runtime/script-pawn-physics.mjs';
import {actorBlockedBy,checkActorEncroachment,checkMoverEncroachment} from '../src/runtime/check-encroachment.mjs';
import {beginTouch,endTouch,isOverlapping} from '../src/runtime/actor-touch.mjs';
import {performActorPhysics} from '../src/runtime/actor-physics.mjs';
import {physicsRotation} from '../src/runtime/actor-rotation.mjs';
import {setScriptRotation} from '../src/runtime/script-set-rotation.mjs';
import {loadTraceKernel} from '../src/runtime/trace-kernel.mjs';
await loadTraceKernel();
const root=gameDirectory(),dir='reports/movement/rotating-brush';
const reuse=process.argv.includes('--reuse');
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const f=Math.fround;
const cylinder=(id,bits,r,h,position,kind='Actor')=>({id,kind,values:{Location:position,CollisionRadius:r,CollisionHeight:h},collisionBits:bits});
// mulberry32: the cases are a function of the seed.
const prng=seed=>()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};

async function buildCases(assets,defaults){
 const asset=await assets.get('09_NYC_ShipFan'),map=decodeMap(asset.bytes),actors=[],fans={};
 for(const actor of map.actors.filter(a=>['DeusExMover1','DeusExMover2','DeusExMover3'].includes(a.name))){
  const values=await defaults.forActor(asset,actor);
  const model=nativeModel(readModel(asset.pkg,asset.bytes,values.Brush));
  actors.push({id:actor.name,kind:'Mover',values,collisionBits:1|(values.bCollideWorld?2:0)|(values.bBlockActors?4:0)|(values.bBlockPlayers?8:0),model});
  fans[actor.name]={values,bounds:brushCollisionBounds(model,values)};
 }
 // A pawn, a decoration (the Toilet2 size), a pickup-sized cylinder and a non-blocking toucher; they start far from every fan.
 actors.push(cylinder('$pawn',15,17,42,[5000,5000,0],'Pawn'),cylinder('$deco',15,18,30.25,[5200,5000,0]),cylinder('$item',3,8,8,[5400,5000,0]),
  cylinder('$toucher',1,8,8,[5600,5000,0]),cylinder('$block',15,18,30.25,[5800,5000,0]));
 const rand=prng(0xfa2021),cases=[],between=(a,b)=>a+(b-a)*rand();
 const tick=1/60,steady=n=>Array(n).fill(f(tick));
 const mixed=[f(1/60),f(1/30),f(1/120),f(0.0083),f(0.0499999),f(0.1),f(1/45),f(0.02),f(0.001),f(1/60),f(1/90),f(0.016667)];
 const inside=(name,rotation,location,z=null)=>{
  // A point inside the brush's world bounds at the pose (rotation, location), z optionally pinned.
  const b=brushCollisionBounds(actors.find(a=>a.id===name).model,{...fans[name].values,Rotation:rotation,Location:location});
  return [between(b.min[0],b.max[0]),between(b.min[1],b.max[1]),z??between(b.min[2],b.max[2])].map(f);
 };
 const fanZ={DeusExMover1:-271};
 const initial=name=>({rotation:fans[name].values.Rotation,rate:fans[name].values.RotationRate,location:fans[name].values.Location});
 for(const name of Object.keys(fans)){
  const {rotation,rate,location}=initial(name);
  // 1. The stock fan alone (colliding, nothing near it): the rotation chain of Play's every tick.
  cases.push({actor:name,physics:9,fixed:true,rotation,rate,dts:steady(24)});
  cases.push({actor:name,physics:5,fixed:true,rotation,rate,dts:mixed});
  // 2. The same with cylinders placed in the blades' sweep (pushed by a zero Delta: EncroachingOn, EncroachedBy), accepted and rejected.
  for(let k=0;k<6;k++){
   const positions={$pawn:inside(name,rotation,location,fanZ[name]),$deco:inside(name,rotation,location,fanZ[name]),$item:inside(name,rotation,location,fanZ[name])};
   cases.push({actor:name,physics:9,fixed:true,rotation,rate,dts:k%2?mixed:steady(12),positions,reject:k%3===2?1:0});
  }
  // 3. Held touches: the source ends every one each tick (IsOverlapping is false for a Brush); with and without collision.
  for(const flags of [null,0,2,15])
   cases.push({actor:name,physics:9,fixed:true,rotation,rate,flags,dts:steady(6),touching:['$toucher','$pawn'],positions:{$toucher:[5600,5000,0],$pawn:inside(name,rotation,location,fanZ[name])}});
  // 4. The fan as a saved level holds it once DeusExMover.BlowItUp has run: bCollideActors and the blocking bits clear, Location + 20000, a spin
  // Rotation (Save0021's yaw 19190), with cylinders near its new position (CheckEncroachment still pushes: a source without collision bits goes on as a non-static Brush).
  const moved=location.map((v,i)=>i===2?f(v+20000):v),spun=[rotation[0],19190,rotation[2]];
  cases.push({actor:name,physics:9,fixed:true,rotation:spun,rate,flags:0,location:moved,dts:steady(24)});
  for(let k=0;k<4;k++){
   const positions={$pawn:inside(name,spun,moved,fanZ[name]!=null?fanZ[name]+20000:null),$deco:inside(name,spun,moved,fanZ[name]!=null?fanZ[name]+20000:null)};
   cases.push({actor:name,physics:9,fixed:true,rotation:spun,rate,flags:k%2?0:2,location:moved,dts:steady(10),positions,reject:k===3?1:0});
  }
  // 5. Other rates over the same brush (the fixed-direction sweeps of fixedTurn, including a rate that crosses the 16-bit wrap in one tick and a tiny one).
  for(const r of [[0,20000,0],[0,-65000,0],[0,3,0],[12000,-9000,4000],[-1,0,1],[65536,0,0],[0,65537,0]])
   cases.push({actor:name,physics:9,fixed:true,rotation,rate:r,dts:mixed.slice(0,6)});
 }
 return {scene:{model:nativeModel(map.model),actors},cases};
}

const files=[];for(const d of ['Maps','System'])for(const name of await readdir(path.join(root,d)))files.push({path:`${d}/${name}`,read:()=>readFile(path.join(root,d,name))});
const assets=new AssetStore(files),defaults=new ClassDefaults(assets);
await mkdir(dir,{recursive:true});
if(!reuse){
 const {scene,cases}=await buildCases(assets,defaults);
 await writeFile(path.join(dir,'scene.json'),JSON.stringify(scene));await writeFile(path.join(dir,'cases.json'),JSON.stringify(cases));
 const result=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-rotating-brush-oracle.py',root,path.join(dir,'scene.json'),path.join(dir,'cases.json')],{encoding:'utf8',maxBuffer:512*1024*1024,timeout:1800000});
 if(result.status!==0)throw Error(result.stderr);
 await writeFile(path.join(dir,'original.json'),result.stdout);
}
if(process.argv.includes('--capture-only')){console.log('original rotating-brush scene captured:',dir);process.exit(0);}

const raw=await Promise.all(['scene','cases','original'].map(key=>readFile(path.join(dir,`${key}.json`))));
const [saved,allCases,native]=raw.map(b=>JSON.parse(b));
const limit=Number(arg('--cases',allCases.length)),cases=allCases.slice(0,limit);
const stats={cases:cases.length,ticks:0,moveActor:0,commits:0,refused:0,pushes:0,events:{},queries:0,hits:0,endTouch:0,zoneBoundary:0,rotationChanges:0};
const mismatches=[];
const bits=new DataView(new ArrayBuffer(4));
for(let index=0;index<cases.length;index++){
 const c=cases[index],scene=structuredClone(saved),actors=scene.actors,expected=native.results[index].steps;
 for(const model of [scene.model,...actors.map(a=>a.model).filter(Boolean)])for(const node of model.nodes)if(node.planeBits)node.plane=node.planeBits.map(w=>{bits.setUint32(0,w,true);return bits.getFloat32(0,true);});
 for(const a of actors){
  const pawn=a.kind==='Pawn';
  Object.assign(a,{flags:a.collisionBits,actorFlags:0x80000,static:false,movable:true,movingBrush:Boolean(a.model),isPawn:pawn,controlledPlayer:false,pawnFlags:0,
   standingCount:0,touching:[null,null,null,null],physics:0,mapActor:!a.model,lineage:[...(pawn?['engine.pawn']:[]),'engine.actor',...(a.model?['engine.mover','engine.brush']:[])]});
  for(const [key,value]of [['position','Location'],['radius','CollisionRadius'],['height','CollisionHeight'],['rotation','Rotation']])
   Object.defineProperty(a,key,{get(){return this.values[value]??(key==='rotation'?[0,0,0]:0);},set(v){this.values[value]=v;}});
 }
 const setFlags=(a,word)=>{a.flags=word;a.collisionBits=word&~2;Object.assign(a,{collideActors:Boolean(word&1),collideWorld:Boolean(word&2),blockActors:Boolean(word&4),blockPlayers:Boolean(word&8)});};
 for(const a of actors)setFlags(a,a.flags);
 const mover=actors.find(a=>a.id===c.actor),others=actors.filter(a=>a!==mover);
 // The hash is built from the scene's registrations. The oracle places the mover first (hash remove, new Location/flags, add if bCollideActors), then the cylinders.
 const queries=createLevelQueries(scene.model,actors,{extentCheck:traceExtent});
 for(const a of actors)a.worldActor=queries.levelInfo;
 const trace=[],rate=[...c.rate];
 let oldLocation=null,velocity=[0,0,0],moverEntry=true;
 const dispatch=(a,event)=>{trace.push({event,actor:a.id});stats.events[event]=(stats.events[event]??0)+1;return event==='EncroachingOn'&&Boolean(c.reject);};
 const removeActor=a=>{trace.push({hash:'remove',actor:a.id});queries.removeActor(a);},addActor=a=>{trace.push({hash:'add',actor:a.id});queries.addActor(a);};
 const positions=()=>Object.fromEntries(actors.map(x=>[x.id,[...x.position]]));
 const encroachmentCheck=(a,position,rotation,extra)=>{
  if(a===mover&&moverEntry){trace.push({checkEncroachment:a.id,position:[...position],actors:positions()});moverEntry=false;}
  const entry={query:a.id,vector:[...position],moverPosition:[...mover.position]};trace.push(entry);stats.queries++;
  const hits=queries.actorEncroachmentCheck(a,position,rotation,extra);entry.hits=hits.map(h=>h.actor.id);stats.hits+=hits.length;return hits;
 };
 // The services Play's spawnedMoveServices gives a pushed non-Pawn actor's MoveActor.
 const services={worldActor:queries.levelInfo,multiLineCheck:queries.multiLineCheck,removeActor,addActor,dispatch,
  isBlockedBy:(s,o)=>actorBlockedBy(s,o,{worldActor:queries.levelInfo}),isOverlapping,
  beginTouch:(a,b)=>beginTouch(a,b,dispatch),endTouch:(a,b,s)=>endTouch(a,b,s,dispatch),setActorZone:a=>trace.push({zoneBoundary:a.id}),
  checkEncroachment:(a,position,rotation,notify)=>{
   trace.push({checkEncroachment:a.id,position:[...position].map(f),actors:positions()});
   return checkActorEncroachment(a,position,rotation,notify,{worldActor:queries.levelInfo,dispatch,encroachmentCheck});
  }};
 const pawnViews=new Map();
 const pushSmooth=(a,delta)=>{
  stats.pushes++;
  const entry={smooth:a.id,vector:[...delta],moverPosition:[...mover.position]};trace.push(entry);
  const result=a.kind==='Pawn'?moveSmoothPawn(pawnViews.get(a),delta):moveSmoothActor(a,delta,services);entry.positionAfter=[...a.position];return result;
 };
 for(const a of others.filter(x=>x.kind==='Pawn')){
  Object.assign(a.values,{Rotation:a.values.Rotation??[0,0,0],StandingCount:0,Base:null,Physics:1,bStatic:false,bMovable:true,
   bCollideActors:Boolean(a.flags&1),bCollideWorld:Boolean(a.flags&2),bBlockActors:Boolean(a.flags&4),bBlockPlayers:Boolean(a.flags&8),bProjTarget:false});
  const level={hash:{multiLineCheck:queries.multiLineCheck,removeActor,addActor,lineCheck:queries.lineCheck},actors,netMode:0,model:scene.model,pointRegion:()=>({zone:null,leaf:0,zoneNumber:0})};
  const field=(actor,name)=>({get:()=>actor.values[name],set:value=>{actor.values[name]=value;}});
  pawnViews.set(a,pawnPhysicsView(a,{level,worldActor:queries.levelInfo,field,read:(actor,name)=>actor.values[name],
   write:(actor,name,value)=>{actor.values[name]=value;},isA:(actor,key)=>actor.lineage.includes(key),zoneFields:()=>({}),isProbing:()=>false,
   dispatch,zoneUpdate:actor=>{trace.push({zoneBoundary:actor.id});return true;}}));
 }
 // The scene's registrations, pawn views included, come first; the placements follow as the oracle does them (hash remove, new pose, add).
 if(c.flags!=null||c.location!=null){
  queries.removeActor(mover);
  if(c.location!=null)mover.position=[...c.location];
  if(c.flags!=null)setFlags(mover,c.flags);
  if(mover.flags&1)queries.addActor(mover);
 }
 for(const [id,position]of Object.entries(c.positions??{})){const a=actors.find(x=>x.id===id);queries.changeActor(a,()=>a.position=position);}
 (c.touching??[]).forEach((id,i)=>{const other=actors.find(a=>a.id===id);mover.touching[i]=other;other.touching[0]=mover;});
 mover.rotation=[...c.rotation];oldLocation=[...mover.position];
 // Play's mover MoveActor (player-scene.mjs moveMover): moveTranslatingMover with the commit's tail.
 const moveMover=(delta,rotation)=>{
  moverEntry=true;
  const entryRotation=[...mover.rotation];
  const result=moveTranslatingMover(mover,delta,{rotation,
   moveRiders:()=>{throw Error('no based riders in this scene');},
   encroachmentCheck:(s,p,r,e)=>encroachmentCheck(s,p,r,e).map(h=>h.actor),moveSmooth:pushSmooth,dispatch,removeActor,addActor,
   afterCommit:process.env.RB_MUTATE==='notail'?null:m=>moverMoveTail(m,{isOverlapping,endTouch:(a,b,s)=>{stats.endTouch++;endTouch(a,b,s,dispatch);},setActorZone:z=>{stats.zoneBoundary++;trace.push({zoneBoundary:z.id});}}),
  });
  stats[result?'commits':'refused']++;
  if(result&&mover.rotation.some((v,i)=>v!==entryRotation[i]))stats.rotationChanges++;
  return result;
 };
 // performActorPhysics over the mover as Play runs it (runActorRotation + setScriptRotation): the fields are the mover's own.
 const fields={Physics:{get:()=>c.physics,set:()=>{}},Location:{get:()=>mover.position,set:v=>{mover.position=v;}},OldLocation:{get:()=>oldLocation,set:v=>{oldLocation=v;}},
  Velocity:{get:()=>velocity,set:v=>{velocity=v;}},RotationRate:{get:()=>rate,set:()=>{}},PendingTouch:{get:()=>null,set:()=>{}},
  Rotation:{get:()=>mover.rotation,set:v=>{mover.rotation=v;}},bStatic:{get:()=>false},bMovable:{get:()=>true},Brush:{get:()=>mover.model},StandingCount:{get:()=>0}};
 const read=(a,name)=>fields[name].get(),write=(a,name,value)=>fields[name].set(value);
 const level={editor:false,moveActor:(actor,delta,rotation,hit,...flagsArgs)=>{
  assert.deepEqual(flagsArgs,[0,0,0,0]);
  trace.push({moveActor:actor.id,delta:[...delta],rotation:[...rotation],flags:[0,0,0,0]});stats.moveActor++;return moveMover(delta,rotation);
 }};
 const view={get rotation(){return mover.rotation;},rotationRate:rate,desiredRotation:c.desired??[0,0,0],bRotateToDesired:false,bFixedRotationDir:Boolean(c.fixed)};
 const physics={read,write,
  physMovingBrush:()=>{},   // bInterpolating clear: AMover::physMovingBrush returns at 0x103de6e1..0x103dea2e
  physicsRotation:(actor,dt)=>{
   trace.push({physicsRotation:dt});
   physicsRotation(view,dt,{moveActor:(_delta,rotation)=>setScriptRotation(mover,rotation,{levelFor:()=>level,read,write}),isProbing:()=>true,endedRotation:()=>{throw Error('EndedRotation is outside this scene');}});
  },
  processEvent:()=>{throw Error('PendingTouch is outside this scene');},
  unsupported:(a,what)=>{throw Error(`${what} is not linked`);},
  physFalling:()=>{throw Error('falling');},physRolling:()=>{throw Error('rolling');}};
 const actual=[];
 let note=null;
 for(const dt of c.dts){
  trace.length=0;moverEntry=true;
  try{performActorPhysics(mover,dt,physics);}catch(error){note=error.message;break;}
  stats.ticks++;
  const slot=p=>p.touching.map(t=>t?.id??null);
  actual.push({position:[...mover.position],rotation:[...mover.rotation],oldLocation:c.physics===9?[...oldLocation]:oldLocation,velocity:[...velocity],physics:c.physics,
   trace:structuredClone(trace),touching:Object.fromEntries(actors.map(a=>[a.id,slot(a)])),actors:Object.fromEntries(actors.map(a=>[a.id,[...a.position]])),
   rotations:Object.fromEntries(actors.map(a=>[a.id,[...a.rotation]]))});
 }
 try{
  if(note)throw Error(note);
  assert.equal(actual.length,expected.length);
  for(let tick=0;tick<expected.length;tick++){
   const want={...expected[tick]};delete want.motion;
   try{assert.deepEqual(actual[tick],want);}catch(error){
    if(process.env.RB_DUMP&&Number(process.env.RB_DUMP)===index){
     const brief=t=>t.trace.map(e=>e.hash?`${e.hash}:${e.actor}`:e.query?`query:${e.query} hits=${e.hits}`:e.smooth?`smooth:${e.smooth}`:e.event?`event:${e.event}:${e.actor}`:e.zoneBoundary?`zone:${e.zoneBoundary}`:Object.keys(e)[0]);
     for(let k=Math.max(0,tick-2);k<=tick;k++){console.log('tick',k,'actual',brief(actual[k]).join(' | '));console.log('tick',k,'native',brief(expected[k]).join(' | '));}
    }
    throw Error(`tick ${tick}: ${error.message.slice(0,1500)}`);}
  }
 }catch(error){mismatches.push({index,input:{...c,positions:c.positions,dts:c.dts.length},message:error.message.slice(0,2000)});}
}
const evidence=Object.fromEntries(['scene','cases','original'].map((key,i)=>[key,createHash('sha256').update(raw[i]).digest('hex')]));
await writeFile(path.join(dir,'comparison.json'),JSON.stringify({stats,evidenceSha256:evidence,hashes:native.hashes,mismatches},null,2));
console.log(JSON.stringify({...stats,mismatchCount:mismatches.length,examples:mismatches.slice(0,2)}));
assert.equal(mismatches.length,0);
