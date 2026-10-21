/** UMesh::GetFrame 0x103a7780..0x103a85d4, the classic mesh pose (docs/umesh.md).
 *
 * The game has five classic UMesh meshes (the boot logos and the flies); every
 * other mesh is a LodMesh, whose GetFrame is the sibling in lodmesh-frame.mjs.
 * Render.dll's DrawMesh calls this one through the mesh's vtable (+0x70) with
 * a 0x58-byte stride, in the render pass, so it and the Core FCoords operators
 * it calls run at x87 precision control 24 (docs/render-pass-precision.md):
 * every add, subtract, multiply and divide rounds to a 24-bit significand, and
 * with float or small-integer operands each operation is one binary32 one
 * (`f(a op b)`). The body shares the LodMesh one's coordinate setup, vertex
 * interpolation and additive blends; it differs in having no special vertices
 * or requested count, a 12-byte cache header (mesh, frame, sequence) without a
 * valid count or completion, and a tween that has no 0.97 completion gate.
 * Non-finite values follow IEEE single rules, not the x87's NaN payload
 * choice (not modelled; no shipped mesh or actor reaches one). */
import {LodMeshError} from './lodmesh.mjs';
import {lodMeshFrameMatrix} from './lodmesh-frame.mjs';
const f=Math.fround;
const named=name=>name!=null&&String(name).toLowerCase()!=='none';
const sameName=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
/** UMesh::GetAnimSeq: the first sequence of that FName (names compare without case). */
const findSequence=(mesh,name)=>mesh.sequences.find(sequence=>sameName(sequence.name,name))??null;

/** The GCache items GetFrame keeps: per key, the mesh, the cached frame float
 * and sequence name (the 12-byte header at the item) and FrameVerts local
 * vectors. Native heap pressure and eviction are not modeled. */
export function createUMeshFrameCache() {
  const entries=new Map();
  return {entries,
    get(key){const entry=entries.get(key);if(entry)entry.locks++;return entry??null;},
    create(key,count){
      if(entries.has(key))throw new LodMeshError('UMesh GetFrame cache key already exists');
      const entry={mesh:null,frame:0,sequence:'None',locks:1,vertices:new Float32Array(count*3)};
      entries.set(key,entry);return entry;
    },
    unlock(entry){if(entry.locks<=0)throw new LodMeshError('Unbalanced UMesh GetFrame cache unlock');entry.locks--;},
    flush(key){const entry=entries.get(key);if(entry?.locks)throw new LodMeshError('UMesh GetFrame cache item is locked');entries.delete(key);},
  };
}
// The inline cache probe: a hit on the same mesh locks the item, a hit on
// another mesh unlocks and flushes it, and a miss creates a new item whose
// header is the mesh, frame 0 and no sequence (the original zeroes it).
function acquire(mesh,key,cache) {
  let entry=cache.get(key),existing=Boolean(entry);
  if(entry&&entry.mesh!==mesh){cache.unlock(entry);cache.flush(key);entry=null;existing=false;}
  if(!entry){entry=cache.create(key,mesh.frameVertexCount);entry.mesh=mesh;}
  return {entry,existing};
}
// FISTP of (phase - 0.5f), round to nearest even; the subtraction rounds to
// 24 bits, which is exact for the phases a mesh can reach.
function frameInteger(phase) {
  const v=f(phase-0.5),lo=Math.floor(v),fraction=v-lo;
  const result=fraction<0.5?lo:fraction>0.5?lo+1:(lo%2===0?lo:lo+1);
  if(!Number.isFinite(result)||result< -0x80000000||result>0x7fffffff)
    throw new LodMeshError('UMesh GetFrame animation phase is outside the original valid vertex domain');
  return result;
}
const read=(services,actor,name)=>{
  const value=services.read(actor,name);
  if(value===undefined)throw new LodMeshError(`UMesh GetFrame requires original ${name}`);
  return value;
};
const indexOf=(services,actor)=>{
  const value=actor?services.objectIndex(actor):0;
  if(!Number.isInteger(value)||value<0||value>0x7fffffff)throw new LodMeshError('UMesh GetFrame requires the global UObject index');
  return value;
};
/** The key of a cache item: `(Index<<8)+0x1d` for the main pose and, for the
 * blend slots, `(animation actor Index<<32)+((slot+1)<<16)+0x1d` (a string
 * here: only identity matters). */
