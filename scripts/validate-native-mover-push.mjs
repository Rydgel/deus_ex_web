/** A moving brush pushing a non-Pawn actor: the original CheckEncroachment
 * (Engine.dll 0x1039a350) push at 0x1039a512-0x1039a577 / 0x1039a6f6-0x1039a773
 * calls AActor::moveSmooth on every blocking non-brush hit; no Pawn test
 * precedes it (docs/mover-push.md). This runs the original MoveActor and
 * FarMoveActor of Training's DeusExMover16 over plain Actor cylinders with the
 * decoration/pickup/carcass collision words, in Unicorn, and replays the same
 * scenes through the JavaScript composition Play uses: moveTranslatingMover or
 * farMoveActor over createLevelQueries, moveSmoothActor (move-smooth.mjs, the
 * pushed actor's own MoveActor through playerMove) and checkActorEncroachment
 * for the pushed actor's nested CheckEncroachment. Every query, hash
 * operation, event, zone boundary, position, rotation and touch slot is
 * compared in order. The pawn-floor scene pushes a Pawn (Engine.Pawn's
 * class) instead, through Play's Pawn entry: moveSmoothPawn over a pawn
 * physics view's moveActorHit.
 *
 * runner-timeout: 1800
 *
 *   NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-mover-push.mjs [--reuse|--capture-only] [--scene training|paris-grill|play-door|pawn-floor]
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
import {nativeModel,typedSceneModels} from './native-model.mjs';
import {gameDirectory} from './game-directory.mjs';
import {brushCollisionBounds} from '../src/runtime/brush-bounds.mjs';
import {createLevelQueries} from '../src/runtime/level-queries.mjs';
import {traceExtent} from '../src/runtime/extent-trace.mjs';
import {moveTranslatingMover} from '../src/runtime/mover-move.mjs';
import {moveSmoothActor,moveSmoothPawn} from '../src/runtime/move-smooth.mjs';
import {pawnPhysicsView} from '../src/runtime/script-pawn-physics.mjs';
import {moveActorRiders} from '../src/runtime/move-riders.mjs';
import {playerMove} from '../src/runtime/player-move.mjs';
import {actorBlockedBy,checkActorEncroachment,checkMoverEncroachment} from '../src/runtime/check-encroachment.mjs';
import {farMoveActor} from '../src/runtime/relocation.mjs';
import {beginTouch,endTouch,isOverlapping} from '../src/runtime/actor-touch.mjs';
import {loadTraceKernel} from '../src/runtime/trace-kernel.mjs';
import {AMMO,GROUPS} from './mover-push-play-door.mjs';
await loadTraceKernel(); // Rust BSP traces; TRACE_KERNEL=js runs the JavaScript bodies
const root=gameDirectory(),base='reports/movement/mover-push';
const reuse=process.argv.includes('--reuse');
const cylinder=(id,bits,r,h,position)=>({id,kind:'Actor',values:{Location:position,CollisionRadius:r,CollisionHeight:h},collisionBits:bits});
const shift=(center,d)=>center.map((v,i)=>Math.fround(v+d[i]));

/** Training's DeusExMover16 (a translating door) with plain Actor cylinders:
 * a decoration with every collision word the push can meet, a second one to
 * block it, and a pickup-sized item, each starting well away from the door. */
