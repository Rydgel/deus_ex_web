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
/** Core's FCoords *= FCoords (docs/weapon-attachment.md): `coords` (Origin, X, Y, Z) seen through `matrix`. */
export const composeCoords=compose;
// The matrix being built, as 12 doubles (Origin, X, Y, Z axes): GetFrame's coordinate setup runs for every actor the frame lights and
// plans, and its rotations were nested arrays and closures for each of the eleven transforms (about 50 arrays a rotate).
const stage=new Float64Array(12);
const dot=(l0,l1,l2,a,b,c)=>f(f(f(l0*f(a))+f(l1*f(b)))+f(l2*f(c)));
/** `compose(coords, [[0,0,0], a, b, c])` on `m` in place, `transform` above with a zero origin: each of the four rows seen through the
 * matrix of rows a, b, c (the point row's origin subtraction is `f(f(v)-f(0))`, which is `f(v)`, as for the vectors). */
function applyRows(m,a0,a1,a2,b0,b1,b2,c0,c1,c2) {
  for(let i=0;i<12;i+=3){
    const l0=f(m[i]),l1=f(m[i+1]),l2=f(m[i+2]);
    m[i]=dot(l0,l1,l2,a0,a1,a2);m[i+1]=dot(l0,l1,l2,b0,b1,b2);m[i+2]=dot(l0,l1,l2,c0,c1,c2);
  }
}
/** The yaw, pitch and roll rotations of `m`, in that order. */
function rotate(m,rotation) {
  const p=rotation[0],y=rotation[1],r=rotation[2],s=rotatorSin;
  const sy=s(y),cy=s((y+0x4000)|0),sp=s(p),cp=s((p+0x4000)|0),sr=s(r),cr=s((r+0x4000)|0);
  applyRows(m,cy,sy,0,-sy,cy,0,0,0,1);
  applyRows(m,cp,0,sp,0,1,0,-sp,0,cp);
  applyRows(m,1,0,0,0,cr,-sr,0,sr,cr);
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
// (the default allocation of a cache: one function for all of them, a binding's cache holds the one it was given)
const newBytes=size=>new Uint8Array(size);
/** The cache service createLodMeshFrameCache makes, as a class of prototype methods: a cache is made for every mesh binding of a level
 * (docs/firefox-60fps-plan.md "The collector's window"), and an object literal of methods and the closure scope they share was
 * about six heap objects a binding. */
class LodMeshFrameCache {
  constructor() {
    this.allocate=undefined;
    this.entries=undefined;
  }
  get(key){const entry=this.entries.get(key);if(entry)entry.locks++;return entry??null;}
  create(key,size){
    if(this.entries.has(key))throw new LodMeshError('GetFrame cache key already exists');
    const bytes=this.allocate(size);
    if(bytes.byteLength!==size||bytes.byteOffset%4)throw new LodMeshError('Invalid GetFrame cache allocation');
    const entry={mesh:null,frame:0,sequence:'None',valid:0,completion:1,locks:1,
      vertices:new Float32Array(bytes.buffer,bytes.byteOffset+20,(size-20)/4)};
    this.entries.set(key,entry);return entry;
  }
  unlock(entry){if(entry.locks<=0)throw new LodMeshError('Unbalanced GetFrame cache unlock');entry.locks--;}
  flush(key){const entry=this.entries.get(key);if(entry?.locks)throw new LodMeshError('GetFrame cache item is locked');this.entries.delete(key);}
}


/** Persistent cache service for the browser's admitted mesh poses. Native heap
 * pressure/eviction is not modeled; an owner can explicitly flush released keys.
 * `allocate` lets the native comparison retain unspecified allocation bytes. */
export function createLodMeshFrameCache({allocate=newBytes}={}) {
  const inst=new LodMeshFrameCache();
  inst.allocate=allocate;
  inst.entries=new Map();
   return inst;
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
  const factor=f(scaleFactor),s0=f(f(mesh.scale[0])*factor),s1=f(f(mesh.scale[1])*factor),s2=f(f(mesh.scale[2])*factor);
  // A zero scale (a ShockRing's first frame) runs the original arithmetic: Core's
  // FScale divides the origin by it (0x1011c39d), so the points are NaN and
  // DrawLodMesh's sign-bit outcodes draw nothing (docs/script-lodmesh-frame.md
  // "A zero DrawScale"). A nonfinite scale stays unsupported.
  if(!Number.isFinite(s0)||!Number.isFinite(s1)||!Number.isFinite(s2))throw new LodMeshError(`GetFrame nonfinite scale is unsupported (${mesh.entry?.name??mesh.name??'mesh'} x ${scaleFactor})`);
  const location=value('Location'),prePivot=value('PrePivot'),rotation=value('Rotation');
  const m=stage;
  for(let i=0;i<12;i++)m[i]=f(coords[i]);
  for(let i=0;i<3;i++)m[i]=f(m[i]-f(f(location[i])+f(prePivot[i])));
  rotate(m,rotation);rotate(m,mesh.rotation);
  applyRows(m,1,0,0,0,1,0,0,0,1); // Core FScale's zero-shear pass.
  return [[f(m[0]/s0),f(m[1]/s1),f(m[2]/s2)],[f(m[3]*s0),f(m[4]*s1),f(m[5]*s2)],[f(m[6]*s0),f(m[7]*s1),f(m[8]*s2)],[f(m[9]*s0),f(m[10]*s1),f(m[11]*s2)]];
}
/** createPublisher's loops as a class of prototype methods (a plan keeps its publisher for as long as the binding keeps the plan). */
class Publisher {
  constructor() {
    this.mesh=undefined;
    this.source=undefined;
    this.kernel=undefined;
    this.matrix=undefined;
    this.output=undefined;
    this.stride=undefined;
    this.out=undefined;
  }
  frameVertex(frame,i){
    const at=(frame*this.mesh.frameVertexCount+i)*8;
    if(at<0||at+6>this.source.byteLength)throw new LodMeshError('GetFrame accesses an unloaded/out-of-range vertex');
    return [0,1,2].map(axis=>this.source.getInt16(at+axis*2,true));
  }
  // The vertex less the mesh Origin (or a blend's absolute frame zero),
  // stored; less the matrix origin for the main pose; the three axis dots;
  // a blend adds onto the output. Each operation at 24 bits.
  publishVertex(i,pose,blend) {
    const origin=blend?this.frameVertex(0,i):this.mesh.origin;
    const vector=pose.map((v,j)=>{
      const component=f(f(v)-f(origin[j]));
      return blend?component:f(component-this.matrix[0][j]);
    });
    for(let j=0;j<3;j++){
      const row=this.matrix[j+1],result=f(f(f(vector[0]*row[0])+f(vector[1]*row[1]))+f(vector[2]*row[2]));
      const at=i*this.stride+j*4;
      this.out.setFloat32(at,blend?f(result+this.out.getFloat32(at,true)):result,true);
    }
  }
  /** The vertex loop of one decided operation. Without `publish` the output
   * is untouched (a scratch buffer receives the kernel's publication). */
  execute(op,publish=true) {
    const {entry,count,alpha,blend}=op;
    if(op.fill)for(let i=op.fill[0];i<op.fill[1];i++)entry.vertices.set(this.frameVertex(op.second,i),i*3);
    if(this.kernel) {
      const target=publish?this.output:scratchOutput(count*this.stride);
      this.kernel.run({source:this.source,frameVertexCount:this.mesh.frameVertexCount,output:target,stride:this.stride,matrix:this.matrix,origin:this.mesh.origin,
        count,entry,...(op.tween?{second:op.second,alpha,tween:true}:{first:op.first,second:op.second,alpha}),blend});
      return;
    }
    if(op.tween)for(let i=0;i<count;i++) {
      if(alpha>0)entry.vertices.set(interpolate(vectorAt(entry.vertices,i),this.frameVertex(op.second,i),alpha),i*3);
      if(publish)this.publishVertex(i,vectorAt(entry.vertices,i),blend);
    }
    else for(let i=0;i<count;i++) {
      const pose=alpha>0?interpolate(this.frameVertex(op.first,i),this.frameVertex(op.second,i),alpha):this.frameVertex(op.first,i);
      entry.vertices.set(pose,i*3);if(publish)this.publishVertex(i,pose,blend);
    }
  }
}


/** The vertex loops of GetFrame for one coordinate matrix and output buffer:
 * `execute(op, publish)` runs one decided operation (tween fill, interpolation
 * into the cache pose and, when `publish`, publication into the output);
 * `frameVertex(frame, i)` reads the mesh's int16 vertex words. The same loops
 * serve a call's own output and the camera-space publications of one
 * pose (publishLodMeshOps). */
function createPublisher(mesh,source,kernel,matrix,output,stride) {
  const inst=new Publisher();
  inst.mesh=mesh; inst.source=source; inst.kernel=kernel; inst.matrix=matrix; inst.output=output; inst.stride=stride;
  inst.out=new DataView(inst.output.buffer,inst.output.byteOffset,inst.output.byteLength);
   return inst;
}
/** frameContext's operations as a class of prototype methods, for the same reason: a binding's last plan holds its context. */
class FrameContext {
  constructor() {
    this.mesh=undefined;
    this.actor=undefined;
    this.services=undefined;
    this._vertexCount=undefined;
    this.stride=undefined;
    this.output=undefined;
    this.source=undefined;
    this.cache=undefined;
    this.special=undefined;
    this.animationActor=undefined;
    this.main=undefined;
    this.matrix=undefined;
    this.kernel=undefined;
    this.publisher=undefined;
  }
  get vertexCount(){return this._vertexCount;}
  decide(channel,lease) {
    const name=channel<0?read(this.services,this.animationActor,'AnimSequence'):read(this.services,this.animationActor,'BlendAnimSequence')[channel];
    const frame=f(channel<0?read(this.services,this.animationActor,'AnimFrame'):read(this.services,this.animationActor,'BlendAnimFrame')[channel]);
    const sequence=findSequence(this.mesh,name),{entry,existing}=lease;
    const available=Math.min((this._vertexCount+this.special)|0,this.mesh.frameVertexCount);
    let count=available;
    if(!(frame>=0)&&existing) {
      count=Math.min(count,entry.valid);entry.valid=count;this._vertexCount=count-this.special;
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
          count=available;this._vertexCount=count-this.special;entry.valid=count;
        }
      }
      // Only the tween path writes the cached frame, at its end (finish).
      const endFrame=f(channel<0?read(this.services,this.animationActor,'AnimFrame'):read(this.services,this.animationActor,'BlendAnimFrame')[channel]);
      return {channel,blend:channel>=0,tween:true,entry,count,fill,first:0,second:targetFrame,alpha,endFrame};
    }
    this._vertexCount=count-this.special;entry.valid=count;
    let first=0,second=0,fraction=0;
    if(sequence) {
      const phase=f((frame>=0?frame:0)*sequence.numFrames),integer=frameInteger(phase);
      fraction=f(phase-integer);
      first=sequence.startFrame+integer%sequence.numFrames;second=sequence.startFrame+((integer+1)|0)%sequence.numFrames;
    }
    return {channel,blend:channel>=0,tween:false,entry,count,fill:null,first,second,alpha:fraction};
  }
  execute(op,publish){return this.publisher.execute(op,publish);}
  /** Apply a cache entry's planned operations that were not executed on the
   * CPU (planLodMeshFrame), in order, to its cache pose only. */
  replay(entry,keep=0) {
    const log=entry.log;
    if(!log?.length)return;
    const pending=log.splice(0,log.length-keep);
    for(const op of pending)this.execute(op,false);
  }
  /** Planned operations must stay inside the loaded vertex records exactly
   * as the loops would require, so the plan throws where they would. */
  check(op) {
    if(op.count<=0)return;
    const frames=op.tween?[op.second]:[op.first,...(op.alpha>0?[op.second]:[])];
    if(op.blend)frames.push(0);
    for(const frame of frames)this.publisher.frameVertex(frame,op.count-1);
    if(op.fill)this.publisher.frameVertex(op.second,op.fill[1]-1);
  }
  blendLease(slot){
    if(!named(read(this.services,this.animationActor,'BlendAnimSequence')[slot]))return null;
    const key=(BigInt(index(this.services,this.animationActor))<<32n)+BigInt((slot+1)*0x10000+0x1d);
    return acquire(this.mesh,key,this.cache);
  }
}


