/** GLSL for the GPU mesh passes (docs/gpu-mesh.md). Every stored result is
 * computed through the barrier B(): ANGLE compiles to Metal with fast-math,
 * which otherwise contracts a*b+c into a fused multiply-add and reassociates
 * sums. The pose pass is GetFrame at the render pass's precision control 24:
 * one binary32 operation per x87 operation, each through B(). The lighting
 * passes keep the CPU kernels' f64 intermediates as float-float pairs (hi,
 * lo); an f32 store is the pair's normalized hi. */

export const WIDTH=1024;

// Float-float helpers; the barrier's zero is \`ZERO\` (a uniform uint).
export const FLOAT_FLOAT=`
float B(float x){return uintBitsToFloat(floatBitsToUint(x)^ZERO);}
vec2 twoSum(float a,float b){float s=B(a+b);float bb=B(s-a);return vec2(s,B(B(a-B(s-bb))+B(b-bb)));}
vec2 fastTwoSum(float a,float b){float s=B(a+b);return vec2(s,B(b-B(s-a)));}
vec2 splitF(float a){float c=B(4097.0*a);float h=B(c-B(c-a));return vec2(h,B(a-h));}
vec2 twoProd(float a,float b){float p=B(a*b);vec2 x=splitF(a),y=splitF(b);
  return vec2(p,B(B(B(B(B(x.x*y.x)-p)+B(x.x*y.y))+B(x.y*y.x))+B(x.y*y.y)));}
vec2 ffAdd(vec2 a,vec2 b){vec2 s=twoSum(a.x,b.x);vec2 t=twoSum(a.y,b.y);
  s=fastTwoSum(s.x,B(s.y+t.x));return fastTwoSum(s.x,B(s.y+t.y));}
vec2 ffAddF(vec2 a,float b){vec2 s=twoSum(a.x,b);return fastTwoSum(s.x,B(s.y+a.y));}
vec2 ffMulF(vec2 a,float b){vec2 p=twoProd(a.x,b);return fastTwoSum(p.x,B(p.y+B(a.y*b)));}
vec2 ffMul(vec2 a,vec2 b){vec2 p=twoProd(a.x,b.x);return fastTwoSum(p.x,B(p.y+B(B(a.x*b.y)+B(a.y*b.x))));}
vec2 ffDiv(vec2 a,vec2 b){float q=B(a.x/b.x);vec2 r=ffAdd(a,-ffMulF(b,q));float q2=B(r.x/b.x);
  vec2 r2=ffAdd(r,-ffMulF(b,q2));return ffAddF(fastTwoSum(q,q2),B(r2.x/b.x));}
ivec2 at(uint t){return ivec2(int(t&1023u),int(t>>10));}
`;

export const COMMON=`#version 300 es
precision highp float;precision highp int;
precision highp sampler2D;precision highp usampler2D;precision highp isampler2D;
uniform uint uZero;
${FLOAT_FLOAT.replace(/\bZERO\b/g,'uZero')}
uint texelIndex(){return (uint(gl_FragCoord.y)<<10)+uint(gl_FragCoord.x);}
`;

// Light-manager tables (squareRootTable, rsqrtTables), indexed by float bits
// exactly as the kernel's table_sqrt/table_rsqrt and mesh-environment.
export const TABLES=`
uniform usampler2D uTables;
uint tableWord(uint k){uvec4 v=texelFetch(uTables,ivec2(int(k>>2),0),0);uint c=k&3u;return c==0u?v.x:c==1u?v.y:c==2u?v.z:v.w;}
float tableSqrt(float value){uint bits=floatBitsToUint(value);
  return uintBitsToFloat(tableWord((bits>>13)&0x7ffu)+((bits&0x7f000000u)>>1));}
float tableRsqrt(float value){uint bits=floatBitsToUint(value);
  float e=uintBitsToFloat(tableWord(2048u+(bits>>23)));float m=uintBitsToFloat(tableWord(2560u+((bits>>13)&0x3ffu)));
  return B(m*e);}
const float EPSILON=uintBitsToFloat(0x3a83126fu);
`;

