/** Conservative draw-group bounds for the GPU mesh path (docs/gpu-mesh.md,
 * "Visibility and render feedback"). Without the posed positions the CPU
 * cannot build three.js's exact group sphere; these boxes certify the cases
 * where the exact sphere's frustum test has only one possible result, and
 * report the rest as ambiguous so the caller computes the exact sphere. */

const boxCache=new WeakMap();
/** Diagnostic counts of certified and ambiguous group decisions. */
export const certificateStats=globalThis.__gpuMeshCertificateStats??={certified:0,ambiguous:0};

/** Per keyframe, the i16 box of `vertices` (unique mesh vertex indices of a
 * draw group) and the box of their differences from frame 0, which is what a
 * blend slot publishes. Int32 [minX,minY,minZ,maxX,maxY,maxZ] per frame. */
export function keyframeBoxes(payload,vertices) {
  let byMesh=boxCache.get(payload);
  if(!byMesh)boxCache.set(payload,byMesh=new Map());
  const signature=vertices.join(',');
  let entry=byMesh.get(signature);
  if(entry)return entry;
  const data=payload.arrays.get(0x60).load().data,V=payload.frameVertexCount;
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const frames=Math.floor(data.byteLength/(8*V));
  const poses=new Int32Array(frames*6),diffs=new Int32Array(frames*6);
  for(let frame=0;frame<frames;frame++){
    const p=frame*6;
    poses.fill(0x7fffffff,p,p+3);poses.fill(-0x80000000,p+3,p+6);
    diffs.fill(0x7fffffff,p,p+3);diffs.fill(-0x80000000,p+3,p+6);
    for(const v of vertices){
      const at=(frame*V+v)*8,base=v*8;
      for(let axis=0;axis<3;axis++){
        const value=view.getInt16(at+axis*2,true),diff=value-view.getInt16(base+axis*2,true);
        if(value<poses[p+axis])poses[p+axis]=value;if(value>poses[p+3+axis])poses[p+3+axis]=value;
        if(diff<diffs[p+axis])diffs[p+axis]=diff;if(diff>diffs[p+3+axis])diffs[p+3+axis]=diff;
      }
    }
  }
  byMesh.set(signature,entry={poses,diffs,frames});
  return entry;
}

/** A group's boxes in one Float64Array: the local boxes of the channels -1 to 3 (six numbers each, [minX, minY, minZ, maxX, maxY,
 * maxZ], NaN while unknown) and then the view box (`viewBox`'s output, which the group also holds as a view of its own). A group
 * used to hold six arrays of its own for these (docs/live-heap.md "Step 4's results"). `channelAt` is a channel's offset. */
export const CHANNEL_BOXES=5,BOX_WORDS=6,VIEW_BOX_AT=CHANNEL_BOXES*BOX_WORDS;
export const newGroupBoxes=()=>new Float64Array((CHANNEL_BOXES+1)*BOX_WORDS).fill(NaN);
export function channelAt(channel) {
  const at=(channel+1)*BOX_WORDS;
  if(!(at>=0&&at<VIEW_BOX_AT))throw new RangeError(`GPU mesh: channel ${channel} has no box`);
  return at;
}

const union=(boxes,at,source,frame)=>{
  const p=frame*6;
  for(let axis=0;axis<3;axis++){
    boxes[at+axis]=Math.min(boxes[at+axis],source[p+axis]);boxes[at+3+axis]=Math.max(boxes[at+3+axis],source[p+3+axis]);
  }
};
/** Advance one channel's local box (in `group.channelBoxes`) through a planned GetFrame operation, with the group's keyframe boxes
 * (`group.boxes`, keyframeBoxes):
 * a keyframe operation bounds the cache pose by its two frames (every
 * interpolated coordinate lies between them); a tween stays within the
 * previous box and the target frame. */
export function advanceChannelBox(group,op) {
  const boxes=group.channelBoxes,keyframes=group.boxes,at=channelAt(op.channel);
  const source=op.blend?keyframes.diffs:keyframes.poses;
  const valid=frame=>Number.isInteger(frame)&&frame>=0&&frame<keyframes.frames;
  if(!op.tween){
    if(!valid(op.first)||op.alpha>0&&!valid(op.second)){boxes.fill(NaN,at,at+BOX_WORDS);return;}
    boxes[at]=boxes[at+1]=boxes[at+2]=Infinity;boxes[at+3]=boxes[at+4]=boxes[at+5]=-Infinity;
    union(boxes,at,source,op.first);
    if(op.alpha>0)union(boxes,at,source,op.second);
  } else if(op.alpha>0){
    if(!valid(op.second)){boxes.fill(NaN,at,at+BOX_WORDS);return;}
    union(boxes,at,source,op.second);
  }
}

/** The view-space box ([y, z, -x] of the world box) containing every group
 * vertex GetFrame publishes for `plan`, given each channel's local box, with
 * a margin for the f32 stores of the publication. NaN when unknown. */
export function viewBox(plan,group) {
  const m=plan.matrix,o=plan.origin,boxes=group.channelBoxes,out=group.viewBox;
  const min=[0,0,0],max=[0,0,0],magnitude=[0,0,0];
  for(const op of plan.channels){
    const at=channelAt(op.channel);
    for(let row=0;row<3;row++){
      const r=m[row+1];
      for(let j=0;j<3;j++){
        const lo=op.blend?boxes[at+j]:boxes[at+j]-o[j]-m[0][j],hi=op.blend?boxes[at+3+j]:boxes[at+3+j]-o[j]-m[0][j];
        const a=r[j]*lo,b=r[j]*hi;
        min[row]+=Math.min(a,b);max[row]+=Math.max(a,b);magnitude[row]+=Math.max(Math.abs(a),Math.abs(b));
      }
    }
  }
  const margin=magnitude.map(value=>value*2**-18+1e-5);
  // Viewer reflection [x, y, z] -> [y, z, -x].
  out[0]=min[1]-margin[1];out[1]=min[2]-margin[2];out[2]=-max[0]-margin[0];
  out[3]=max[1]+margin[1];out[4]=max[2]+margin[2];out[5]=-min[0]+margin[0];
  return out;
}

/** 1 when every sphere centred in `box` passes three.js's frustum test, 0
 * when every such sphere of radius at most the half-diagonal fails it, -1
 * when the exact sphere is needed. */
export function certifyFrustum(frustum,box) {
  if(box.some(Number.isNaN)){certificateStats.ambiguous++;return -1;}
  const hx=(box[3]-box[0])/2,hy=(box[4]-box[1])/2,hz=(box[5]-box[2])/2;
  const cx=box[0]+hx,cy=box[1]+hy,cz=box[2]+hz,half=Math.hypot(hx,hy,hz);
  let inside=true;
  for(const plane of frustum.planes){
    const n=plane.normal,center=n.x*cx+n.y*cy+n.z*cz+plane.constant;
    const extent=Math.abs(n.x)*hx+Math.abs(n.y)*hy+Math.abs(n.z)*hz;
    const epsilon=1e-6*(Math.abs(plane.constant)+Math.abs(center)+extent+1);
    if(center+extent+half<-epsilon){certificateStats.certified++;return 0;}
    if(center-extent<epsilon)inside=false;
  }
  if(inside){certificateStats.certified++;return 1;}
  certificateStats.ambiguous++;return -1;
}
