/** DrawLodMesh's distance LOD for one Play mesh binding
 * (docs/script-lodmesh-lod.md "Play"): the selection from the main frame's
 * coords, width and FOV; after GetFrame, the morph of the drawn positions,
 * the reduced faces and the packed wedge dwords (vertex, U, V) that the
 * normals, the lighting and the draw read. The original's translation is
 * src/runtime/lodmesh-lod.mjs; the lodmesh kernel's `lod` runs the morph
 * and the corners when it is loaded.
 *
 * `after` morphs whatever buffer it is given. Play gives it two kinds:
 * GetFrame's world-space output (identity Coords), which the draw, the
 * environment mapping and the culling bounds use, and, for the lighting,
 * the camera-space buffer GetFrame fills when DrawLodMesh calls it with the
 * frame's own Frame->Coords (actor-mesh-sim.mjs cameraDrawn), which is the
 * original's buffer and rounds the morph where the original does
 * (docs/script-lodmesh-lod.md "Camera space"). */
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
// The float-to-word conversion of the JavaScript morph's alphas, used at once: one pair for every binding.
const alphaFloat=new Float32Array(1),alphaWord=new Uint32Array(alphaFloat.buffer);
/** One binding's LOD state (createMeshLod makes it): its topology and the lighting topologies per returned count (the reduced faces
 * depend on it alone), a few at a time, of which the kernel keeps an uploaded copy of each. A class of prototype methods: a binding
 * used to hold the four methods as closures over a scope of its own (docs/firefox-60fps-plan.md "The collector's window"). */
