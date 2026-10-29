import {brushCollisionBounds,primitiveCollisionBounds} from './brush-bounds.mjs';
import {modelPointCheck} from './point-check.mjs';
import {primitivePointCheck} from './primitive-collision.mjs';
import {brushToWorld} from './coords.mjs';
const f=Math.fround;
const valuesOf=actor=>actor.collisionValues??actor.values;

/** Original10358d50 posed-primitive versus candidate-cylinder query.
 * Keeps existing registration unchanged and returns original APPENDED order. */
export function actorEncroachmentCheck(hash,actor,position,rotation,extra=0){
 if(!actor)throw Error('Original ActorEncroachmentCheck requires an actor');
 // The posed copy of the actor's values: only the fields the bounds and the point checks below read (brushToWorld, the bounds
 // kernel and primitiveCollisionBounds). A spread of the whole `values` read every field of the facade (Tag, Location, Rotation,
 // Physics, ...) just to replace two of them, a few KB for each query.
 const own=valuesOf(actor);
 const posed={Location:position.map(f),Rotation:rotation.map(v=>v|0),CollisionRadius:own.CollisionRadius,CollisionHeight:own.CollisionHeight,
  PrePivot:own.PrePivot,PostScale:own.PostScale,MainScale:own.MainScale};
 const bounds=actor.model?brushCollisionBounds(actor.model,posed):primitiveCollisionBounds(null,posed);
 return hash.actorEncroachmentCheck({bounds},candidate=>{
  const values=valuesOf(candidate),isBrush=candidate.lineage?.includes('engine.brush')??false;
  const isStatic=candidate.actorFlags===undefined?Boolean(values.bStatic):Boolean(candidate.actorFlags&1);
  if(candidate.model&&isBrush&&!isStatic)return null;
  if(candidate===actor)return null;
  const extent=[f(values.CollisionRadius??0),f(values.CollisionRadius??0),f(values.CollisionHeight??0)];
  const hit=actor.model?modelPointCheck(actor.model,values.Location,extent,brushToWorld(posed)):
   primitivePointCheck({location:posed.Location,radius:posed.CollisionRadius??0,height:posed.CollisionHeight??0},values.Location,extent);
  return hit.outside?null:{...hit,actor:candidate,primitive:null,item:hit.item??-1};
 });
}
