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
// The correctly rounded binary32 quotient (a GPU division may be 2 ulp off):
// q from the float-float quotient (within about 2^-46 of a/b), then one step
// toward the exact remainder r = a - q*b (exact as a pair) when |r/b|
// reaches half the spacing on that side of q (a quarter of q's ulp below a
// power of two). A quotient of two floats is never a rounding midpoint.
// Normal-range quotients only (the lighting's).
float divRN(float a,float b){
  float q=ffDiv(vec2(a,0.0),vec2(b,0.0)).x;
  if(!(abs(q)<3.0e38)||abs(q)<1.0e-37)return q;
  vec2 r=ffAdd(vec2(a,0.0),-twoProd(q,b));
  if(r.x==0.0)return q;
  uint bits=floatBitsToUint(abs(q));
  bool bigger=((r.x>0.0)==(b>0.0))==(q>0.0);
  float ulp=uintBitsToFloat((bits&0x7f800000u)-0x0b800000u);
  float halfStep=B(ulp*((bigger||(bits&0x7fffffu)!=0u)?0.5:0.25));
  if(abs(r.x)<B(abs(b)*halfStep))return q;
  float stepped=uintBitsToFloat(bigger?bits+1u:bits-1u);
  return q<0.0?-stepped:stepped;}
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
// U2 actorFlags,lightStart,poseFrame,lightFrame   U3 environment,lightCount,wedgeBase,special
// U4+k channel k (main, blend 0..3): mode(0 off,1 keyframe,2 tween),first,second,blend
// U9 channels 0..3, U10.x channel 4: GetFrame count | fill start << 16
// U10.yzw the LOD: returned ordinary count C, morph start (int), flags (1 LOD, 2 morph)
// U11 lodFrame, the morph's inverse (float bits), 0, 0
// F0 matrix row 0 (m0)  F1..F3 rows 1..3  F4 mesh origin  F5+k channel alpha
// F10 ambient rgb, ScaleGlow*1.4 (24-bit)   F11 unlit rgb
// F12..F15 the lighting frame's GetFrame matrix (rows 0..3): the camera-space publication
export const PARAMS=`
uniform usampler2D uParamsU;uniform sampler2D uParamsF;
uvec4 pu(uint slot,int k){return texelFetch(uParamsU,ivec2(k,int(slot)),0);}
vec4 pf(uint slot,int k){return texelFetch(uParamsF,ivec2(k,int(slot)),0);}
`;

