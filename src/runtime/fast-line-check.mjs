const f=Math.fround;
const bits=new DataView(new ArrayBuffer(4));
const distance=(point,plane)=>f((point[2]*plane[2]+point[1]*plane[1])+point[0]*plane[0]-plane[3]);
function side(value) {
  bits.setFloat32(0,value,true);
  return Number(bits.getInt32(0,true)>=0);
}
function vector(value) {
  if(!Array.isArray(value)||value.length!==3||!value.every(Number.isFinite))
    throw new Error('FastLineCheck requires a finite vector');
  const result=value.map(f);
  if(!result.every(Number.isFinite))throw new Error('FastLineCheck vector exceeds float32');
  return result;
}

/** UModel.FastLineCheck 103f3280 -> 103f33a0, not the general LineCheck ray.
 * Original reference cases, branches and precision scope: docs/fast-line-check.md.
 *
 * The level's Model is the one Engine's moving brush tracker extends in place
 * (docs/brush-tracker.md): while a tracker lives, XLevel->Model holds every
 * mover's fragment nodes where the tracker last left them, and the original's
 * FastLineCheck callers (CheckHearSound, MakeNoise, FastTrace, the pawn
 * natives, Galaxy's Update) traverse those too. A model the host tracks
 * carries `trackedLineNodes()` (sim-host.mjs): null without a live tracker,
 * else the node block as the tracker holds it now ({memory, at, count,
 * rootOutside}, the original 64-byte FBspNode layout,
 * bsp-occlusion.mjs lineNodes), read in place.
 */
export function fastLineCheck(model,first,second) {
  const live=model?.trackedLineNodes?.();
  if(live)return traverse(live.count,live.rootOutside,blockNodes(live),vector(first),vector(second));
  if(!Array.isArray(model?.nodes)||model.rootOutside===undefined)
    throw new Error('FastLineCheck requires the original compiled BSP');
  return traverse(model.nodes.length,model.rootOutside,index=>model.nodes[index],vector(first),vector(second));
}

/** The plane, children and NodeFlags of node `i` of a block in memory:
 * FPlane at +0, iBack +0x20, iFront +0x24, NodeFlags +0x37. */
function blockNodes({memory,at,count}) {
  const fl=new Float32Array(memory.buffer),words=new Int32Array(memory.buffer),bytes=new Uint8Array(memory.buffer);
  return index=>{
    if(!(index>=0&&index<count))return undefined;
    const o=(at>>>2)+16*index;
    return {plane:[fl[o],fl[o+1],fl[o+2],fl[o+3]],back:words[o+8],front:words[o+9],flags:bytes[at+64*index+55]};
  };
}

function traverse(count,rootOutside,nodeAt,first,second) {
  if(!count)return Boolean(rootOutside);
  const stack=[{index:0,first,second,outside:Number(Boolean(rootOutside))}];
  let visits=0;
  while(stack.length){
    let {index,first:a,second:b,outside}=stack.pop();
    while(index!==-1){
      if(++visits>count*8+8)throw new Error('Invalid cyclic FastLineCheck BSP');
      const node=nodeAt(index);
      if(!node)throw new Error('Invalid FastLineCheck node index');
      const endDistance=distance(b,node.plane),startDistance=distance(a,node.plane);
      if(!Number.isFinite(endDistance)||!Number.isFinite(startDistance))
        throw new Error('Nonfinite FastLineCheck plane distance is unsupported');
      const endSide=side(endDistance),startSide=side(startDistance);
      const nextOutside=s=>s^((s^outside)&(node.flags&1));
      if(endSide===startSide){
        outside=nextOutside(endSide);index=endSide?node.front:node.back;
      }else{
        const fraction=endDistance/(endDistance-startDistance);
        const middle=a.map((value,axis)=>f((value-b[axis])*fraction+b[axis]));
        stack.push({index:endSide?node.front:node.back,first:middle,second:b,outside:nextOutside(endSide)});
        outside=nextOutside(startSide);index=startSide?node.front:node.back;
        b=a;a=middle;
      }
    }
    if(!outside)return false;
  }
  return true;
}
