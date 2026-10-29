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
import {identityOf} from './actor-touch.mjs';

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
 * looking for `other`. Pointers compare, so a pawn physics view stands for its
 * host (identityOf). */
export function isBasedOn(actor,other){
 other=identityOf(other);
 for(let base=identityOf(actor);base;base=base.base)if(base===other)return true;
 return false;
}

/** AActor::FindBase(0x103c9470): one downward extent trace 8.0 units below
 * Location, extent (CollisionRadius, CollisionRadius, CollisionHeight)
 * (the stack slots stored at 0x103c94a8-0x103c9511: X and Y from +0x1d4, Z
 * from +0x1d8; 2026-10-16, it was {R, H, R}), flags 0x17, through the XLevel vtable +0xc0
 * SingleLineCheck. When the hit actor differs from Base the result is
 * IsBasedOn-gated (a hit already standing on the source is skipped) before
 * SetSupportBase; a null hit still reaches SetSupportBase(null), which
 * clears the base through SetBase. */
export function findActorBase(actor,{lineCheck,dispatch}){
 const [x,y,z]=actor.position;
 const radius=f(actor.radius??0),height=f(actor.height??0);
 const hit=lineCheck([x,y,z].map(f),[x,y,f(z-8)].map(f),[radius,radius,height],0x17,0,actor);
 const target=hit?.actor??null;
 if(target===(actor.base??null))return;
 if(target&&isBasedOn(target,actor))return;
 setSupportBase(actor,target,dispatch);
}

// AActor +0x1ec (sdk-layouts.mjs AActor; actor-flag-words.mjs MOTION_WORD).
const MOTION_BOOLS=Object.freeze([['bSpecialLit',0x1],['bActorShadows',0x2],['bCorona',0x4],['bLensFlare',0x8],
 ['bBounce',0x10],['bFixedRotationDir',0x20],['bRotateToDesired',0x40],['bInterpolating',0x80],['bJustTeleported',0x100]]);

// The spawned actor's accessors are functions shared by every spawned actor: they find the actor's CollisionView through `this`
// (docs/live-heap.md, "Step 5's results"). A closure pair and its context for each of the twenty-odd members was most of what a
// spawned actor held.
const VIEW=Symbol('collisionView');

/** One spawned actor's access to its field storage: `get(name)` and `put(name, value)` read and write the field `name`.
 * `bind(actor, name)` (ScriptRuntime.boundField) resolves the same storage read/write reach once, on first access, so lookup
 * errors keep their timing. */
class CollisionView {
 constructor(actor,read,write,bind,motionWord){
  this.actor=actor;this.read=read;this.write=write;this.bind=bind;this.motionWord=motionWord;
  this.bound=bind===null?null:new Map();
 }
 access(name){
  let entry=this.bound.get(name);
  if(!entry)this.bound.set(name,entry=this.bind(this.actor,name));
  return entry;
 }
 get(name){return this.bound===null?this.read(this.actor,name):this.access(name).get();}
 put(name,value){
  if(this.bound===null)this.write(this.actor,name,value);else this.access(name).set(value);
 }
}

// accessor functions, made once for a field name or a touching slot
const fieldMembers=new Map();
const fieldMember=name=>{
 let member=fieldMembers.get(name);
 if(!member)fieldMembers.set(name,member=Object.freeze({
  get(){return this[VIEW].get(name);},
  set(value){this[VIEW].put(name,value);},
 }));
 return member;
};
const fieldGetter=name=>fieldMember(name).get;
const SLOTS=[0,1,2,3].map(index=>Object.freeze({
 get(){return this[VIEW].get('Touching')[index];},
 set(value){const view=this[VIEW],slots=view.get('Touching');slots[index]=value;view.put('Touching',slots);},
}));
const SHARED=Object.freeze({
 actorFlags:{get(){const view=this[VIEW];return (view.get('bStatic')?1:0)|(view.get('bDeleteMe')?0x80:0)|
  (view.get('bCollideWhenPlacing')?0x20000:0)|(view.get('bMovable')?0x80000:0);}},
 collisionBits:{get(){const view=this[VIEW];return (view.get('bCollideActors')?1:0)|(view.get('bBlockActors')?4:0)|
  (view.get('bBlockPlayers')?8:0)|(view.get('bProjTarget')?0x10:0);}},
 flags:{get(){return this.collisionBits|(this[VIEW].get('bCollideWorld')?2:0);},
  set(v){const view=this[VIEW];view.put('bCollideActors',Boolean(v&1));
   view.put('bBlockActors',Boolean(v&4));view.put('bBlockPlayers',Boolean(v&8));}},
 blocking:{get(){return this.blockPlayers;}},
 static:{get(){return Boolean(this.actorFlags&1);}},
 movable:{get(){return Boolean(this.actorFlags&0x80000);}},
 // The +0x1ec word of bSpecialLit..bJustTeleported that FarMoveActor sets bJustTeleported in and a spawned pawn's physics reads and
 // writes (script-pawn-physics.mjs): the image dword (actor-flag-words.mjs MOTION_WORD), or, for a class without linked offsets
 // (isolated harnesses), the same nine bools composed from their fields.
 imagedMotion:{get(){return this[VIEW].motionWord.get();},set(v){this[VIEW].motionWord.set(v>>>0);}},
 composedMotion:{get(){const view=this[VIEW];return MOTION_BOOLS.reduce((word,[name,mask])=>view.get(name)?word|mask:word,0);},
  set(v){const view=this[VIEW];for(const [name,mask] of MOTION_BOOLS)view.put(name,Boolean(v&mask));}},
});

