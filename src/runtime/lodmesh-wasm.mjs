/** Bulk vertex ABI; state/caches remain owned by the original JS GetFrame. */
import {LodMeshError} from './lodmesh.mjs';

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
  const {memory,reserve,pose}=instance.exports;
  return {name:'rust-wasm',run({source,frameVertexCount,count,first=0,second=0,alpha=0,
    tween=false,blend=false,entry,output,stride,matrix,origin}) {
    if(count<=0)return;
    const firstAt=64,secondAt=firstAt+8*count,baseAt=secondAt+8*count;
    const cacheAt=baseAt+8*count,outAt=cacheAt+12*count,bytes=outAt+count*stride;
    const ptr=reserve(bytes/4);
    // reserve may grow memory, invalidating all earlier typed-array views.
    const scratch=new Uint8Array(memory.buffer,ptr,bytes);
    const floats=new Float32Array(memory.buffer,ptr,16);
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
    const alphaBits=new DataView(memory.buffer,ptr+60,4);
    alphaBits.setFloat32(0,alpha,true);
    pose(count,stride/4,alphaBits.getUint32(0,true),Number(tween),Number(blend));
    cacheBytes.set(scratch.subarray(cacheAt,outAt));
    output.set(scratch.subarray(outAt));
  }};
}
