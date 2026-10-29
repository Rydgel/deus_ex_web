const f=Math.fround;
const bits=new DataView(new ArrayBuffer(4));
function side(value) {
  bits.setFloat32(0,value,true);
  return Number(bits.getInt32(0,true)>=0);
}
// The two endpoints as float32 components (FastLineCheck's `vector`): first at 0..2, second at 3..5. A scratch, not an array each.
const ends=new Float64Array(6);
function endpoint(value,at) {
  if(!Array.isArray(value)||value.length!==3||!Number.isFinite(value[0])||!Number.isFinite(value[1])||!Number.isFinite(value[2]))
    throw new Error('FastLineCheck requires a finite vector');
  const x=f(value[0]),y=f(value[1]),z=f(value[2]);
  if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z))throw new Error('FastLineCheck vector exceeds float32');
  ends[at]=x;ends[at+1]=y;ends[at+2]=z;
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
  if(live){
    useBlock(live);
    endpoint(first,0);endpoint(second,3);
    return traverse(live.count,live.rootOutside);
  }
  if(!Array.isArray(model?.nodes)||model.rootOutside===undefined)
    throw new Error('FastLineCheck requires the original compiled BSP');
  endpoint(first,0);endpoint(second,3);
  srcNodes=model.nodes;
  return traverse(model.nodes.length,model.rootOutside);
}

// Where traverse reads its nodes from, set by the caller (traverse does not nest): the model's node objects, or a block in memory in
// the original 64-byte FBspNode layout (the tracker's, as it holds it now): FPlane at +0, iBack +0x20, iFront +0x24, NodeFlags +0x37.
// The block's typed views are kept for the memory buffer they were made over (a node in the block was an object with a plane array
// for every node a line crossed).
let srcNodes=null,srcCount=0,srcAt=0,viewBuffer=null,viewFloats=null,viewWords=null,viewBytes=null;
function useBlock({memory,at,count}) {
  srcNodes=null;srcCount=count;srcAt=at;
  if(viewBuffer!==memory.buffer){
    viewBuffer=memory.buffer;viewFloats=new Float32Array(viewBuffer);viewWords=new Int32Array(viewBuffer);viewBytes=new Uint8Array(viewBuffer);
  }
}

// The pending far sides of the line's splits: index, first point, second point and outside flag in eight doubles a frame.
let frames=new Float64Array(8*64);

function traverse(count,rootOutside) {
  const nodes=srcNodes;
  if(!count)return Boolean(rootOutside);
  let a0=ends[0],a1=ends[1],a2=ends[2],b0=ends[3],b1=ends[4],b2=ends[5];
  let sp=0,index=0,outside=Number(Boolean(rootOutside)),visits=0;
  const limit=count*8+8;
  for(;;){
    while(index!==-1){
      if(++visits>limit)throw new Error('Invalid cyclic FastLineCheck BSP');
      let p0,p1,p2,p3,back,front,flags;
      if(nodes!==null){
        const node=nodes[index];
        if(!node)throw new Error('Invalid FastLineCheck node index');
        const plane=node.plane;
        p0=plane[0];p1=plane[1];p2=plane[2];p3=plane[3];back=node.back;front=node.front;flags=node.flags;
      }else{
        if(!(index>=0&&index<srcCount))throw new Error('Invalid FastLineCheck node index');
        const o=(srcAt>>>2)+16*index;
        p0=viewFloats[o];p1=viewFloats[o+1];p2=viewFloats[o+2];p3=viewFloats[o+3];back=viewWords[o+8];front=viewWords[o+9];flags=viewBytes[srcAt+64*index+55];
      }
      const endDistance=f((b2*p2+b1*p1)+b0*p0-p3),startDistance=f((a2*p2+a1*p1)+a0*p0-p3);
      if(!Number.isFinite(endDistance)||!Number.isFinite(startDistance))
        throw new Error('Nonfinite FastLineCheck plane distance is unsupported');
      const endSide=side(endDistance),startSide=side(startDistance),keep=flags&1;
      if(endSide===startSide){
        outside=endSide^((endSide^outside)&keep);index=endSide?front:back;
      }else{
        const fraction=endDistance/(endDistance-startDistance);
        const m0=f((a0-b0)*fraction+b0),m1=f((a1-b1)*fraction+b1),m2=f((a2-b2)*fraction+b2);
        if((sp+1)*8>frames.length){const grown=new Float64Array(frames.length*2);grown.set(frames);frames=grown;}
        const at=sp*8;
        frames[at]=endSide?front:back;frames[at+1]=m0;frames[at+2]=m1;frames[at+3]=m2;frames[at+4]=b0;frames[at+5]=b1;frames[at+6]=b2;
        frames[at+7]=endSide^((endSide^outside)&keep);sp++;
        outside=startSide^((startSide^outside)&keep);index=startSide?front:back;
        b0=a0;b1=a1;b2=a2;a0=m0;a1=m1;a2=m2;
      }
    }
    if(!outside)return false;
    if(sp===0)return true;
    sp--;
    const at=sp*8;
    index=frames[at];a0=frames[at+1];a1=frames[at+2];a2=frames[at+3];b0=frames[at+4];b1=frames[at+5];b2=frames[at+6];outside=frames[at+7];
  }
}