export const FULLSCREEN_VERTEX=`#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID&1)<<2)-1.0,float((gl_VertexID&2)<<1)-1.0);gl_Position=vec4(p,0.0,1.0);}`;

// Per-slot parameter rows (uParamsU RGBA32UI, uParamsF RGBA32F), one row per slot:
// U0 keyBase,V,faceBase,F   U1 vertBase(mesh CSR),vbase,fbase,cbase
// U2 actorFlags,lightStart,poseFrame,lightFrame   U3 environment,lightCount,0,0
// U4+k channel k (main, blend 0..3): mode(0 off,1 keyframe,2 tween),first,second,blend
// F0 matrix row 0 (m0)  F1..F3 rows 1..3  F4 mesh origin  F5+k channel alpha
// F10 ambient rgb, ScaleGlow   F11 unlit rgb
export const PARAMS=`
uniform usampler2D uParamsU;uniform sampler2D uParamsF;
uvec4 pu(uint slot,int k){return texelFetch(uParamsU,ivec2(k,int(slot)),0);}
vec4 pf(uint slot,int k){return texelFetch(uParamsF,ivec2(k,int(slot)),0);}
`;

/** Pose pass: GetFrame's interpolation and publication (lodmesh-frame.mjs
 * execute / kernel pose) for all channels, into the ping-pong pose and cache
 * pose targets. Texels of slots not planned this frame are copied through. */
export const POSE_FRAGMENT=`${COMMON}${PARAMS}
uniform usampler2D uVertexMap;uniform isampler2D uKeyframes;
uniform sampler2D uPrevPose,uPrevState0,uPrevState1,uPrevState2,uPrevState3,uPrevState4;
uniform uint uFrame;
/*POSE_OUTPUTS*/
vec3 key(uint keyBase,uint V,uint frame,uint i){return vec3(texelFetch(uKeyframes,at(keyBase+frame*V+i),0).xyz);}
// (b - a)*alpha + a per axis, each operation one binary32 rounding (GetFrame
// at the render pass's precision control 24): keyframe interpolation from
// frame a, or a tween from the cache pose a toward integer frame b.
vec3 interpolate(vec3 a,vec3 b,float alpha){
  return vec3(B(B(B(b.x-a.x)*alpha)+a.x),B(B(B(b.y-a.y)*alpha)+a.y),B(B(B(b.z-a.z)*alpha)+a.z));}
float dot24(vec3 v,vec3 r){return B(B(B(v.x*r.x)+B(v.y*r.y))+B(v.z*r.z));}
void main(){
  uint t=texelIndex();ivec2 p=at(t);
  vec4 prevPose=texelFetch(uPrevPose,p,0);
  vec4 s[5];s[0]=texelFetch(uPrevState0,p,0);s[1]=texelFetch(uPrevState1,p,0);s[2]=texelFetch(uPrevState2,p,0);
  s[3]=texelFetch(uPrevState3,p,0);s[4]=texelFetch(uPrevState4,p,0);
  oPose=prevPose;
  uvec2 map=texelFetch(uVertexMap,p,0).xy;
  if(map.x!=0u){
    uint slot=map.x-1u,i=map.y;
    if(pu(slot,2).z==uFrame){
      uvec4 u0=pu(slot,0);uint keyBase=u0.x,V=u0.y;
      vec3 m0=pf(slot,0).xyz,r1=pf(slot,1).xyz,r2=pf(slot,2).xyz,r3=pf(slot,3).xyz,origin=pf(slot,4).xyz;
      vec3 outp=vec3(0.0);
      for(int k=0;k<5;k++){
        uvec4 ch=pu(slot,4+k);
        if(ch.x==0u)continue;
        float alpha=pf(slot,5+k).x;
        vec3 pose;
        if(ch.x==1u){vec3 a=key(keyBase,V,ch.y,i);pose=alpha>0.0?interpolate(a,key(keyBase,V,ch.z,i),alpha):a;}
        else pose=alpha>0.0?interpolate(s[k].xyz,key(keyBase,V,ch.z,i),alpha):s[k].xyz;
        s[k]=vec4(pose,1.0);
        if(ch.w==0u){
          vec3 c=vec3(B(pose.x-origin.x),B(pose.y-origin.y),B(pose.z-origin.z));
          vec3 v=vec3(B(c.x-m0.x),B(c.y-m0.y),B(c.z-m0.z));
          outp=vec3(dot24(v,r1),dot24(v,r2),dot24(v,r3));
        }else{
          vec3 base=key(keyBase,V,0u,i);
          vec3 c=vec3(B(pose.x-base.x),B(pose.y-base.y),B(pose.z-base.z));
          outp=vec3(B(dot24(c,r1)+outp.x),B(dot24(c,r2)+outp.y),B(dot24(c,r3)+outp.z));
        }
      }
      oPose=vec4(outp,1.0);
    }
  }
  oState0=s[0];oState1=s[1];oState2=s[2];oState3=s[3];oState4=s[4];
}`;

