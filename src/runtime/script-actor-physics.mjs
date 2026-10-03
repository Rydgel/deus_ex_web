import {falling} from './falling.mjs';
import {actorLanded,decorationLanded} from './landing.mjs';
import {playerMove} from './player-move.mjs';
import {setActorPhysics,findActorBase} from './script-actor-collision.mjs';
import {processDecorationHitWall,setSupportBase} from './walking-callbacks.mjs';
import {physicsRotation} from './actor-rotation.mjs';
import {setScriptRotation} from './script-set-rotation.mjs';
import {rolling} from './rolling.mjs';
import {projectile} from './projectile.mjs';
import {physPathing} from './pathing.mjs';

/** Field-backed adapters for the recovered non-Pawn routines. Original scripts
 * mutate these same fields during HitWall/Landed, so no snapshot is copied
 * back over their writes. Evidence: docs/script-crate-destruction.md. */
export function runSpawnedActorFalling(runtime,actor,seconds,iterations=0) {
  const {host,options}=spawnedFallingAdapter(runtime,actor);
  falling(host,seconds,iterations,options);
}

/** The live host and falling options of runSpawnedActorFalling. The Rust
 * body (fall.rs, actor-physics-kernel.mjs) calls the host's `landed` here. */
export function spawnedFallingAdapter(runtime,actor) {
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
  // physFalling stores OldLocation = Location at every substep for every
  // source (0x103d0ee2-0x103d0f01, no Pawn test).
  for(const [key,name] of Object.entries({position:'Location',oldLocation:'OldLocation',velocity:'Velocity',acceleration:'Acceleration',
    physics:'Physics',justTeleported:'bJustTeleported',bBounce:'bBounce',bDeleteMe:'bDeleteMe'}))
    Object.defineProperty(host,key,{get:()=>get(name),set:value=>runtime.writeNamed(actor,name,value)});
  if(isDecoration)Object.defineProperty(host,'landingCounter',{
    get:()=>get('numLandings'),set:value=>runtime.writeNamed(actor,'numLandings',value),
  });
  // physFalling's IsA(ADecoration) && bBobbing branch (0x103d0f42, Decoration
  // +0x31c & 0x08), re-read at each integration. Other classes fail that IsA.
  if(isDecoration)Object.defineProperty(host,'bobbing',{get:()=>Boolean(get('bBobbing'))});
  // physFalling and processLanded read the actor's live Region.Zone
  // (actor+0xc8, kept by MoveActor's SetActorZone): ZoneGravity at each
  // integration, ZoneVelocity per substep, bWaterZone/ZoneFluidFriction with
  // Mass/Buoyancy for the water integration (0x103d125a), ZoneTerminalVelocity
  // after the move, bBounceVelocity/ZoneVelocity when landing
  // (docs/swimming.md "physFalling water paths").
  const regionZone=()=>{
    const zone=runtime.regionValue(actor).zone;
    if(!zone)throw new Error('physFalling requires the actor Region.Zone (actor+0xc8)');
    return zone;
  };
  const zoneField=name=>runtime.readNamed(regionZone(),name);
  for(const [key,name] of Object.entries({gravity:'ZoneGravity',zoneVelocity:'ZoneVelocity',
    terminalVelocity:'ZoneTerminalVelocity',fluidFriction:'ZoneFluidFriction',regionWater:'bWaterZone'}))
    Object.defineProperty(host,key,{get:key==='regionWater'?()=>Boolean(zoneField(name)):()=>zoneField(name)});
  for(const [key,name] of Object.entries({mass:'Mass',buoyancy:'Buoyancy'}))
    Object.defineProperty(host,key,{get:()=>get(name)});
  const zone={get bBounceVelocity(){return zoneField('bBounceVelocity');},get ZoneVelocity(){return zoneField('ZoneVelocity');}};
  Object.assign(host,{
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
  return {host,options:{nonPawn:true,hitWallEvent:(normal,wall)=>dispatch(actor,'HitWall',[normal,world(wall)])}};
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
    physFalling:(remaining,iterations)=>runSpawnedActorFalling(runtime,actor,remaining,iterations),
    setBase:target=>setSupportBase(actor,world(target),dispatch),
  });
  return get('Physics');
}