/** GetFrame's per-call setup shared by the full evaluation and the plan:
 * Load, the four-slot cache leases, the coordinate matrix and the vertex
 * operations. `decide` applies one channel's cache-scalar updates in the
 * original order and returns its vertex operation; `execute` runs that
 * operation's vertex loop (tween fill, interpolation into the cache pose
 * and, when `publish`, publication into the output). The split changes no
 * order of observable effects: the scalars never depend on vertex data. */
function frameContext(mesh,actor,coords,services,{vertexCount,stride,output}) {
  const inst=new FrameContext();
  inst.mesh=mesh; inst.actor=actor; inst.services=services; inst._vertexCount=vertexCount; inst.stride=stride; inst.output=output;
  const vertices=inst.mesh.arrays.get(0x60).load(); // Original virtual Load is first.
  inst.source=new DataView(vertices.data.buffer,vertices.data.byteOffset,vertices.data.byteLength);
  inst.cache=inst.services.cache;
  if(!inst.cache)throw new LodMeshError('GetFrame requires the persistent native cache service');
  if(!Number.isInteger(inst._vertexCount)||inst._vertexCount<0||inst.stride<12||inst.stride%4||inst.output.byteLength<inst.mesh.frameVertexCount*inst.stride)
    throw new LodMeshError('Invalid GetFrame output/count/stride');
  inst.special=inst.mesh.scalarBits.get(0x184)|0;
  const owner=read(inst.services,inst.actor,'bAnimByOwner')?read(inst.services,inst.actor,'Owner'):null;
  inst.animationActor=owner??inst.actor;
  const mainKey=BigInt((((index(inst.services,inst.actor)<<8)>>>0)+0x1d)>>>0);
  inst.main=acquire(inst.mesh,mainKey,inst.cache);
  const scaleFactor=read(inst.services,inst.animationActor,'bParticles')?1:read(inst.services,inst.actor,'DrawScale');
  inst.matrix=lodMeshFrameMatrix(inst.mesh,coords,scaleFactor,name=>read(inst.services,inst.actor,name));
  inst.kernel=inst.services.kernel;
  inst.publisher=createPublisher(inst.mesh,inst.source,inst.kernel,inst.matrix,inst.output,inst.stride);
  
  return inst;
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
  const ops=[];
  const evaluate=lease=>{
    const op=context.decide(lease.channel,lease);
    // A cache pose planned for the GPU is brought up to date first.
    context.replay(op.entry);
    context.execute(op);
    if(op.tween)op.entry.frame=op.endFrame;
    context.cache.unlock(op.entry);
    ops.push(op);
  };
  evaluate({...context.main,channel:-1});
  for(let slot=0;slot<4;slot++) {
    const lease=context.blendLease(slot);
    if(lease)evaluate({...lease,channel:slot});
  }
  return {output:context.output,vertexCount:context.vertexCount,ops};
}

