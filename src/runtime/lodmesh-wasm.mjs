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
    release_light_mesh:releaseLightMesh,light_mesh:lightMesh,pose_count:poseCount}=instance.exports;
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
    /** Diagnostics: vertices posed by the exact integer path and by the
     * general extended-precision loop (docs/lodmesh-wasm.md). */
    poseCounts:()=>poseCount?{double:poseCount(3)>>>0,exact:poseCount(0)>>>0,
      nonFinite:poseCount(1)>>>0,extended:poseCount(2)>>>0}:null,
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
  },light({points,faces,origin,axes,ambient,scaleGlow,unlit,lights,flags}) {
    const vertexCount=points.length/3,faceCount=faces.length/4,lightCount=lights.length;
    if(!Number.isInteger(vertexCount)||!Number.isInteger(faceCount))throw new TypeError('Invalid mesh-lighting buffers');
    const mesh=lightingMesh(faces);
    const header=20,pointsAt=header,lightsAt=pointsAt+vertexCount*3;
    const cameraAt=lightsAt+lightCount*7,normalsAt=cameraAt+vertexCount*3,litAt=normalsAt+vertexCount*3;
    const drawnAt=litAt+vertexCount,vertexLightAt=drawnAt+faceCount,colorsAt=vertexLightAt+vertexCount*3;
    const words=colorsAt+faceCount*9;
    const views=work(words),floats=views.floats;
    floats.set(origin,0);
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
  return kernel;
}
