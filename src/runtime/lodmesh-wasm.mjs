/** Bulk vertex ABI; state/caches remain owned by the original JS GetFrame. */
import {LodMeshError} from './lodmesh.mjs';
import {squareRootTable} from './dynamic-lighting.mjs';
import {rsqrtTables} from './mesh-lighting.mjs';

let pending;
export function loadLodMeshKernel() {
  return pending??=load();
}
async function load() {
  const url=new URL('./lodmesh-kernel.wasm',import.meta.url);
  let bytes;
  if(url.protocol==='file:') {
    const module='node:fs/promises';
    bytes=await (await import(/* @vite-ignore */ module)).readFile(url);
  } else {
    const response=await fetch(url);
    if(!response.ok)throw new Error(`Cannot load mesh kernel: HTTP ${response.status}`);
    bytes=await response.arrayBuffer();
  }
  return createLodMeshKernel((await WebAssembly.instantiate(bytes)).instance);
}

export function createLodMeshKernel(instance) {
  const {memory,reserve,pose,init_lighting:initializeLighting,upload_light_mesh:uploadLightMesh,
    release_light_mesh:releaseLightMesh,light_mesh:lightMesh,pose_count:poseCount,lod_select:lodSelect,
    upload_lod_mesh:uploadLodMesh,release_lod_mesh:releaseLodMesh,lod_morph:lodMorph,lod_corners:lodCorners}=instance.exports;
  let workPtr=-1,workBuffer=null,words=null,floats=null,scratch=null;
  const outputs=new Map();
  const work=count=>{
    const nextPtr=reserve(count),nextBuffer=memory.buffer;
    if(nextPtr!==workPtr||nextBuffer!==workBuffer){
      workPtr=nextPtr;workBuffer=nextBuffer;
      words=new Uint32Array(nextBuffer,nextPtr);floats=new Float32Array(nextBuffer,nextPtr);
      scratch=new Uint8Array(nextBuffer,nextPtr);outputs.clear();
    }
    return {words,floats,scratch};
  };
  // A kernel call may grow Wasm memory (its allocations detach the old
  // ArrayBuffer); the WORK pointer itself does not move during pose/light.
  const current=()=>{
    if(memory.buffer!==workBuffer){
      workBuffer=memory.buffer;
      words=new Uint32Array(workBuffer,workPtr);floats=new Float32Array(workBuffer,workPtr);
      scratch=new Uint8Array(workBuffer,workPtr);outputs.clear();
    }
    return {words,floats,scratch};
  };
  const squareRoots=squareRootTable(),roots=rsqrtTables(),tableWords=squareRoots.length+roots.exponent.length+roots.mantissa.length;
  let at=0,initial=work(tableWords);
  initial.words.set(squareRoots,at);at+=squareRoots.length;initial.words.set(roots.exponent,at);at+=roots.exponent.length;
  initial.words.set(roots.mantissa,at);initializeLighting();
  const lightingMeshes=new WeakMap();
  const lightingMesh=faces=>{
    let mesh=lightingMeshes.get(faces);
    if(mesh)return mesh;
    const faceCount=faces.length/4;
    if(!(faces instanceof Uint32Array)||!Number.isInteger(faceCount))throw new TypeError('Invalid mesh-lighting topology');
    const upload=work(faces.length);upload.words.set(faces,0);
    mesh={handle:uploadLightMesh(faceCount),faceCount};lightingMeshes.set(faces,mesh);
    return mesh;
  };
  const kernel={name:'rust-wasm',
    /** Diagnostics: vertices posed by the binary32 path and by the Ext
     * model rounded to 24 bits, for a pass with non-finite words and for a
     * declined vertex (docs/lodmesh-wasm.md). */
    poseCounts:()=>poseCount?{single:poseCount(0)>>>0,nonFinite:poseCount(1)>>>0,extended:poseCount(2)>>>0}:null,
    run({source,frameVertexCount,count,first=0,second=0,alpha=0,
    tween=false,blend=false,entry,output,stride,matrix,origin}) {
    if(count<=0)return;
    const firstAt=64,secondAt=firstAt+8*count,baseAt=secondAt+8*count;
    const cacheAt=baseAt+8*count,outAt=cacheAt+12*count,bytes=outAt+count*stride;
    const views=work(bytes/4),scratch=views.scratch,floats=views.floats,words=views.words;
    for(let i=0;i<4;i++)floats.set(matrix[i],i*3);
    floats.set(origin,12);
    const copyFrame=(frame,dst)=>{
      const at=frame*frameVertexCount*8,end=at+count*8;
      if(!Number.isSafeInteger(at)||at<0||end-2>source.byteLength)
        throw new LodMeshError('GetFrame accesses an unloaded/out-of-range vertex');
      scratch.set(new Uint8Array(source.buffer,source.byteOffset+at,Math.min(count*8,source.byteLength-at)),dst);
    };
    if(!tween)copyFrame(first,firstAt);
    if(alpha>0)copyFrame(second,secondAt);
    if(blend)copyFrame(0,baseAt);
    const cacheBytes=new Uint8Array(entry.vertices.buffer,entry.vertices.byteOffset,count*12);
    if(tween)scratch.set(cacheBytes,cacheAt);
    // Copy existing output even on a main pass to retain caller-owned padding.
    scratch.set(output.subarray(0,count*stride),outAt);
    floats[15]=alpha;
    pose(count,stride/4,words[15],Number(tween),Number(blend));
    const after=current().scratch;
    cacheBytes.set(after.subarray(cacheAt,outAt));
    output.set(after.subarray(outAt,outAt+count*stride));
  },light({points,faces,origin,axes,mirror=1,ambient,scaleGlow,unlit,lights,flags}) {
    const vertexCount=points.length/3,faceCount=faces.length/4,lightCount=lights.length;
    if(!Number.isInteger(vertexCount)||!Number.isInteger(faceCount))throw new TypeError('Invalid mesh-lighting buffers');
    const mesh=lightingMesh(faces);
    const header=20,pointsAt=header,lightsAt=pointsAt+vertexCount*3;
    const cameraAt=lightsAt+lightCount*7,normalsAt=cameraAt+vertexCount*3,litAt=normalsAt+vertexCount*3;
    const drawnAt=litAt+vertexCount,vertexLightAt=drawnAt+faceCount,colorsAt=vertexLightAt+vertexCount*3;
    const words=colorsAt+faceCount*9;
    const views=work(words),floats=views.floats;
    floats.set(origin,0);floats[3]=mirror;
    for(let axis=0;axis<3;axis++)floats.set(axes[axis],4+axis*3);
    floats.set(ambient,13);floats[16]=scaleGlow;floats.set(unlit,17);
    floats.set(points,pointsAt);
    for(let i=0;i<lightCount;i++){
      const info=lights[i],offset=lightsAt+i*7;
      floats.set(info.location,offset);floats[offset+3]=info.rradius;floats.set(info.color,offset+4);
    }
    lightMesh(mesh.handle,vertexCount,lightCount,flags>>>0);
    const after=current().floats;
    const key=`${colorsAt}:${faceCount}`;
    let output=outputs.get(key);
    if(!output){output=after.subarray(colorsAt,colorsAt+faceCount*9);outputs.set(key,output);}
    return output;
  },releaseLightingMesh(faces){
    const mesh=lightingMeshes.get(faces);
    if(mesh){releaseLightMesh(mesh.handle);lightingMeshes.delete(faces);}
  }};
  if(lodSelect)kernel.lod=createLodFacade({work,current,lodSelect,uploadLodMesh,releaseLodMesh,lodMorph,lodCorners});
  return kernel;
}