// The lighting frame's camera transform (kernel camera_component): exact
// differences and products, one rounding of the sum.
export const CAMERA=`
uniform vec3 uCameraOrigin,uCameraX,uCameraY,uCameraZ;
float cameraComponent(vec3 p,vec3 axis){
  vec2 s=ffAdd(ffAdd(ffMulF(twoSum(p.x,-uCameraOrigin.x),axis.x),ffMulF(twoSum(p.y,-uCameraOrigin.y),axis.y)),
    ffMulF(twoSum(p.z,-uCameraOrigin.z),axis.z));
  return s.x;}
vec3 toCamera(vec3 p){return vec3(cameraComponent(p,uCameraX),cameraComponent(p,uCameraY),cameraComponent(p,uCameraZ));}
`;

/** Face pass: DrawLodMesh 0x10b0fe60..0x10b0ffc9 (kernel light_mesh_job's
 * face loop) in camera space; w = 0 not drawn, 1 drawn, 2 drawn and
 * PF_Unlit. Attachment 1: meshFaceNormal on the world pose. */
export const FACE_FRAGMENT=`${COMMON}${TABLES}${PARAMS}${CAMERA}
uniform usampler2D uFaceMap,uMeshFaces;uniform sampler2D uPose;uniform uint uFrame;
layout(location=0) out vec4 oFace;layout(location=1) out vec4 oEnvironment;
void main(){
  uint t=texelIndex();uvec2 map=texelFetch(uFaceMap,at(t),0).xy;
  if(map.x==0u)discard;
  uint slot=map.x-1u;uvec4 u2=pu(slot,2),u3=pu(slot,3);
  bool lit=u2.w==uFrame,environment=u3.x!=0u&&u2.z==uFrame;
  if(!lit&&!environment)discard;
  uvec4 u0=pu(slot,0),u1=pu(slot,1);
  uvec4 face=texelFetch(uMeshFaces,at(u0.z+map.y),0);
  vec3 w0=texelFetch(uPose,at(u1.y+face.x),0).xyz,w1=texelFetch(uPose,at(u1.y+face.y),0).xyz,w2=texelFetch(uPose,at(u1.y+face.z),0).xyz;
  oFace=vec4(0.0);oEnvironment=vec4(0.0);
  if(lit){
    vec3 p0=toCamera(w0),p1=toCamera(w1),p2=toCamera(w2);
    vec2 ax=twoSum(p2.x,-p0.x),ay=twoSum(p2.y,-p0.y),az=twoSum(p2.z,-p0.z),bx=twoSum(p0.x,-p1.x);
    float bz=B(p0.z-p1.z),by=B(p0.y-p1.y);
    float nz=ffAdd(ffMul(bx,ay),-ffMulF(ax,by)).x,ny=ffAdd(ffMulF(ax,bz),-ffMul(bx,az)).x,nx=ffAdd(ffMulF(az,by),-ffMulF(ay,bz)).x;
    float scale=tableRsqrt(ffAddF(ffAdd(ffAdd(twoProd(nx,nx),twoProd(ny,ny)),twoProd(nz,nz)),EPSILON).x);
    vec3 n=vec3(B(nx*scale),B(ny*scale),B(nz*scale));
    float dot=ffAdd(ffAdd(twoProd(n.x,p0.x),twoProd(n.y,p0.y)),twoProd(n.z,p0.z)).x;
    uint flags=face.w|u2.x;
    bool drawn=(face.w&1u)==0u&&((face.w&0x100u)!=0u||dot<0.0);
    oFace=vec4(n,drawn?((flags&0x400000u)!=0u?2.0:1.0):0.0);
  }
  if(u3.x!=0u){
    vec2 ux=twoSum(w2.x,-w0.x),uy=twoSum(w2.y,-w0.y),uz=twoSum(w2.z,-w0.z);
    float vx=B(w0.x-w1.x),vy=B(w0.y-w1.y),vz=B(w0.z-w1.z);
    float cx=ffAdd(ffMulF(uz,vy),-ffMulF(uy,vz)).x,cy=ffAdd(ffMulF(ux,vz),-ffMulF(uz,vx)).x,cz=ffAdd(ffMulF(uy,vx),-ffMulF(ux,vy)).x;
    float r=tableRsqrt(ffAddF(ffAdd(ffAdd(twoProd(cx,cx),twoProd(cy,cy)),twoProd(cz,cz)),EPSILON).x);
    oEnvironment=vec4(B(cx*r),B(cy*r),B(cz*r),1.0);
  }
}`;

