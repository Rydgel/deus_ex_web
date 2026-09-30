/** GPU evaluation of GetFrame and DrawLodMesh lighting for Play's actor
 * meshes (docs/gpu-mesh.md). Raw WebGL2 resources and passes; the draw
 * materials bind the results through three.js ExternalTextures. The CPU
 * kernels remain the reference; nothing here chooses frames, lights or
 * visibility. */
import * as THREE from 'three';
import {squareRootTable} from '../runtime/dynamic-lighting.mjs';
import {rsqrtTables} from '../runtime/mesh-lighting.mjs';
import {WIDTH,COMMON,FLOAT_FLOAT,FULLSCREEN_VERTEX,POSE_FRAGMENT,FACE_FRAGMENT,VERTEX_FRAGMENT,CORNER_FRAGMENT,ENVIRONMENT_UV}
  from './gpu-mesh-glsl.mjs';

export const GPU_MESH_MAX_LIGHTS=32;
const PARAMS_U=9,PARAMS_F=12,STATES=5;
const f32=Math.fround;
// 1.4 as a float-float pair: the kernel multiplies ScaleGlow by the f64 1.4.
const GLOW_HI=f32(1.4),GLOW_LO=f32(1.4-GLOW_HI);
// D3D diffuse scale (diffuse_channel): float(255*float(1/255)).
if(f32(255*f32(1/255))!==1)throw new Error('GPU mesh assumes the D3D diffuse scale is exactly 1');