/** Field-backed AActor::physProjectile (projectile.mjs, docs/projectile.md)
 * for a serialized map actor or spawned collision-view actor: live script
 * fields, the actor's live Region.Zone, the original MoveActor, HitWall by
 * ProcessEvent, ULevel::DestroyActor for zone 0 and the live Falling adapter
 * for a bounce that set PHYS_Falling. */
export function runActorProjectile(runtime,actor,seconds,iterations=0) {
  const level=runtime.collisionViewActors.has(actor)?runtime.levelFor(actor)
    :runtime.mapMoveLevel(actor,'physProjectile');
  if(!level?.hash)throw new Error('Projectile actor requires the level collision hash');
  const get=name=>runtime.readNamed(actor,name);
  const world=target=>target===level.hash.levelInfo?level.actors[0]:target;
  const dispatch=(target,event,args)=>runtime.dispatchSpawnedEvent(world(target),event,args);
  // The inlined IsA(AProjectile) at 0x103d47b6 selects the MaxSpeed clamp.
  let isProjectile=false;
  for(let cls=runtime.instance(actor).cls;cls;cls=cls.base)if(cls.record.key==='engine.projectile'){isProjectile=true;break;}
  const regionZone=()=>{
    const zone=runtime.regionValue(actor).zone;
    if(!zone)throw new Error('physProjectile requires the actor Region.Zone (actor+0xc8)');
    return zone;
  };
  const host={zoneNumber:runtime.regionValue(actor).zoneNumber};
  for(const [key,name] of Object.entries({position:'Location',oldPosition:'OldLocation',velocity:'Velocity',
    acceleration:'Acceleration',physics:'Physics',justTeleported:'bJustTeleported',bBounce:'bBounce',bDeleteMe:'bDeleteMe'}))
    Object.defineProperty(host,key,{get:()=>get(name),set:value=>runtime.writeNamed(actor,name,value)});
  Object.defineProperty(host,'regionWater',{get:()=>Boolean(runtime.readNamed(regionZone(),'bWaterZone'))});
  Object.defineProperty(host,'fluidFriction',{get:()=>runtime.readNamed(regionZone(),'ZoneFluidFriction')});
  Object.defineProperty(host,'maxSpeed',{get:()=>isProjectile?get('MaxSpeed'):null});
  projectile(host,seconds,iterations,{
    destroy:()=>runtime.destroyActor(actor,false),
    move:delta=>{
      const result=playerMove(actor,delta,runtime.spawnedMoveServices(actor,level));
      return {time:Math.fround(result.time),normal:result.hit?.normal??[0,0,0],actor:world(result.hit?.actor??null)};
    },
    hitWall:(normal,wall)=>dispatch(actor,'HitWall',[normal,world(wall)]),
    physFalling:(remaining,iterations)=>runSpawnedActorFalling(runtime,actor,remaining,iterations),
  });
}

/** PHYS_Interpolating for a non-Pawn actor (helicopters on their flight
 * paths): AActor::physPathing (pathing.mjs) over the actor's fields, with
 * the generic MoveActor with its rotation (all flags clear; physPathing
 * ignores the result) and InterpolateEnd through the attached actors'
 * original bodies. performPhysics owns OldLocation and Velocity. */
export function runActorPathing(runtime,actor,seconds) {
  const level=runtime.collisionViewActors.has(actor)?runtime.levelFor(actor)
    :runtime.mapMoveLevel(actor,'physPathing');
  if(!level?.hash)throw new Error('physPathing requires the level collision hash');
  const isA=(target,key)=>{
    for(let cls=runtime.instance(target).cls;cls;cls=cls.base)if(cls.record.key===key)return true;
    return false;
  };
  physPathing(actor,seconds,{
    read:(target,name)=>runtime.readNamed(target,name),
    write:(target,name,value)=>runtime.writeNamed(target,name,value),
    isA,
    defaultFovAngle:target=>{
      const cls=runtime.instance(target).cls;
      return runtime.classDefaultReference(cls,runtime.lookupMember(cls,'fields','FovAngle')).get();
    },
    moveActor:(target,delta,rotation)=>{playerMove(target,delta,runtime.spawnedMoveServices(target,level),rotation);},
    interpolateEnd:(receiver,other)=>runtime.processEvent(receiver,'InterpolateEnd',[other]),
  });
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