/** Vertex pass: the kernel's vertex normal, normal plane and light_vertex;
 * attachment 1 the environment vertex normal (meshVertexNormalsInto). */
export const VERTEX_FRAGMENT=`${COMMON}${TABLES}${PARAMS}${CAMERA}
uniform usampler2D uVertexMap,uMeshVertices,uAdjacency;uniform sampler2D uPose,uFaces,uEnvironmentFaces,uLights;
uniform uint uFrame;uniform vec2 uGlow;
layout(location=0) out vec4 oLight;layout(location=1) out vec4 oEnvironment;
uint adjacent(uint k){uvec4 v=texelFetch(uAdjacency,at(k>>2),0);uint c=k&3u;return c==0u?v.x:c==1u?v.y:c==2u?v.z:v.w;}
void main(){
  uint t=texelIndex();uvec2 map=texelFetch(uVertexMap,at(t),0).xy;
  if(map.x==0u)discard;
  uint slot=map.x-1u;uvec4 u2=pu(slot,2),u3=pu(slot,3);
  bool lit=u2.w==uFrame,environment=u3.x!=0u&&u2.z==uFrame;
  if(!lit&&!environment)discard;
  uvec4 u1=pu(slot,1);uvec2 list=texelFetch(uMeshVertices,at(u1.x+map.y),0).xy;
  vec3 N=vec3(0.0),E=vec3(0.0);
  for(uint j=0u;j<list.y;j++){
    uint face=u1.z+adjacent(list.x+j);
    if(lit){vec3 n=texelFetch(uFaces,at(face),0).xyz;N=vec3(B(n.x+N.x),B(n.y+N.y),B(n.z+N.z));}
    if(u3.x!=0u){vec3 n=texelFetch(uEnvironmentFaces,at(face),0).xyz;E=vec3(B(E.x+n.x),B(E.y+n.y),B(E.z+n.z));}
  }
  oLight=vec4(0.0);oEnvironment=vec4(0.0);
  if(u3.x!=0u){
    float r=tableRsqrt(ffAddF(ffAdd(ffAdd(twoProd(E.x,E.x),twoProd(E.y,E.y)),twoProd(E.z,E.z)),EPSILON).x);
    oEnvironment=vec4(B(E.x*r),B(E.y*r),B(E.z*r),1.0);
  }
  if(!lit)return;
  vec3 P=toCamera(texelFetch(uPose,at(u1.y+map.y),0).xyz);
  float scale=tableRsqrt(ffAddF(ffAdd(ffAdd(twoProd(N.x,N.x),twoProd(N.y,N.y)),twoProd(N.z,N.z)),EPSILON).x);
  vec2 ex=twoProd(scale,N.x),ey=twoProd(scale,N.y),ez=twoProd(scale,N.z);
  float nx=ex.x,ny=ey.x,nz=ez.x;
  float nw=ffAdd(ffAdd(ffMulF(ex,P.x),ffMulF(ey,P.y)),ffMulF(ez,P.z)).x;
  uint flags=u2.x;
  vec3 sum=vec3(0.0);
  if((flags&0x400000u)!=0u)sum=vec3(0.5);
  else{
    float p2=ffAdd(ffAdd(twoProd(P.x,P.x),twoProd(P.y,P.y)),twoProd(P.z,P.z)).x;
    for(uint l=0u;l<u3.y;l++){
      vec4 L=texelFetch(uLights,at((u2.y+l)*2u),0),C=texelFetch(uLights,at((u2.y+l)*2u+1u),0);
      float dz=B(L.z-P.z),dy=B(L.y-P.y);vec2 dxe=twoSum(L.x,-P.x);float dx=dxe.x;
      float dist2=ffAdd(ffAdd(ffMulF(dxe,dx),twoProd(dy,dy)),twoProd(dz,dz)).x;
      float dist=tableSqrt(dist2);
      vec2 factor=ffAddF(-twoProd(dist,L.w),1.0);
      if(!(factor.x>0.0))continue;
      vec2 c=ffAddF(ffDiv(ffAdd(ffAdd(twoProd(dy,ny),twoProd(dz,nz)),twoProd(dx,nx)),vec2(dist,0.0)),1.0);
      float diffuse=ffAddF(ffMul(c,c),-1.5).x;
      if(diffuse<0.0)diffuse=0.0;
      float plane2=B(2.0*ffAddF(ffAdd(ffAdd(twoProd(L.z,nz),twoProd(L.y,ny)),twoProd(L.x,nx)),-nw).x);
      float rx=B(L.x-B(nx*plane2)),ry=B(L.y-B(ny*plane2)),rz=B(L.z-B(nz*plane2));
      vec2 specular=ffAddF(ffAdd(ffAdd(twoProd(rx,P.x),twoProd(rz,P.z)),twoProd(ry,P.y)),-p2);
      vec2 total=vec2(diffuse,0.0);
      if(specular.x>0.0)total=ffAddF(ffDiv(ffMulF(ffMul(specular,specular),6.0),twoProd(dist2,p2)),diffuse);
      vec2 amount=ffMul(total,factor);
      if(amount.x>0.0){
        sum.x=ffAddF(ffMulF(amount,C.x),sum.x).x;
        sum.y=B(ffMulF(amount,C.y).x+sum.y);
        sum.z=B(ffMulF(amount,C.z).x+sum.z);
      }
    }
  }
  vec4 f10=pf(slot,10);
  vec2 glow=ffMulF(uGlow,f10.w);
  oLight=vec4(min(1.0,ffAddF(ffMulF(glow,sum.x),f10.x).x),min(1.0,ffAddF(ffMulF(glow,sum.y),f10.y).x),
    min(1.0,ffAddF(ffMulF(glow,sum.z),f10.z).x),1.0);
}`;

