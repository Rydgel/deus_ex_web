/** DrawLodMesh's distance LOD for one Play mesh binding
 * (docs/script-lodmesh-lod.md "Play"): the selection from the main frame's
 * coords, width and FOV; after GetFrame, the morph of the drawn positions,
 * the reduced faces and the packed wedge dwords (vertex, U, V) that the
 * normals, the lighting and the draw read. The original's translation is
 * src/runtime/lodmesh-lod.mjs; the lodmesh kernel's `lod` runs the morph
 * and the corners when it is loaded.
 *
 * Play keeps GetFrame's output in world space (the lighting's camera
 * transform is a host stage, docs/render-pass-precision.md), so the morph
 * runs on world-space positions: the selection, counts, faces, wedges and
 * alphas are the original's; the morphed coordinates round in another space. */
import {lodMeshCorners,lodMeshTanFactor,lodMeshTopology,morphLodMesh,selectLodMesh,RENDER_LOD_SETTINGS} from '../runtime/lodmesh-lod.mjs';

const topologies=new WeakMap();
/** The mesh's LOD arrays, shared by its bindings; null without LOD. */
export function meshLodTopology(payload) {
  let topology=topologies.get(payload);
  if(topology===undefined){
    try{topology=lodMeshTopology(payload);}catch{topology=null;}
    topologies.set(payload,topology);
  }
  return topology;
}

/** The frame's LOD inputs: Frame->Coords (12 floats), the float width FX and
 * the viewport actor's FovAngle, with the shipped URender settings. */
const tangents=new Map();
export function lodFrame({coords,fx,fov},settings=RENDER_LOD_SETTINGS) {
  const key=Math.fround(fov);
  let tanFactor=tangents.get(key);
  if(tanFactor===undefined){
    tanFactor=lodMeshTanFactor(key);
    if(tangents.size>64)tangents.clear();
    tangents.set(key,tanFactor);
  }
  return {coords,fx:Math.fround(fx),fov:key,tanFactor,settings};
}

const PF_INVISIBLE=1;
/** One binding's LOD state. `faces` are readLodMeshSurfaces' faces (vertex
 * indices with the special prefix), `faceWords` their [v0, v1, v2, flags]. */
export function createMeshLod(payload,faces,faceWords,{kernel=null}={}) {
  const topology=meshLodTopology(payload);
  if(!topology)return null;
  const {special,modelVerts:N}=topology,V=payload.frameVertexCount,F=topology.faceCount;
  const lod=kernel?.lod??null;
  const alphas=new Uint32Array(N),alphaFloat=new Float32Array(1),alphaWord=new Uint32Array(alphaFloat.buffer);
  let morphed=null;
  // Lighting topologies per returned count (the reduced faces depend on it
  // alone), a few at a time; the kernel keeps an uploaded copy of each.
  const lighting=new Map();
  const lightingOf=(count,resolved)=>{
    let entry=lighting.get(count);
    if(entry){lighting.delete(count);lighting.set(count,entry);return entry;}
    const words=new Uint32Array(F*4),list=new Array(F);
    for(let i=0;i<F;i++){
      const at=i*3,flags=faceWords[i*4+3];
      if(resolved[at]<0){words.set([0,0,0,(flags|PF_INVISIBLE)>>>0],i*4);list[i]={vertices:[0,0,0],flags:(flags|PF_INVISIBLE)>>>0};continue;}
      const vertices=[resolved[at],resolved[at+1],resolved[at+2]];
      words.set([...vertices,flags],i*4);list[i]={vertices,flags};
    }
    entry={faceWords:words,faces:list};
    lighting.set(count,entry);
    if(lighting.size>6){const [oldest,old]=lighting.entries().next().value;lighting.delete(oldest);kernel?.releaseLightingMesh(old.faceWords);}
    return entry;
  };
  return {topology,
    /** The selection for this frame (selectLodMesh) from the actor's
     * Location, DrawScale and LODBias. */
    select(frame,location,drawScale,lodBias){
      return selectLodMesh(topology,frame.settings,{location,drawScale,lodBias},frame.coords,frame);
    },
    /** After GetFrame returned `count` ordinary vertices into `output`
     * (12-byte stride, special vertices first): the drawn positions (the
     * output itself, or a morphed copy), the final flags, the per-face
     * resolved vertices (special prefix included; -1 for a face above the
     * count) and packed wedge dwords while the LOD flag holds, and the
     * lighting topology of those faces. */
    after(selection,count,output){
      const source=new Float32Array(output.buffer,output.byteOffset,V*3);
      let positions=source,state,resolved=null,scratch=null;
      if(lod){
        const work=selection.morph?{positions:0,stride:3,alphas:V*3,alphaStride:1}:null;
        if(work){
          const words=lod.words(V*3+N);
          words.floats.set(source,0);
          state=lod.morphWords(topology,selection,count,{...work,positions:special*3,alphas:V*3});
          if(state.morph){morphed??=new Float32Array(V*3);morphed.set(lod.words(V*3+N).floats.subarray(0,V*3));positions=morphed;}
        }else state={active:selection.active&&count<N,morph:false,start:0,count};
        if(state.active){
          // Alphas stay at WORK[V*3..] from the morph above; without a morph
          // no corner reads them.
          const out=lod.cornersWords(topology,state,{alphas:V*3,alphaStride:1,wordsBefore:V*3+N});
          resolved=new Int32Array(F*3);scratch=Uint32Array.from(out.scratch);
          for(let i=0;i<F*3;i++){const v=out.faces[i];resolved[i]=v===0xffffffff?-1:v+special;}
        }
      }else{
        if(selection.morph){morphed??=new Float32Array(V*3);morphed.set(source);positions=morphed;}
        const base=special*3;
        state=morphLodMesh(topology,selection,count,{
          vertex:i=>[positions[base+i*3],positions[base+i*3+1],positions[base+i*3+2]],
          setVertex:(i,xyz)=>{positions[base+i*3]=xyz[0];positions[base+i*3+1]=xyz[1];positions[base+i*3+2]=xyz[2];},
          setAlpha:(i,alpha)=>{alphaFloat[0]=alpha;alphas[i]=alphaWord[0];}});
        if(!state.morph)positions=source;
        if(state.active){
          const corners=lodMeshCorners(topology,state,v=>alphas[v]);
          resolved=new Int32Array(F*3);scratch=corners.scratch;
          corners.faces.forEach((face,i)=>{for(let k=0;k<3;k++)resolved[i*3+k]=face?face[k]+special:-1;});
        }
      }
      const light=state.active?lightingOf(count,resolved):{faceWords,faces};
      return {state,positions,resolved,scratch,lighting:light};
    },
    dispose(){for(const entry of lighting.values())kernel?.releaseLightingMesh(entry.faceWords);lighting.clear();},
  };
}
