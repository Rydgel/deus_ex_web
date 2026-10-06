/** ULodMesh::GetFrame 10355360..103568e5; docs/script-lodmesh-frame.md.
 *
 * GetFrame's only caller is DrawLodMesh (Render 0x10b0ee0f), inside the render
 * pass, so it and the Core FCoords operators it calls run under x87 precision
 * control 24 (docs/render-pass-precision.md): every add, subtract, multiply
 * and divide rounds to a 24-bit significand. Every operand is a float, an
 * int16 vertex word or a small integer, so each operation is a binary32 one
 * (`f(a op b)`: the double result rounds innocuously). Non-finite values
 * follow IEEE single rules rather than the x87's NaN payload choice (not
 * modelled; no shipped mesh or actor reaches one). */
import {findSequence,LodMeshError} from './lodmesh.mjs';
import {rotatorSin} from './coords.mjs';
const f=Math.fround;
const identity=()=>[[0,0,0],[1,0,0],[0,1,0],[0,0,1]];
/** Core's inline TransformPointBy (Origin subtracted) / TransformVectorBy:
 * `(d.x·A.x + d.y·A.y) + d.z·A.z` per axis, at 24 bits. */
function transform(v,coords,point) {
  const o=coords[0];
  const l0=point?f(f(v[0])-f(o[0])):f(v[0]),l1=point?f(f(v[1])-f(o[1])):f(v[1]),l2=point?f(f(v[2])-f(o[2])):f(v[2]);
  const out=[0,0,0];
  for(let k=0;k<3;k++){const r=coords[k+1];out[k]=f(f(f(l0*f(r[0]))+f(l1*f(r[1])))+f(l2*f(r[2])));}
  return out;
}
const compose=(coords,matrix)=>coords.map((v,i)=>transform(v,matrix,i===0));
function rotate(coords,rotation) {
  const [p,y,r]=rotation,s=rotatorSin,c=a=>s((a+0x4000)|0);
  for(const rows of [
    [[c(y),s(y),0],[-s(y),c(y),0],[0,0,1]],
    [[c(p),0,s(p)],[0,1,0],[-s(p),0,c(p)]],
    [[1,0,0],[0,c(r),-s(r)],[0,s(r),c(r)]],
  ])coords=compose(coords,[[0,0,0],...rows]);
  return coords;
}
const read=(services,actor,name)=>{
  const value=services.read(actor,name);
  if(value===undefined)throw new LodMeshError(`GetFrame requires original ${name}`);
  return value;
};
const index=(services,actor)=>{
  const value=services.objectIndex(actor);
  if(!Number.isInteger(value)||value<0||value>0x7fffffff)throw new LodMeshError('GetFrame requires the global UObject index');
  return value;
};
const named=name=>name!=null&&String(name).toLowerCase()!=='none';

/** Persistent cache service for the browser's admitted mesh poses. Native heap
 * pressure/eviction is not modeled; an owner can explicitly flush released keys.
 * `allocate` lets the native comparison retain unspecified allocation bytes. */
export function createLodMeshFrameCache({allocate=size=>new Uint8Array(size)}={}) {
  const entries=new Map();
  return {entries,
    get(key){const entry=entries.get(key);if(entry)entry.locks++;return entry??null;},
    create(key,size){
      if(entries.has(key))throw new LodMeshError('GetFrame cache key already exists');
      const bytes=allocate(size);
      if(bytes.byteLength!==size||bytes.byteOffset%4)throw new LodMeshError('Invalid GetFrame cache allocation');
      const entry={mesh:null,frame:0,sequence:'None',valid:0,completion:1,locks:1,
        vertices:new Float32Array(bytes.buffer,bytes.byteOffset+20,(size-20)/4)};
      entries.set(key,entry);return entry;
    },
    unlock(entry){if(entry.locks<=0)throw new LodMeshError('Unbalanced GetFrame cache unlock');entry.locks--;},
    flush(key){const entry=entries.get(key);if(entry?.locks)throw new LodMeshError('GetFrame cache item is locked');entries.delete(key);},
  };
}
function acquire(mesh,key,cache) {
  let entry=cache.get(key),existing=!!entry;
  if(entry&&entry.mesh!==mesh){cache.unlock(entry);cache.flush(key);entry=null;existing=false;}
  if(!entry){entry=cache.create(key,20+12*mesh.frameVertexCount);entry.mesh=mesh;}
  return {entry,existing};
}
// Native FISTP uses nearest-even on (phase - .5f). Phase is a float of at most
// 2^22 here, so the subtraction is exact at 24 bits (and in a double).
function frameInteger(phase) {
  const v=phase-0.5,lo=Math.floor(v),fraction=v-lo;
  const result=fraction<0.5?lo:fraction>0.5?lo+1:(lo%2===0?lo:lo+1);
  if(!Number.isFinite(result)||result<0||result>0x7fffffff)
    throw new LodMeshError('GetFrame animation phase exceeds the original valid vertex domain');
  return result;
}
// `(b - a)·t + a` per axis: X keeps its difference and product on the stack,
// Y/Z store them, which at 24 bits is the same rounding.
function interpolate(a,b,t) {
  const alpha=f(t);
  return a.map((value,i)=>{const base=f(value);return f(f(f(f(b[i])-base)*alpha)+base);});
}
const vectorAt=(array,index)=>Array.from(array.subarray(index*3,index*3+3));

