/** The JavaScript side of the Rust kernel's classic-UMesh DrawMesh (native/lodmesh-kernel/src/umesh.rs, docs/umesh.md "In Play"):
 * topology upload and the per-call scratch layout. The reference is `drawUMesh` with `packUMeshDraw` (umesh-draw.mjs); the kernel
 * writes the words `packUMeshDraw` makes (validate-umesh-wasm compares them bit for bit).
 *
 * One call carries the camera-space points GetFrame published, the frame's Mirror, outcode planes and Uncoords, the poly flags,
 * SetupForActor's result (flags, ambient, ScaleGlow, lights), the mesh textures' infos by TextureIndex and the environment map's.
 * Returns the colours per triangle corner and the environment UVs as fresh arrays, the points (Fatness moves them) and, on request,
 * each vertex's normal plane and Light (validation). */
import {umeshTopology} from './umesh-draw.mjs';

const HEADER=48,INFO_WORDS=6;
export const UMESH_STATUS={ok:0,noEnvironment:1,invalid:2};

export function createUMeshFacade({work,current,exports}) {
  const {upload_umesh:upload,release_umesh:release,umesh_draw:draw,umesh_layout:layoutAt}=exports;
  const handles=new WeakMap(),uses=new WeakMap(),layouts=new Map();
  /** The kernel's handle for a mesh's topology (uploaded once), or -1 when the kernel does not accept the topology. */
  function handleOf(mesh) {
    const topology=umeshTopology(mesh);
    let handle=handles.get(topology);
    if(handle!==undefined)return handle;
    const {triangles,links}=topology,vertexCount=mesh.frameVertexCount;
    if(links.length<vertexCount){handles.set(topology,-1);return -1;}
    const linkCount=links.reduce((total,run)=>total+run.length,0);
    const words=work(triangles.length*5+vertexCount*2+linkCount).words;
    let at=0;
    for(const tri of triangles){words[at++]=tri.vertices[0];words[at++]=tri.vertices[1];words[at++]=tri.vertices[2];words[at++]=tri.flags>>>0;words[at++]=tri.texture>>>0;}
    let offset=0;
    for(let v=0;v<vertexCount;v++){words[at++]=links[v].length;words[at++]=offset;offset+=links[v].length;}
    for(let v=0;v<vertexCount;v++)for(const t of links[v])words[at++]=t;
    const result=upload(triangles.length,vertexCount,linkCount);
    handle=result===0xffffffff?-1:result;
    handles.set(topology,handle);
    return handle;
  }
  const regions=(vertexCount,triCount,textureCount,lightCount)=>{
    const key=`${vertexCount}:${triCount}:${textureCount}:${lightCount}`;
    let at=layouts.get(key);
    if(!at){
      at=['textures','lights','points','colors','env_uv','planes','vertex_light','words'].reduce((regions,name,i)=>({...regions,[name]:layoutAt(vertexCount,triCount,textureCount,lightCount,i)}),{});
      layouts.set(key,at);
    }
    return at;
  };
  const kernel={
    handleOf,
    /** Whether the kernel can draw this mesh (its topology was accepted). */
    accepts:mesh=>handleOf(mesh)>=0,
    /** A binding's use of the mesh: uploads the topology on the first and returns whether the kernel draws it; `release` is
     * its pair, and the last one frees the kernel's copy. */
    acquire(mesh) {
      if(handleOf(mesh)<0)return false;
      const topology=umeshTopology(mesh);
      uses.set(topology,(uses.get(topology)??0)+1);
      return true;
    },
    release(mesh) {
      const topology=umeshTopology(mesh),count=(uses.get(topology)??0)-1;
      if(count>0){uses.set(topology,count);return;}
      uses.delete(topology);
      const handle=handles.get(topology);
      if(handle>=0)release(handle);
      handles.delete(topology);
    },
    /** DrawMesh's classic body for `points` (a Float32Array of FrameVerts x,y,z, not changed). `textures[i]` is the info
     * {uSize, vSize, uScale, vScale, flags} of mesh texture i or null; `environment` the environment map's or null. */
    draw(mesh,points,{frame,polyFlags,setupFlags=0,fatness=0x80,unlit,ambient,scaleGlow,lights,textures,environment,envOutput,diagnostics=false}) {
      const handle=handleOf(mesh);
      if(handle<0)throw new Error('The UMesh kernel does not accept this topology');
      const vertexCount=mesh.frameVertexCount,triCount=umeshTopology(mesh).triangles.length;
      const textureCount=textures.length,lightCount=lights.length;
      const at=regions(vertexCount,triCount,textureCount,lightCount);
      const {words,floats}=work(at.words);
      floats[0]=frame.mirror;
      words[1]=frame.prj?1:0;
      if(frame.prj)for(let k=0;k<4;k++)floats[2+k]=frame.prj[k];
      for(let j=0;j<3;j++)for(let k=0;k<3;k++)floats[6+j*3+k]=frame.uncoords[j][k];
      words[15]=polyFlags>>>0;words[16]=setupFlags>>>0;words[17]=fatness>>>0;
      floats.set(unlit,18);floats.set(ambient,21);floats[24]=scaleGlow;words[25]=(envOutput?1:0)|(diagnostics?2:0);
      const info=(base,value)=>{
        if(!value){words[base]=0;return;}
        words[base]=1;words[base+1]=value.uSize>>>0;words[base+2]=value.vSize>>>0;floats[base+3]=value.uScale;floats[base+4]=value.vScale;words[base+5]=value.flags>>>0;
      };
      info(26,environment);
      for(let i=0;i<textureCount;i++)info(at.textures+i*INFO_WORDS,textures[i]);
      for(let i=0;i<lightCount;i++){
        const light=lights[i],base=at.lights+i*7;
        floats.set(light.location,base);floats[base+3]=light.rradius;floats.set(light.color,base+4);
      }
      floats.set(points.subarray(0,vertexCount*3),at.points);
      const status=draw(handle,textureCount,lightCount);
      const after=current();
      const out=after.floats,view=after.words;
      const result={status,kept:view[32],drawn:view[33],allOutside:view[34]!==0};
      if(status!==UMESH_STATUS.ok)return result;
      result.colors=out.slice(at.colors,at.colors+triCount*9);
      result.envUv=envOutput?out.slice(at.env_uv,at.env_uv+triCount*6):null;
      // Fatness is the only thing that moves a point.
      result.points=fatness!==0x80?out.slice(at.points,at.points+vertexCount*3):points;
      if(diagnostics){
        result.planes=out.slice(at.planes,at.planes+vertexCount*4);
        result.vertexLight=out.slice(at.vertex_light,at.vertex_light+vertexCount*3);
      }
      return result;
    },
  };
  return kernel;
}
