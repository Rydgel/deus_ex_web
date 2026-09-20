/**
 * Recovered AActor collision/base natives for spawned script actors.
 *
 * Every routine below is the installed Engine.dll body translated against
 * this host's actor view: `flags` is the native +0x1dc collision bitfield,
 * `position`/`radius`/`height`/`base`/`physics`/`velocity`/`acceleration`
 * are the script-visible fields, and `level.hash` supplies the original
 * RemoveActor/AddActor slots (XLevel+0xf8 vtable +0xc/+0x8). The actor is
 * expected to be the spawn host's collision view, which reads and writes the
 * real field storage rather than a mirrored copy.
 *
 * Evidence: Engine.dll image base 0x10300000 —
 *   AActor::SetCollision      0x10369200 (thunk 0x10301a5f)
 *   execSetCollision          0x103e1900 (native index 262)
 *   AActor::SetCollisionSize  0x10369320 (thunk 0x10303d64, native 283)
 *   AActor::SetPhysics        0x103c95f0 (native index 3970)
 *   AActor::FindBase          0x103c9470 (thunk 0x10301749)
 *   AActor::IsBasedOn         0x1034c8d0 (thunk 0x103020db)
 *   AActor::SetSupportBase    thunk 0x1030146f (body 0x103c9390)
 *   AActor::SetBase           thunk 0x10301285 (body 0x10369c80)
 * See docs/script-datavault-image.md.
 */
import {setBase,setSupportBase} from './walking-callbacks.mjs';

const f=Math.fround;

/** execSetCollision argument resolution (0x103e1900). The original fills
 * each skipped optional parameter from the actor's CURRENT +0x1dc bits
 * (collide=bit0, blockActors=bit2, blockPlayers=bit3) — not false. */
export function setCollisionArguments(actor,argumentCount,evaluateArgument){
 const flags=actor.flags??0;
 return [
  argumentCount>0?Boolean(evaluateArgument(0)):Boolean(flags&1),
  argumentCount>1?Boolean(evaluateArgument(1)):Boolean(flags&4),
  argumentCount>2?Boolean(evaluateArgument(2)):Boolean(flags&8),
 ];
}

/** AActor::SetCollision(0x10369200). When the actor previously collided and
 * the level has a hash it is removed first; the flag word keeps bit 1
 * (bCollideWorld) and all upper bits while bits 0/2/3 are replaced; the actor
 * is re-added when the new collide bit is set. */
export function setActorCollision(actor,collideActors,blockActors,blockPlayers,{level}){
 const hash=level?.hash;
 if((actor.flags??0)&1&&hash)hash.removeActor(actor);
 actor.flags=(((actor.flags??0)&~0xd)|
  (collideActors?1:0)|(blockActors?4:0)|(blockPlayers?8:0))>>>0;
 if(actor.flags&1&&hash)hash.addActor(actor);
}

/** AActor::SetCollisionSize(0x10369320). Negative sizes are legal here; the
 * hash registration is removed before the writes and re-added after, keyed
 * on the collide bit both times. */
export function setActorCollisionSize(actor,radius,height,{level}){
 const hash=level?.hash;
 if((actor.flags??0)&1&&hash)hash.removeActor(actor);
 actor.radius=f(radius);actor.height=f(height);
 if((actor.flags??0)&1&&hash)hash.addActor(actor);
 return true;
}

/** AActor::IsBasedOn(0x1034c8d0): walks `actor`'s own +0xc4 (Base) chain
 * looking for `other`. */
export function isBasedOn(actor,other){
 for(let base=actor;base;base=base.base)if(base===other)return true;
 return false;
}

/** AActor::FindBase(0x103c9470): one downward extent trace 8.0 units below
 * Location, extent pushed as {CollisionRadius, CollisionHeight,
 * CollisionRadius}, flags 0x17, through the XLevel vtable +0xc0
 * SingleLineCheck. When the hit actor differs from Base the result is
 * IsBasedOn-gated (a hit already standing on the source is skipped) before
 * SetSupportBase; a null hit still reaches SetSupportBase(null), which
 * clears the base through SetBase. */
export function findActorBase(actor,{lineCheck,dispatch}){
 const [x,y,z]=actor.position;
 const radius=f(actor.radius??0),height=f(actor.height??0);
 const hit=lineCheck([x,y,z].map(f),[x,y,f(z-8)].map(f),[radius,height,radius],0x17,0,actor);
 const target=hit?.actor??null;
 if(target===(actor.base??null))return;
 if(target&&isBasedOn(target,actor))return;
 setSupportBase(actor,target,dispatch);
}

/** Install the spawned actor's collision/native view on the constructed
 * script identity. Field-backed properties read and write the object's real
 * script storage through `read`/`write` (namedReference); host-only members
 * (lineage, worldActor, movingBrush, model) are plain properties matching the
 * map-actor surface consumed by collision-hash, encroachment-query and the
 * line filters. `values`/`collisionValues` expose only the enumerable fields
 * the original collision queries read. */
