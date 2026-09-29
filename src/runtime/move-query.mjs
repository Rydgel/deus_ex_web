import {identityOf} from './actor-touch.mjs';
const f=Math.fround;
const flags=actor=>actor.flags??0;
// AActor::IsBasedOn (0x1034c8d0) walks +0xc4 Base pointers from the actor
// itself: a pawn physics view compares as its host (identityOf).
function basedOn(actor,source){
  const seen=new Set();source=identityOf(source);
  for(let current=identityOf(actor);current;current=current.base){
    if(current===source)return true;
    if(seen.has(current))throw new Error('Cyclic actor Base chain');
    seen.add(current);
  }
  return false;
}

/** Original controlled-player MoveActor translation/query prefix.
 * Actor traits: flags (native collision bit mask), controlledPlayer, projectile,
 * movingBrush (nonnull Brush and IsA(Brush)), base. The source must be a
 * controlled player cylinder. multiLineCheck returns original ordered hits.
 * success is the original accepted-scene return, not an override for a scene
 * rejection. Scene mutation/events and nondefault move flags are not implemented here.
 * Evidence and original comparisons: docs/move-query.md.
 */
export function moveQuery({source,worldActor,start,delta,extent,multiLineCheck,ignorePawns=false,ignoreBases=false}){
  // MoveActor's query/selection/math is source-type independent: it keys on each
  // candidate's type and the source's block flags, never on whether the source is
  // a player. A decoration cylinder (e.g. a pushed Plant2 under physFalling)
  // therefore uses the same path, and so does a script-attached pawn cylinder.
  // Proven by native-move-query-oracle.py with sourceControlledPlayer:false
  // (docs/move-query.md, docs/script-plant-contact.md).
  // `mapActor` marks a non-pawn serialized actor admitted by
  // ScriptRuntime.mapMoveLevel (docs/script-map-actor-move.md).
  if((!source?.controlledPlayer && !source?.decoration && !source?.pawn && !source?.scriptView && !source?.mapActor) || source.movingBrush)throw new Error('Move query requires a controlled-player, pawn, decoration, map or spawned-script-actor cylinder');
  start=start.map(f);delta=delta.map(f);extent=extent.map(f);
  if([...start,...delta,...extent].some(v=>!Number.isFinite(v)))throw new Error('Nonfinite movement query unsupported');
  // Original non-editor immovable/static rejection precedes the tiny gate.
  if(source.static||source.movable===false)return {success:false,delta:[0,0,0],position:start,time:1,hit:null};
  if(delta.every(v=>Math.abs(v)<.0001))return {success:true,delta:[0,0,0],position:start,time:1,hit:null};
  const length=Math.sqrt(delta[2]*delta[2]+delta[1]*delta[1]+delta[0]*delta[0]),size=f(length),reciprocal=f(1/length);
  const direction=delta.map(v=>f(v*reciprocal)),extended=delta.map((v,i)=>f(v+2*direction[i]));
  let hit=null,time=1,displacement=delta;
  const sourceFlags=flags(source);
  if(sourceFlags&3){
    const hits=multiLineCheck({end:start.map((v,i)=>f(v+extended[i])),start:start.slice(),extent:extent.slice(),
      checkActors:!!(sourceFlags&1),worldActor:sourceFlags&2?worldActor:null,extra:0});
    if(sourceFlags&14)for(const candidate of hits){
      const other=candidate.actor;
      // ULevel::MoveActor bIgnorePawns (Engine.dll 0x103995ea): a non-static
      // candidate (+0x28 & 1 == 0) whose class ancestry reaches APawn
      // (0x1058c660) or ADecoration (0x10578d48) is skipped before the
      // based-on and block tests.
      if(ignorePawns&&other&&!(other.actorFlags&1)&&
        (other.lineage?.includes('engine.pawn')||other.lineage?.includes('engine.decoration')))continue;
      // ULevel::MoveActor bIgnoreBases (Engine.dll 0x10399651): when set, the
      // mover skips candidates that are its own bases — Source->IsBasedOn(hit).
      // This is what lets a colliding attached item ride its base through the
      // recursive rider MoveActor without being blocked by it.
      if(ignoreBases&&basedOn(source,other))continue;
      if(basedOn(other,source))continue;
      let blocks;
      if(other===worldActor)blocks=!!(sourceFlags&2);
      else if(other.movingBrush)blocks=!!(sourceFlags&2)&&!!(flags(other)&8);
      else blocks=!!(flags(other)&8)&&!!(sourceFlags&((other.controlledPlayer||other.projectile)?8:4));
      if(blocks){hit={...candidate,location:candidate.location?.slice(),normal:candidate.normal?.slice()};break;}
    }
  }
  if(hit){
    time=f(hit.time);
    if(time<1){
      const distance=(size+2)*time,storedDistance=f(distance);
      if(distance<=2){displacement=[0,0,0];time=0;}
      else {
        displacement=extended.map((v,i)=>f(f(v*time)-f(direction[i]*2)));
        time=f((storedDistance-2)/size);
      }
    }
    hit.time=time;
  }
  return {success:time>0,delta:displacement,position:start.map((v,i)=>f(v+displacement[i])),time,hit};
}
