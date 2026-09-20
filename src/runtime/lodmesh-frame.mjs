/** ULodMesh::GetFrame 10355360..103568e5; docs/script-lodmesh-frame.md. */
import {findSequence,LodMeshError} from './lodmesh.mjs';
import {rotatorSin} from './coords.mjs';
import {x87load,x87store,x87add,x87neg,x87mul,x87div} from './script-vm.mjs';
const ld=x87load,st=x87store,f=Math.fround,sub=(a,b)=>x87add(a,x87neg(b));
const identity=()=>[[0,0,0],[1,0,0],[0,1,0],[0,0,1]];
const dot=(v,row)=>st(x87add(x87add(x87mul(v[0],ld(row[0])),x87mul(v[1],ld(row[1]))),x87mul(v[2],ld(row[2]))));
const transform=(v,coords,point)=>{
  const local=v.map((x,i)=>point?sub(ld(x),ld(coords[0][i])):ld(x));
  return coords.slice(1).map(row=>dot(local,row));
};
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

/** Evaluate the original vertex pose into the caller's strided buffer.
 * Count excludes mesh special vertices; the output includes them. `coords`
 * contains original FCoords origin/X/Y/Z vectors, flattened (12 f32 values).
 * Actor state is read-only; cache/header state and vertexCount are outputs. */
export function getLodMeshFrame(mesh,actor,coords,services,{vertexCount=mesh.frameVertexCount-(mesh.scalarBits.get(0x184)|0),
  stride=12,output=new Uint8Array(mesh.frameVertexCount*stride)}={}) {
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
  let matrix=[0,1,2,3].map(i=>coords.slice(i*3,i*3+3).map(f));
  const scaleFactor=read(services,animationActor,'bParticles')?1:read(services,actor,'DrawScale');
  const scale=mesh.scale.map(v=>st(x87mul(ld(v),ld(scaleFactor))));
  if(scale.some(v=>v===0||!Number.isFinite(v)))throw new LodMeshError('GetFrame zero/nonfinite scale is unsupported');
  const location=read(services,actor,'Location'),prePivot=read(services,actor,'PrePivot');
  matrix[0]=matrix[0].map((v,i)=>st(sub(ld(v),x87add(ld(location[i]),ld(prePivot[i])))));
  matrix=rotate(rotate(matrix,read(services,actor,'Rotation')),mesh.rotation);
  matrix=compose(matrix,identity()); // Core FScale's zero-shear pass.
  matrix=matrix.map((v,row)=>v.map((x,i)=>st(row?x87mul(ld(x),ld(scale[i])):x87div(ld(x),ld(scale[i])))));
  // These operands stay constant for every vertex and blend slot in this
  // call. Reuse their exact x87 loads; retain every original store/order.
  const kernel=services.kernel;
  const loadedMatrix=kernel?null:matrix.map(row=>row.map(ld)),loadedOrigin=kernel?null:mesh.origin.map(ld);
  const runKernel=options=>kernel.run({source,frameVertexCount:mesh.frameVertexCount,
    output,stride,matrix,origin:mesh.origin,...options});
  const frameVertex=(frame,i)=>{
    const at=(frame*mesh.frameVertexCount+i)*8;
    if(at<0||at+6>source.byteLength)throw new LodMeshError('GetFrame accesses an unloaded/out-of-range vertex');
    return [0,1,2].map(axis=>source.getInt16(at+axis*2,true));
  };
  function evaluate(channel,lease) {
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
      if(above(completion,f(0.97))) {
        alpha=0;
        if(count<available){
          for(let i=count;i<available;i++)entry.vertices.set(frameVertex(targetFrame,i),i*3);
          count=available;vertexCount=count-special;entry.valid=count;
        }
      }
      if(kernel)runKernel({count,entry,second:targetFrame,alpha,tween:true,blend:channel>=0});
      else for(let i=0;i<count;i++) {
        if(alpha>0)entry.vertices.set(interpolate(vectorAt(entry.vertices,i),frameVertex(targetFrame,i),alpha),i*3);
        publish(i,vectorAt(entry.vertices,i),channel>=0);
      }
      // Only the tween path writes the cached frame at its end.
      entry.frame=f(channel<0?read(services,animationActor,'AnimFrame'):read(services,animationActor,'BlendAnimFrame')[channel]);
    }else {
      vertexCount=count-special;entry.valid=count;
      let first=0,second=0,fraction=0;
      if(sequence) {
        const phase=st(x87mul(ld(frame>=0?frame:0),ld(sequence.numFrames))),integer=frameInteger(phase);
        fraction=st(sub(ld(phase),ld(integer)));
        first=sequence.startFrame+integer%sequence.numFrames;second=sequence.startFrame+((integer+1)|0)%sequence.numFrames;
      }
      if(kernel)runKernel({count,entry,first,second,alpha:fraction,blend:channel>=0});
      else for(let i=0;i<count;i++) {
        const pose=fraction>0?interpolate(frameVertex(first,i),frameVertex(second,i),fraction):frameVertex(first,i);
        entry.vertices.set(pose,i*3);publish(i,pose,channel>=0);
      }
    }
    cache.unlock(entry);
  }
  function publish(i,pose,blend) {
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
  evaluate(-1,main);
  for(let slot=0;slot<4;slot++) {
    if(!named(read(services,animationActor,'BlendAnimSequence')[slot]))continue;
    const key=(BigInt(index(services,animationActor))<<32n)+BigInt((slot+1)*0x10000+0x1d);
    evaluate(slot,acquire(mesh,key,cache));
  }
  return {output,vertexCount};
}
