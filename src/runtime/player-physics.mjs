import {walking} from './walking.mjs';
import {falling} from './falling.mjs';
import {processLanded} from './landing.mjs';
import {walkingSurfacePrelude} from './walking-surface.mjs';
import {setBase,setSupportBase,setWalkingPhysics,processPlayerHitWall} from './walking-callbacks.mjs';
const f=Math.fround;
const isA=(actor,name)=>actor?.lineage?.includes(`engine.${name}`)??false;
const unsupported=name=>{throw Error(`Unsupported original player physics callback: ${name}`);};

/** Connect the evidenced dry-player routines without substituting RNG/FarMove.
 * One pawn object persists through all remaining-time physics dispatches. */
export function runPlayerPhysics(player,dt,{acceleration,groundSpeed,isWalking,zone}) {
 const queries=player.collision.queries,defaults=player.defaults;
 if(zone.bWaterZone)unsupported('water-zone physics');
 if(defaults.bBounce)unsupported('bouncing Pawn physics');
 player.motionFlags??=defaults.bJustTeleported?0x100:0;
 const pawn=player.physicsPawn??={base:player.spawnBase??null,hitSlopedWall:false,moveTimer:0,pawnFlags:0,destination:[0,0,0],
  // Actor+0x1ec is shared by physics and FarMoveActor; preserve every other bit.
  get justTeleported(){return Boolean(player.motionFlags&0x100);},
  set justTeleported(value){player.motionFlags=((player.motionFlags&~0x100)|(value?0x100:0))>>>0;}};
 Object.assign(pawn,{position:player.position.map(f),velocity:player.velocity.map(f),acceleration:acceleration.map(f),
  physics:player.grounded?1:2,worldActor:queries.levelInfo,radius:player.radius,height:player.height,
  rotation:player.bodyRotation,groundSpeed,accelRate:defaults.AccelRate,airControl:defaults.AirControl,
  maxStepHeight:defaults.MaxStepHeight,mass:defaults.Mass,minHitWall:defaults.MinHitWall??-.6,
  canJump:Boolean(defaults.bCanJump),isPlayer:true,isWalking,gravity:zone.ZoneGravity??[0,0,-950],
  friction:zone.ZoneGroundFriction??8,zoneVelocity:zone.ZoneVelocity??[0,0,0],terminalVelocity:zone.ZoneTerminalVelocity??2500});
 const decorate=actor=>{
  if(actor){
   // Map actors receive this host marker during scene preparation. Spawned
   // collision views expose the same class-derived marker as a read-only
   // property; the original IsA test observes classification and never writes
   // it back to the hit actor.
   if(!('isPawn' in actor))actor.isPawn=isA(actor,'pawn');
   actor.pushableDecoration=isA(actor,'decoration')&&Boolean(actor.values?.bPushable);
   actor.mass=actor.values?.Mass;actor.standingCount??=actor.values?.StandingCount??0;
  }
  return actor;
 };
 const dispatch=(target,event,args)=>{
  if(player.physicsDispatch)return player.physicsDispatch(target,event,args,pawn);
  if(event==='SupportActor') {
   if(target===pawn.worldActor)return setBase(pawn,target,dispatch);
   if(target.lineage?.includes('deusex.deusexmover')){
    if(pawn.velocity[2]<-500)unsupported('DeusExMover stomp damage');
    if(target.values?.bDestroyed)return pawn.setPhysics(2);
    return setBase(pawn,target,dispatch);
   }
   return unsupported(`${target.name}.SupportActor`);
  }
  if(event==='Attach'||event==='Detach'){
   if(target.lineage?.includes('deusex.deusexmover')&&target.values?.InitialState==='TriggerToggle')return;
   return unsupported(`${target.name}.${event}`);
  }
  if(event==='BaseChange'){
   if(isA(pawn.base,'pawn')||(isA(pawn.base,'decoration')&&pawn.velocity[2]<-400))unsupported('Pawn.BaseChange stomp/jump-off');
   return;
  }
  // Original Actor.HitWall and Pawn.MayFall/WalkTexture are empty for JC's
  // ordinary PlayerWalking state. Visual Falling/Landed work is recorded below.
  if(event==='HitWall')return;
  unsupported(event);
 };
 pawn.lineCheck=(start,end,extent,flags,extra=0)=>{
  const hit=queries.lineCheck(start,end,extent,flags,extra,player.collisionActor);decorate(hit.actor);return hit;
 };
 pawn.move=delta=>{
  player.position=[...pawn.position];const {hit,time}=player.move(delta);pawn.position=player.position.map(f);
  return {time:f(time),normal:hit?.normal.map(f)??[0,0,0],actor:decorate(hit?.actor??null)};
 };
 pawn.setSupportBase=actor=>setSupportBase(pawn,actor,dispatch);
 pawn.setPhysics=(next,support=null)=>setWalkingPhysics(pawn,next,support,{dispatch,findBase:()=>unsupported('FindBase without explicit landing support')});
 // Original JC ancestry/PlayerWalking serialized masks omit HitWall bit0x200;
 // an empty Actor event declaration does not enable its runtime probe.
 pawn.hitWall=hit=>processPlayerHitWall(pawn,hit.normal,hit.actor,{dispatch,isProbing:()=>false});
 pawn.mayFall=()=>{};
 pawn.fallingEvent=()=>{player.unimplementedPhysicsEffects.add('PlayerPawn.PlayInAir animation');};
 pawn.walkTexture=()=>{};
 pawn.textureForHit=hit=>player.textureForHit?player.textureForHit(hit):unsupported('original surface texture lookup');
 pawn.walkingPrelude=()=>walkingSurfacePrelude(pawn);
 pawn.findSpot=(position,extent,checkActors,checkFirst)=>player.collision.findSpot(position,extent,checkActors,checkFirst);
 pawn.farMove=(...args)=>player.nativeFarMove?player.nativeFarMove(pawn,...args):unsupported('FarMoveActor');
 pawn.random=()=>player.nativeRandom?player.nativeRandom():unsupported('original RNG state');
 // Original physFalling103d0cdc uses world+movers flags6 and the pawn source.
 pawn.airControlBlocked=delta=>queries.lineCheck(pawn.position,pawn.position.map((v,i)=>f(v+delta[i])),[pawn.radius,pawn.radius,pawn.height],6,0,player.collisionActor).time<1;
 pawn.landedEvent=()=>{
  player.justLanded=true;
  player.unimplementedPhysicsEffects.add('DeusExPlayer.Landed animation/audio/damage');
 };
 pawn.walking=(seconds,iterations)=>walking(pawn,seconds,iterations);
 pawn.falling=(seconds,iterations)=>falling(pawn,seconds,iterations);
 pawn.landed=(hit,remaining,iterations)=>processLanded(pawn,hit,remaining,iterations);
 // Jump has already selected Falling in PlayerMove; perform native base removal.
 if(pawn.physics===2&&pawn.base)setBase(pawn,null,dispatch);
 pawn.oldLocation=[...pawn.position];
 if(pawn.physics===1)pawn.walking(dt,0);else pawn.falling(dt,0);
 player.position=pawn.position;player.velocity=pawn.velocity;player.grounded=pawn.physics===1;
 return pawn.oldLocation[2];
}
