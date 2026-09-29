import {falling} from './falling.mjs';
import {actorLanded,decorationLanded} from './landing.mjs';
import {playerMove} from './player-move.mjs';
import {setActorPhysics,findActorBase} from './script-actor-collision.mjs';
import {processDecorationHitWall,setSupportBase} from './walking-callbacks.mjs';
import {physicsRotation} from './actor-rotation.mjs';
import {setScriptRotation} from './script-set-rotation.mjs';
import {rolling} from './rolling.mjs';

/** Field-backed adapters for the recovered non-Pawn routines. Original scripts
 * mutate these same fields during HitWall/Landed, so no snapshot is copied
 * back over their writes. Evidence: docs/script-crate-destruction.md. */
export function runSpawnedActorFalling(runtime,actor,seconds,zone,iterations=0) {
  // A serialized map actor already owns its collision/native surface; preserve
  // that identity and only link its hash cylinder to live Location. Spawned
  // actors expose the same members through installActorCollisionView.
  const level=runtime.collisionViewActors.has(actor)?runtime.levelFor(actor)
    :runtime.mapMoveLevel(actor,'physFalling');
  if(!level?.hash)throw new Error('Falling actor requires the level collision hash');
  const get=name=>runtime.readNamed(actor,name);
  const world=target=>target===level.hash.levelInfo?level.actors[0]:target;
  const dispatch=(target,event,args)=>runtime.dispatchSpawnedEvent(world(target),event,args);
  const isDecoration=(()=>{
    for(let cls=runtime.instance(actor).cls;cls;cls=cls.base)
      if(cls.record.key==='engine.decoration')return true;
    return false;
  })();
  const host={};
  for(const [key,name] of Object.entries({position:'Location',velocity:'Velocity',acceleration:'Acceleration',
    physics:'Physics',justTeleported:'bJustTeleported',bBounce:'bBounce',bDeleteMe:'bDeleteMe'}))
    Object.defineProperty(host,key,{get:()=>get(name),set:value=>runtime.writeNamed(actor,name,value)});
  if(isDecoration)Object.defineProperty(host,'landingCounter',{
    get:()=>get('numLandings'),set:value=>runtime.writeNamed(actor,'numLandings',value),
  });
  // physFalling's IsA(ADecoration) && bBobbing branch (0x103d0f42, Decoration
  // +0x31c & 0x08): falling() stops at it. Other classes fail that IsA.
  if(isDecoration)Object.defineProperty(host,'bobbing',{get:()=>Boolean(get('bBobbing'))});
  Object.assign(host,{gravity:zone.ZoneGravity??[0,0,-950],zoneVelocity:zone.ZoneVelocity??[0,0,0],
    terminalVelocity:zone.ZoneTerminalVelocity??2500,
    zoneNumber:runtime.regionValue(actor).zoneNumber,
    move:delta=>{
      const result=playerMove(actor,delta,runtime.spawnedMoveServices(actor,level));
      return {time:Math.fround(result.time),normal:result.hit?.normal??[0,0,0],actor:world(result.hit?.actor??null)};
    },
    hitWall:hit=>processDecorationHitWall(actor,hit.normal,hit.actor,{
      isProbing:(source,name)=>runtime.isProbing(source,name),dispatch}),
    landedEvent:normal=>dispatch(actor,'Landed',[normal]),
    // physFalling's zone-0 branch (0x103d0b89): Actor.FellOutOfWorld.
    fellOutOfWorld:()=>dispatch(actor,'FellOutOfWorld',[]),
    setPhysics:(next,base)=>setActorPhysics(actor,next,world(base),{dispatch,
      findBase:target=>findActorBase(target,{lineCheck:(...args)=>level.hash.lineCheck(...args),dispatch})}),
    landed:hit=>isDecoration?decorationLanded(host,hit,{zone}):actorLanded(host,hit,{zone}),
  });
  falling(host,seconds,iterations,{nonPawn:true,hitWallEvent:(normal,wall)=>dispatch(actor,'HitWall',[normal,world(wall)])});
}

/** Field-backed AActor::physRolling for a serialized map actor or spawned
 * collision-view actor. The original Rolling body calls live ULevel
 * MoveActor, ProcessEvent, SetPhysics/SetSupportBase and can recurse into the
 * original Falling body; callbacks therefore read and write script fields at
 * each access instead of copying a host snapshot. Evidence: docs/rolling.md,
 * docs/script-map-actor-move.md and docs/walking-callbacks.md. */
export function runActorRolling(runtime,actor,seconds,zone) {
  const level=runtime.collisionViewActors.has(actor)?runtime.levelFor(actor)
    :runtime.mapMoveLevel(actor,'physRolling');
  if(!level?.hash)throw new Error('Rolling actor requires the level collision hash');
  const get=name=>runtime.readNamed(actor,name);
  const world=target=>target===level.hash.levelInfo?level.actors[0]:target;
  const dispatch=(target,event,args)=>runtime.dispatchSpawnedEvent(world(target),event,args);
  const host={};
  for(const [key,name] of Object.entries({position:'Location',velocity:'Velocity',acceleration:'Acceleration',
    physics:'Physics',justTeleported:'bJustTeleported',base:'Base',bBounce:'bBounce',bDeleteMe:'bDeleteMe'}))
    Object.defineProperty(host,key,{get:()=>get(name),set:value=>runtime.writeNamed(actor,name,value)});
  rolling(host,seconds,{
    zone,
    move:delta=>{
      const result=playerMove(actor,delta,runtime.spawnedMoveServices(actor,level));
      return {time:Math.fround(result.time),normal:result.hit?.normal??[0,0,0],actor:world(result.hit?.actor??null)};
    },
    eventHitWall:(normal,wall)=>dispatch(actor,'HitWall',[normal,world(wall)]),
    eventFalling:()=>dispatch(actor,'Falling',[]),
    setPhysics:(next,base)=>setActorPhysics(actor,next,world(base),{dispatch,
      findBase:target=>findActorBase(target,{lineCheck:(...args)=>level.hash.lineCheck(...args),dispatch})}),
    physFalling:(remaining,iterations)=>runSpawnedActorFalling(runtime,actor,remaining,zone,iterations),
    setBase:target=>setSupportBase(actor,world(target),dispatch),
  });
  return get('Physics');
}

export function runActorRotation(runtime,actor,seconds) {
  const read=(target,name)=>runtime.readNamed(target,name);
  const write=(target,name,value)=>runtime.writeNamed(target,name,value);
  const view={};
  for(const [key,name] of Object.entries({rotation:'Rotation',rotationRate:'RotationRate',
    desiredRotation:'DesiredRotation',bRotateToDesired:'bRotateToDesired',bFixedRotationDir:'bFixedRotationDir'}))
    Object.defineProperty(view,key,{get:()=>read(actor,name)});
  return physicsRotation(view,seconds,{
    moveActor:(_delta,rotation)=>setScriptRotation(actor,rotation,{levelFor:runtime.levelFor,read,write}),
    isProbing:name=>runtime.isProbing(actor,name),
    endedRotation:()=>runtime.processEvent(actor,'EndedRotation',[]),
  });
}
