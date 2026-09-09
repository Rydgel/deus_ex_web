import {modelPointCheck} from './point-check.mjs';
import {primitivePointCheck} from './primitive-collision.mjs';
import {brushToWorld} from './coords.mjs';
const f=Math.fround;

/** Original level point list/join/closest recovery. Hash must be the same live
 * registration instance as line queries. See docs/level-points.md. */
export function createLevelPoints(model,hash,levelInfo){
 const actorPoint=(actor,{position,extent})=>{
  const values=actor.collisionValues??actor.values;
  const hit=actor.model?modelPointCheck(actor.model,position,extent,brushToWorld(values)):
   primitivePointCheck({location:values.Location,radius:values.CollisionRadius??0,height:values.CollisionHeight??0},position,extent);
  return hit.outside?null:{...hit,actor,primitive:actor.model??null,item:hit.item??-1};
 };
 const multiPointCheck=(position,extent,flags=0,worldActor=levelInfo,checkActors=1)=>{
  position=position.map(f);extent=extent.map(f);
  const hits=checkActors&&hash?hash.actorPointCheck({position,extent},actorPoint):[];
  if(worldActor){const hit=modelPointCheck(model,position,extent);if(!hit.outside)hits.unshift({...hit,actor:worldActor,primitive:model});}
  return hits;
 };
 const singlePointCheck=(position,extent,flags=0,worldActor=levelInfo,checkActors=1)=>{
  position=position.map(f);const hits=multiPointCheck(position,extent,flags,worldActor,checkActors);
  let hit=hits[0]??null;
  for(const candidate of hits.slice(1)){
   const a=candidate.location.map((v,i)=>v-position[i]),b=hit.location.map((v,i)=>v-position[i]);b[2]=f(b[2]);
   if(b[2]*b[2]+b[1]*b[1]+b[0]*b[0]>a[2]*a[2]+a[1]*a[1]+a[0]*a[0])hit=candidate;
  }
  return {outside:!hit,hit};
 };
 return {multiPointCheck,singlePointCheck};
}