export function installActorCollisionView(actor,{read,write,worldActor,lineage}){
 const field=name=>()=>read(actor,name);
 const fieldWrite=name=>value=>write(actor,name,value);
 const bit=(mask,name)=>()=>Boolean(read(actor,name)?mask:0);
 const values={};
 for(const name of ['Tag','Location','Rotation','CollisionRadius','CollisionHeight','Physics'])
  Object.defineProperty(values,name,{enumerable:true,get:field(name)});
 Object.defineProperties(actor,{
  lineage:{value:Object.freeze([...lineage])},
  worldActor:{value:worldActor},
  values:{value:values},collisionValues:{value:values},
  model:{value:null},movingBrush:{value:false},projectile:{value:false},
  controlledPlayer:{value:false},isPawn:{value:false},
  // moveQuery's source-type gate marker: a spawned script-actor collision
  // view admitted to the recovered MoveActor translation. `pawn`/`decoration`
  // stay false — the non-pawn MoveActor tail (CheckEncroachment at
  // 0x10399bf5) is the original branch these actors take.
  scriptView:{value:true},pawn:{value:false},decoration:{value:false},
  standingCount:{get:field('StandingCount'),set:fieldWrite('StandingCount')},
  touching:{value:[null,null,null,null]},
  actorFlags:{get:()=>(read(actor,'bStatic')?1:0)|(read(actor,'bDeleteMe')?0x80:0)|
   (read(actor,'bCollideWhenPlacing')?0x20000:0)|(read(actor,'bMovable')?0x80000:0)},
  collisionBits:{get:()=>(read(actor,'bCollideActors')?1:0)|(read(actor,'bBlockActors')?4:0)|
   (read(actor,'bBlockPlayers')?8:0)|(read(actor,'bProjTarget')?0x10:0)},
  flags:{get(){return this.collisionBits|(read(actor,'bCollideWorld')?2:0);},
   set(v){write(actor,'bCollideActors',Boolean(v&1));
    write(actor,'bBlockActors',Boolean(v&4));write(actor,'bBlockPlayers',Boolean(v&8));}},
  collideActors:bit(1,'bCollideActors'),collideWorld:bit(1,'bCollideWorld'),
  blockActors:bit(1,'bBlockActors'),blockPlayers:bit(1,'bBlockPlayers'),
  blocking:{get(){return this.blockPlayers;}},
  position:{get:field('Location'),set:fieldWrite('Location')},
  oldLocation:{get:field('OldLocation'),set:fieldWrite('OldLocation')},
  rotation:{get:field('Rotation'),set:fieldWrite('Rotation')},
  // motionFlags carries the native +0x?? motion byte; the only bit this host
  // tracks is bJustTeleported (0x100, Actor.uc:416) written by FarMoveActor.
  motionFlags:{get:()=>read(actor,'bJustTeleported')?0x100:0,
   set:v=>write(actor,'bJustTeleported',Boolean(v&0x100))},
  radius:{get:field('CollisionRadius'),set:fieldWrite('CollisionRadius')},
  height:{get:field('CollisionHeight'),set:fieldWrite('CollisionHeight')},
  base:{get:field('Base'),set:fieldWrite('Base')},
  physics:{get:field('Physics'),set:fieldWrite('Physics')},
  velocity:{get:field('Velocity'),set:fieldWrite('Velocity')},
  acceleration:{get:field('Acceleration'),set:fieldWrite('Acceleration')},
  owner:{get:field('Owner')},
  static:{get(){return Boolean(this.actorFlags&1);}},
  movable:{get(){return Boolean(this.actorFlags&0x80000);}},
 });
 return actor;
}

/** AActor::SetPhysics(0x103c95f0). Same-physics early out; then for
 * {None,Walking,Rotating,Rolling,Spider}={0,1,5,7,0xa} (EPhysics,
 * Actor.uc:102-116) the byte is
 * written and either SetSupportBase (explicit new base different from Base)
 * or FindBase runs; other modes clear an existing Base via SetBase(null,1).
 * Velocity(+0x144) and Acceleration(+0x150) are zeroed only when the
 * re-read physics is 0 or 5 — callbacks may have changed it. */
export function setActorPhysics(actor,newPhysics,newBase,{dispatch,findBase}){
 newPhysics=Number(newPhysics)&0xff;
 if(newPhysics===((actor.physics??0)&0xff))return;
 actor.physics=newPhysics;
 if([0,1,5,7,0xa].includes(newPhysics)){
  if(newBase){if(newBase!==actor.base)setSupportBase(actor,newBase,dispatch);}
  else findBase(actor);
 }else if(actor.base)setBase(actor,null,dispatch,true);
 if(actor.physics===0||actor.physics===5){
  actor.velocity=[0,0,0];actor.acceleration=[0,0,0];
 }
}