class Arena {
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
const rowsFor=count=>Math.max(1,Math.ceil(count/WIDTH));

export function createGpuMesh(renderer,{vertexCapacity=1<<17,faceCapacity=1<<18,cornerCapacity=3<<18,
  slotCapacity=2048,keyframeCapacity=1<<21,lightCapacity=1<<15}={}) {
  const gl=renderer.getContext();
  if(!(gl instanceof WebGL2RenderingContext))throw new Error('GPU mesh requires WebGL2');
  if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('GPU mesh requires EXT_color_buffer_float');
  const drawBuffers=gl.getParameter(gl.MAX_DRAW_BUFFERS);
  if(drawBuffers<1+STATES)throw new Error(`GPU mesh needs ${1+STATES} draw buffers, device has ${drawBuffers}`);

  // ---- programs
  const compile=(type,source)=>{
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(`GPU mesh shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const vertexShader=compile(gl.VERTEX_SHADER,FULLSCREEN_VERTEX);
  const program=source=>{
    const handle=gl.createProgram();gl.attachShader(handle,vertexShader);gl.attachShader(handle,compile(gl.FRAGMENT_SHADER,source));
    gl.linkProgram(handle);
    if(!gl.getProgramParameter(handle,gl.LINK_STATUS))throw new Error(`GPU mesh program: ${gl.getProgramInfoLog(handle)}`);
    const locations=new Map();
    const count=gl.getProgramParameter(handle,gl.ACTIVE_UNIFORMS);
    for(let i=0;i<count;i++){const info=gl.getActiveUniform(handle,i);locations.set(info.name,gl.getUniformLocation(handle,info.name));}
    return {handle,locations};
  };
  const programs={pose:program(POSE_FRAGMENT),face:program(FACE_FRAGMENT),vertex:program(VERTEX_FRAGMENT),
    corner:program(CORNER_FRAGMENT)};
  const vao=gl.createVertexArray();

  // ---- textures
  const texture=(internal,format,type,width,height)=>{
    const handle=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,handle);
    gl.texStorage2D(gl.TEXTURE_2D,1,internal,width,height);
    for(const [name,value] of [[gl.TEXTURE_MIN_FILTER,gl.NEAREST],[gl.TEXTURE_MAG_FILTER,gl.NEAREST],
      [gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,name,value);
    return {handle,internal,format,type,width,height};
  };
  const RGBA32F=[gl.RGBA32F,gl.RGBA,gl.FLOAT],RGBA32UI=[gl.RGBA32UI,gl.RGBA_INTEGER,gl.UNSIGNED_INT];
  const RG32UI=[gl.RG32UI,gl.RG_INTEGER,gl.UNSIGNED_INT],RGBA16I=[gl.RGBA16I,gl.RGBA_INTEGER,gl.SHORT];
  const RGBA8UI=[gl.RGBA8UI,gl.RGBA_INTEGER,gl.UNSIGNED_BYTE];
  const texels=(spec,count)=>texture(...spec,WIDTH,rowsFor(count));
  const vertexRows=rowsFor(vertexCapacity),faceRows=rowsFor(faceCapacity),cornerRows=rowsFor(cornerCapacity);
  const tables=texture(...RGBA32UI,WIDTH,1);
  const keyframes=texels(RGBA16I,keyframeCapacity),meshFaces=texels(RGBA32UI,faceCapacity);
  const meshVertices=texels(RG32UI,vertexCapacity),adjacency=texels(RGBA32UI,faceCapacity*3/4);
  const vertexMap=texels(RG32UI,vertexCapacity),faceMap=texels(RG32UI,faceCapacity),cornerMap=texels(RG32UI,cornerCapacity);
  const paramsU=texture(...RGBA32UI,PARAMS_U,slotCapacity),paramsF=texture(...RGBA32F,PARAMS_F,slotCapacity);
  const lightTexture=texels(RGBA32F,lightCapacity*2);
  const pose=[0,1].map(()=>Array.from({length:1+STATES},()=>texels(RGBA32F,vertexCapacity)));
  const faceNormals=texels(RGBA32F,faceCapacity),environmentFaces=texels(RGBA32F,faceCapacity);
  const vertexLight=texels(RGBA32F,vertexCapacity),environmentNormals=texels(RGBA32F,vertexCapacity);
  const corners=texels(RGBA8UI,cornerCapacity);

  const upload=(target,x,y,width,height,data)=>{
    gl.bindTexture(gl.TEXTURE_2D,target.handle);
    gl.texSubImage2D(gl.TEXTURE_2D,0,x,y,width,height,target.format,target.type,data);
  };
  // Row-aligned range upload: data covers whole texels starting at `start`.
  const uploadRange=(target,start,components,data)=>{
    const count=data.length/components;
    let at=0;
    while(at<count){
      const texel=start+at,x=texel%WIDTH,y=Math.floor(texel/WIDTH),n=Math.min(WIDTH-x,count-at);
      upload(target,x,y,n,1,data.subarray(at*components,(at+n)*components));at+=n;
    }
  };
  const framebuffer=attachments=>{
    const handle=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,handle);
    attachments.forEach((target,i)=>gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0+i,gl.TEXTURE_2D,target.handle,0));
    const status=gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if(status!==gl.FRAMEBUFFER_COMPLETE)throw new Error(`GPU mesh framebuffer incomplete: 0x${status.toString(16)}`);
    return {handle,count:attachments.length,attachments};
  };
  const poseFramebuffers=pose.map(framebuffer);
  const faceFramebuffer=framebuffer([faceNormals,environmentFaces]);
  const vertexFramebuffer=framebuffer([vertexLight,environmentNormals]);
  const cornerFramebuffer=framebuffer([corners]);
  {
    // Zero the ping-pong targets so copied-through free texels are defined.
    for(const fb of poseFramebuffers){
      gl.bindFramebuffer(gl.FRAMEBUFFER,fb.handle);
      gl.drawBuffers(fb.attachments.map((_,i)=>gl.COLOR_ATTACHMENT0+i));
      for(let i=0;i<fb.count;i++)gl.clearBufferfv(gl.COLOR,i,[0,0,0,0]);
    }
    const words=new Uint32Array(WIDTH*4);
    const tableWords=[...squareRootTable(),...rsqrtTables().exponent,...rsqrtTables().mantissa];
    words.set(tableWords);
    upload(tables,0,0,WIDTH,1,words);
  }
  const external=target=>{const t=new THREE.ExternalTexture(target.handle);return t;};
  const cornerColors=(()=>{
    // Exact f32(byte/255), the CPU path's deusLight values.
    const data=new Float32Array(256*4);
    for(let i=0;i<256;i++)data[i*4]=f32(i/255);
    const t=new THREE.DataTexture(data,256,1,THREE.RGBAFormat,THREE.FloatType);
    t.needsUpdate=true;return t;
  })();
  const shared={
    deusPose:{value:external(pose[0][0])},deusCorners:{value:external(corners)},
    deusEnvironmentNormals:{value:external(environmentNormals)},deusByteColors:{value:cornerColors},
    deusCameraHi:{value:new THREE.Vector3()},deusCameraLo:{value:new THREE.Vector3()},deusZero:{value:0},
  };

  // ---- CPU mirrors of the per-frame parameters
  const slotParamsU=new Uint32Array(slotCapacity*PARAMS_U*4),slotParamsF=new Float32Array(slotCapacity*PARAMS_F*4);
  const lightData=new Float32Array(lightCapacity*8);
  let lightCount=0,dirtyLow=Infinity,dirtyHigh=-1;
  const slots=new Arena(slotCapacity),vertexArena=new Arena(vertexCapacity),faceArena=new Arena(faceCapacity);
  const cornerArena=new Arena(cornerCapacity),keyArena=new Arena(keyframeCapacity);
  const meshVertexArena=new Arena(vertexCapacity),meshFaceArena=new Arena(faceCapacity),adjacencyArena=new Arena(faceCapacity*3);
  let frame=0,current=0,camera=null;
  const meshes=new Map();

  /** Static mesh data shared by every actor with that mesh. `faces` are
   * [v0, v1, v2, flags] words in draw order (DrawLodMesh's face list). */
  function mesh(payload,faceWords) {
    let record=meshes.get(payload);
    if(record){record.users++;return record;}
    const V=payload.frameVertexCount,F=faceWords.length/4;
    const data=payload.arrays.get(0x60).load().data;
    const keyTexels=data.byteLength/8;
    if(!Number.isInteger(keyTexels)||data.byteOffset%2)throw new Error('GPU mesh: unexpected keyframe record layout');
    const keyBase=keyArena.allocate(keyTexels),faceBase=meshFaceArena.allocate(F),vertBase=meshVertexArena.allocate(V);
    // Adjacency: each vertex's faces in ascending face order, with repeats
    // for a vertex that occurs twice in a face, as the kernel adds it twice.
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
    const adjacencyStart=Math.ceil(adjacencyBase/4)*4;
    uploadRange(keyframes,keyBase,4,new Int16Array(data.buffer,data.byteOffset,keyTexels*4));
    uploadRange(meshFaces,faceBase,4,Uint32Array.from(faceWords));
    const vertexWords=new Uint32Array(V*2),listWords=new Uint32Array(Math.ceil(total/4)*4);
    let at=0;
    lists.forEach((list,v)=>{vertexWords[v*2]=adjacencyStart+at;vertexWords[v*2+1]=list.length;listWords.set(list,at);at+=list.length;});
    uploadRange(meshVertices,vertBase,2,vertexWords);
    if(listWords.length)uploadRange(adjacency,adjacencyStart/4,4,listWords);
    record={payload,V,F,keyBase,faceBase,vertBase,adjacencyBase,adjacencyCount:total+4,keyTexels,users:1};
    meshes.set(payload,record);
    return record;
  }
  function releaseMesh(record) {
    if(--record.users>0)return;
    meshes.delete(record.payload);
    keyArena.release(record.keyBase,record.keyTexels);meshFaceArena.release(record.faceBase,record.F);
    meshVertexArena.release(record.vertBase,record.V);adjacencyArena.release(record.adjacencyBase,record.adjacencyCount);
  }
  const mapWords=(slot,count)=>{const words=new Uint32Array(count*2);for(let i=0;i<count;i++){words[i*2]=slot+1;words[i*2+1]=i;}return words;};

  /** An actor slot: its vertex, face and corner texel ranges. */
  function allocate(payload,faceWords,{environment=false}={}) {
    const record=mesh(payload,faceWords);
    const slot=slots.allocate(1),vbase=vertexArena.allocate(record.V),fbase=faceArena.allocate(record.F);
    const cbase=cornerArena.allocate(record.F*3);
    if([slot,vbase,fbase,cbase].some(base=>base<0)){
      if(slot>=0)slots.release(slot,1);if(vbase>=0)vertexArena.release(vbase,record.V);
      if(fbase>=0)faceArena.release(fbase,record.F);if(cbase>=0)cornerArena.release(cbase,record.F*3);
      releaseMesh(record);throw new Error('GPU mesh capacity exceeded');
    }
    uploadRange(vertexMap,vbase,2,mapWords(slot,record.V));
    uploadRange(faceMap,fbase,2,mapWords(slot,record.F));
    uploadRange(cornerMap,cbase,2,mapWords(slot,record.F*3));
    const u=slotParamsU.subarray(slot*PARAMS_U*4,(slot+1)*PARAMS_U*4);u.fill(0);
    u.set([record.keyBase,record.V,record.faceBase,record.F, record.vertBase,vbase,fbase,cbase]);
    u[12]=environment?1:0;
    slotParamsF.subarray(slot*PARAMS_F*4,(slot+1)*PARAMS_F*4).fill(0);
    touch(slot);
    return {slot,vbase,fbase,cbase,mesh:record,environment,released:false};
  }
  function release(handle) {
    if(handle.released)return;handle.released=true;
    const {slot,vbase,fbase,cbase,mesh:record}=handle;
    uploadRange(vertexMap,vbase,2,new Uint32Array(record.V*2));
    uploadRange(faceMap,fbase,2,new Uint32Array(record.F*2));
    uploadRange(cornerMap,cbase,2,new Uint32Array(record.F*6));
    vertexArena.release(vbase,record.V);faceArena.release(fbase,record.F);cornerArena.release(cbase,record.F*3);
    slots.release(slot,1);releaseMesh(record);
  }
  function touch(slot){dirtyLow=Math.min(dirtyLow,slot);dirtyHigh=Math.max(dirtyHigh,slot);}
  /** This frame's GetFrame plan (lodmesh-frame.mjs planLodMeshFrame). */
  function setPose(handle,plan) {
    const {slot}=handle,u=slot*PARAMS_U*4,fl=slot*PARAMS_F*4;
    if(plan.channels.some(op=>op.fill))throw new Error('GPU mesh: tween count expansion is CPU-only');
    for(let row=0;row<4;row++)for(let i=0;i<3;i++)slotParamsF[fl+row*4+i]=plan.matrix[row][i];
    for(let i=0;i<3;i++)slotParamsF[fl+16+i]=plan.origin[i];
    for(let k=0;k<STATES;k++){slotParamsU.fill(0,u+(4+k)*4,u+(5+k)*4);slotParamsF[fl+(5+k)*4]=0;}
    for(const op of plan.channels){
      if(op.count!==handle.mesh.V)throw new Error('GPU mesh: partial GetFrame counts are CPU-only');
      const k=op.channel+1;
      slotParamsU.set([op.tween?2:1,op.first,op.second,op.blend?1:0],u+(4+k)*4);
      slotParamsF[fl+(5+k)*4]=op.alpha;
    }
    slotParamsU[u+8+2]=frame+1;
    touch(slot);
  }
  /** SetupForActor's result for this frame (mesh-lighting-view setupMesh). */
  function setLighting(handle,{flags,ambient,scaleGlow,unlit,lights}) {
    if(lights.length>GPU_MESH_MAX_LIGHTS)return false;
    if(lightCount+lights.length>lightCapacity)return false;
    const {slot}=handle,u=slot*PARAMS_U*4,fl=slot*PARAMS_F*4;
    slotParamsU[u+8]=flags>>>0;slotParamsU[u+8+1]=lightCount;slotParamsU[u+8+3]=frame+1;
    slotParamsU[u+12+1]=lights.length;
    slotParamsF[fl+40]=ambient[0];slotParamsF[fl+41]=ambient[1];slotParamsF[fl+42]=ambient[2];slotParamsF[fl+43]=scaleGlow;
    slotParamsF[fl+44]=unlit[0];slotParamsF[fl+45]=unlit[1];slotParamsF[fl+46]=unlit[2];
    for(const light of lights){
      const at=lightCount*8,{location,color}=light;
      lightData[at]=location[0];lightData[at+1]=location[1];lightData[at+2]=location[2];lightData[at+3]=light.rradius;
      lightData[at+4]=color[0];lightData[at+5]=color[1];lightData[at+6]=color[2];lightData[at+7]=0;
      lightCount++;
    }
    touch(slot);
    return true;
  }
  /** The main frame's lighting coordinates (mesh-lighting-view beginFrame). */
  function setCamera(origin,axes){camera={origin,axes};}
  /** The render camera for environment UVs, as a float-float pair. */
  function setViewCamera(position){
    const hi=position.map(f32);shared.deusCameraHi.value.set(...hi);
    shared.deusCameraLo.value.set(...position.map((value,i)=>f32(value-hi[i])));
  }

  const bindTextures=(prog,list)=>{
    list.forEach(([name,target],unit)=>{
      gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,target.handle);
      const location=prog.locations.get(name);if(location)gl.uniform1i(location,unit);
    });
  };
  const draw=(prog,fb,rows)=>{
    if(rows<=0)return;
    gl.bindFramebuffer(gl.FRAMEBUFFER,fb.handle);
    gl.drawBuffers(fb.attachments.map((_,i)=>gl.COLOR_ATTACHMENT0+i));
    gl.viewport(0,0,WIDTH,rows);
    gl.drawArrays(gl.TRIANGLES,0,3);
  };
  const setUniforms=prog=>{
    const u=prog.locations;
    if(u.get('uZero'))gl.uniform1ui(u.get('uZero'),0);
    if(u.get('uFrame'))gl.uniform1ui(u.get('uFrame'),frame);
    if(camera&&u.get('uCameraOrigin')){
      gl.uniform3fv(u.get('uCameraOrigin'),camera.origin);gl.uniform3fv(u.get('uCameraX'),camera.axes[0]);
      gl.uniform3fv(u.get('uCameraY'),camera.axes[1]);gl.uniform3fv(u.get('uCameraZ'),camera.axes[2]);
    }
    if(u.get('uGlow'))gl.uniform2f(u.get('uGlow'),GLOW_HI,GLOW_LO);
  };

  /** Run this frame's passes; afterwards three.js state is reset. */
  function run() {
    frame++;
    if(dirtyHigh>=dirtyLow){
      const rows=dirtyHigh-dirtyLow+1;
      upload(paramsU,0,dirtyLow,PARAMS_U,rows,slotParamsU.subarray(dirtyLow*PARAMS_U*4,(dirtyHigh+1)*PARAMS_U*4));
      upload(paramsF,0,dirtyLow,PARAMS_F,rows,slotParamsF.subarray(dirtyLow*PARAMS_F*4,(dirtyHigh+1)*PARAMS_F*4));
    }
    if(lightCount)uploadRange(lightTexture,0,4,lightData.subarray(0,lightCount*8));
    // The frame numbers written by setPose/setLighting were frame+1 before
    // the increment above; they now equal `frame`.
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);gl.colorMask(true,true,true,true);
    const previous=pose[current],next=pose[current^1];
    const vRows=rowsFor(vertexArena.high),fRows=rowsFor(faceArena.high),cRows=rowsFor(cornerArena.high);
    // Pose.
    let prog=programs.pose;gl.useProgram(prog.handle);setUniforms(prog);
    bindTextures(prog,[['uParamsU',paramsU],['uParamsF',paramsF],['uVertexMap',vertexMap],['uKeyframes',keyframes],
      ['uPrevPose',previous[0]],...previous.slice(1).map((target,k)=>[`uPrevState${k}`,target])]);
    draw(prog,poseFramebuffers[current^1],vertexArena.high?vRows:0);
    current^=1;
    // Faces.
    prog=programs.face;gl.useProgram(prog.handle);setUniforms(prog);
    bindTextures(prog,[['uParamsU',paramsU],['uParamsF',paramsF],['uTables',tables],['uFaceMap',faceMap],
      ['uMeshFaces',meshFaces],['uPose',next[0]]]);
    draw(prog,faceFramebuffer,faceArena.high?fRows:0);
    // Vertices.
    prog=programs.vertex;gl.useProgram(prog.handle);setUniforms(prog);
    bindTextures(prog,[['uParamsU',paramsU],['uParamsF',paramsF],['uTables',tables],['uVertexMap',vertexMap],
      ['uMeshVertices',meshVertices],['uAdjacency',adjacency],['uPose',next[0]],['uFaces',faceNormals],
      ['uEnvironmentFaces',environmentFaces],['uLights',lightTexture]]);
    draw(prog,vertexFramebuffer,vertexArena.high?vRows:0);
    // Corners.
    prog=programs.corner;gl.useProgram(prog.handle);setUniforms(prog);
    bindTextures(prog,[['uParamsU',paramsU],['uParamsF',paramsF],['uCornerMap',cornerMap],['uMeshFaces',meshFaces],
      ['uMeshVertices',meshVertices],['uAdjacency',adjacency],['uFaces',faceNormals],['uLight',vertexLight]]);
    draw(prog,cornerFramebuffer,cornerArena.high?cRows:0);
    gl.bindVertexArray(null);
    shared.deusPose.value.sourceTexture=next[0].handle;
    renderer.resetState();
    dirtyLow=Infinity;dirtyHigh=-1;lightCount=0;
  }

  /** Validation only: the draw shader's environmentUV for every vertex of
   * `handle` from `position` (a camera in original coordinates, doubles). */
  let uvProgram=null,uvTarget=null,uvFramebuffer=null;
  function environmentUVs(handle,position) {
    uvProgram??=program(`${COMMON}uniform usampler2D uVertexMap;uniform sampler2D uPose,uEnvironment;
uniform vec3 uCameraHi,uCameraLo;${ENVIRONMENT_UV}out vec4 oUV;
void main(){uint t=texelIndex();vec3 p=texelFetch(uPose,at(t),0).xyz,n=texelFetch(uEnvironment,at(t),0).xyz;
  oUV=vec4(environmentUV(p,n,uCameraHi,uCameraLo),0.0,1.0);}`);
    uvTarget??=texels(RGBA32F,vertexCapacity);uvFramebuffer??=framebuffer([uvTarget]);
    gl.bindVertexArray(vao);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(uvProgram.handle);setUniforms(uvProgram);
    const hi=position.map(f32),lo=position.map((value,i)=>f32(value-hi[i]));
    gl.uniform3fv(uvProgram.locations.get('uCameraHi'),hi);gl.uniform3fv(uvProgram.locations.get('uCameraLo'),lo);
    bindTextures(uvProgram,[['uPose',pose[current][0]],['uEnvironment',environmentNormals]]);
    draw(uvProgram,uvFramebuffer,rowsFor(vertexArena.high));
    gl.bindVertexArray(null);renderer.resetState();
    return read('uv',handle.vbase,handle.mesh.V);
  }
  /** Validation readback of texel ranges (never used by Play). */
  function read(name,start,count) {
    const targets={pose:[pose[current][0],gl.FLOAT,4,Float32Array],faces:[faceNormals,gl.FLOAT,4,Float32Array],
      light:[vertexLight,gl.FLOAT,4,Float32Array],corners:[corners,gl.UNSIGNED_INT,4,Uint32Array],
      environment:[environmentNormals,gl.FLOAT,4,Float32Array],uv:[uvTarget,gl.FLOAT,4,Float32Array],environmentFaces:[environmentFaces,gl.FLOAT,4,Float32Array],
      ...Object.fromEntries([0,1,2,3,4].map(k=>[`state${k}`,[pose[current][1+k],gl.FLOAT,4,Float32Array]]))};
    const [target,type,components,Type]=targets[name];
    const fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target.handle,0);
    const out=new Type(count*components),row=new Type(WIDTH*components);
    const format=type===gl.FLOAT?gl.RGBA:gl.RGBA_INTEGER;
    let at=0;
    while(at<count){
      const texel=start+at,x=texel%WIDTH,y=Math.floor(texel/WIDTH),n=Math.min(WIDTH-x,count-at);
      gl.readPixels(x,y,n,1,format,type,row);
      out.set(row.subarray(0,n*components),at*components);at+=n;
    }
    gl.deleteFramebuffer(fb);renderer.resetState();
    return out;
  }

  return {allocate,release,setPose,setLighting,setCamera,setViewCamera,run,read,environmentUVs,shared,
    get frame(){return frame;},
    stats:()=>({slots:slots.high,vertices:vertexArena.high,faces:faceArena.high,corners:cornerArena.high,
      keyframes:keyArena.high,meshes:meshes.size}),
    dispose(){
      for(const target of [tables,keyframes,meshFaces,meshVertices,adjacency,vertexMap,faceMap,cornerMap,paramsU,paramsF,
        lightTexture,...pose.flat(),faceNormals,environmentFaces,vertexLight,environmentNormals,corners])gl.deleteTexture(target.handle);
      for(const fb of [...poseFramebuffers,faceFramebuffer,vertexFramebuffer,cornerFramebuffer])gl.deleteFramebuffer(fb.handle);
      for(const prog of Object.values(programs))gl.deleteProgram(prog.handle);
      gl.deleteVertexArray(vao);cornerColors.dispose();renderer.resetState();
    }};
}

/** Vertex-shader code for the draw materials: position from the pose
 * texture (the viewer's [x,y,z] -> [y,z,-x] reflection), corner colour from
 * the corner texture, environment UVs from the render camera. */
export const DRAW_VERTEX_DECLARATIONS=`
uniform highp sampler2D deusPose,deusEnvironmentNormals,deusByteColors;uniform highp usampler2D deusCorners;
uniform vec3 deusCameraHi,deusCameraLo;uniform uint deusZero;uniform float deusGpu;
attribute float deusVertexTexel,deusCornerTexel;
${FLOAT_FLOAT.replace(/\bZERO\b/g,'deusZero')}
${ENVIRONMENT_UV}
`;