// The resolved corner dwords (RESOLVE_FRAGMENT) and the LOD vertex lists
// (gpu-mesh-layout.mjs lodVertexLists): a corner's vertex, and whether a
// list entry is a corner that resolved to this vertex.
export const CORNERS=`
uniform usampler2D uCornerWedges,uLodVertices,uLodLists;
const uint DROPPED=0xfffffffeu;
uint cornerWedge(uint cbase,uint corner){return texelFetch(uCornerWedges,at(cbase+corner),0).x;}
uint lodEntry(uint k){uvec4 v=texelFetch(uLodLists,at(k>>2),0);uint c=k&3u;return c==0u?v.x:c==1u?v.y:c==2u?v.z:v.w;}
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
      uvec4 u9=pu(slot,9);uint counts[5];counts[0]=u9.x;counts[1]=u9.y;counts[2]=u9.z;counts[3]=u9.w;counts[4]=pu(slot,10).x;
      // A vertex at or above a channel's count keeps its cache pose and the
      // output it had (GetFrame's loops stop at the count).
      vec3 outp=prevPose.xyz;
      for(int k=0;k<5;k++){
        uvec4 ch=pu(slot,4+k);
        if(ch.x==0u)continue;
        uint count=counts[k]&0xffffu,fill=counts[k]>>16;
        if(i>=count)continue;
        float alpha=pf(slot,5+k).x;
        vec3 pose;
        // A tween's count expansion fills the cache from the target frame
        // (its alpha is then 0).
        if(i>=fill)pose=key(keyBase,V,ch.z,i);
        else if(ch.x==1u){vec3 a=key(keyBase,V,ch.y,i);pose=alpha>0.0?interpolate(a,key(keyBase,V,ch.z,i),alpha):a;}
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

/** Morph pass: DrawLodMesh's post-frame range 0x10b0ee34..0x10b0ef6e
 * (lodmesh-lod.mjs morphLodMesh) on the posed vertices, into the final
 * pose the lighting and the draw read; w is the vertex's stored alpha (0
 * outside the morph). A slot neither posed nor re-selected this frame keeps
 * its final pose. */
export const MORPH_FRAGMENT=`${COMMON}${PARAMS}
uniform usampler2D uVertexMap,uLodVertices;uniform sampler2D uPose;uniform uint uFrame;
out vec4 oFinal;
void main(){
  uint t=texelIndex();uvec2 map=texelFetch(uVertexMap,at(t),0).xy;
  if(map.x==0u)discard;
  uint slot=map.x-1u;uvec4 u2=pu(slot,2),u10=pu(slot,10),u11=pu(slot,11);
  if(u2.z!=uFrame&&u11.x!=uFrame)discard;
  vec4 p=texelFetch(uPose,at(t),0);
  oFinal=vec4(p.xyz,0.0);
  uint special=pu(slot,3).w,i=map.y;
  if((u10.w&2u)==0u||i<special)return;
  int o=int(i-special),start=int(u10.z);
  if(o<=start||o>=int(u10.y))return;
  float alpha=B(float(o-start)*uintBitsToFloat(u11.y));
  if(!(1.0>alpha))alpha=1.0;
  uvec4 u1=pu(slot,1);uint target=texelFetch(uLodVertices,at(u1.x+i),0).z;
  if(target==0u)return;
  vec3 T=texelFetch(uPose,at(u1.y+special+target),0).xyz;
  oFinal=vec4(B(B(B(T.x-p.x)*alpha)+p.x),B(B(B(T.y-p.y)*alpha)+p.y),B(B(B(T.z-p.z)*alpha)+p.z),alpha);
}`;

/** Corner pass for the LOD: DrawLodMesh 0x10b0fc6f..0x10b0fe60
 * (lodmesh-lod.mjs lodMeshCorners): each slot corner's packed wedge dword
 * (vertex word, U, V); 0xffffffff for a face above the count, 0xfffffffe
 * for a wedge that never collapses below it (the original loops forever).
 * Without the LOD flag the corner's own wedge. Run when the slot's LOD
 * parameters changed; otherwise its dwords stay. */
export const RESOLVE_FRAGMENT=`${COMMON}${PARAMS}
uniform usampler2D uCornerMap,uLodFaces,uWedges;uniform sampler2D uFinal;uniform uint uFrame;
out uint oWedge;
uint lerpByte(uint from,uint to,float alpha){
  float value=B(B(float(int(to)-int(from))*alpha)+float(from));return uint(int(roundEven(value)))&255u;}
