/** ULodMesh::GetFrame 10355360..103568e5; docs/script-lodmesh-frame.md. */
import {findSequence,LodMeshError} from './lodmesh.mjs';
import {rotatorSin} from './coords.mjs';
import {x87load,x87store,x87add,x87neg,x87mul,x87div} from './script-vm.mjs';
import {unambiguousF32,ulps53,exactSum} from './x87-fast.mjs';
const ld=x87load,st=x87store,f=Math.fround,sub=(a,b)=>x87add(a,x87neg(b));
const identity=()=>[[0,0,0],[1,0,0],[0,1,0],[0,0,1]];
const dot=(v,row)=>st(x87add(x87add(x87mul(v[0],ld(row[0])),x87mul(v[1],ld(row[1]))),x87mul(v[2],ld(row[2]))));
const transformExtended=(v,coords,point)=>{
  const local=v.map((x,i)=>point?sub(ld(x),ld(coords[0][i])):ld(x));
  return coords.slice(1).map(row=>dot(local,row));
};
// Fast exact form of transformExtended (x87-fast.mjs): the same f32 loads,
// evaluated in doubles. A store whose double evaluation is exact (TwoSum; the
// f32 products are always exact) is that value; otherwise the rounding must
// be certain within a bound covering the double and 64-bit x87 evaluations
// (32 units of 2^-53 per term magnitude). Any other element takes the x87 model.
const REFERENCE_FRAME=typeof process!=='undefined'&&process.env?.LODMESH_FRAME_REFERENCE==='1';
const BOUND=ulps53(32);
function transform(v,coords,point) {
  if(REFERENCE_FRAME)return transformExtended(v,coords,point);
  const x0=f(v[0]),x1=f(v[1]),x2=f(v[2]);
  let l0=x0,l1=x1,l2=x2,e0=0,e1=0,e2=0,f32Local=true;
  if(point){
    const o=coords[0],o0=f(o[0]),o1=f(o[1]),o2=f(o[2]);
    l0=x0-o0;l1=x1-o1;l2=x2-o2;f32Local=false;
    e0=(Math.abs(x0)+Math.abs(o0))*BOUND;e1=(Math.abs(x1)+Math.abs(o1))*BOUND;e2=(Math.abs(x2)+Math.abs(o2))*BOUND;
  }
  const out=[0,0,0];
  for(let k=0;k<3;k++){
    const row=coords[k+1],r0=f(row[0]),r1=f(row[1]),r2=f(row[2]);
    const p0=l0*r0,p1=l1*r1,p2=l2*r2,s1=p0+p1,s=s1+p2;
    let stored;
    if(f32Local&&exactSum(p0,p1,s1)&&exactSum(s1,p2,s))stored=f(s);
    else stored=unambiguousF32(s,(Math.abs(p0)+Math.abs(p1)+Math.abs(p2))*BOUND
      +e0*Math.abs(r0)+e1*Math.abs(r1)+e2*Math.abs(r2));
    if(stored===undefined)return transformExtended(v,coords,point);
    out[k]=stored;
  }
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
// Native FISTP uses nearest-even on the extended (phase - .5) value. Phase is
// f32, so this subtraction is exact in a JS double throughout the valid range.
function frameInteger(phase) {
  const v=phase-0.5,lo=Math.floor(v),fraction=v-lo;
  const result=fraction<0.5?lo:fraction>0.5?lo+1:(lo%2===0?lo:lo+1);
  if(!Number.isFinite(result)||result<0||result>0x7fffffff)
    throw new LodMeshError('GetFrame animation phase exceeds the original valid vertex domain');
  return result;
}
// X keeps subtraction/product extended; Y/Z store both before the final add.
function interpolate(a,b,t) {
  const alpha=ld(t);
  return a.map((value,i)=>{
    const base=ld(value);
    let delta=sub(ld(b[i]),base);if(i)delta=ld(st(delta));
    let product=x87mul(delta,alpha);if(i)product=ld(st(product));
    return st(x87add(product,base));
  });
}
const vectorAt=(array,index)=>Array.from(array.subarray(index*3,index*3+3));
const above=(a,b)=>{const d=sub(a,ld(b));return d.nan===undefined&&!d.neg&&(d.inf||d.sig!==0n);};

/** GetFrame's coordinate setup (10355360.., the matrix the vertex loops
 * use): caller coords, then Location+PrePivot, the actor and mesh rotations,
 * the zero-shear pass and the mesh Scale times DrawScale. `value(name)`
 * reads the actor's Location, PrePivot and Rotation in the original order. */
export function lodMeshFrameMatrix(mesh,coords,scaleFactor,value) {
  let matrix=[0,1,2,3].map(i=>coords.slice(i*3,i*3+3).map(f));
  // An f32 product is exact in x87 and in a double; its store is one rounding.
  const scale=REFERENCE_FRAME?mesh.scale.map(v=>st(x87mul(ld(v),ld(scaleFactor))))
    :mesh.scale.map(v=>f(f(v)*f(scaleFactor)));
  if(scale.some(v=>v===0||!Number.isFinite(v)))throw new LodMeshError('GetFrame zero/nonfinite scale is unsupported');
  const location=value('Location'),prePivot=value('PrePivot');
  matrix[0]=matrix[0].map((v,i)=>{
    const extended=()=>st(sub(ld(v),x87add(ld(location[i]),ld(prePivot[i]))));
    if(REFERENCE_FRAME)return extended();
    const a=f(location[i]),b=f(prePivot[i]),x=f(v),t=a+b,d=x-t;
    if(exactSum(a,b,t)&&exactSum(x,-t,d))return f(d);
    return unambiguousF32(d,(Math.abs(x)+Math.abs(a)+Math.abs(b))*BOUND)??extended();
  });
  matrix=rotate(rotate(matrix,value('Rotation')),mesh.rotation);
  matrix=compose(matrix,identity()); // Core FScale's zero-shear pass.
  matrix=matrix.map((v,row)=>v.map((x,i)=>{
    const extended=()=>st(row?x87mul(ld(x),ld(scale[i])):x87div(ld(x),ld(scale[i])));
    if(REFERENCE_FRAME)return extended();
    if(row){
      // An exact f32 product; a non-finite one keeps the x87 NaN/inf model.
      const product=f(x)*f(scale[i]);
      return Number.isFinite(product)?f(product):extended();
    }
    // The x87 quotient is the exact quotient rounded to 64 bits; the double
    // one is within 2^-53 of it: accept only a certain f32 rounding.
    const q=f(x)/f(scale[i]);
    return unambiguousF32(q,Math.abs(q)*ulps53(4))??extended();
  }));
  return matrix;
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
  // These operands stay constant for every vertex and blend slot in this
  // call. Reuse their exact x87 loads; retain every original store/order.
  const kernel=services.kernel;
  const loadedMatrix=kernel?null:matrix.map(row=>row.map(ld)),loadedOrigin=kernel?null:mesh.origin.map(ld);
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
      let alpha=st(sub(ld(1),x87div(ld(frame),ld(entry.frame))));
      if(entry.sequence!==name)entry.completion=0;
      if(entry.sequence!==name||!(alpha>=0)||alpha>1){
        entry.frame=sequence?st(x87div(ld(-1),ld(sequence.numFrames))):0;entry.sequence=name;alpha=0;
      }
      const completion=x87add(x87mul(sub(ld(1),ld(entry.completion)),ld(alpha)),ld(entry.completion));
      entry.completion=st(completion);
      let fill=null;
      if(above(completion,f(0.97))) {
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
      const phase=st(x87mul(ld(frame>=0?frame:0),ld(sequence.numFrames))),integer=frameInteger(phase);
      fraction=st(sub(ld(phase),ld(integer)));
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
  function publishVertex(i,pose,blend) {
    const origin=blend?frameVertex(0,i).map(ld):loadedOrigin;
    const vector=pose.map((v,j)=>{
      const component=ld(st(sub(ld(v),origin[j])));
      return blend?component:sub(component,loadedMatrix[0][j]);
    });
    const result=loadedMatrix.slice(1).map(row=>st(x87add(
      x87add(x87mul(vector[0],row[0]),x87mul(vector[1],row[1])),x87mul(vector[2],row[2]))));
    for(let j=0;j<3;j++){
      const at=i*stride+j*4;
      out.setFloat32(at,blend?st(x87add(ld(result[j]),ld(out.getFloat32(at,true)))):result[j],true);
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
