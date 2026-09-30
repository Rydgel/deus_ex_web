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

const union=(box,source,frame)=>{
  const p=frame*6;
  for(let axis=0;axis<3;axis++){
    box[axis]=Math.min(box[axis],source[p+axis]);box[3+axis]=Math.max(box[3+axis],source[p+3+axis]);
  }
};
/** Advance one channel's local box through a planned GetFrame operation:
 * a keyframe operation bounds the cache pose by its two frames (every
 * interpolated coordinate lies between them); a tween stays within the
 * previous box and the target frame. */
export function advanceChannelBox(box,op,boxes) {
  const source=op.blend?boxes.diffs:boxes.poses;
  const valid=frame=>Number.isInteger(frame)&&frame>=0&&frame<boxes.frames;
  if(!op.tween){
    if(!valid(op.first)||op.alpha>0&&!valid(op.second)){box.fill(NaN);return;}
    box[0]=box[1]=box[2]=Infinity;box[3]=box[4]=box[5]=-Infinity;
    union(box,source,op.first);
    if(op.alpha>0)union(box,source,op.second);
  } else if(op.alpha>0){
    if(!valid(op.second)){box.fill(NaN);return;}
    union(box,source,op.second);
  }
}

/** The view-space box ([y, z, -x] of the world box) containing every group
 * vertex GetFrame publishes for `plan`, given each channel's local box, with
 * a margin for the f32 stores of the publication. NaN when unknown. */
export function viewBox(plan,channelBoxes,out) {
  const m=plan.matrix,o=plan.origin;
  const min=[0,0,0],max=[0,0,0],magnitude=[0,0,0];
  for(const op of plan.channels){
    const box=channelBoxes[op.channel+1];
    for(let row=0;row<3;row++){
      const r=m[row+1];
      for(let j=0;j<3;j++){
        const lo=op.blend?box[j]:box[j]-o[j]-m[0][j],hi=op.blend?box[3+j]:box[3+j]-o[j]-m[0][j];
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
