// The installActorCollisionView of 3502f642, verbatim (closures per member), for the differential test of the shared-accessor version
// (test/collision-view.test.mjs, docs/live-heap.md "Step 5's results").
// AActor +0x1ec (sdk-layouts.mjs AActor; actor-flag-words.mjs MOTION_WORD).
const MOTION_BOOLS=Object.freeze([['bSpecialLit',0x1],['bActorShadows',0x2],['bCorona',0x4],['bLensFlare',0x8],
 ['bBounce',0x10],['bFixedRotationDir',0x20],['bRotateToDesired',0x40],['bInterpolating',0x80],['bJustTeleported',0x100]]);

/** Install the spawned actor's collision/native view on the constructed
 * script identity. Field-backed properties read and write the object's real
 * script storage through `read`/`write` (namedReference); host-only members
 * (lineage, worldActor, movingBrush, model) are plain properties matching the
 * map-actor surface consumed by collision-hash, encroachment-query and the
 * line filters. `values`/`collisionValues` expose only the enumerable fields
 * the original collision queries read. */
export function referenceInstallActorCollisionView(actor,{read,write,bind=null,worldActor,lineage,motionWord=null}){
 const isPawn=lineage.includes('engine.pawn');
 // `bind(actor,name)` (ScriptRuntime.boundField) resolves the same storage
 // read/write reach once, on first access, so lookup errors keep their timing.
 const bound=new Map(),access=name=>{
  let entry=bound.get(name);
  if(!entry)bound.set(name,entry=bind(actor,name));
  return entry;
 };
 const field=bind?name=>{let entry=null;return ()=>(entry??=access(name)).get();}:name=>()=>read(actor,name);
 const fieldWrite=bind?name=>{let entry=null;return value=>(entry??=access(name)).set(value);}:name=>value=>write(actor,name,value);
 const get=bind?name=>access(name).get():name=>read(actor,name);
 const put=bind?(name,value)=>access(name).set(value):(name,value)=>write(actor,name,value);
 // Native AddTouch/EndTouch and script Touching address the same four
 // pointers (+0xe8..+0xf4), including during synchronous event dispatch.
 // Keep the array surface the collision bodies mutate, but put its entries
 // in the real field storage instead of a host-only list. Resolve storage
 // on every access so an arena growth or a script write stays visible.
 const touching=new Array(4);
 for(let index=0;index<4;index++)Object.defineProperty(touching,index,{enumerable:true,
  get:()=>get('Touching')[index],
  set:value=>{const slots=get('Touching');slots[index]=value;put('Touching',slots);}});
 const bit=(mask,name)=>()=>Boolean(get(name)?mask:0);
 const values={};
 for(const name of ['Tag','Location','Rotation','CollisionRadius','CollisionHeight','Physics'])
  Object.defineProperty(values,name,{enumerable:true,get:field(name)});
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
  standingCount:{get:field('StandingCount'),set:fieldWrite('StandingCount')},
  touching:{value:touching},
  actorFlags:{get:()=>(get('bStatic')?1:0)|(get('bDeleteMe')?0x80:0)|
   (get('bCollideWhenPlacing')?0x20000:0)|(get('bMovable')?0x80000:0)},
  collisionBits:{get:()=>(get('bCollideActors')?1:0)|(get('bBlockActors')?4:0)|
   (get('bBlockPlayers')?8:0)|(get('bProjTarget')?0x10:0)},
  flags:{get(){return this.collisionBits|(get('bCollideWorld')?2:0);},
   set(v){put('bCollideActors',Boolean(v&1));
    put('bBlockActors',Boolean(v&4));put('bBlockPlayers',Boolean(v&8));}},
  collideActors:bit(1,'bCollideActors'),collideWorld:bit(1,'bCollideWorld'),
  blockActors:bit(1,'bBlockActors'),blockPlayers:bit(1,'bBlockPlayers'),
  blocking:{get(){return this.blockPlayers;}},
  position:{get:field('Location'),set:fieldWrite('Location')},
  oldLocation:{get:field('OldLocation'),set:fieldWrite('OldLocation')},
  rotation:{get:field('Rotation'),set:fieldWrite('Rotation')},
  // The +0x1ec word of bSpecialLit..bJustTeleported that FarMoveActor sets
  // bJustTeleported in and a spawned pawn's physics reads and writes
  // (script-pawn-physics.mjs): the image dword (actor-flag-words.mjs
  // MOTION_WORD), or, for a class without linked offsets (isolated
  // harnesses), the same nine bools composed from their fields.
  motionFlags:motionWord?{get:()=>motionWord.get(),set:v=>motionWord.set(v>>>0)}
   :{get:()=>MOTION_BOOLS.reduce((word,[name,mask])=>get(name)?word|mask:word,0),
    set:v=>{for(const [name,mask] of MOTION_BOOLS)put(name,Boolean(v&mask));}},
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
 // APawn::execAddPawn/RemovePawn and native list consumers use this same
 // +0x498 field. Map pawns already bind NextPawn onto their host property;
 // fresh pawns expose the reverse view over their newly allocated storage.
 if(isPawn)Object.defineProperty(actor,'nextPawn',{
  get:field('NextPawn'),set:fieldWrite('NextPawn'),enumerable:true,
 });
 return actor;
}