class MeshLod {
  constructor() {
    this.faceWords=undefined;
    this.kernel=undefined;
    this.topology=undefined;
    this.special=undefined;
    this.N=undefined;
    this.V=undefined;
    this.F=undefined;
    this.lod=undefined;
    this.alphas=null;
    this.lighting=null;
  }
  lightingOf(count,resolved){
    // (made at the first reduced face list: most bindings never draw one)
    const lighting=this.lighting??=new Map();
    let entry=lighting.get(count);
    if(entry){lighting.delete(count);lighting.set(count,entry);return entry;}
    const words=new Uint32Array(this.F*4);
    for(let i=0;i<this.F;i++){
      const at=i*3,flags=this.faceWords[i*4+3];
      if(resolved[at]<0){words[i*4+3]=(flags|PF_INVISIBLE)>>>0;continue;}
      words[i*4]=resolved[at];words[i*4+1]=resolved[at+1];words[i*4+2]=resolved[at+2];words[i*4+3]=flags;
    }
    entry={faceWords:words};
    lighting.set(count,entry);
    if(lighting.size>6){const [oldest,old]=lighting.entries().next().value;lighting.delete(oldest);this.kernel?.releaseLightingMesh(old.faceWords);}
    return entry;
  }
  /** Every frame vertex a corner of `faceIndices` can draw under any
   * count: its wedge collapse chain's vertices and their collapse targets
   * (a morph moves a vertex toward its target), sorted. */
  closure(faceIndices){
    const {faces:wedgesOf,wedges,collapseWedges,collapsePoints}=this.topology,set=new Set();
    for(const face of faceIndices)for(let corner=0;corner<3;corner++){
      let wedge=wedgesOf[face*4+corner];
      for(let steps=0;steps<=wedges.length;steps++){
        const vertex=wedges[wedge]&0xffff;
        set.add(vertex+this.special);set.add(collapsePoints[vertex]+this.special);
        const next=collapseWedges[wedge];
        if(next===wedge)break;
        wedge=next;
      }
    }
    return [...set].sort((a,b)=>a-b);
  }
  /** The selection for this frame (selectLodMesh) from the actor's
   * Location, DrawScale and LODBias. */
  select(frame,location,drawScale,lodBias){
    return selectLodMesh(this.topology,frame.settings,{location,drawScale,lodBias},frame.coords,frame);
  }
  /** After GetFrame returned `count` ordinary vertices into `output`
   * (12-byte stride, special vertices first): the drawn positions (the
   * output itself, or a morphed copy of its own, which a later call, another
   * frame's, leaves alone), the final flags, the per-face
   * resolved vertices (special prefix included; -1 for a face above the
   * count) and packed wedge dwords while the LOD flag holds, and the
   * lighting topology of those faces. */
  after(selection,count,output){
    const source=new Float32Array(output.buffer,output.byteOffset,this.V*3);
    let positions=source,state,resolved=null,scratch=null;
    if(this.lod){
      const work=selection.morph?{positions:0,stride:3,alphas:this.V*3,alphaStride:1}:null;
      if(work){
        const words=this.lod.words(this.V*3+this.N);
        words.floats.set(source,0);
        state=this.lod.morphWords(this.topology,selection,count,{...work,positions:this.special*3,alphas:this.V*3});
        if(state.morph)positions=Float32Array.from(this.lod.words(this.V*3+this.N).floats.subarray(0,this.V*3));
      }else state={active:selection.active&&count<this.N,morph:false,start:0,count};
      if(state.active){
        // Alphas stay at WORK[V*3..] from the morph above; without a morph
        // no corner reads them.
        const out=this.lod.cornersWords(this.topology,state,{alphas:this.V*3,alphaStride:1,wordsBefore:this.V*3+this.N});
        resolved=new Int32Array(this.F*3);scratch=Uint32Array.from(out.scratch);
        for(let i=0;i<this.F*3;i++){const v=out.faces[i];resolved[i]=v===0xffffffff?-1:v+this.special;}
      }
    }else{
      if(selection.morph)positions=Float32Array.from(source);
      const base=this.special*3;
      // (the JavaScript morph's alphas, made at its first use: the kernel path keeps its own)
      const alphas=this.alphas??=new Uint32Array(this.N);
      state=morphLodMesh(this.topology,selection,count,{
        vertex:i=>[positions[base+i*3],positions[base+i*3+1],positions[base+i*3+2]],
        setVertex:(i,xyz)=>{positions[base+i*3]=xyz[0];positions[base+i*3+1]=xyz[1];positions[base+i*3+2]=xyz[2];},
        setAlpha:(i,alpha)=>{alphaFloat[0]=alpha;alphas[i]=alphaWord[0];}});
      if(!state.morph)positions=source;
      if(state.active){
        const corners=lodMeshCorners(this.topology,state,v=>alphas[v]);
        resolved=new Int32Array(this.F*3);scratch=corners.scratch;
        corners.faces.forEach((face,i)=>{for(let k=0;k<3;k++)resolved[i*3+k]=face?face[k]+this.special:-1;});
      }
    }
    const light=state.active?this.lightingOf(count,resolved):{faceWords:this.faceWords};
    return {state,positions,resolved,scratch,lighting:light};
  }
  dispose(){
    if(!this.lighting)return;
    for(const entry of this.lighting.values())this.kernel?.releaseLightingMesh(entry.faceWords);
    this.lighting.clear();
  }
}

/** One binding's LOD state. `faceWords` are the mesh's faces (MeshFaces.words,
 * mesh-faces.mjs): [v0, v1, v2, flags] with the special prefix in the vertices. */
export function createMeshLod(payload,faceWords,{kernel=null}={}) {
  const inst=new MeshLod();
  inst.faceWords=faceWords; inst.kernel=kernel;
  inst.topology=meshLodTopology(payload);
  if(!inst.topology)return null;
  const {special,modelVerts:N}=inst.topology; inst.special=special; inst.N=N; inst.V=payload.frameVertexCount; inst.F=inst.topology.faceCount;
  inst.lod=inst.kernel?.lod??null;
  // The topology's upload writes the kernel's WORK area: do it before `after` stages positions there.
  inst.lod?.handleOf(inst.topology);
  return inst;
}