async function trainingScene(assets,defaults,{minimal=false}={}){
 const asset=await assets.get('00_Training'),map=decodeMap(asset.bytes),actors=[];
 for(const actor of map.actors.filter(a=>['DeusExMover16','DeusExMover17'].includes(a.name))){
  const values=await defaults.forActor(asset,actor);
  actors.push({id:actor.name,kind:'Mover',values,collisionBits:1|(values.bCollideWorld?2:0)|(values.bBlockActors?4:0)|(values.bBlockPlayers?8:0),model:nativeModel(readModel(asset.pkg,asset.bytes,values.Brush))});
 }
 const b=brushCollisionBounds(actors[0].model,actors[0].values),center=b.min.map((v,i)=>Math.fround((v+b.max[i])/2));
 if(minimal)return {scene:{model:nativeModel(map.model),actors}};
 // The Paris club toilet (Toilet2) is radius 18, height 30.25.
 const variants=[1,3,5,7,15].map((bits,i)=>cylinder(`$deco${bits}`,bits,18,30.25,[-1000-100*i,-1000,0]));
 actors.push(...variants,cylinder('$block',15,18,30.25,[-2000,-1000,0]),cylinder('$item',3,8,8,[-2200,-1000,0]));
 const cases=[],mover=actors[0].id,at=(id,p=center)=>({[id]:p});
 // 1. Translation pushes, with the deco (all four block bits) in the leaf.
 for(const delta of [[0,0,1],[0,0,-1],[1,0,0],[-1,0,0],[16,0,0],[64,0,0],[-64,0,0]])
  cases.push({actor:mover,delta,positions:at('$deco15')},{actor:mover,delta,reject:1,positions:at('$deco15')});
 // 2. Rotation only (the Paris club grill): the push vector is zero.
 for(const rotation of [[0,8192,0],[0,-16384,0],[1024,512,-256],[0,0,-9213]])
  cases.push({actor:mover,delta:[0,0,0],rotation,positions:at('$deco15')},{actor:mover,delta:[0,0,0],rotation,reject:1,positions:at('$deco15')});
 cases.push({actor:mover,delta:[4,0,0],rotation:[0,512,0],positions:at('$deco15')});
 // 3. Which collision words the mover blocks and pushes (bCollideWorld on the
 // pushed actor decides; bBlockActors/bBlockPlayers on it do not).
 for(const bits of [1,3,5,7,15])for(const delta of [[0,0,1],[16,0,0]])
  cases.push({actor:mover,delta,positions:at(`$deco${bits}`)});
 cases.push({actor:mover,delta:[16,0,0],positions:at('$item')},{actor:mover,delta:[0,0,-8],positions:at('$item')});
 // 4. A pushed actor that meets another: the nested MoveActor hits, Bump on
 // both, the slide, HitWall and TwoWallAdjust, plus the floor/walls of the map.
 for(const side of [[40,0,0],[0,40,0],[-40,0,0],[0,-40,0],[0,0,40],[0,0,-40],[30,30,0]])
  for(const delta of [[64,0,0],[-64,0,0],[0,0,-8],[0,0,8]])
   cases.push({actor:mover,delta,positions:{...at('$deco15'),...at('$block',shift(center,side))}});
 for(const delta of [[0,0,-40],[0,0,40],[200,0,0],[-200,0,0],[0,200,0],[0,-200,0]])cases.push({actor:mover,delta,positions:at('$deco15')});
 // 5. The mover with bCollideWorld (the pushed actor blocked by the mover's
 // own reverse push).
 for(const delta of [[0,0,1],[16,0,0]])cases.push({actor:mover,delta,collideWorld:1,positions:at('$deco15')});
 // 6. FarMoveActor of the mover (DeusExMover.BlowItUp's SetLocation, notify 1):
 // into the deco (accepted and rejected), with an existing touch, and onto
 // non-blocking cylinders.
 const moverLocation=actors[0].values.Location,offset=d=>moverLocation.map((v,i)=>Math.fround(v+d[i]));
 cases.push({actor:mover,destination:offset([0,0,1]),positions:at('$deco15')},{actor:mover,destination:offset([0,0,1]),reject:1,positions:at('$deco15')},
  {actor:mover,destination:offset([0,0,20000]),positions:at('$deco15')},{actor:mover,destination:offset([0,0,20000]),touching:['$deco15'],positions:at('$deco15')},
  {actor:mover,destination:offset([0,0,1]),positions:at('$deco1')},{actor:mover,destination:offset([0,0,1]),positions:at('$deco3')},
  {actor:mover,destination:offset([0,0,1]),touching:['$deco1'],positions:at('$deco1')},{actor:mover,destination:offset([0,0,1]),positions:{...at('$deco15'),...at('$block',shift(center,[40,0,0]))}});
 return {dir:base,scene:{model:nativeModel(map.model),actors},cases};
}

