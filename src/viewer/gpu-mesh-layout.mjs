/** The GPU mesh path's texel allocation and per-frame limits without a GL
 * context (docs/gpu-mesh.md, docs/sim-worker.md). The page's gpu-mesh.mjs
 * keeps one to place its uploads; the simulation side keeps another with the
 * same capacities and the same calls in the same order, so it knows which
 * actors take the GPU path, which plans the GPU can run and when a frame's
 * light texels run out, exactly as the page will. */
import {meshLodTopology} from './actor-mesh-lod.mjs';

export const GPU_MESH_MAX_LIGHTS=32;
// `wedgeCapacity`: the meshes' Wedges; `lodListCapacity`: their LOD vertex
// lists (every face corner whose wedge collapse chain reaches the vertex).
export const GPU_MESH_CAPACITIES={vertexCapacity:1<<17,faceCapacity:1<<18,cornerCapacity:3<<18,
  slotCapacity:2048,keyframeCapacity:1<<21,lightCapacity:1<<15,wedgeCapacity:1<<18,lodListCapacity:1<<21};
/** The player view model's own GPU mesh instance (weapon-overlay-draw.mjs).
 * DeusExItems' largest LodMesh has 255 vertices, 304 faces and 17596
 * keyframe texels (.work/tools/mesh-sizes.mjs); a binding that does not
 * fit takes the CPU path. */
export const WEAPON_GPU_MESH_CAPACITIES={vertexCapacity:1<<13,faceCapacity:1<<14,cornerCapacity:3<<14,
  slotCapacity:64,keyframeCapacity:1<<19,lightCapacity:1<<10,wedgeCapacity:1<<14,lodListCapacity:1<<17};

/** DrawLodMesh's LOD vertex lists for the GPU vertex and corner passes
 * (docs/gpu-mesh.md "Distance LOD"): for each frame vertex, every face
 * corner (face·4 + corner) whose wedge's CollapseWedgeThus chain passes a
 * wedge of that vertex, in ascending face then corner order. A reduced
 * corner resolves to one wedge of its chain, so a vertex's faces under any
 * count are the entries whose resolved corner is that vertex, in the order
 * DrawLodMesh adds them. */
export function lodVertexLists(topology,V) {
  const {faces,faceCount,wedges,collapseWedges,special}=topology,lists=Array.from({length:V},()=>[]);
  for(let face=0;face<faceCount;face++)for(let corner=0;corner<3;corner++){
    let wedge=faces[face*4+corner];
    for(let steps=0;steps<=wedges.length;steps++){
      const list=lists[(wedges[wedge]&0xffff)+special],entry=face*4+corner;
      if(list.at(-1)!==entry)list.push(entry);
      const next=collapseWedges[wedge];
      if(next===wedge)break;
      wedge=next;
    }
  }
  return lists;
}

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
  const {vertexCapacity,faceCapacity,cornerCapacity,slotCapacity,keyframeCapacity,lightCapacity,wedgeCapacity,lodListCapacity}=
    {...GPU_MESH_CAPACITIES,...capacities};
  const slots=new Arena(slotCapacity),vertexArena=new Arena(vertexCapacity),faceArena=new Arena(faceCapacity);
  const wedgeArena=new Arena(wedgeCapacity),lodListArena=new Arena(lodListCapacity);
  const cornerArena=new Arena(cornerCapacity),keyArena=new Arena(keyframeCapacity);
  const meshVertexArena=new Arena(vertexCapacity),meshFaceArena=new Arena(faceCapacity),adjacencyArena=new Arena(faceCapacity*3);
  const meshes=new Map();
  // The light texels of the main frame's run (pool 0) and of each child
  // frame's own run (a pool per frame index): a pass's lighting run starts at
  // texel 0 and its lights are free again once it ran.
  let lightCount=0,frame=0;const framePools=new Map();

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
    // The LOD's static data (actor-mesh-lod.mjs meshLodTopology): every
    // GPU-path mesh has it, the corner pass resolves corners through it.
    const lod=meshLodTopology(payload);
    if(!lod||lod.faceCount!==F)throw new Error('GPU mesh: no LOD topology');
    const lodLists=lodVertexLists(lod,V),lodTotal=lodLists.reduce((sum,list)=>sum+list.length,0);
    const W=lod.wedges.length,wedgeBase=wedgeArena.allocate(W),lodListBase=lodListArena.allocate(lodTotal+4);
    if([keyBase,faceBase,vertBase,adjacencyBase,wedgeBase,lodListBase].some(base=>base<0)){
      for(const [arena,base,count] of [[keyArena,keyBase,keyTexels],[meshFaceArena,faceBase,F],[meshVertexArena,vertBase,V],
        [adjacencyArena,adjacencyBase,total+4],[wedgeArena,wedgeBase,W],[lodListArena,lodListBase,lodTotal+4]])if(base>=0)arena.release(base,count);
      throw new Error('GPU mesh capacity exceeded');
    }
    record={key,payload,V,F,keyBase,faceBase,vertBase,adjacencyBase,adjacencyStart:Math.ceil(adjacencyBase/4)*4,
      adjacencyCount:total+4,keyTexels,users:1,lists,lod,W,wedgeBase,lodLists,lodListBase,
      lodListStart:Math.ceil(lodListBase/4)*4,lodListCount:lodTotal+4};
    meshes.set(key,record);
    return {record,created:true};
  }
  function releaseMesh(record) {
    if(--record.users>0)return false;
    meshes.delete(record.key);
    keyArena.release(record.keyBase,record.keyTexels);meshFaceArena.release(record.faceBase,record.F);
    meshVertexArena.release(record.vertBase,record.V);adjacencyArena.release(record.adjacencyBase,record.adjacencyCount);
    wedgeArena.release(record.wedgeBase,record.W);lodListArena.release(record.lodListBase,record.lodListCount);
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
    /** Throws where the GPU cannot run a GetFrame plan (the CPU path takes
     * it): the pose pass packs each channel's count and fill start into 16
     * bits. */
    checkPose(handle,plan) {
      for(const op of plan.channels){
        const fill=op.fill?op.fill[0]:op.count;
        if(!(op.count>=0&&op.count<=handle.mesh.V&&fill>=0&&fill<=op.count))throw new Error('GPU mesh: invalid GetFrame count');
      }
    },
    /** This frame's light texels for one SetupForActor result, or false when
     * they do not fit (the CPU path lights the actor). */
    reserveLights(count,pool=0) {
      if(count>GPU_MESH_MAX_LIGHTS)return false;
      if(pool){
        const used=framePools.get(pool)??0;
        if(used+count>lightCapacity)return false;
        framePools.set(pool,used+count);return {start:used};
      }
      if(lightCount+count>lightCapacity)return false;
      const start=lightCount;lightCount+=count;
      return {start};
    },
    /** A child frame's lighting run ran (the page's lightRun): its light
     * texels are free again. */
    endLights(pool=0){if(pool)framePools.delete(pool);else lightCount=0;},
    /** The frame's passes ran: the frame number advances, the light texels
     * are free again. */
    endFrame(){frame++;lightCount=0;framePools.clear();},
    get frame(){return frame;},
    get lightCount(){return lightCount;},
    arenas:{slots,vertexArena,faceArena,cornerArena,keyArena,wedgeArena,lodListArena},
    meshes,
    capacities:{vertexCapacity,faceCapacity,cornerCapacity,slotCapacity,keyframeCapacity,lightCapacity,wedgeCapacity,lodListCapacity},
  };
}