/** The coordinate matrix GetFrame would build for `actor` with the caller's
 * `coords` (12 floats: Origin, X, Y, Z), without touching the cache: the
 * animation actor's bParticles and the render actor's DrawScale, Location,
 * PrePivot and Rotation through `services.read`. */
export function lodMeshCameraMatrix(mesh,actor,coords,services) {
  const owner=read(services,actor,'bAnimByOwner')?read(services,actor,'Owner'):null;
  const scaleFactor=read(services,owner??actor,'bParticles')?1:read(services,actor,'DrawScale');
  return lodMeshFrameMatrix(mesh,coords,scaleFactor,name=>read(services,actor,name));
}

/** GetFrame's publication of poses already in the cache: the operations of an
 * earlier call (`getLodMeshFrame`'s `ops`, a plan's `channels` once its cache
 * poses are current) published again through `matrix` into `output`, main
 * channel first and the additive blends after it, as the call itself did.
 * DrawLodMesh calls GetFrame once for each frame that draws an actor, with
 * that frame's Frame->Coords, so each frame's buffer is the same cache poses
 * through its own matrix (docs/script-lodmesh-lod.md "Camera space").
 * The cache is read, never changed: each operation runs as a tween with alpha
 * 0 and no fill, which republishes the cached pose. */
export function publishLodMeshOps(mesh,ops,matrix,{output,stride=12,kernel=null}) {
  const vertices=mesh.arrays.get(0x60).load();
  const source=new DataView(vertices.data.buffer,vertices.data.byteOffset,vertices.data.byteLength);
  const publisher=createPublisher(mesh,source,kernel,matrix,output,stride);
  for(const op of ops)publisher.execute({...op,tween:true,alpha:0,fill:null},true);
  return output;
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

/** The scalar state of every cache entry (header fields and the pending
 * operation logs, not the cached poses, which planning never touches) and a
 * function that puts it back, dropping the entries created since. For a
 * sequence of planned calls that turns out not to merge. */
export function snapshotLodMeshCache(cache) {
  const saved=new Map();
  for(const [key,entry] of cache.entries)
    saved.set(key,{entry,frame:entry.frame,sequence:entry.sequence,valid:entry.valid,completion:entry.completion,log:entry.log?.slice()});
  return () => {
    for(const key of [...cache.entries.keys()])if(!saved.has(key))cache.entries.delete(key);
    for(const {entry,frame,sequence,valid,completion,log} of saved.values()){
      entry.frame=frame;entry.sequence=sequence;entry.valid=valid;entry.completion=completion;
      if(log)entry.log=log;else delete entry.log;
    }
  };
}

/** One GetFrame call per frame that draws an actor (DrawFrame's order, the
 * main frame last), each planned in order by planLodMeshFrame, as the one
 * plan the GPU pose pass can run (docs/script-lodmesh-lod.md "Child
 * frames"). A call after the first in a tick leaves the cached poses as they
 * are except for the vertices it publishes: a keyframe operation recomputes
 * the same poses (so the one with the largest count covers them), and a
 * tween operation after the first has alpha 0 (the first wrote the cached
 * frame) and nothing to fill (the first expanded the valid count), so it
 * only publishes the cache. Per channel the merged operation is the one that
 * changes the pose (or, if none, the one publishing most), with the largest
 * count; each cache entry's log then holds it in place of this tick's
 * operations. Returns null when a channel mixes a keyframe operation and a
 * tween operation (a cache entry created in this tick while tweening), which
 * one operation cannot express: restore the cache and plan one call. */
export function mergeLodMeshPlans(plans) {
  if(plans.length===1)return plans[0];
  const last=plans.at(-1),channels=[];
  for(const channel of last.channels) {
    const ops=plans.map(plan=>plan.channels.find(op=>op.channel===channel.channel));
    if(ops.some(op=>!op))return null;
    const real=ops.filter(op=>!(op.tween&&!(op.alpha>0)&&!op.fill));
    const pool=real.length?real:ops;
    if(pool.some(op=>op.tween!==pool[0].tween)||(pool[0].tween&&real.length>1))return null;
    const chosen=pool.reduce((a,b)=>b.count>a.count?b:a);
    const count=Math.max(...ops.map(op=>op.count));
    if(chosen.fill&&count!==chosen.count)return null;
    channels.push({merged:{...chosen,count},ops});
  }
  for(const {merged,ops} of channels) {
    const entry=merged.entry,mine=new Set(ops);
    entry.log=(entry.log??[]).filter(op=>!mine.has(op));
    entry.log.push(merged);
  }
  return {...last,channels:channels.map(entry=>entry.merged)};
}
