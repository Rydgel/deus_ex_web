/** GPU evaluation of GetFrame and DrawLodMesh lighting for Play's actor
 * meshes (docs/gpu-mesh.md). Raw WebGL2 resources and passes; the draw
 * materials bind the results through three.js ExternalTextures. The CPU
 * kernels remain the reference; nothing here chooses frames, lights or
 * visibility. */
import * as THREE from 'three';
import {squareRootTable} from '../runtime/dynamic-lighting.mjs';
import {rsqrtTables} from '../runtime/mesh-lighting.mjs';
import {r24prod} from '../runtime/x87-pc24.mjs';
import {createGpuMeshLayout} from './gpu-mesh-layout.mjs';
import {PLAN_HEAD,PLAN_OP,LIGHTING_HEAD,LIGHTING_LIGHT} from './mesh-frame-pack.mjs';
import {WIDTH,COMMON,FLOAT_FLOAT,FULLSCREEN_VERTEX,poseFragment,FACE_FRAGMENT,VERTEX_FRAGMENT,CORNER_FRAGMENT,ENVIRONMENT_UV,
  MORPH_FRAGMENT,RESOLVE_FRAGMENT} from './gpu-mesh-glsl.mjs';

export {GPU_MESH_MAX_LIGHTS} from './gpu-mesh-layout.mjs';
const PARAMS_U=12,PARAMS_F=12,STATES=5;
const floatWord=(()=>{const v=new DataView(new ArrayBuffer(4));return x=>(v.setFloat32(0,x,true),v.getUint32(0,true));})();
// The pose pass's targets, split into two draws of three (docs/gpu-mesh.md
// "Pose pass targets"): drawn as one pass of all six RGBA32F targets, Chrome
// on an Apple M2 (ANGLE over Metal) intermittently lost blocks of the last
// target, the blend slot 3 cache pose.
const POSE_PARTS=[['oPose','oState0','oState1'],['oState2','oState3','oState4']];
const f32=Math.fround;
// FLightManager::Light's ScaleGlow*1.4 (a double constant), rounded once from
// the exact product as the render pass's precision control 24 does.
// D3D diffuse scale (diffuse_channel): float(255*float(1/255)).
if(f32(255*f32(1/255))!==1)throw new Error('GPU mesh assumes the D3D diffuse scale is exactly 1');

const rowsFor=count=>Math.max(1,Math.ceil(count/WIDTH));

/** `layout` (gpu-mesh-layout.mjs) places the texels; the simulation side
 * keeps its own with the same capacities and calls. */