const mainKey=(services,actor)=>`m${(((indexOf(services,actor)<<8)>>>0)+0x1d)>>>0}`;
const blendKey=(services,animationActor,slot)=>`b${indexOf(services,animationActor)}:${slot}`;

/** UMesh::GetFrame for the coordinate matrix of `coords` (12 floats: Origin,
 * X, Y, Z). `actor` supplies Location, PrePivot, Rotation, DrawScale,
 * bAnimByOwner, Owner and, through the animation actor, bParticles,
 * AnimSequence, AnimFrame, BlendAnimSequence and BlendAnimFrame. Returns the
 * strided `output` (FrameVerts vectors of `stride` bytes) and the operations
 * it ran, which publishUMeshOps republishes through another matrix. */
export function getUMeshFrame(mesh,actor,coords,services,{stride=12,output=new Uint8Array(mesh.frameVertexCount*stride)}={}) {
  if(stride<12||stride%4||output.byteLength<mesh.frameVertexCount*stride)throw new LodMeshError('Invalid UMesh GetFrame output/stride');
  const vertices=mesh.arrays.get(0x60).load(); // The virtual Load of the four lazy arrays comes first.
  mesh.arrays.get(0x78).load();mesh.arrays.get(0x9c).load();mesh.arrays.get(0xcc).load();
  const source=new DataView(vertices.data.buffer,vertices.data.byteOffset,vertices.data.byteLength);
  const cache=services.cache,kernel=services.kernel??null;
  const sourceBytes=kernel?new Uint8Array(vertices.data.buffer,vertices.data.byteOffset,vertices.data.byteLength):null;
  if(!cache)throw new LodMeshError('UMesh GetFrame requires the persistent native cache service');
  const count=mesh.frameVertexCount;
  const owner=read(services,actor,'bAnimByOwner')?read(services,actor,'Owner'):null;
  const animationActor=owner??actor;
  const main=acquire(mesh,mainKey(services,actor),cache);
  const scaleFactor=read(services,animationActor,'bParticles')?1:read(services,actor,'DrawScale');
  const matrix=lodMeshFrameMatrix(mesh,coords,scaleFactor,name=>read(services,actor,name));
  const frameVertex=(frame,i)=>{
    const at=(frame*count+i)*8;
    if(at<0||at+6>source.byteLength)throw new LodMeshError('UMesh GetFrame accesses an unloaded/out-of-range vertex');
    return [source.getInt16(at,true),source.getInt16(at+2,true),source.getInt16(at+4,true)];
  };
  const out=new DataView(output.buffer,output.byteOffset,output.byteLength);
  const ops=[];
  /** One pose (the main one, or blend slot `channel`): the cache update and
   * the vertex loop. */
  function pose(lease,channel) {
    const blend=channel>=0,{entry,existing}=lease;
    const name=blend?read(services,animationActor,'BlendAnimSequence')[channel]:read(services,animationActor,'AnimSequence');
    let frame=f(blend?read(services,animationActor,'BlendAnimFrame')[channel]:read(services,animationActor,'AnimFrame'));
    const sequence=named(name)?findSequence(mesh,name):null;
    let tween=false,first=0,second=0,alpha=0;
    if(!(frame>=0)&&existing) {
      // Negative (or unordered) AnimFrame with a cache item: tween from the cached pose to the
      // sequence's first frame, over the alpha the frame has left of the cached one.
      tween=true;second=sequence?sequence.startFrame:0;
      const reset=sequence?f(-1/sequence.numFrames):0;
      alpha=f(1-f(frame/f(entry.frame)));
      if(!sameName(entry.sequence,name)||!(alpha>=0)||alpha>1){entry.sequence=name;alpha=0;entry.frame=reset;}
    } else {
      if(!(frame>=0))frame=0; // The clamp to the zero float.
      if(sequence) {
        const phase=f(frame*sequence.numFrames),integer=frameInteger(phase);
        alpha=f(phase-integer);
        first=sequence.startFrame+integer%sequence.numFrames;second=sequence.startFrame+((integer+1)|0)%sequence.numFrames;
      }
    }
    const op={entry,channel,blend,tween,first,second,alpha};
    execute(op,true);
    // Only the tween path writes the cached frame, at its end.
    if(tween)entry.frame=f(blend?read(services,animationActor,'BlendAnimFrame')[channel]:read(services,animationActor,'AnimFrame'));
    cache.unlock(entry);
    ops.push(op);
  }
  /** One decided operation's vertex loop; `publish` writes the output. */
  function execute(op,publish) {
    const {entry,alpha,blend}=op;
    // The Rust kernel's pose loops (native/lodmesh-kernel, the LodMesh GetFrame's) are these loops over packed vertices; the
    // JavaScript below stays the reference (`kernel` null: services.kernel absent, ?meshBackend=javascript).
    if(kernel) {
      kernel.run({source:sourceBytes,frameVertexCount:count,output,stride,matrix,
        origin:mesh.origin,count,entry,...(op.tween?{second:op.second,alpha,tween:true}:{first:op.first,second:op.second,alpha}),blend});
      return;
    }
    for(let i=0;i<count;i++) {
      const cached=entry.vertices;
      if(op.tween) {
        const b=frameVertex(op.second,i);
        for(let j=0;j<3;j++)cached[i*3+j]=f(f(f(b[j]-cached[i*3+j])*alpha)+cached[i*3+j]);
      } else {
        const a=frameVertex(op.first,i),b=frameVertex(op.second,i);
        for(let j=0;j<3;j++)cached[i*3+j]=f(f(f(b[j]-a[j])*alpha)+a[j]);
      }
      if(publish)publishVertex(entry,i,matrix,blend,out,output,stride,frameVertex,mesh);
    }
  }
  pose(main,-1);
  for(let slot=0;slot<4;slot++) {
    if(!named(read(services,animationActor,'BlendAnimSequence')[slot]))continue;
    pose(acquire(mesh,blendKey(services,animationActor,slot),cache),slot);
  }
  return {output,ops};
}