/** Install the spawned actor's collision/native view on the constructed
 * script identity. Field-backed properties read and write the object's real
 * script storage through `read`/`write` (namedReference); host-only members
 * (lineage, worldActor, movingBrush, model) are plain properties matching the
 * map-actor surface consumed by collision-hash, encroachment-query and the
 * line filters. `values`/`collisionValues` expose only the enumerable fields
 * the original collision queries read. */
export function installActorCollisionView(actor,{read,write,bind=null,worldActor,lineage,motionWord=null}){
 const isPawn=lineage.includes('engine.pawn');
 const view=new CollisionView(actor,read,write,bind,motionWord);
 // Native AddTouch/EndTouch and script Touching address the same four
 // pointers (+0xe8..+0xf4), including during synchronous event dispatch.
 // Keep the array surface the collision bodies mutate, but put its entries
 // in the real field storage instead of a host-only list. Resolve storage
 // on every access so an arena growth or a script write stays visible.
 const touching=new Array(4);
 Object.defineProperty(touching,VIEW,{value:view});
 for(let index=0;index<4;index++)Object.defineProperty(touching,index,{enumerable:true,...SLOTS[index]});
 const values={};
 Object.defineProperty(values,VIEW,{value:view});
 for(const name of ['Tag','Location','Rotation','CollisionRadius','CollisionHeight','Physics'])
  Object.defineProperty(values,name,{enumerable:true,get:fieldGetter(name)});
 Object.defineProperty(actor,VIEW,{value:view});
 Object.defineProperties(actor,{
  lineage:{value:Object.freeze([...lineage])},
  worldActor:{value:worldActor},
  values:{value:values},collisionValues:{value:values},
  model:{value:null},movingBrush:{value:false},projectile:{value:lineage.includes('engine.projectile')},
  controlledPlayer:{value:false,writable:true},isPawn:{value:isPawn},
  // moveQuery's source-type gate marker: a spawned script-actor collision
  // view admitted to the recovered MoveActor translation. Pawn ancestry
  // selects its original MoveActor tail (skipping non-pawn encroachment).
  scriptView:{value:true},pawn:{value:isPawn},decoration:{value:false},
  standingCount:fieldMember('StandingCount'),
  touching:{value:touching},
  actorFlags:SHARED.actorFlags,
  collisionBits:SHARED.collisionBits,
  flags:SHARED.flags,
  // These four were given a function (the closure `bit(mask, name)` returned) where a descriptor belongs, which defines each as a
  // non-writable data member with the value undefined: as they are, so `blocking` (blockPlayers) reads undefined too.
  collideActors:{value:undefined},collideWorld:{value:undefined},
  blockActors:{value:undefined},blockPlayers:{value:undefined},
  blocking:SHARED.blocking,
  position:fieldMember('Location'),
  oldLocation:fieldMember('OldLocation'),
  rotation:fieldMember('Rotation'),
  motionFlags:motionWord?SHARED.imagedMotion:SHARED.composedMotion,
  radius:fieldMember('CollisionRadius'),
  height:fieldMember('CollisionHeight'),
  base:fieldMember('Base'),
  physics:fieldMember('Physics'),
  velocity:fieldMember('Velocity'),
  acceleration:fieldMember('Acceleration'),
  owner:{get:fieldGetter('Owner')},
  static:SHARED.static,
  movable:SHARED.movable,
 });
 // APawn::execAddPawn/RemovePawn and native list consumers use this same
 // +0x498 field. Map pawns already bind NextPawn onto their host property;
 // fresh pawns expose the reverse view over their newly allocated storage.
 if(isPawn)Object.defineProperty(actor,'nextPawn',{...fieldMember('NextPawn'),enumerable:true});
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