/** 10_Paris_Club's DeusExMover4, the toilet grill: a pure roll about its top
 * edge (KeyRot[1] roll -16384, Location unchanged), so the push vector is
 * zero. Toilet0 (Toilet2, flags 15, r18 h30.25) sits where the panel ends its
 * swing. Each case is one MoveActor step at a roll of the interpolation. */
async function parisGrillScene(assets,defaults){
 const asset=await assets.get('10_Paris_Club'),map=decodeMap(asset.bytes),actors=[];
 for(const actor of map.actors.filter(a=>a.name==='DeusExMover4')){
  const values=await defaults.forActor(asset,actor);
  actors.push({id:actor.name,kind:'Mover',values,collisionBits:1|(values.bCollideWorld?2:0)|(values.bBlockActors?4:0)|(values.bBlockPlayers?8:0),model:nativeModel(readModel(asset.pkg,asset.bytes,values.Brush))});
 }
 const toilet=[-1651.758544921875,-1480.9237060546875,-157.80087280273438];
 actors.push(cylinder('$toilet',15,18,30.25,toilet),cylinder('$far',15,18,30.25,[-1651.758544921875,-1380.9237060546875,-157.80087280273438]));
 const cases=[],mover='DeusExMover4',yaw=-16384;
 for(const roll of [-1000,-4000,-8000,-8500,-9000,-9213,-10000,-12000,-14000,-16000,-16384])
  cases.push({actor:mover,delta:[0,0,0],rotation:[0,yaw,roll],positions:{'$toilet':toilet}},{actor:mover,delta:[0,0,0],rotation:[0,yaw,roll],reject:1,positions:{'$toilet':toilet}});
 // The toilet is clear of the panel until late in the swing, and a second
 // cylinder is never reached.
 cases.push({actor:mover,delta:[0,0,0],rotation:[0,yaw,-16384],positions:{'$toilet':[toilet[0],toilet[1]-60,toilet[2]]}});
 return {dir:`${base}/paris-grill`,scene:{model:nativeModel(map.model),actors},cases};
}

/** The Training door leaf closing on a pickup squeezed against the door
 * frame: the recorded Play groups of mover-push-play-door.mjs. */
async function playDoorScene(assets,defaults){
 const {scene}=await trainingScene(assets,defaults,{minimal:true});
 scene.actors.push(cylinder('$ammo',AMMO.bits,AMMO.radius,AMMO.height,AMMO.start));
 const cases=GROUPS.map(g=>({actor:'DeusExMover16',delta:g.delta,positions:{DeusExMover16:g.mover,DeusExMover17:g.other,$ammo:g.ammo}}));
 return {dir:`${base}/play-door`,scene,cases};
}

/** A Pawn (kind 'Pawn': Engine.Pawn's class in native-level-oracle.py) on
 * Training's floor, with DeusExMover16's leaf moved over it and then down
 * into it. Pushed straight into the floor, the pawn's moveSmooth has a zero
 * slide: its second MoveActor returns before writing the shared Hit
 * (0x10399228), and HitWall and TwoWallAdjust run with the first call's floor
 * hit (docs/mover-push.md). Gaps under the pawn from touching to clear of the
 * push, and two pushes with a slide along the floor. */
