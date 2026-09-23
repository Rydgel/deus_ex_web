import {falling} from './falling.mjs';
import {actorLanded} from './landing.mjs';
import {playerMove} from './player-move.mjs';
import {setActorPhysics,findActorBase} from './script-actor-collision.mjs';
import {processDecorationHitWall} from './walking-callbacks.mjs';
import {physicsRotation} from './actor-rotation.mjs';
import {setScriptRotation} from './script-set-rotation.mjs';

/** Field-backed adapters for the recovered non-Pawn routines. Original scripts
 * mutate these same fields during HitWall/Landed, so no snapshot is copied
 * back over their writes. Evidence: docs/script-crate-destruction.md. */
export function runSpawnedActorFalling(runtime,actor,seconds,zone) {
  if(!runtime.collisionViewActors.has(actor))throw new Error('Falling actor lacks its native collision view');
  const level=runtime.levelFor(actor),get=name=>runtime.namedReference(actor,name).get();
  const world=target=>target===level.hash.levelInfo?level.actors[0]:target;
  const dispatch=(target,event,args)=>runtime.dispatchSpawnedEvent(world(target),event,args);
  const host={};
  for(const [key,name] of Object.entries({position:'Location',velocity:'Velocity',acceleration:'Acceleration',
    physics:'Physics',justTeleported:'bJustTeleported',bBounce:'bBounce',bDeleteMe:'bDeleteMe'}))
    Object.defineProperty(host,key,{get:()=>get(name),set:value=>runtime.namedReference(actor,name).set(value)});
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
    setPhysics:(next,base)=>setActorPhysics(actor,next,world(base),{dispatch,
      findBase:target=>findActorBase(target,{lineCheck:(...args)=>level.hash.lineCheck(...args),dispatch})}),
    landed:hit=>actorLanded(host,hit,{zone}),
  });
  falling(host,seconds,0,{nonPawn:true,hitWallEvent:(normal,wall)=>dispatch(actor,'HitWall',[normal,world(wall)])});
}

export function runActorRotation(runtime,actor,seconds) {
  const read=(target,name)=>runtime.namedReference(target,name).get();
  const write=(target,name,value)=>runtime.namedReference(target,name).set(value);
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
