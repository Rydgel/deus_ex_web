import {rotatorSin} from './coords.mjs';
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
   return {key:object.key,outerName:objectAt(object.asset.pkg,object.entry.outer)?.name??object.asset.name,friction:f(friction)};
  })());
  return cache.get(surface.texture);
 }));
}

/** Ordinary original103cc450 surface prelude: native scanner103ccc40 followed by
 * floor texture query103ccb70 and empty/inherited WalkTexture callback.
 * Explicitly unsupported Ladder and texture friction<1 fail before guessed motion.
 */
export function walkingSurfacePrelude(pawn){
 const position=pawn.position.map(f),radius=f(pawn.radius),height=f(pawn.height),yaw=pawn.rotation[1]|0;
 const start=[position[0],position[1],f(position[2]-f(height*f(.95)))];
 const query=(a,b)=>pawn.lineCheck(a,b,[0,0,0],6,0);
 let selected=null;
 scan:for(const offset of [0,-16384,16384,32768]){
  const angle=(yaw+offset)|0;
  const end=[f(start[0]+f(2*radius*rotatorSin((angle+16384)|0))),f(start[1]+f(2*radius*rotatorSin(angle))),start[2]];
  for(let z=0;z<=32;z+=4){
   const hit=query(start,[end[0],end[1],f(end[2]+z)]);selected=pawn.textureForHit(hit);
   if(selected&&(selected.outerName===null||selected.outerName==='Ladder'))break scan;
  }
 }
 if(selected?.outerName?.toLowerCase()==='ladder')throw Error(`Unsupported original Ladder surface: ${selected.key}`);
 const hit=query(position,[position[0],position[1],f(position[2]-f(height+2*radius))]);
 const texture=pawn.textureForHit(hit);
 pawn.walkTexture(texture,hit.location,hit.normal);
 if(pawn.physics===1&&texture&&texture.friction<1)throw Error(`Unsupported original texture sliding: ${texture.key}`);
 return false;
}
