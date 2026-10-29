import {rotatorSin} from './coords.mjs';
import {getAxes} from './camera.mjs';
import {x87cmp,x87load} from './script-vm.mjs';
import {readObject,objectAt} from '../unreal/objects.mjs';
import {ClassDefaults} from '../unreal/classes.mjs';
import {HASH_DIFFERENTIAL,lineResultDifference} from './collision-kernel.mjs';
import {TRACE_DIFFERENTIAL} from './trace-kernel.mjs';
import {o3} from './o3-record.mjs';
const f=Math.fround;
const CHECK_SCAN=HASH_DIFFERENTIAL||TRACE_DIFFERENTIAL;

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

/** The scanner's segments: the pawn's stored position, the scan start, the
 * four scan ends' X/Y and the floor end. */
const SCAN_OFFSETS=[0,-16384,16384,32768];
const newScanInputs=()=>({position:[0,0,0],start:[0,0,0],ends:[[0,0],[0,0],[0,0],[0,0]],floorEnd:[0,0,0]});
// The scan's inputs written into `into` (indexed, without the map and its callback: this runs for every walking pawn at every tick).
function fillScanInputs(pawn,into){
 const source=pawn.position,position=into.position,start=into.start,ends=into.ends,floorEnd=into.floorEnd;
 position[0]=f(source[0]);position[1]=f(source[1]);position[2]=f(source[2]);
 const radius=f(pawn.radius),height=f(pawn.height),yaw=pawn.rotation[1]|0;
 start[0]=position[0];start[1]=position[1];start[2]=f(position[2]-f(height*f(.95)));
 for(let k=0;k<4;k++){
  const angle=(yaw+SCAN_OFFSETS[k])|0,end=ends[k];
  end[0]=f(start[0]+f(2*radius*rotatorSin((angle+16384)|0)));end[1]=f(start[1]+f(2*radius*rotatorSin(angle)));
 }
 floorEnd[0]=position[0];floorEnd[1]=position[1];floorEnd[2]=f(position[2]-f(height+2*radius));
 return into;
}
export function surfaceScanInputs(pawn){return fillScanInputs(pawn,newScanInputs());}
// The prelude of a pawn whose scan runs in the kernel keeps its inputs here: the kernel reads the numbers and nothing keeps the arrays
// (a prelude that runs the JavaScript scan, whose hits can be made of them, takes arrays of its own).
const scanScratch=newScanInputs();

/** The scanner's queries in JavaScript: the last scan hit and its texture,
 * the index of the last scan query run, and the floor hit (null where the
 * ladder branch takes over). */
export function scanSurface(pawn,start,ends,position,floorEnd){
 const query=(a,b)=>pawn.lineCheck(a,b,[0,0,0],6,0);
 let selected=null,selectedHit=null,index=0;
 scan:for(let d=0;d<4;d++){
  const end=[ends[d][0],ends[d][1],start[2]];
  for(let z=0;z<=32;z+=4){
   const hit=query(start,[end[0],end[1],f(end[2]+z)]);selected=pawn.textureForHit(hit);selectedHit=hit;index=d*9+z/4;
   if(selected&&(selected.outerName===null||selected.outerName==='Ladder'))break scan;
  }
 }
 let ladder;
 try{ladder=selected?.outerName?.toLowerCase()==='ladder';}catch{ladder=true;}
 return {selected,selectedHit,index,floor:ladder?null:query(position,floorEnd)};
}

/** Original103cc450 surface prelude: native scanner103ccc40, then either the
 * Ladder branch (WalkTexture with the scan hit, climbLadder) or the floor
 * texture query103ccb70 and its WalkTexture callback. Texture friction<1
 * fails explicitly before guessed motion.
 *
 * A pawn offering `surfaceScan` (script-pawn-physics.mjs) runs the scan and
 * the floor query in one Rust call (collision-kernel.mjs, docs/rust-core.md
 * R3-b), with the same reads. HASH_DIFFERENTIAL/TRACE_DIFFERENTIAL compare
 * it with the JavaScript scan.
 */
export function walkingSurfacePrelude(pawn,dt,iterations=0){
 const {position,start,ends,floorEnd}=!o3.on&&typeof pawn.surfaceScan==='function'?fillScanInputs(pawn,scanScratch):surfaceScanInputs(pawn);
 const query=(a,b)=>pawn.lineCheck(a,b,[0,0,0],6,0);
 let selected=null,selectedHit=null,floor=null;
 // O3 recording (o3-record.mjs) takes the JavaScript scan, whose queries are the service calls the recording replays.
 const scan=o3.on?null:pawn.surfaceScan?.(start,ends,position,floorEnd);
 if(scan){
  selectedHit=scan.selected;selected=pawn.textureForHit(selectedHit);floor=scan.floor;
  if(CHECK_SCAN)checkScan(scan,selected,scanSurface(pawn,start,ends,position,floorEnd));
 } else {
  // The JavaScript scan, with the floor query where the original has it.
  scan:for(let d=0;d<4;d++){
   const end=[ends[d][0],ends[d][1],start[2]];
   for(let z=0;z<=32;z+=4){
    const hit=query(start,[end[0],end[1],f(end[2]+z)]);selected=pawn.textureForHit(hit);selectedHit=hit;
    if(selected&&(selected.outerName===null||selected.outerName==='Ladder'))break scan;
   }
  }
 }
 if(selected?.outerName?.toLowerCase()==='ladder'){
  // A pawn without the physFlying service stops at the branch entry 0x103cc519.
  if(typeof pawn.flying!=='function')throw Error(`Unsupported original Ladder surface without physFlying: ${selected.key}`);
  pawn.walkTexture(selected,selectedHit.location,selectedHit.normal);
  return climbLadder(pawn,dt,iterations);
 }
 const hit=floor??query(position,floorEnd);
 const texture=pawn.textureForHit(hit);
 pawn.walkTexture(texture,hit.location,hit.normal);
 if(pawn.physics===1&&texture&&texture.friction<1)throw Error(`Unsupported original texture sliding: ${texture.key}`);
 return false;
}

// The kernel scan against the JavaScript one: the same last scan query,
// texture and the fields read from both hits.
function checkScan(scan,selected,expected){
 const fields=hit=>({actor:hit.actor,item:hit.item,location:hit.location,normal:hit.normal});
 const difference=scan.index!==expected.index?`index ${scan.index} ${expected.index}`:selected!==expected.selected?'texture'
  :(scan.floor===null)!==(expected.floor===null)?'floor queried'
  :lineResultDifference(fields(scan.selected),fields(expected.selectedHit))??(scan.floor&&lineResultDifference(fields(scan.floor),fields(expected.floor)));
 if(difference)throw Error(`walking-surface kernel differential mismatch: ${difference}`);
}