void main(){
  uint t=texelIndex();uvec2 map=texelFetch(uCornerMap,at(t),0).xy;
  if(map.x==0u)discard;
  uint slot=map.x-1u;uvec4 u10=pu(slot,10);
  if(pu(slot,11).x!=uFrame)discard;
  uvec4 u0=pu(slot,0),u1=pu(slot,1),u3=pu(slot,3);
  uint f=map.y/3u,k=map.y-f*3u;
  uvec4 face=texelFetch(uLodFaces,at(u0.z+f),0);
  uint own=k==0u?face.x:k==1u?face.y:face.z;
  uvec2 wedge=texelFetch(uWedges,at(u3.z+own),0).xy;
  if((u10.w&1u)==0u){oWedge=wedge.x;return;}
  uint count=u10.y;
  if(face.w>count){oWedge=0xffffffffu;return;}
  uint x=own,packed=wedge.x,next=wedge.y;
  for(int n=0;n<64&&(packed&0xffffu)>=count;n++){x=next;uvec2 e=texelFetch(uWedges,at(u3.z+x),0).xy;packed=e.x;next=e.y;}
  if((packed&0xffffu)>=count){oWedge=0xfffffffeu;return;}
  uint vertex=packed&0xffffu;
  if((u10.w&2u)!=0u&&int(vertex)>int(u10.z)){
    float alpha=texelFetch(uFinal,at(u1.y+u3.w+vertex),0).w;
    if(floatBitsToUint(alpha)!=0u&&next!=x){
      uint other=texelFetch(uWedges,at(u3.z+next),0).x;
      uint u=(packed>>16)&255u,v=packed>>24,nu=(other>>16)&255u,nv=other>>24;
      if(u!=nu||v!=nv)packed=vertex|(lerpByte(u,nu,alpha)<<16)|(lerpByte(v,nv,alpha)<<24);
    }
  }
  oWedge=packed;
}`;

/** Camera pose pass: GetFrame's publication (the POSE_FRAGMENT's main and
 * additive blend arithmetic) of the cache poses through the lighting frame's
 * own matrix (F12..F15: GetFrame called with that frame's Frame->Coords), for
 * the slots lit in this run. DrawLodMesh calls GetFrame once for each frame
 * that draws an actor, and what it publishes is in that frame's camera space:
 * the morph, the normals and the lighting all start from these values
 * (docs/script-lodmesh-lod.md "Camera space"). The cache poses are the
 * channels' states the pose pass left (a keyframe operation stores its pose
 * there too). */
export const CAMERA_POSE_FRAGMENT=`${COMMON}${PARAMS}
uniform usampler2D uVertexMap;uniform isampler2D uKeyframes;
uniform sampler2D uState0,uState1,uState2,uState3,uState4;
uniform uint uLightFrame;
out vec4 oCamera;
vec3 key(uint keyBase,uint V,uint frame,uint i){return vec3(texelFetch(uKeyframes,at(keyBase+frame*V+i),0).xyz);}
float dot24(vec3 v,vec3 r){return B(B(B(v.x*r.x)+B(v.y*r.y))+B(v.z*r.z));}
void main(){
  uint t=texelIndex();ivec2 p=at(t);
  uvec2 map=texelFetch(uVertexMap,p,0).xy;
  if(map.x==0u)discard;
  uint slot=map.x-1u,i=map.y;
  if(pu(slot,2).w!=uLightFrame)discard;
  uvec4 u0=pu(slot,0);uint keyBase=u0.x,V=u0.y;
  vec3 m0=pf(slot,12).xyz,r1=pf(slot,13).xyz,r2=pf(slot,14).xyz,r3=pf(slot,15).xyz,origin=pf(slot,4).xyz;
  uvec4 u9=pu(slot,9);uint counts[5];counts[0]=u9.x;counts[1]=u9.y;counts[2]=u9.z;counts[3]=u9.w;counts[4]=pu(slot,10).x;
  vec4 s[5];s[0]=texelFetch(uState0,p,0);s[1]=texelFetch(uState1,p,0);s[2]=texelFetch(uState2,p,0);
  s[3]=texelFetch(uState3,p,0);s[4]=texelFetch(uState4,p,0);
  vec3 outp=vec3(0.0);
  for(int k=0;k<5;k++){
    uvec4 ch=pu(slot,4+k);
    if(ch.x==0u)continue;
    if(i>=(counts[k]&0xffffu))continue;
    vec3 pose=s[k].xyz;
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
  oCamera=vec4(outp,1.0);
}`;

/** Camera morph pass: MORPH_FRAGMENT's arithmetic on the camera-space pose,
 * for the slots lit in this run, into the camera-space final pose the face,
 * vertex and corner passes read. w is the vertex's stored alpha, which the
 * world pass computes the same (it depends on the counts alone). */
export const CAMERA_MORPH_FRAGMENT=`${COMMON}${PARAMS}
uniform usampler2D uVertexMap,uLodVertices;uniform sampler2D uPose;uniform uint uLightFrame;
out vec4 oFinal;
void main(){
  uint t=texelIndex();uvec2 map=texelFetch(uVertexMap,at(t),0).xy;
  if(map.x==0u)discard;
  uint slot=map.x-1u;uvec4 u2=pu(slot,2),u10=pu(slot,10),u11=pu(slot,11);
  if(u2.w!=uLightFrame)discard;
  vec4 p=texelFetch(uPose,at(t),0);
  oFinal=vec4(p.xyz,0.0);
  uint special=pu(slot,3).w,i=map.y;
  if((u10.w&2u)==0u||i<special)return;
  int o=int(i-special),start=int(u10.z);
  if(o<=start||o>=int(u10.y))return;
  float alpha=B(float(o-start)*uintBitsToFloat(u11.y));
  if(!(1.0>alpha))alpha=1.0;
  uvec4 u1=pu(slot,1);uint target=texelFetch(uLodVertices,at(u1.x+i),0).z;
  if(target==0u)return;
  vec3 T=texelFetch(uPose,at(u1.y+special+target),0).xyz;
  oFinal=vec4(B(B(B(T.x-p.x)*alpha)+p.x),B(B(B(T.y-p.y)*alpha)+p.y),B(B(B(T.z-p.z)*alpha)+p.z),alpha);
}`;

// The lighting frame's Mirror (Frame+0x20) and lighting stamp. The vertices
// the lighting passes read are already in that frame's camera space.
export const CAMERA=`
uniform float uMirror;uniform uint uLightFrame;
`;

/** Face pass: DrawLodMesh 0x10b0fe60..0x10b0ffc9 (kernel light_mesh_job's
 * face loop) on the camera-space final pose (uCameraPose); w = 0 not drawn,
 * 1 drawn, 2 drawn and PF_Unlit. Attachment 1: meshFaceNormal on the world
 * pose. */
export const FACE_FRAGMENT=`${COMMON}${TABLES}${PARAMS}${CAMERA}${CORNERS}
uniform usampler2D uFaceMap,uMeshFaces;uniform sampler2D uPose,uCameraPose;uniform uint uFrame;
layout(location=0) out vec4 oFace;layout(location=1) out vec4 oEnvironment;
void main(){
  uint t=texelIndex();uvec2 map=texelFetch(uFaceMap,at(t),0).xy;
  if(map.x==0u)discard;
  uint slot=map.x-1u;uvec4 u2=pu(slot,2),u3=pu(slot,3);
  bool lit=u2.w==uLightFrame,environment=u3.x!=0u&&u2.z==uFrame;
  if(!lit&&!environment)discard;
  uvec4 u0=pu(slot,0),u1=pu(slot,1);
  uvec4 face=texelFetch(uMeshFaces,at(u0.z+map.y),0);
  // The corners' vertices from their resolved wedges (the LOD's collapsed
  // ones; at full detail the face's own). A dropped face adds nothing.
  uint c0=cornerWedge(u1.w,map.y*3u),c1=cornerWedge(u1.w,map.y*3u+1u),c2=cornerWedge(u1.w,map.y*3u+2u);
  oFace=vec4(0.0);oEnvironment=vec4(0.0);
  if(c0>=DROPPED||c1>=DROPPED||c2>=DROPPED)return;
  uint special=pu(slot,3).w;
  face.xyz=uvec3(special+(c0&0xffffu),special+(c1&0xffffu),special+(c2&0xffffu));
  vec3 w0=texelFetch(uPose,at(u1.y+face.x),0).xyz,w1=texelFetch(uPose,at(u1.y+face.y),0).xyz,w2=texelFetch(uPose,at(u1.y+face.z),0).xyz;
  if(lit){
    vec3 p0=texelFetch(uCameraPose,at(u1.y+face.x),0).xyz,p1=texelFetch(uCameraPose,at(u1.y+face.y),0).xyz,
      p2=texelFetch(uCameraPose,at(u1.y+face.z),0).xyz;
    // DrawLodMesh 0x10b0fe60..0x10b0ffbb at 24 bits (accumulateFaceNormal, faceDot),
    // the dot times Frame.Mirror (+0x20: exactly 1 or -1).
    float ax=B(p2.x-p0.x),ay=B(p2.y-p0.y),az=B(p2.z-p0.z),bx=B(p0.x-p1.x),bz=B(p0.z-p1.z),by=B(p0.y-p1.y);
    float nz=B(B(bx*ay)-B(by*ax)),ny=B(B(bz*ax)-B(bx*az)),nx=B(B(by*az)-B(bz*ay));
    float scale=tableRsqrt(B(B(B(B(nx*nx)+B(ny*ny))+B(nz*nz))+EPSILON));
    vec3 n=vec3(B(nx*scale),B(ny*scale),B(nz*scale));
    float dot=B(B(B(B(n.x*p0.x)+B(n.z*p0.z))+B(n.y*p0.y))*uMirror);
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
export const VERTEX_FRAGMENT=`${COMMON}${TABLES}${PARAMS}${CAMERA}${CORNERS}
uniform usampler2D uVertexMap,uMeshVertices,uAdjacency;uniform sampler2D uPose,uCameraPose,uFaces,uEnvironmentFaces,uLights;
uniform uint uFrame;
layout(location=0) out vec4 oLight;layout(location=1) out vec4 oEnvironment;
uint adjacent(uint k){uvec4 v=texelFetch(uAdjacency,at(k>>2),0);uint c=k&3u;return c==0u?v.x:c==1u?v.y:c==2u?v.z:v.w;}
void main(){
  uint t=texelIndex();uvec2 map=texelFetch(uVertexMap,at(t),0).xy;
  if(map.x==0u)discard;
  uint slot=map.x-1u;uvec4 u2=pu(slot,2),u3=pu(slot,3);
  bool lit=u2.w==uLightFrame,environment=u3.x!=0u&&u2.z==uFrame;
  if(!lit&&!environment)discard;
  uvec4 u1=pu(slot,1);
  vec3 N=vec3(0.0),E=vec3(0.0);
  // The faces containing the vertex in face order: at full detail its own
  // list; with the LOD the list entries whose corner resolved to it.
  // Below ModelVerts corners may collapse; at the full count (a morph alone)
  // every corner keeps its own vertex, so the exact list holds (a dropped
  // face there adds a zero normal and is not drawn).
  uvec4 lodRow=pu(slot,10);bool lod=(lodRow.w&1u)!=0u&&lodRow.y<pu(slot,0).y-pu(slot,3).w;
  uvec2 list=lod?texelFetch(uLodVertices,at(u1.x+map.y),0).xy:texelFetch(uMeshVertices,at(u1.x+map.y),0).xy;
  for(uint j=0u;j<list.y;j++){
    uint face;
    if(lod){uint e=lodEntry(list.x+j),c=cornerWedge(u1.w,(e>>2)*3u+(e&3u));
      if(c>=DROPPED||u3.w+(c&0xffffu)!=map.y)continue;face=u1.z+(e>>2);}
    else face=u1.z+adjacent(list.x+j);
    if(lit){vec3 n=texelFetch(uFaces,at(face),0).xyz;N=vec3(B(n.x+N.x),B(n.y+N.y),B(n.z+N.z));}
    if(u3.x!=0u){vec3 n=texelFetch(uEnvironmentFaces,at(face),0).xyz;E=vec3(B(E.x+n.x),B(E.y+n.y),B(E.z+n.z));}
  }
  oLight=vec4(0.0);oEnvironment=vec4(0.0);
  if(u3.x!=0u){
    float r=tableRsqrt(ffAddF(ffAdd(ffAdd(twoProd(E.x,E.x),twoProd(E.y,E.y)),twoProd(E.z,E.z)),EPSILON).x);
    oEnvironment=vec4(B(E.x*r),B(E.y*r),B(E.z*r),1.0);
  }
  if(!lit)return;
  vec3 P=texelFetch(uCameraPose,at(u1.y+map.y),0).xyz;
  // DrawLodMesh 0x10b10863..0x10b1090f and FLightManager::Light at the
  // render pass's 24 bits (the kernel's light_vertex): one binary32
  // operation each, the two quotients correctly rounded (divRN).
  float scale=tableRsqrt(B(B(B(B(N.x*N.x)+B(N.y*N.y))+B(N.z*N.z))+EPSILON));
  float nx=B(scale*N.x),ny=B(scale*N.y),nz=B(scale*N.z);
  float nw=B(B(B(P.x*nx)+B(P.y*ny))+B(P.z*nz));
  uint flags=u2.x;
  vec3 sum=vec3(0.0);
  if((flags&0x400000u)!=0u)sum=vec3(0.5);
  else{
    float p2=B(B(B(P.x*P.x)+B(P.y*P.y))+B(P.z*P.z));
    for(uint l=0u;l<u3.y;l++){
      vec4 L=texelFetch(uLights,at((u2.y+l)*2u),0),C=texelFetch(uLights,at((u2.y+l)*2u+1u),0);
      float dz=B(L.z-P.z),dy=B(L.y-P.y),dx=B(L.x-P.x);
      float dist2=B(B(B(dx*dx)+B(dy*dy))+B(dz*dz));
      float dist=tableSqrt(dist2);
      float factor=B(1.0-B(dist*L.w));
      if(!(factor>0.0))continue;
      float c=B(divRN(B(B(B(dy*ny)+B(dz*nz))+B(dx*nx)),dist)+1.0);
      float diffuse=B(B(c*c)-1.5);
      if(!(diffuse>=0.0))diffuse=0.0;
      float planeDot=B(B(B(B(L.z*nz)+B(L.y*ny))+B(L.x*nx))-nw),s2=B(planeDot+planeDot);
      float rx=B(L.x-B(s2*nx)),ry=B(L.y-B(s2*ny)),rz=B(L.z-B(s2*nz));
      float specular=B(B(B(B(rx*P.x)+B(rz*P.z))+B(ry*P.y))-p2);
      float total=diffuse;
      if(specular>0.0)total=B(divRN(B(B(specular*specular)*6.0),B(dist2*p2))+diffuse);
      float amount=B(total*factor);
      if(amount>0.0){
        sum.x=B(B(amount*C.x)+sum.x);
        sum.y=B(B(amount*C.y)+sum.y);
        sum.z=B(B(amount*C.z)+sum.z);
      }
    }
  }
  // F10.w: ScaleGlow*1.4 rounded once from the exact product (gpu-mesh.mjs).
  vec4 f10=pf(slot,10);
  float glow=f10.w;
  oLight=vec4(min(1.0,B(B(sum.x*glow)+f10.x)),min(1.0,B(B(sum.y*glow)+f10.y)),min(1.0,B(B(glow*sum.z)+f10.z)),1.0);
}`;

/** Corner pass: the kernel's final loop. Modulated corners and corners of
 * vertices no drawn face contains are white; a drawn PF_Unlit face at or
 * before this face that contains the vertex replaces its light with the unlit
 * colour (the in-order overwrite); diffuse bytes are FISTP(L*255). */
export const CORNER_FRAGMENT=`${COMMON}${PARAMS}${CORNERS}
uniform usampler2D uCornerMap,uMeshFaces,uMeshVertices,uAdjacency;uniform sampler2D uFaces,uLight;uniform uint uLightFrame;
out uvec4 oColor;
uint adjacent(uint k){uvec4 v=texelFetch(uAdjacency,at(k>>2),0);uint c=k&3u;return c==0u?v.x:c==1u?v.y:c==2u?v.z:v.w;}
uint byteOf(float value){return uint(roundEven(B(value*255.0)))&255u;}
void main(){
  uint t=texelIndex();uvec2 map=texelFetch(uCornerMap,at(t),0).xy;
  if(map.x==0u)discard;
  uint slot=map.x-1u;uvec4 u2=pu(slot,2);
  if(u2.w!=uLightFrame)discard;
  uvec4 u0=pu(slot,0),u1=pu(slot,1);
  uint f=map.y/3u,k=map.y-f*3u;
  uvec4 face=texelFetch(uMeshFaces,at(u0.z+f),0);
  uint c=cornerWedge(u1.w,map.y);
  if(c>=DROPPED){oColor=uvec4(255u,255u,255u,1u);return;}
  uint special=pu(slot,3).w,v=special+(c&0xffffu);
  if(((face.w|u2.x)&0x40u)!=0u){oColor=uvec4(255u,255u,255u,1u);return;}
  // Below ModelVerts corners may collapse; at the full count (a morph alone)
  // every corner keeps its own vertex, so the exact list holds (a dropped
  // face there adds a zero normal and is not drawn).
  uvec4 lodRow=pu(slot,10);bool lod=(lodRow.w&1u)!=0u&&lodRow.y<pu(slot,0).y-pu(slot,3).w;
  uvec2 list=lod?texelFetch(uLodVertices,at(u1.x+v),0).xy:texelFetch(uMeshVertices,at(u1.x+v),0).xy;
  bool lit=false,unlit=false;
  for(uint j=0u;j<list.y;j++){
    uint other;
    if(lod){uint e=lodEntry(list.x+j),o=cornerWedge(u1.w,(e>>2)*3u+(e&3u));
      if(o>=DROPPED||special+(o&0xffffu)!=v)continue;other=e>>2;}
    else other=adjacent(list.x+j);
    float w=texelFetch(uFaces,at(u1.z+other),0).w;
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