export function createGpuMesh(renderer,capacities={}) {
  const layout=createGpuMeshLayout(capacities);
  const {vertexCapacity,faceCapacity,cornerCapacity,slotCapacity,keyframeCapacity,lightCapacity,wedgeCapacity,lodListCapacity}=layout.capacities;
  const gl=renderer.getContext();
  if(!(gl instanceof WebGL2RenderingContext))throw new Error('GPU mesh requires WebGL2');
  if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('GPU mesh requires EXT_color_buffer_float');
  const drawBuffers=gl.getParameter(gl.MAX_DRAW_BUFFERS),targets=Math.max(...POSE_PARTS.map(part=>part.length));
  if(drawBuffers<targets)throw new Error(`GPU mesh needs ${targets} draw buffers, device has ${drawBuffers}`);

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
  const poseParts=POSE_PARTS.map(part=>program(poseFragment(part)));
  const programs={face:program(FACE_FRAGMENT),vertex:program(VERTEX_FRAGMENT),
    corner:program(CORNER_FRAGMENT),morph:program(MORPH_FRAGMENT),resolve:program(RESOLVE_FRAGMENT)};
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
  const RGBA8UI=[gl.RGBA8UI,gl.RGBA_INTEGER,gl.UNSIGNED_BYTE],R32UI=[gl.R32UI,gl.RED_INTEGER,gl.UNSIGNED_INT];
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
  // The distance LOD (docs/gpu-mesh.md "Distance LOD"): per mesh the faces'
  // wedges and FaceLevel, the Wedges with their CollapseWedgeThus, per
  // vertex its LOD list and CollapsePointThus target, the lists; per slot
  // the morphed final pose and the resolved corner dwords.
  const meshLodFaces=texels(RGBA32UI,faceCapacity),meshWedges=texels(RG32UI,wedgeCapacity);
  const meshLodVertices=texels(RGBA32UI,vertexCapacity),lodLists=texels(RGBA32UI,lodListCapacity/4);
  const finalPose=texels(RGBA32F,vertexCapacity),cornerWedges=texels(R32UI,cornerCapacity);

  // three sets the unpack state per texture and leaves it (a flipY texture
  // leaves UNPACK_FLIP_Y on, which reverses the rows of a typed-array upload).
  const upload=(target,x,y,width,height,data)=>{
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
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
  // Per ping-pong side, one framebuffer per pose part (POSE_PARTS order).
  const poseFramebuffers=pose.map(side=>{let at=0;return POSE_PARTS.map(part=>framebuffer(side.slice(at,at+=part.length)));});
  const faceFramebuffer=framebuffer([faceNormals,environmentFaces]);
  const vertexFramebuffer=framebuffer([vertexLight,environmentNormals]);
  const cornerFramebuffer=framebuffer([corners]);
  const morphFramebuffer=framebuffer([finalPose]),resolveFramebuffer=framebuffer([cornerWedges]);
  {
    // Zero the ping-pong targets so copied-through free texels are defined.
    for(const fb of poseFramebuffers.flat()){
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
    deusPose:{value:external(finalPose)},deusCorners:{value:external(corners)},deusCornerWedges:{value:external(cornerWedges)},
    deusEnvironmentNormals:{value:external(environmentNormals)},deusByteColors:{value:cornerColors},
    deusCameraHi:{value:new THREE.Vector3()},deusCameraLo:{value:new THREE.Vector3()},deusZero:{value:0},
  };

  // ---- CPU mirrors of the per-frame parameters
  const slotParamsU=new Uint32Array(slotCapacity*PARAMS_U*4),slotParamsF=new Float32Array(slotCapacity*PARAMS_F*4);
  const lightData=new Float32Array(lightCapacity*8);
  let dirtyLow=Infinity,dirtyHigh=-1;
  const {slots,vertexArena,faceArena,cornerArena,keyArena}=layout.arenas;
  // `lightStamp`: the lighting frame number setLighting writes: the next run's
  // (frame + 1) or, inside beginLightRun..lightRun, that run's own.
  let frame=0,current=0,camera=null,lightStamp=null,lightRuns=0;

  /** A new mesh record's static data: keyframes, faces and the vertex
   * adjacency lists (gpu-mesh-layout.mjs). */
  function uploadMesh(record,faceWords) {
    const data=record.payload.arrays.get(0x60).load().data;
    uploadRange(keyframes,record.keyBase,4,new Int16Array(data.buffer,data.byteOffset,record.keyTexels*4));
    uploadRange(meshFaces,record.faceBase,4,Uint32Array.from(faceWords));
    const total=record.adjacencyCount-4,vertexWords=new Uint32Array(record.V*2),listWords=new Uint32Array(Math.ceil(total/4)*4);
    let at=0;
    record.lists.forEach((list,v)=>{vertexWords[v*2]=record.adjacencyStart+at;vertexWords[v*2+1]=list.length;listWords.set(list,at);at+=list.length;});
    uploadRange(meshVertices,record.vertBase,2,vertexWords);
    if(listWords.length)uploadRange(adjacency,record.adjacencyStart/4,4,listWords);
    // The LOD's static data (gpu-mesh-layout.mjs).
    const lod=record.lod,faceWordsLod=new Uint32Array(record.F*4),wedgeWords=new Uint32Array(record.W*2);
    for(let f=0;f<record.F;f++)faceWordsLod.set([lod.faces[f*4],lod.faces[f*4+1],lod.faces[f*4+2],lod.faceLevel[f]],f*4);
    for(let w=0;w<record.W;w++){wedgeWords[w*2]=lod.wedges[w];wedgeWords[w*2+1]=lod.collapseWedges[w];}
    uploadRange(meshLodFaces,record.faceBase,4,faceWordsLod);
    if(record.W)uploadRange(meshWedges,record.wedgeBase,2,wedgeWords);
    const lodTotal=record.lodListCount-4,lodVertexWords=new Uint32Array(record.V*4),lodListWords=new Uint32Array(Math.ceil(lodTotal/4)*4);
    at=0;
    record.lodLists.forEach((list,v)=>{
      const ordinary=v-lod.special;
      lodVertexWords.set([record.lodListStart+at,list.length,ordinary>=0&&ordinary<lod.collapsePoints.length?lod.collapsePoints[ordinary]:0,0],v*4);
      lodListWords.set(list,at);at+=list.length;
    });
    uploadRange(meshLodVertices,record.vertBase,4,lodVertexWords);
    if(lodListWords.length)uploadRange(lodLists,record.lodListStart/4,4,lodListWords);
  }
  const mapWords=(slot,count)=>{const words=new Uint32Array(count*2);for(let i=0;i<count;i++){words[i*2]=slot+1;words[i*2+1]=i;}return words;};

  /** An actor slot: its vertex, face and corner texel ranges. `key` names
   * the mesh resource (one record per mesh); by default the payload. */
  function allocate(payload,faceWords,{environment=false,key=payload}={}) {
    const handle=layout.allocate(key,payload,faceWords,{environment});
    const {slot,vbase,fbase,cbase,mesh:record}=handle;
    if(handle.created)uploadMesh(record,faceWords);
    uploadRange(vertexMap,vbase,2,mapWords(slot,record.V));
    uploadRange(faceMap,fbase,2,mapWords(slot,record.F));
    uploadRange(cornerMap,cbase,2,mapWords(slot,record.F*3));
    const u=slotParamsU.subarray(slot*PARAMS_U*4,(slot+1)*PARAMS_U*4);u.fill(0);
    u.set([record.keyBase,record.V,record.faceBase,record.F, record.vertBase,vbase,fbase,cbase]);
    u[12]=environment?1:0;u[14]=record.wedgeBase;u[15]=record.lod.special;
    // Full detail until setLod; the first run resolves the corners.
    u[41]=record.lod.modelVerts;u[44]=frame+1;
    slotParamsF.subarray(slot*PARAMS_F*4,(slot+1)*PARAMS_F*4).fill(0);
    touch(slot);
    return handle;
  }
  function release(handle) {
    if(handle.released)return;
    const {vbase,fbase,cbase,mesh:record}=handle;
    uploadRange(vertexMap,vbase,2,new Uint32Array(record.V*2));
    uploadRange(faceMap,fbase,2,new Uint32Array(record.F*2));
    uploadRange(cornerMap,cbase,2,new Uint32Array(record.F*6));
    layout.release(handle);
  }
  function touch(slot){dirtyLow=Math.min(dirtyLow,slot);dirtyHigh=Math.max(dirtyHigh,slot);}
  /** This frame's GetFrame plan (lodmesh-frame.mjs planLodMeshFrame), or
   * its packed form {u32, f32, at} (mesh-frame-pack.mjs). */
  function setPose(handle,plan) {
    const {slot}=handle,u=slot*PARAMS_U*4,fl=slot*PARAMS_F*4,packed=plan.u32?plan:null;
    // Each channel's GetFrame count and fill start (mesh-frame-pack.mjs).
    const countWord=(count,fill)=>{
      if(!(count>=0&&count<=handle.mesh.V&&fill>=0&&fill<=count))throw new Error('GPU mesh: invalid GetFrame count');
      return (count|fill<<16)>>>0;
    };
    const countAt=state=>state<4?u+36+state:u+40;
    if(packed){
      const {u32,f32,at}=packed;
      for(let row=0;row<4;row++)for(let i=0;i<3;i++)slotParamsF[fl+row*4+i]=f32[at+row*3+i];
      for(let i=0;i<3;i++)slotParamsF[fl+16+i]=f32[at+12+i];
      for(let k=0;k<STATES;k++){slotParamsU.fill(0,u+(4+k)*4,u+(5+k)*4);slotParamsF[fl+(5+k)*4]=0;}
      for(let k=0;k<u32[at+15];k++){
        const base=at+PLAN_HEAD+PLAN_OP*k,state=u32[base];
        slotParamsU.set([u32[base+1]?2:1,u32[base+2],u32[base+3],u32[base+4]],u+(4+state)*4);
        slotParamsF[fl+(5+state)*4]=f32[base+5];
        slotParamsU[countAt(state)]=countWord(u32[base+6],u32[base+7]);
      }
    }else{
      for(let row=0;row<4;row++)for(let i=0;i<3;i++)slotParamsF[fl+row*4+i]=plan.matrix[row][i];
      for(let i=0;i<3;i++)slotParamsF[fl+16+i]=plan.origin[i];
      for(let k=0;k<STATES;k++){slotParamsU.fill(0,u+(4+k)*4,u+(5+k)*4);slotParamsF[fl+(5+k)*4]=0;}
      for(const op of plan.channels){
        const k=op.channel+1;
        slotParamsU.set([op.tween?2:1,op.first,op.second,op.blend?1:0],u+(4+k)*4);
        slotParamsF[fl+(5+k)*4]=op.alpha;
        slotParamsU[countAt(k)]=countWord(op.count,op.fill?op.fill[0]:op.count);
      }
    }
    slotParamsU[u+8+2]=frame+1;
    touch(slot);
  }
  /** SetupForActor's result for this frame (mesh-lighting-view setupMesh),
   * or its packed form {u32, f32, at} (mesh-frame-pack.mjs). */
  function setLighting(handle,lighting) {
    const packed=lighting.u32?lighting:null,count=packed?packed.u32[packed.at+8]:lighting.lights.length;
    const reserved=layout.reserveLights(count);
    if(!reserved)return false;
    let lightCount=reserved.start;
    const {slot}=handle,u=slot*PARAMS_U*4,fl=slot*PARAMS_F*4;
    slotParamsU[u+8+1]=lightCount;slotParamsU[u+8+3]=lightStamp??frame+1;
    slotParamsU[u+12+1]=count;
    if(packed){
      const {u32,f32,at}=packed;
      slotParamsU[u+8]=u32[at];
      for(let i=0;i<3;i++){slotParamsF[fl+40+i]=f32[at+1+i];slotParamsF[fl+44+i]=f32[at+5+i];}
      slotParamsF[fl+43]=r24prod(f32[at+4],1.4);
      for(let k=0;k<count;k++){
        const base=at+LIGHTING_HEAD+LIGHTING_LIGHT*k,to=lightCount*8;
        for(let i=0;i<7;i++)lightData[to+i]=f32[base+i];
        lightData[to+7]=0;lightCount++;
      }
    }else{
      const {flags,ambient,scaleGlow,unlit,lights}=lighting;
      slotParamsU[u+8]=flags>>>0;
      slotParamsF[fl+40]=ambient[0];slotParamsF[fl+41]=ambient[1];slotParamsF[fl+42]=ambient[2];slotParamsF[fl+43]=r24prod(f32(scaleGlow),1.4);
      slotParamsF[fl+44]=unlit[0];slotParamsF[fl+45]=unlit[1];slotParamsF[fl+46]=unlit[2];
      for(const light of lights){
        const at=lightCount*8,{location,color}=light;
        lightData[at]=location[0];lightData[at+1]=location[1];lightData[at+2]=location[2];lightData[at+3]=light.rradius;
        lightData[at+4]=color[0];lightData[at+5]=color[1];lightData[at+6]=color[2];lightData[at+7]=0;
        lightCount++;
      }
    }
    touch(slot);
    return true;
  }
  /** This frame's DrawLodMesh LOD state after GetFrame (lodmesh-lod.mjs
   * lodMorphScalars): the returned ordinary count, the morph start, the
   * flags and the morph's inverse. The morph and corner passes rerun. */
  function setLod(handle,{count,start,active,morph,inverse}) {
    const u=handle.slot*PARAMS_U*4;
    slotParamsU[u+41]=count>>>0;slotParamsU[u+42]=start>>>0;slotParamsU[u+43]=(active?1:0)|(morph?2:0);
    slotParamsU[u+44]=frame+1;slotParamsU[u+45]=floatWord(inverse);
    touch(handle.slot);
  }
  /** The lighting frame's coordinates and Mirror (mesh-lighting-view
   * beginFrame: Frame->Coords and Frame->Mirror, 1 in the root frame). */
  function setCamera(origin,axes,mirror=1){camera={origin,axes,mirror};}
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
  // `poseFrame`: the pose stamp (uFrame); `lighting`: the lighting stamp
  // (uLightFrame) and the frame's camera, which a lighting run replaces.
  const NO_FRAME=0xffffffff;
  const setUniforms=(prog,poseFrame=frame,lighting={stamp:frame,camera})=>{
    const u=prog.locations,view=lighting.camera;
    if(u.get('uZero'))gl.uniform1ui(u.get('uZero'),0);
    if(u.get('uFrame'))gl.uniform1ui(u.get('uFrame'),poseFrame);
    if(u.get('uLightFrame'))gl.uniform1ui(u.get('uLightFrame'),lighting.stamp>>>0);
    if(view&&u.get('uCameraOrigin')){
      gl.uniform3fv(u.get('uCameraOrigin'),view.origin);gl.uniform3fv(u.get('uCameraX'),view.axes[0]);
      gl.uniform3fv(u.get('uCameraY'),view.axes[1]);gl.uniform3fv(u.get('uCameraZ'),view.axes[2]);
      gl.uniform1f(u.get('uMirror'),view.mirror??1);
    }
  };
  /** The lighting passes (faces, vertices, corners) for the slots whose
   * lighting stamp is `lighting.stamp`, in the frame `lighting.camera`. */
  function lightingPasses(poseFrame,lighting) {
    const vRows=rowsFor(vertexArena.high),fRows=rowsFor(faceArena.high),cRows=rowsFor(cornerArena.high);
    const lodTextures=[['uCornerWedges',cornerWedges],['uLodVertices',meshLodVertices],['uLodLists',lodLists]];
    // Faces.
    let prog=programs.face;gl.useProgram(prog.handle);setUniforms(prog,poseFrame,lighting);
    bindTextures(prog,[['uParamsU',paramsU],['uParamsF',paramsF],['uTables',tables],['uFaceMap',faceMap],
      ['uMeshFaces',meshFaces],['uPose',finalPose],...lodTextures]);
    draw(prog,faceFramebuffer,faceArena.high?fRows:0);
    // Vertices.
    prog=programs.vertex;gl.useProgram(prog.handle);setUniforms(prog,poseFrame,lighting);
    bindTextures(prog,[['uParamsU',paramsU],['uParamsF',paramsF],['uTables',tables],['uVertexMap',vertexMap],
      ['uMeshVertices',meshVertices],['uAdjacency',adjacency],['uPose',finalPose],['uFaces',faceNormals],
      ['uEnvironmentFaces',environmentFaces],['uLights',lightTexture],...lodTextures]);
    draw(prog,vertexFramebuffer,vertexArena.high?vRows:0);
    // Corners.
    prog=programs.corner;gl.useProgram(prog.handle);setUniforms(prog,poseFrame,lighting);
    bindTextures(prog,[['uParamsU',paramsU],['uParamsF',paramsF],['uCornerMap',cornerMap],['uMeshFaces',meshFaces],
      ['uMeshVertices',meshVertices],['uAdjacency',adjacency],['uFaces',faceNormals],['uLight',vertexLight],...lodTextures]);
    draw(prog,cornerFramebuffer,cornerArena.high?cRows:0);
  }
  const GL_STATE=()=>{
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);gl.colorMask(true,true,true,true);
  };
  const uploadDirty=()=>{
    if(dirtyHigh>=dirtyLow){
      const rows=dirtyHigh-dirtyLow+1;
      upload(paramsU,0,dirtyLow,PARAMS_U,rows,slotParamsU.subarray(dirtyLow*PARAMS_U*4,(dirtyHigh+1)*PARAMS_U*4));
      upload(paramsF,0,dirtyLow,PARAMS_F,rows,slotParamsF.subarray(dirtyLow*PARAMS_F*4,(dirtyHigh+1)*PARAMS_F*4));
    }
    dirtyLow=Infinity;dirtyHigh=-1;
    if(layout.lightCount)uploadRange(lightTexture,0,4,lightData.subarray(0,layout.lightCount*8));
  };
  /** Start a lighting run for a child frame's pass: the setLighting calls
   * that follow belong to it, and lightRun runs them (DrawFrame lights each
   * frame's sprites with that frame's Coords and Mirror, so the page redoes
   * the lighting of the actors a pass draws before drawing it). */
  function beginLightRun(){lightStamp=0x80000000+(++lightRuns&0x3fffffff);return lightStamp;}
  /** Nothing was queued for the run beginLightRun started. */
  function cancelLightRun(){lightStamp=null;}
  /** The lighting passes of the setLighting calls since beginLightRun, in
   * `view` ({origin, axes, mirror}); the corner colours of those slots then
   * hold that frame's lighting until the next run lights them again. */
  function lightRun(view) {
    const stamp=lightStamp;lightStamp=null;
    if(stamp===null)throw new Error('GPU mesh: lightRun without beginLightRun');
    uploadDirty();
    GL_STATE();
    lightingPasses(NO_FRAME,{stamp,camera:view});
    gl.bindVertexArray(null);
    renderer.resetState();
    layout.endLights();
  }

  /** Run this frame's passes; afterwards three.js state is reset. */
  function run() {
    frame++;
    uploadDirty();
    // The frame numbers written by setPose/setLighting were frame+1 before
    // the increment above; they now equal `frame`.
    GL_STATE();
    const previous=pose[current],next=pose[current^1];
    const vRows=rowsFor(vertexArena.high),cRows=rowsFor(cornerArena.high);
    // Pose, one draw per part: each evaluates every channel from the
    // previous targets and writes its own targets of the next side.
    let prog;
    poseParts.forEach((part,i)=>{
      prog=part;gl.useProgram(prog.handle);setUniforms(prog);
      bindTextures(prog,[['uParamsU',paramsU],['uParamsF',paramsF],['uVertexMap',vertexMap],['uKeyframes',keyframes],
        ['uPrevPose',previous[0]],...previous.slice(1).map((target,k)=>[`uPrevState${k}`,target])]);
      draw(prog,poseFramebuffers[current^1][i],vertexArena.high?vRows:0);
    });
    current^=1;
    // The LOD's morph into the final pose, then the resolved corners.
    prog=programs.morph;gl.useProgram(prog.handle);setUniforms(prog);
    bindTextures(prog,[['uParamsU',paramsU],['uVertexMap',vertexMap],['uLodVertices',meshLodVertices],['uPose',next[0]]]);
    draw(prog,morphFramebuffer,vertexArena.high?vRows:0);
    prog=programs.resolve;gl.useProgram(prog.handle);setUniforms(prog);
    bindTextures(prog,[['uParamsU',paramsU],['uCornerMap',cornerMap],['uLodFaces',meshLodFaces],['uWedges',meshWedges],
      ['uFinal',finalPose]]);
    draw(prog,resolveFramebuffer,cornerArena.high?cRows:0);
    lightingPasses(frame,{stamp:frame,camera});
    gl.bindVertexArray(null);
    renderer.resetState();
    layout.endFrame();
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
    bindTextures(uvProgram,[['uPose',finalPose],['uEnvironment',environmentNormals]]);
    draw(uvProgram,uvFramebuffer,rowsFor(vertexArena.high));
    gl.bindVertexArray(null);renderer.resetState();
    return read('uv',handle.vbase,handle.mesh.V);
  }
  /** Validation readback of texel ranges (never used by Play). */
  function read(name,start,count) {
    const targets={pose:[pose[current][0],gl.FLOAT,4,Float32Array],final:[finalPose,gl.FLOAT,4,Float32Array],
      cornerWedges:[cornerWedges,gl.UNSIGNED_INT,1,Uint32Array],faces:[faceNormals,gl.FLOAT,4,Float32Array],
      light:[vertexLight,gl.FLOAT,4,Float32Array],corners:[corners,gl.UNSIGNED_INT,4,Uint32Array],
      environment:[environmentNormals,gl.FLOAT,4,Float32Array],uv:[uvTarget,gl.FLOAT,4,Float32Array],environmentFaces:[environmentFaces,gl.FLOAT,4,Float32Array],
      ...Object.fromEntries([0,1,2,3,4].map(k=>[`state${k}`,[pose[current][1+k],gl.FLOAT,4,Float32Array]]))};
    const [target,type,components,Type]=targets[name];
    const fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target.handle,0);
    // readPixels' integer formats: RGBA_INTEGER always works; one-channel
    // targets read as RGBA and keep the first component.
    const read4=components===1,out=new Type(count*components),row=new Type(WIDTH*4);
    const format=type===gl.FLOAT?gl.RGBA:gl.RGBA_INTEGER;
    let at=0;
    while(at<count){
      const texel=start+at,x=texel%WIDTH,y=Math.floor(texel/WIDTH),n=Math.min(WIDTH-x,count-at);
      gl.readPixels(x,y,n,1,format,type,row);
      if(read4)for(let i=0;i<n;i++)out[at+i]=row[i*4];else out.set(row.subarray(0,n*components),at*components);at+=n;
    }
    gl.deleteFramebuffer(fb);renderer.resetState();
    return out;
  }

  return {allocate,release,setPose,setLod,setLighting,setCamera,setViewCamera,run,beginLightRun,lightRun,cancelLightRun,read,environmentUVs,shared,
    capacities:layout.capacities,
    get frame(){return frame;},
    stats:()=>({slots:slots.high,vertices:vertexArena.high,faces:faceArena.high,corners:cornerArena.high,
      keyframes:keyArena.high,meshes:layout.meshes.size}),
    dispose(){
      for(const target of [tables,keyframes,meshFaces,meshVertices,adjacency,vertexMap,faceMap,cornerMap,paramsU,paramsF,
        lightTexture,...pose.flat(),faceNormals,environmentFaces,vertexLight,environmentNormals,corners,meshLodFaces,meshWedges,
        meshLodVertices,lodLists,finalPose,cornerWedges])gl.deleteTexture(target.handle);
      for(const fb of [...poseFramebuffers.flat(),faceFramebuffer,vertexFramebuffer,cornerFramebuffer,morphFramebuffer,
        resolveFramebuffer])gl.deleteFramebuffer(fb.handle);
      for(const prog of [...poseParts,...Object.values(programs)])gl.deleteProgram(prog.handle);
      gl.deleteVertexArray(vao);cornerColors.dispose();renderer.resetState();
    }};
}

/** Vertex-shader code for the draw materials: position from the pose
 * texture (the viewer's [x,y,z] -> [y,z,-x] reflection), corner colour from
 * the corner texture, environment UVs from the render camera. */
export const DRAW_VERTEX_DECLARATIONS=`
uniform highp sampler2D deusPose,deusEnvironmentNormals,deusByteColors;uniform highp usampler2D deusCorners,deusCornerWedges;
uniform vec3 deusCameraHi,deusCameraLo;uniform uint deusZero;uniform float deusGpu;
attribute float deusVertexTexel,deusCornerTexel;
${FLOAT_FLOAT.replace(/\bZERO\b/g,'deusZero')}
${ENVIRONMENT_UV}
`;
