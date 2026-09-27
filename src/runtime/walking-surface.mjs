import {rotatorSin} from './coords.mjs';
import {getAxes} from './camera.mjs';
import {x87cmp,x87load} from './script-vm.mjs';
import {readObject,objectAt} from '../unreal/objects.mjs';
import {ClassDefaults} from '../unreal/classes.mjs';
const f=Math.fround;

/** Decode original serialized texture overrides plus original class defaults.
 * Result is indexed by BSP surface; actor/mesh hit selection belongs to caller. */
export async function walkingSurfaceTextures(assets,asset,model){
 const defaults=new ClassDefaults(assets),cache=new Map();
 return Promise.all(model.surfaces.map(async surface=>{
  if(!surface.texture)return null;
  if(!cache.has(surface.texture))cache.set(surface.texture,(async()=>{
   const object=await assets.resolve(asset,surface.texture),stored=readObject(object.asset.pkg,object.asset.bytes,object.index);
   const inherited=await defaults.get(object.asset,object.entry.classIndex);
   const friction=stored.values.Friction??inherited.Friction;
   if(!Number.isFinite(friction))throw Error(`Unresolved original Texture.Friction: ${object.key}`);
   return {key:object.key,name:object.entry.name,outerName:objectAt(object.asset.pkg,object.entry.outer)?.name??object.asset.name,friction:f(friction)};
  })());
  return cache.get(surface.texture);
 }));
}

// `fcomp 0.0; test ah,0x40`: equal (or unordered) reads as a zero component.
const zeroComponent=c=>{const r=x87cmp(x87load(f(c)),x87load(0));return r==='eq'||r==='un';};

/** Original ladder branch 0x103cc519-0x103cc6ca (docs/ladder-flying.md): with
 * any nonzero Acceleration component, ViewRotation.Pitch moves 6144 away from
 * zero, bIsWalking is set and Velocity.Z becomes GroundSpeed * XAxis.Z * 0.5
 * of (GMath.UnitCoords / that rotation); physFlying then runs with the caller's
 * arguments, and zero Acceleration leaves zero Velocity. Returns handled. */
function climbLadder(pawn,dt,iterations){
 const still=()=>pawn.acceleration.every(zeroComponent);
 if(!still()){
  const [pitch,yaw,roll]=pawn.viewRotation;
  const xAxis=getAxes([(pitch>=0?pitch+0x1800:pitch-0x1800)|0,yaw|0,roll|0])[0];
  pawn.isWalking=true;
  const velocity=pawn.velocity.map(f);velocity[2]=f(f(pawn.groundSpeed)*xAxis[2]*.5);pawn.velocity=velocity;
 }
 pawn.flying(dt,iterations);
 if(still())pawn.velocity=[0,0,0];
 return true;
}

/** Original103cc450 surface prelude: native scanner103ccc40, then either the
 * Ladder branch (WalkTexture with the scan hit, climbLadder) or the floor
 * texture query103ccb70 and its WalkTexture callback. Texture friction<1
 * fails explicitly before guessed motion.
 */
export function walkingSurfacePrelude(pawn,dt,iterations=0){
 const position=pawn.position.map(f),radius=f(pawn.radius),height=f(pawn.height),yaw=pawn.rotation[1]|0;
 const start=[position[0],position[1],f(position[2]-f(height*f(.95)))];
 const query=(a,b)=>pawn.lineCheck(a,b,[0,0,0],6,0);
 let selected=null,selectedHit=null;
 scan:for(const offset of [0,-16384,16384,32768]){
  const angle=(yaw+offset)|0;
  const end=[f(start[0]+f(2*radius*rotatorSin((angle+16384)|0))),f(start[1]+f(2*radius*rotatorSin(angle))),start[2]];
  for(let z=0;z<=32;z+=4){
   const hit=query(start,[end[0],end[1],f(end[2]+z)]);selected=pawn.textureForHit(hit);selectedHit=hit;
   if(selected&&(selected.outerName===null||selected.outerName==='Ladder'))break scan;
  }
 }
 if(selected?.outerName?.toLowerCase()==='ladder'){
  // A pawn without the physFlying service stops at the branch entry 0x103cc519.
  if(typeof pawn.flying!=='function')throw Error(`Unsupported original Ladder surface without physFlying: ${selected.key}`);
  pawn.walkTexture(selected,selectedHit.location,selectedHit.normal);
  return climbLadder(pawn,dt,iterations);
 }
 const hit=query(position,[position[0],position[1],f(position[2]-f(height+2*radius))]);
 const texture=pawn.textureForHit(hit);
 pawn.walkTexture(texture,hit.location,hit.normal);
 if(pawn.physics===1&&texture&&texture.friction<1)throw Error(`Unsupported original texture sliding: ${texture.key}`);
 return false;
}
