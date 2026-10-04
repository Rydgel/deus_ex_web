/** The GPU mesh path's texel allocation and per-frame limits without a GL
 * context (docs/gpu-mesh.md, docs/sim-worker.md). The page's gpu-mesh.mjs
 * keeps one to place its uploads; the simulation side keeps another with the
 * same capacities and the same calls in the same order, so it knows which
 * actors take the GPU path, which plans the GPU can run and when a frame's
 * light texels run out, exactly as the page will. */
export const GPU_MESH_MAX_LIGHTS=32;
export const GPU_MESH_CAPACITIES={vertexCapacity:1<<17,faceCapacity:1<<18,cornerCapacity:3<<18,
  slotCapacity:2048,keyframeCapacity:1<<21,lightCapacity:1<<15};
/** The player view model's own GPU mesh instance (weapon-overlay-draw.mjs).
 * DeusExItems' largest LodMesh has 255 vertices, 304 faces and 17596
 * keyframe texels (.work/tools/mesh-sizes.mjs); a binding that does not
 * fit takes the CPU path. */
export const WEAPON_GPU_MESH_CAPACITIES={vertexCapacity:1<<13,faceCapacity:1<<14,cornerCapacity:3<<14,
  slotCapacity:64,keyframeCapacity:1<<19,lightCapacity:1<<10};

export class Arena {
  constructor(capacity){this.capacity=capacity;this.free=[[0,capacity]];this.high=0;}
  allocate(count){
    for(let i=0;i<this.free.length;i++){
      const [start,size]=this.free[i];
      if(size<count)continue;
      if(size===count)this.free.splice(i,1);else this.free[i]=[start+count,size-count];
      this.high=Math.max(this.high,start+count);
      return start;
    }
    return -1;
  }
  release(start,count){
    this.free.push([start,count]);this.free.sort((a,b)=>a[0]-b[0]);
    const merged=[];
    for(const range of this.free){
      const last=merged.at(-1);
      if(last&&last[0]+last[1]===range[0])last[1]+=range[1];else merged.push([...range]);
    }
    this.free=merged;
  }
}

/** `key` names a mesh resource (one record per mesh, shared by its actors);
 * `payload` is its decoded LodMesh, `faceWords` its [v0, v1, v2, flags] face
 * words in draw order. */
export function createGpuMeshLayout(capacities={}) {
  const {vertexCapacity,faceCapacity,cornerCapacity,slotCapacity,keyframeCapacity,lightCapacity}=
    {...GPU_MESH_CAPACITIES,...capacities};
  const slots=new Arena(slotCapacity),vertexArena=new Arena(vertexCapacity),faceArena=new Arena(faceCapacity);
  const cornerArena=new Arena(cornerCapacity),keyArena=new Arena(keyframeCapacity);
  const meshVertexArena=new Arena(vertexCapacity),meshFaceArena=new Arena(faceCapacity),adjacencyArena=new Arena(faceCapacity*3);
  const meshes=new Map();
  let lightCount=0,frame=0;

  /** Static mesh data shared by every actor with that mesh: its texel bases
   * and the vertex → face adjacency lists (each vertex's faces in ascending
   * face order, with repeats for a vertex that occurs twice in a face, as
   * the kernel adds it twice). */
  function mesh(key,payload,faceWords) {
    let record=meshes.get(key);
    if(record){record.users++;return {record,created:false};}
    const V=payload.frameVertexCount,F=faceWords.length/4;
    const data=payload.arrays.get(0x60).load().data;
    const keyTexels=data.byteLength/8;
    if(!Number.isInteger(keyTexels)||data.byteOffset%2)throw new Error('GPU mesh: unexpected keyframe record layout');
    const keyBase=keyArena.allocate(keyTexels),faceBase=meshFaceArena.allocate(F),vertBase=meshVertexArena.allocate(V);
    const lists=Array.from({length:V},()=>[]);
    for(let face=0;face<F;face++)for(let k=0;k<3;k++){
      const v=faceWords[face*4+k];
      if(v>=V)throw new Error('GPU mesh: face vertex out of range');
      lists[v].push(face);
    }
    const total=lists.reduce((sum,list)=>sum+list.length,0);
    const adjacencyBase=adjacencyArena.allocate(total+4);
    if([keyBase,faceBase,vertBase,adjacencyBase].some(base=>base<0))
      throw new Error('GPU mesh capacity exceeded');
    record={key,payload,V,F,keyBase,faceBase,vertBase,adjacencyBase,adjacencyStart:Math.ceil(adjacencyBase/4)*4,
      adjacencyCount:total+4,keyTexels,users:1,lists};
    meshes.set(key,record);
    return {record,created:true};
  }
  function releaseMesh(record) {
    if(--record.users>0)return false;
    meshes.delete(record.key);
    keyArena.release(record.keyBase,record.keyTexels);meshFaceArena.release(record.faceBase,record.F);
    meshVertexArena.release(record.vertBase,record.V);adjacencyArena.release(record.adjacencyBase,record.adjacencyCount);
    return true;
  }

  return {
    /** An actor slot: its vertex, face and corner texel ranges; `created`
     * when the mesh record is new (the page uploads its static data). */
    allocate(key,payload,faceWords,{environment=false}={}) {
      const {record,created}=mesh(key,payload,faceWords);
      const slot=slots.allocate(1),vbase=vertexArena.allocate(record.V),fbase=faceArena.allocate(record.F);
      const cbase=cornerArena.allocate(record.F*3);
      if([slot,vbase,fbase,cbase].some(base=>base<0)){
        if(slot>=0)slots.release(slot,1);if(vbase>=0)vertexArena.release(vbase,record.V);
        if(fbase>=0)faceArena.release(fbase,record.F);if(cbase>=0)cornerArena.release(cbase,record.F*3);
        releaseMesh(record);throw new Error('GPU mesh capacity exceeded');
      }
      return {slot,vbase,fbase,cbase,mesh:record,environment,released:false,created};
    },
    release(handle) {
      if(handle.released)return false;handle.released=true;
      const {slot,vbase,fbase,cbase,mesh:record}=handle;
      vertexArena.release(vbase,record.V);faceArena.release(fbase,record.F);cornerArena.release(cbase,record.F*3);
      slots.release(slot,1);releaseMesh(record);
      return true;
    },
    /** Throws where the GPU cannot run a GetFrame plan (the CPU path takes it). */
    checkPose(handle,plan) {
      if(plan.channels.some(op=>op.fill))throw new Error('GPU mesh: tween count expansion is CPU-only');
      for(const op of plan.channels)
        if(op.count!==handle.mesh.V)throw new Error('GPU mesh: partial GetFrame counts are CPU-only');
    },
    /** This frame's light texels for one SetupForActor result, or false when
     * they do not fit (the CPU path lights the actor). */
    reserveLights(count) {
      if(count>GPU_MESH_MAX_LIGHTS)return false;
      if(lightCount+count>lightCapacity)return false;
      const start=lightCount;lightCount+=count;
      return {start};
    },
    /** The frame's passes ran: the frame number advances, the light texels
     * are free again. */
    endFrame(){frame++;lightCount=0;},
    get frame(){return frame;},
    get lightCount(){return lightCount;},
    arenas:{slots,vertexArena,faceArena,cornerArena,keyArena},
    meshes,
    capacities:{vertexCapacity,faceCapacity,cornerCapacity,slotCapacity,keyframeCapacity,lightCapacity},
  };
}