async function pawnFloorScene(assets,defaults){
 const {scene}=await trainingScene(assets,defaults,{minimal:true});
 // (-360,800): open floor on the Z -128 plane, no wall within 200 units. A
 // 17x42 cylinder's extent trace meets it with its center near Z -84 to
 // -85.4 (by trace length), so the pawn starts from touching to well clear.
 const x=-360,y=800,height=42;
 scene.actors.push({...cylinder('$pawn',15,17,height,[x,y,-84]),kind:'Pawn'});
 // The leaf (8 thick, 64 wide, 128 high about its Location) 0.5 above the pawn.
 const at=z=>({$pawn:[x,y,z],DeusExMover16:[x-4,y,z+height+.5+64]});
 const cases=[],mover='DeusExMover16';
 for(const z of [-84.5,-84,-83,-80,-74,-56])for(const d of [1,4,16])cases.push({actor:mover,delta:[0,0,-d],positions:at(z)});
 cases.push({actor:mover,delta:[0,0,-4],reject:1,positions:at(-84)},{actor:mover,delta:[0,0,-16],reject:1,positions:at(-80)});
 cases.push({actor:mover,delta:[8,0,-16],positions:at(-84)},{actor:mover,delta:[0,6,-16],positions:at(-80)});
 return {dir:`${base}/pawn-floor`,scene,cases};
}

const captured=[];
{
 const files=[];for(const d of ['Maps','System'])for(const name of await readdir(path.join(root,d)))files.push({path:`${d}/${name}`,read:()=>readFile(path.join(root,d,name))});
 const assets=new AssetStore(files),defaults=new ClassDefaults(assets);
 const scenes=[[trainingScene,'training',base],[parisGrillScene,'paris-grill',`${base}/paris-grill`],[playDoorScene,'play-door',`${base}/play-door`],
  [pawnFloorScene,'pawn-floor',`${base}/pawn-floor`]];
 for(const [build,name,saved] of scenes){
  // --reuse replays the saved captures; --scene training|paris-grill|play-door|pawn-floor captures only that scene.
  const only=process.argv.includes('--scene')?process.argv[process.argv.indexOf('--scene')+1]:null;
  if(reuse||only&&only!==name){captured.push(saved);continue;}
  const {dir,scene,cases}=await build(assets,defaults);
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'scene.json'),JSON.stringify(scene));await writeFile(path.join(dir,'cases.json'),JSON.stringify(cases));
  const result=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-mover-move-oracle.py',root,path.join(dir,'scene.json'),path.join(dir,'cases.json')],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:1800000});
  if(result.status!==0)throw Error(result.stderr);
  await writeFile(path.join(dir,'original.json'),result.stdout);captured.push(dir);
 }
}
if(process.argv.includes('--capture-only')){console.log('original non-Pawn push scenes captured:',captured.join(', '));process.exit(0);}