// The vertex less the mesh Origin (or a blend's absolute frame zero), stored;
// less the matrix origin for the main pose; the three axis dots
// `(v.x·A.x + v.y·A.y) + v.z·A.z`; a blend adds onto the output. Each
// operation at 24 bits.
function publishVertex(entry,i,matrix,blend,out,output,stride,frameVertex,mesh) {
  const origin=blend?frameVertex(0,i):mesh.origin;
  const vector=[0,1,2].map(j=>{
    const component=f(f(entry.vertices[i*3+j])-f(origin[j]));
    return blend?component:f(component-matrix[0][j]);
  });
  for(let j=0;j<3;j++) {
    const row=matrix[j+1],result=f(f(f(vector[0]*row[0])+f(vector[1]*row[1]))+f(vector[2]*row[2]));
    const at=i*stride+j*4;
    out.setFloat32(at,blend?f(result+out.getFloat32(at,true)):result,true);
  }
}

/** The pose DrawMesh gets for any Coords: the cached poses of an earlier call's
 * `ops` published through `matrix` (umeshCameraMatrix), main pose first and the
 * additive blends after it, as the call did. The cache is read, never changed. */
export function publishUMeshOps(mesh,ops,matrix,{output,stride=12,kernel=null}) {
  const vertices=mesh.arrays.get(0x60).load();
  if(kernel) {
    // Each operation republishes its cached pose as a tween of alpha 0 does (the pose loops of the Rust kernel).
    const source=new Uint8Array(vertices.data.buffer,vertices.data.byteOffset,vertices.data.byteLength);
    for(const op of ops)kernel.run({source,frameVertexCount:mesh.frameVertexCount,output,stride,matrix,origin:mesh.origin,count:mesh.frameVertexCount,
      entry:op.entry,tween:true,alpha:0,second:0,blend:op.blend});
    return output;
  }
  const source=new DataView(vertices.data.buffer,vertices.data.byteOffset,vertices.data.byteLength);
  const frameVertex=(frame,i)=>{
    const at=(frame*mesh.frameVertexCount+i)*8;
    return [source.getInt16(at,true),source.getInt16(at+2,true),source.getInt16(at+4,true)];
  };
  const out=new DataView(output.buffer,output.byteOffset,output.byteLength);
  for(const op of ops)for(let i=0;i<mesh.frameVertexCount;i++)
    publishVertex(op.entry,i,matrix,op.blend,out,output,stride,frameVertex,mesh);
  return output;
}

/** The coordinate matrix GetFrame builds for `actor` and the caller's `coords`
 * (12 floats), without touching the cache. */
export function umeshCameraMatrix(mesh,actor,coords,services) {
  const owner=read(services,actor,'bAnimByOwner')?read(services,actor,'Owner'):null;
  const scaleFactor=read(services,owner??actor,'bParticles')?1:read(services,actor,'DrawScale');
  return lodMeshFrameMatrix(mesh,coords,scaleFactor,name=>read(services,actor,name));
}