/** GetFrame's coordinate setup (10355360.., the matrix the vertex loops
 * use): caller coords, then Location+PrePivot, the actor and mesh rotations,
 * the zero-shear pass and the mesh Scale times DrawScale. `value(name)`
 * reads the actor's Location, PrePivot and Rotation in the original order. */
export function lodMeshFrameMatrix(mesh,coords,scaleFactor,value) {
  let matrix=[0,1,2,3].map(i=>coords.slice(i*3,i*3+3).map(f));
  const scale=mesh.scale.map(v=>f(f(v)*f(scaleFactor)));
  if(scale.some(v=>v===0||!Number.isFinite(v)))throw new LodMeshError('GetFrame zero/nonfinite scale is unsupported');
  const location=value('Location'),prePivot=value('PrePivot');
  matrix[0]=matrix[0].map((v,i)=>f(f(v)-f(f(location[i])+f(prePivot[i]))));
  matrix=rotate(rotate(matrix,value('Rotation')),mesh.rotation);
  matrix=compose(matrix,identity()); // Core FScale's zero-shear pass.
  return matrix.map((v,row)=>v.map((x,i)=>row?f(f(x)*scale[i]):f(f(x)/scale[i])));
}

/** GetFrame's per-call setup shared by the full evaluation and the plan:
 * Load, the four-slot cache leases, the coordinate matrix and the vertex
 * operations. `decide` applies one channel's cache-scalar updates in the
 * original order and returns its vertex operation; `execute` runs that
 * operation's vertex loop (tween fill, interpolation into the cache pose
 * and, when `publish`, publication into the output). The split changes no
 * order of observable effects: the scalars never depend on vertex data. */