let pushes=0,events={},total=0;const mismatches=[],evidence={};
for(const dir of captured){
const raw=await Promise.all(['scene','cases','original'].map(key=>readFile(path.join(dir,`${key}.json`))));
const [saved,cases,native]=raw.map(b=>JSON.parse(b));total+=cases.length;
for(let index=0;index<cases.length;index++){
 const c=cases[index],scene=structuredClone(saved),actors=scene.actors,expected=native.results[index];
 const bits=new DataView(new ArrayBuffer(4));
 typedSceneModels(scene,actors);
 for(const a of actors){
  const pawn=a.kind==='Pawn';
  Object.assign(a,{flags:a.collisionBits,actorFlags:0x80000,static:false,movable:true,movingBrush:Boolean(a.model),isPawn:pawn,controlledPlayer:false,pawnFlags:0,
   standingCount:0,touching:[null,null,null,null],physics:0,mapActor:!a.model,lineage:[...(pawn?['engine.pawn']:[]),'engine.actor',...(a.model?['engine.mover','engine.brush']:[])]});
  Object.assign(a,{collideActors:Boolean(a.flags&1),collideWorld:Boolean(a.flags&2),blockActors:Boolean(a.flags&4),blockPlayers:Boolean(a.flags&8)});
  for(const [key,value]of [['position','Location'],['radius','CollisionRadius'],['height','CollisionHeight'],['rotation','Rotation']])
   Object.defineProperty(a,key,{get(){return this.values[value]??(key==='rotation'?[0,0,0]:0);},set(v){this.values[value]=v;}});
 }
 const queries=createLevelQueries(scene.model,actors,{extentCheck:traceExtent}),mover=actors.find(a=>a.id===c.actor),trace=[];
 if(c.collideWorld){mover.flags|=2;mover.collideWorld=true;}
 for(const a of actors)a.worldActor=queries.levelInfo;
 for(const [id,position]of Object.entries(c.positions??{})){const a=actors.find(x=>x.id===id);queries.changeActor(a,()=>a.position=position);}
 const dispatch=(a,event)=>{trace.push({event,actor:a.id});events[event]=(events[event]??0)+1;return event==='EncroachingOn'&&Boolean(c.reject);};
 const removeActor=a=>{trace.push({hash:'remove',actor:a.id});queries.removeActor(a);},addActor=a=>{trace.push({hash:'add',actor:a.id});queries.addActor(a);};
 const positions=()=>Object.fromEntries(actors.map(x=>[x.id,[...x.position]]));
 // The native logs every CheckEncroachment entry; the mover's is logged at its first query.
 let moverEntry=true;
 const encroachmentCheck=(a,position,rotation,extra)=>{
  if(a===mover&&moverEntry){trace.push({checkEncroachment:a.id,position:[...position],actors:positions()});moverEntry=false;}
  const entry={query:a.id,vector:[...position],moverPosition:[...mover.position]};trace.push(entry);
  const hits=queries.actorEncroachmentCheck(a,position,rotation,extra);entry.hits=hits.map(h=>h.actor.id);return hits;
 };
 // The services Play's spawnedMoveServices gives a non-Pawn actor's MoveActor.
 const services={worldActor:queries.levelInfo,multiLineCheck:queries.multiLineCheck,removeActor,addActor,dispatch,
  isBlockedBy:(s,o)=>actorBlockedBy(s,o,{worldActor:queries.levelInfo}),isOverlapping,
  beginTouch:(a,b)=>beginTouch(a,b,dispatch),endTouch:(a,b,s)=>endTouch(a,b,s,dispatch),setActorZone:a=>trace.push({zoneBoundary:a.id}),
  checkEncroachment:(a,position,rotation,notify)=>{
   trace.push({checkEncroachment:a.id,position:[...position].map(Math.fround),actors:positions()});
   return checkActorEncroachment(a,position,rotation,notify,{worldActor:queries.levelInfo,dispatch,encroachmentCheck:encroachmentCheck});
  }};
 const pushSmooth=(a,delta)=>{
  pushes++;
  const entry={smooth:a.id,vector:[...delta],moverPosition:[...mover.position]};trace.push(entry);
  const result=a.kind==='Pawn'?moveSmoothPawn(pawnViews.get(a),delta):moveSmoothActor(a,delta,services);entry.positionAfter=[...a.position];return result;
 };
 // A Pawn moves through a pawn physics view (script-pawn-physics.mjs) over its
 // values, the fields a map pawn's view binds; the hash, events and zone are
 // the same traced services. Built before the case runs: its collision link
 // re-registers the pawn, which is not part of the original trace.
 const pawnViews=new Map();
 for(const a of actors.filter(x=>x.kind==='Pawn')){
  Object.assign(a.values,{Rotation:a.values.Rotation??[0,0,0],StandingCount:0,Base:null,Physics:1,bStatic:false,bMovable:true,
   bCollideActors:Boolean(a.flags&1),bCollideWorld:Boolean(a.flags&2),bBlockActors:Boolean(a.flags&4),bBlockPlayers:Boolean(a.flags&8),bProjTarget:false});
  const level={hash:{multiLineCheck:queries.multiLineCheck,removeActor,addActor,lineCheck:queries.lineCheck},actors,netMode:0,model:scene.model,
   pointRegion:()=>({zone:null,leaf:0,zoneNumber:0})};
  const field=(actor,name)=>({get:()=>actor.values[name],set:value=>{actor.values[name]=value;}});
  pawnViews.set(a,pawnPhysicsView(a,{level,worldActor:queries.levelInfo,field,read:(actor,name)=>actor.values[name],
   write:(actor,name,value)=>{actor.values[name]=value;},isA:(actor,key)=>actor.lineage.includes(key),zoneFields:()=>({}),isProbing:()=>false,
   dispatch,zoneUpdate:actor=>{trace.push({zoneBoundary:actor.id});return true;}}));
 }
 trace.length=0;
 if('destination' in c){
  (c.touching??[]).forEach((id,i)=>{const other=actors.find(a=>a.id===id);mover.touching[i]=other;other.touching[0]=mover;});
  const level={editor:false,netMode:0,actors,hash:{removeActor,addActor},findSpot:()=>{throw Error('FindSpot is not reached for a mover');},
   checkEncroachment:(a,position,rotation,notify)=>checkMoverEncroachment(a,position,rotation,notify,{worldActor:queries.levelInfo,encroachmentCheck:(s,p,r,e)=>encroachmentCheck(s,p,r,e).map(h=>h.actor),moveSmooth:pushSmooth,dispatch,isOverlapping}),
   setBase:()=>{throw Error('no based children');},setActorZone:a=>trace.push({zoneBoundary:a.id})};
  const result=farMoveActor(level,mover,c.destination,c.test??0,c.noCheck??0);
  const actual={result:Number(result),position:mover.position,oldLocation:mover.oldLocation??[0,0,0],motion:mover.motionFlags??0,trace,
   touching:Object.fromEntries(actors.map(a=>[a.id,a.touching.map(t=>t?.id??null)])),actors:Object.fromEntries(actors.map(a=>[a.id,a.position]))};
  try{assert.deepEqual(actual,expected);}catch(error){mismatches.push({scene:dir,index,input:c,actual,expected,message:error.message.slice(0,800)});}
  continue;
 }
 const result=moveTranslatingMover(mover,c.delta,{rotation:c.rotation??null,
  moveRiders:()=>{throw Error('no based riders in this scene');},
  encroachmentCheck:(s,p,r,e)=>encroachmentCheck(s,p,r,e).map(h=>h.actor),moveSmooth:pushSmooth,dispatch,removeActor,addActor});
 if(result&&!moverEntry)trace.push({boundary:'after pose/hash commit; before Bump/touch/zone'});
 const actual={result:Number(result),position:mover.position,rotation:mover.rotation,trace,actors:Object.fromEntries(actors.map(a=>[a.id,a.position])),
  rotations:Object.fromEntries(actors.map(a=>[a.id,a.rotation]))};
 try{
  assert.deepEqual(actual,expected);
  // The recorded Play groups: the original ends the pickup where Play's pushes did.
  if(dir.endsWith('play-door'))assert.deepEqual(expected.actors.$ammo,GROUPS[index].final,'original pickup position vs Play');
 }catch(error){mismatches.push({scene:dir,index,input:c,actual,expected,message:error.message.slice(0,800)});}
}
evidence[dir]=Object.fromEntries(['scene','cases','original'].map((key,i)=>[key,createHash('sha256').update(raw[i]).digest('hex')]));
await writeFile(path.join(dir,'comparison.json'),JSON.stringify({cases:cases.length,evidenceSha256:evidence[dir],hashes:native.hashes},null,2));
}
await writeFile(path.join(base,'comparison.json'),JSON.stringify({cases:total,pushes,events,evidence,mismatches},null,2));
console.log(JSON.stringify({cases:total,pushes,events,mismatchCount:mismatches.length,examples:mismatches.slice(0,2)}));assert.equal(mismatches.length,0);