/** Corner pass: the kernel's final loop. Modulated corners and corners of
 * vertices no drawn face contains are white; a drawn PF_Unlit face at or
 * before this face that contains the vertex replaces its light with the unlit
 * colour (the in-order overwrite); diffuse bytes are FISTP(L*255). */
export const CORNER_FRAGMENT=`${COMMON}${PARAMS}
uniform usampler2D uCornerMap,uMeshFaces,uMeshVertices,uAdjacency;uniform sampler2D uFaces,uLight;uniform uint uFrame;
out uvec4 oColor;
uint adjacent(uint k){uvec4 v=texelFetch(uAdjacency,at(k>>2),0);uint c=k&3u;return c==0u?v.x:c==1u?v.y:c==2u?v.z:v.w;}
uint byteOf(float value){return uint(roundEven(B(value*255.0)))&255u;}
void main(){
  uint t=texelIndex();uvec2 map=texelFetch(uCornerMap,at(t),0).xy;
  if(map.x==0u)discard;
  uint slot=map.x-1u;uvec4 u2=pu(slot,2);
  if(u2.w!=uFrame)discard;
  uvec4 u0=pu(slot,0),u1=pu(slot,1);
  uint f=map.y/3u,k=map.y-f*3u;
  uvec4 face=texelFetch(uMeshFaces,at(u0.z+f),0);
  uint v=k==0u?face.x:k==1u?face.y:face.z;
  if(((face.w|u2.x)&0x40u)!=0u){oColor=uvec4(255u,255u,255u,1u);return;}
  uvec2 list=texelFetch(uMeshVertices,at(u1.x+v),0).xy;
  bool lit=false,unlit=false;
  for(uint j=0u;j<list.y;j++){
    uint other=adjacent(list.x+j);float w=texelFetch(uFaces,at(u1.z+other),0).w;
    if(w>0.5){lit=true;if(w>1.5&&other<=f)unlit=true;}
  }
  if(!lit){oColor=uvec4(255u,255u,255u,1u);return;}
  vec3 light=unlit?pf(slot,11).xyz:texelFetch(uLight,at(u1.y+v),0).xyz;
  oColor=uvec4(byteOf(light.x),byteOf(light.y),byteOf(light.z),1u);
}`;