function frameContext(mesh,actor,coords,services,{vertexCount,stride,output}) {
  const vertices=mesh.arrays.get(0x60).load(); // Original virtual Load is first.
  const source=new DataView(vertices.data.buffer,vertices.data.byteOffset,vertices.data.byteLength);
  const cache=services.cache;
  if(!cache)throw new LodMeshError('GetFrame requires the persistent native cache service');
  if(!Number.isInteger(vertexCount)||vertexCount<0||stride<12||stride%4||output.byteLength<mesh.frameVertexCount*stride)
    throw new LodMeshError('Invalid GetFrame output/count/stride');
  const out=new DataView(output.buffer,output.byteOffset,output.byteLength),special=mesh.scalarBits.get(0x184)|0;
  const owner=read(services,actor,'bAnimByOwner')?read(services,actor,'Owner'):null;
  const animationActor=owner??actor;
  const mainKey=BigInt((((index(services,actor)<<8)>>>0)+0x1d)>>>0);
  const main=acquire(mesh,mainKey,cache);
  const scaleFactor=read(services,animationActor,'bParticles')?1:read(services,actor,'DrawScale');
  const matrix=lodMeshFrameMatrix(mesh,coords,scaleFactor,name=>read(services,actor,name));
  const kernel=services.kernel;
  const frameVertex=(frame,i)=>{
    const at=(frame*mesh.frameVertexCount+i)*8;
    if(at<0||at+6>source.byteLength)throw new LodMeshError('GetFrame accesses an unloaded/out-of-range vertex');
    return [0,1,2].map(axis=>source.getInt16(at+axis*2,true));
  };
  const context={mesh,source,cache,kernel,matrix,special,animationActor,main,output,stride,
    get vertexCount(){return vertexCount;}};
  context.decide=function decide(channel,lease) {
    const name=channel<0?read(services,animationActor,'AnimSequence'):read(services,animationActor,'BlendAnimSequence')[channel];
    const frame=f(channel<0?read(services,animationActor,'AnimFrame'):read(services,animationActor,'BlendAnimFrame')[channel]);
    const sequence=findSequence(mesh,name),{entry,existing}=lease;
    const available=Math.min((vertexCount+special)|0,mesh.frameVertexCount);
    let count=available;
    if(!(frame>=0)&&existing) {
      count=Math.min(count,entry.valid);entry.valid=count;vertexCount=count-special;
      const targetFrame=sequence?.startFrame??0;
      let alpha=f(1-f(frame/f(entry.frame)));
      if(entry.sequence!==name)entry.completion=0;
      if(entry.sequence!==name||!(alpha>=0)||alpha>1){
        entry.frame=sequence?f(-1/sequence.numFrames):0;entry.sequence=name;alpha=0;
      }
      // Compared on the stack before its store, which at 24 bits is the
      // same value: (1 - completion)·alpha + completion against .97f.
      const completion=f(f(f(1-f(entry.completion))*alpha)+f(entry.completion));
      entry.completion=completion;
      let fill=null;
      if(completion>f(0.97)) {
        alpha=0;
        if(count<available){
          fill=[count,available];
          count=available;vertexCount=count-special;entry.valid=count;
        }
      }
      // Only the tween path writes the cached frame, at its end (finish).
      const endFrame=f(channel<0?read(services,animationActor,'AnimFrame'):read(services,animationActor,'BlendAnimFrame')[channel]);
      return {channel,blend:channel>=0,tween:true,entry,count,fill,first:0,second:targetFrame,alpha,endFrame};
    }
    vertexCount=count-special;entry.valid=count;
    let first=0,second=0,fraction=0;
    if(sequence) {
      const phase=f((frame>=0?frame:0)*sequence.numFrames),integer=frameInteger(phase);
      fraction=f(phase-integer);
      first=sequence.startFrame+integer%sequence.numFrames;second=sequence.startFrame+((integer+1)|0)%sequence.numFrames;
    }
    return {channel,blend:channel>=0,tween:false,entry,count,fill:null,first,second,alpha:fraction};
  };
  /** The vertex loop of one decided operation. Without `publish` the output
   * is untouched (a scratch buffer receives the kernel's publication). */
  context.execute=function execute(op,publish=true) {
    const {entry,count,alpha,blend}=op;
    if(op.fill)for(let i=op.fill[0];i<op.fill[1];i++)entry.vertices.set(frameVertex(op.second,i),i*3);
    if(kernel) {
      const target=publish?output:scratchOutput(count*stride);
      kernel.run({source,frameVertexCount:mesh.frameVertexCount,output:target,stride,matrix,origin:mesh.origin,
        count,entry,...(op.tween?{second:op.second,alpha,tween:true}:{first:op.first,second:op.second,alpha}),blend});
      return;
    }
    if(op.tween)for(let i=0;i<count;i++) {
      if(alpha>0)entry.vertices.set(interpolate(vectorAt(entry.vertices,i),frameVertex(op.second,i),alpha),i*3);
      if(publish)publishVertex(i,vectorAt(entry.vertices,i),blend);
    }
    else for(let i=0;i<count;i++) {
      const pose=alpha>0?interpolate(frameVertex(op.first,i),frameVertex(op.second,i),alpha):frameVertex(op.first,i);
      entry.vertices.set(pose,i*3);if(publish)publishVertex(i,pose,blend);
    }
  };
  /** Apply a cache entry's planned operations that were not executed on the
   * CPU (planLodMeshFrame), in order, to its cache pose only. */
  context.replay=function replay(entry,keep=0) {
    const log=entry.log;
    if(!log?.length)return;
    const pending=log.splice(0,log.length-keep);
    for(const op of pending)context.execute(op,false);
  };
  /** Planned operations must stay inside the loaded vertex records exactly
   * as the loops would require, so the plan throws where they would. */
  context.check=function check(op) {
    if(op.count<=0)return;
    const frames=op.tween?[op.second]:[op.first,...(op.alpha>0?[op.second]:[])];
    if(op.blend)frames.push(0);
    for(const frame of frames)frameVertex(frame,op.count-1);
    if(op.fill)frameVertex(op.second,op.fill[1]-1);
  };
  // The vertex less the mesh Origin (or a blend's absolute frame zero),
  // stored; less the matrix origin for the main pose; the three axis dots;
  // a blend adds onto the output. Each operation at 24 bits.
  function publishVertex(i,pose,blend) {
    const origin=blend?frameVertex(0,i):mesh.origin;
    const vector=pose.map((v,j)=>{
      const component=f(f(v)-f(origin[j]));
      return blend?component:f(component-matrix[0][j]);
    });
    for(let j=0;j<3;j++){
      const row=matrix[j+1],result=f(f(f(vector[0]*row[0])+f(vector[1]*row[1]))+f(vector[2]*row[2]));
      const at=i*stride+j*4;
      out.setFloat32(at,blend?f(result+out.getFloat32(at,true)):result,true);
    }
  }
  context.blendLease=slot=>{
    if(!named(read(services,animationActor,'BlendAnimSequence')[slot]))return null;
    const key=(BigInt(index(services,animationActor))<<32n)+BigInt((slot+1)*0x10000+0x1d);
    return acquire(mesh,key,cache);
  };
  return context;
}
let scratch=new Uint8Array(0);
const scratchOutput=size=>scratch.byteLength>=size?scratch.subarray(0,size):(scratch=new Uint8Array(size));
const frameDefaults=(mesh,{vertexCount=mesh.frameVertexCount-(mesh.scalarBits.get(0x184)|0),
  stride=12,output=new Uint8Array(mesh.frameVertexCount*stride)}={})=>({vertexCount,stride,output});