/** DrawLodMesh's distance LOD (native/lodmesh-kernel/src/lod.rs; the JS
 * reference is lodmesh-lod.mjs, whose argument shapes these take). A
 * topology's arrays upload once, keyed by its CollapsePointThus array. */
function createLodFacade({work,current,lodSelect,uploadLodMesh,releaseLodMesh,lodMorph,lodCorners}) {
  const handles=new WeakMap();
  const bitsOf=(()=>{const v=new DataView(new ArrayBuffer(4));return x=>(v.setFloat32(0,x,true),v.getUint32(0,true));})();
  const floatOf=(()=>{const v=new DataView(new ArrayBuffer(4));return w=>(v.setUint32(0,w>>>0,true),v.getFloat32(0,true));})();
  const handleOf=topology=>{
    let handle=handles.get(topology.collapsePoints);
    if(handle!==undefined)return handle;
    const {collapsePoints,faceLevel,faces,faceCount,collapseWedges,wedges}=topology;
    const words=work(collapsePoints.length+faceCount*4+wedges.length*2).words;
    let at=0;
    words.set(collapsePoints,at);at+=collapsePoints.length;words.set(faceLevel,at);at+=faceCount;
    for(let i=0;i<faceCount;i++)for(let j=0;j<3;j++)words[at++]=faces[i*4+j];
    words.set(collapseWedges,at);at+=collapseWedges.length;words.set(wedges,at);
    handle=uploadLodMesh(collapsePoints.length,faceCount,wedges.length);
    handles.set(topology.collapsePoints,handle);
    return handle;
  };
  const lod={
    handleOf,
    /** WORK's word and float views for `count` words (valid until the next
     * kernel call that may grow memory). */
    words(count){const views=work(count);return {words:views.words,floats:views.floats};},
    release(topology){const handle=handles.get(topology.collapsePoints);if(handle!==undefined){releaseLodMesh(handle);handles.delete(topology.collapsePoints);}},
    select(topology,renderer,actor,coords,{fx,tanFactor}){
      const words=work(38).words;
      words.set([topology.modelVerts>>>0,topology.lodStrengthBits>>>0,(topology.collapseCount??topology.collapsePoints.length)>>>0,
        bitsOf(topology.meshScaleMax),topology.lodMinVerts>>>0,bitsOf(topology.lodMorph),bitsOf(topology.lodZDisplace),
        bitsOf(renderer.shapeLOD),bitsOf(renderer.adjust),renderer.mode>>>0,bitsOf(renderer.fix),...actor.location.map(bitsOf),
        bitsOf(actor.drawScale),bitsOf(actor.lodBias),...coords.map(bitsOf),bitsOf(fx),bitsOf(tanFactor)],0);
      lodSelect();
      const out=current().words.subarray(30,38);
      if(out[7])throw new Error('DrawLodMesh LOD detail has no integer count');
      return {detail:floatOf(out[0]),requested:out[1]|0,active:Boolean(out[2]),morph:Boolean(out[3]),
        location:out[2]?[floatOf(out[4]),floatOf(out[5]),floatOf(out[6])]:null};
    },
    /** The morph over WORK words: `positions`/`alphas` word offsets and
     * strides. Returns {active, morph, start, count}. */
    morphWords(topology,selection,count,{positions,stride,alphas,alphaStride}){
      const packed=lodMorph(handleOf(topology),topology.modelVerts,bitsOf(topology.lodMorph),bitsOf(selection.detail),
        Number(selection.active)|Number(selection.morph)<<1,count,positions,stride,alphas,alphaStride)>>>0;
      return {active:Boolean(packed&1),morph:Boolean(packed&2),start:packed>>>2,count};
    },
    /** lodmesh-lod.mjs morphLodMesh's arguments over an 88-byte
     * FTransTexture buffer (validation); `ordinary` its byte offset. */
    morph(topology,selection,count,buffer,ordinary){
      const handle=handleOf(topology),words=work(buffer.byteLength/4);
      new Uint8Array(words.words.buffer,words.words.byteOffset,buffer.byteLength).set(buffer);
      const state=lod.morphWords(topology,selection,count,{positions:ordinary/4,stride:22,alphas:ordinary/4+20,alphaStride:22});
      const after=current().words;
      buffer.set(new Uint8Array(after.buffer,after.byteOffset,buffer.byteLength));
      void handle;
      return state;
    },
    /** The corner selection with alphas at WORK word `alphas` (stride
     * `alphaStride`) and `extra` words after them reserved: returns the
     * three ordinary vertices per face (-1 for a face above the count) and
     * the packed wedge dwords, as views valid until the next kernel call. */
    cornersWords(topology,state,{alphas,alphaStride,wordsBefore}){
      const handle=handleOf(topology),faceCount=topology.faceCount,wedgeCount=topology.wedges.length;
      const facesAt=wordsBefore,scratchAt=facesAt+faceCount*3;
      work(scratchAt+wedgeCount);
      const status=lodCorners(handle,Number(state.active)|Number(state.morph)<<1,state.start,state.count,alphas,alphaStride,facesAt,scratchAt);
      if(status)throw new Error('DrawLodMesh wedge collapse does not reach the vertex count');
      const words=current().words;
      return {faces:words.subarray(facesAt,facesAt+faceCount*3),scratch:words.subarray(scratchAt,scratchAt+wedgeCount)};
    },
    /** lodmesh-lod.mjs lodMeshCorners over an 88-byte buffer (validation). */
    corners(topology,state,buffer,ordinary){
      const words=work(buffer.byteLength/4).words;
      new Uint8Array(words.buffer,words.byteOffset,buffer.byteLength).set(buffer);
      const out=lod.cornersWords(topology,state,{alphas:ordinary/4+20,alphaStride:22,wordsBefore:buffer.byteLength/4});
      const faces=[];
      for(let i=0;i<topology.faceCount;i++)faces.push(out.faces[i*3]===0xffffffff?null:[out.faces[i*3],out.faces[i*3+1],out.faces[i*3+2]]);
      return {faces,scratch:Uint32Array.from(out.scratch)};
    },
  };
  return lod;
}