/** writeMeshEnvironmentUV (mesh-environment.mjs) with identity axes, for a
 * camera position given as a float-float pair. Shared by the draw shader and
 * the validator's UV pass. */
export const ENVIRONMENT_UV=`
vec2 environmentUV(vec3 point,vec3 normal,vec3 cameraHi,vec3 cameraLo){
  vec3 r=vec3(ffAddF(twoSum(point.x,-cameraHi.x),-cameraLo.x).x,ffAddF(twoSum(point.y,-cameraHi.y),-cameraLo.y).x,
    ffAddF(twoSum(point.z,-cameraHi.z),-cameraLo.z).x);
  vec2 s=ffAdd(ffAdd(twoProd(r.x,r.x),twoProd(r.y,r.y)),twoProd(r.z,r.z));
  float y0=B(inversesqrt(s.x));
  // One float-float Newton step for 1/sqrt(s): y = y0 + y0*(1 - s*y0^2)/2.
  vec2 e=ffAddF(-ffMulF(ffMulF(s,y0),y0),1.0);
  float reciprocal=ffAddF(ffMulF(ffMulF(e,y0),0.5),y0).x;
  float dx=B(r.x*reciprocal),dy=B(r.y*reciprocal),dz=B(r.z*reciprocal);
  float twice=B(2.0*ffAdd(ffAdd(twoProd(dx,normal.x),twoProd(dy,normal.y)),twoProd(dz,normal.z)).x);
  float rx=B(dx-B(normal.x*twice)),ry=B(dy-B(normal.y*twice));
  return vec2(B(1.0+rx)*0.5,B(1.0+ry)*0.5);}
`;

const POSE_TARGETS=['oPose','oState0','oState1','oState2','oState3','oState4'];
/** The pose pass writing only `targets` (names from POSE_TARGETS, in
 * attachment order); the others are plain globals the compiler drops. Every
 * part computes the same values from the same inputs (gpu-mesh.mjs
 * POSE_PARTS, docs/gpu-mesh.md "Pose pass targets"). */
export function poseFragment(targets){
  const declarations=POSE_TARGETS.map(name=>{const at=targets.indexOf(name);
    return at>=0?`layout(location=${at}) out vec4 ${name};`:`vec4 ${name};`;}).join('');
  return POSE_FRAGMENT.replace('/*POSE_OUTPUTS*/',declarations);
}