/** Evaluate the original vertex pose into the caller's strided buffer.
 * Count excludes mesh special vertices; the output includes them. `coords`
 * contains original FCoords origin/X/Y/Z vectors, flattened (12 f32 values).
 * Actor state is read-only; cache/header state and vertexCount are outputs. */
export function getLodMeshFrame(mesh,actor,coords,services,options={}) {
  const context=frameContext(mesh,actor,coords,services,frameDefaults(mesh,options));
  const evaluate=lease=>{
    const op=context.decide(lease.channel,lease);
    // A cache pose planned for the GPU is brought up to date first.
    context.replay(op.entry);
    context.execute(op);
    if(op.tween)op.entry.frame=op.endFrame;
    context.cache.unlock(op.entry);
  };
  evaluate({...context.main,channel:-1});
  for(let slot=0;slot<4;slot++) {
    const lease=context.blendLease(slot);
    if(lease)evaluate({...lease,channel:slot});
  }
  return {output:context.output,vertexCount:context.vertexCount};
}

/** GetFrame without its vertex loops, for the GPU path (docs/gpu-mesh.md):
 * the same Load, leases, matrix and cache-scalar updates in the same order,
 * returning each channel's vertex operation. Each operation is also logged on
 * its cache entry (a keyframe operation replaces the log) so the CPU cache
 * pose can be replayed exactly on demand. */
export function planLodMeshFrame(mesh,actor,coords,services,options={}) {
  const context=frameContext(mesh,actor,coords,services,frameDefaults(mesh,options));
  const channels=[];
  const plan=lease=>{
    const op=context.decide(lease.channel,lease);
    context.check(op);
    if(op.tween)op.entry.frame=op.endFrame;
    const log=op.entry.log??=[];
    if(!op.tween)log.length=0;
    log.push(op);channels.push(op);
    context.cache.unlock(op.entry);
  };
  plan({...context.main,channel:-1});
  for(let slot=0;slot<4;slot++) {
    const lease=context.blendLease(slot);
    if(lease)plan({...lease,channel:slot});
  }
  return {matrix:context.matrix,origin:mesh.origin,channels,vertexCount:context.vertexCount,
    special:context.special,context};
}

/** The exact CPU output of a plan's frame: replays each channel's earlier
 * logged operations into its cache pose, then executes the planned one with
 * publication, in channel order, into `plan.context.output`. This is the
 * output getLodMeshFrame would have produced for the same frame. */
export function materializeLodMeshFrame(plan) {
  const {context,channels}=plan;
  for(const op of channels) {
    if(op.entry.log?.at(-1)!==op)throw new LodMeshError('GetFrame plan is no longer current for its cache entry');
    context.replay(op.entry,1);
    op.entry.log.length=0;
    context.execute(op);
  }
  return context.output;
}
