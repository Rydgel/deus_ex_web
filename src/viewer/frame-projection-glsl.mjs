/** GLSL for the original's vertex projection (docs/frame-projection.md): the
 * chain src/runtime/frame-projection.mjs is the CPU reference of. Every
 * rounded result goes through the barrier B() (gpu-mesh-glsl.mjs FLOAT_FLOAT:
 * ANGLE's Metal and GL backends fuse a*b+c and reassociate sums, GLSL ES 3.00
 * has no `precise`), and the one division is the correctly rounded divRN, so
 * each x87 operation of the render pass (precision control 24) is one binary32
 * operation here.
 *
 *   fpView(p)   ClipBspSurf's transform of a world-space point (Unreal axes)
 *   fpVertex(v) Render.dll's projection and D3DDrv's vertex of a view-space
 *               point: (X, Y, depth, RHW) as the render device receives it
 *   fpClip(v)   the same vertex as clip coordinates for the host rasterizer
 *   fpVertexDecal(v), fpClipDecal(v)   ClipDecal's point: the same, but a point
 *               flagged outside the view has its ScreenX and ScreenY clamped
 *               (Render.dll 0x10b1c660..0x10b1c825)
 *
 * Uniforms (all from one pass frame, frame-projection.mjs `uniforms`):
 *   uFpOn      1 when the pass has a frame, else the host camera projects
 *   uFpOrigin, uFpAxisX/Y/Z   Frame->Coords
 *   uFpProj    (Proj.Z, RProj.Z, FX15, FY15)
 *   uFpRect    (X, Y, XB, YB), the frame's rectangle in drawing-buffer pixels
 *   uFpView    (width, height, x, y) of the viewport the pass renders into
 *              (top-down pixels; the frame's rectangle for the main pass, a
 *              mirror target's whole size)
 *   uFpDepth   (_33, _43, horizontal flip)
 *   uFpPrj     (PrjXM, PrjYM, PrjXP, PrjYP) of the frame, ClipDecal's outcode planes
 */
import { FLOAT_FLOAT } from './gpu-mesh-glsl.mjs';

export const FRAME_PROJECTION_UNIFORMS = `
uniform float uFpOn;
uniform vec3 uFpOrigin,uFpAxisX,uFpAxisY,uFpAxisZ;
uniform vec4 uFpProj,uFpRect,uFpView;
uniform vec3 uFpDepth;
uniform vec4 uFpPrj;
`;

const FUNCTIONS = `
vec3 fpView(vec3 p){
  float dx=B(p.x-uFpOrigin.x),dy=B(p.y-uFpOrigin.y),dz=B(p.z-uFpOrigin.z);
  return vec3(B(B(B(dx*uFpAxisX.x)+B(dy*uFpAxisX.y))+B(dz*uFpAxisX.z)),
    B(B(B(dx*uFpAxisY.x)+B(dy*uFpAxisY.y))+B(dz*uFpAxisY.z)),
    B(B(B(dx*uFpAxisZ.x)+B(dy*uFpAxisZ.y))+B(dz*uFpAxisZ.z)));}
vec4 fpVertex(vec3 v){
  float rz=divRN(uFpProj.x,v.z);
  float screenX=B(B(v.x*rz)+uFpProj.z),screenY=B(B(v.y*rz)+uFpProj.w);
  float rhw=B(rz*uFpProj.y);
  return vec4(B(B(uFpRect.z+screenX)-0.5),B(B(uFpRect.w+screenY)-0.5),B(B(rhw*uFpDepth.y)+uFpDepth.x),rhw);}
// A D3D vertex as clip coordinates: w is the view depth z, so the rasterizer's
// perspective division and clipping act on the exact screen position, depth
// and RHW (the mapping to normalized device coordinates is the host's).
vec4 fpClipOf(vec4 d,float z){
  float nx=(d.x+0.5-uFpView.z)*(2.0/uFpView.x)-1.0;
  float ny=1.0-(d.y+0.5-uFpView.w)*(2.0/uFpView.y);
  float nz=2.0*d.z-1.0;
  return vec4(uFpDepth.z*nx*z,ny*z,nz*z,z);}
// The vertex in clip space. A point nearer than the near plane (view depth 1,
// where the depth is 0) takes the same mapping in its linear form, which clips
// there.
vec4 fpClipLinear(vec3 v){
  float flip=uFpDepth.z;
  float a=2.0*uFpProj.x/uFpView.x,b=2.0*(uFpProj.z+uFpRect.z-uFpView.z)/uFpView.x-1.0;
  float c=2.0*uFpProj.x/uFpView.y,e=1.0-2.0*(uFpProj.w+uFpRect.w-uFpView.w)/uFpView.y;
  float zb=uFpDepth.x;
  return vec4(flip*(a*v.x+b*v.z),e*v.z-c*v.y,(2.0*zb-1.0)*v.z-2.0*zb*uFpProj.y*uFpProj.x,v.z);}
vec4 fpClip(vec3 v){
  if(v.z>=1.0)return fpClipOf(fpVertex(v),v.z);
  return fpClipLinear(v);}
// ClipDecal's point (Render.dll 0x10b1c660..0x10b1c825): the outcode flags are
// the sign bits of Z*PrjXM + X, Z*PrjYM + Y, Z*PrjXP - X and Z*PrjYP - Y (each
// stored as binary32), and a flagged point's ScreenX and ScreenY are clamped to
// [0, X - 1] and [0, Y - 1] (X, Y the frame's size) before D3DDrv builds the
// vertex; RZ, RHW and the depth are the unclamped point's.
vec4 fpVertexDecal(vec3 v){
  float rz=divRN(uFpProj.x,v.z);
  float screenX=B(B(v.x*rz)+uFpProj.z),screenY=B(B(v.y*rz)+uFpProj.w);
  float a=B(B(v.z*uFpPrj.x)+v.x),b=B(B(v.z*uFpPrj.y)+v.y),c=B(B(v.z*uFpPrj.z)-v.x),e=B(B(v.z*uFpPrj.w)-v.y);
  if(((floatBitsToUint(a)|floatBitsToUint(b)|floatBitsToUint(c)|floatBitsToUint(e))>>31u)!=0u){
    float lx=uFpRect.x-1.0,ly=uFpRect.y-1.0;
    screenX=screenX<0.0?0.0:(screenX<lx?screenX:lx);
    screenY=screenY<0.0?0.0:(screenY<ly?screenY:ly);}
  float rhw=B(rz*uFpProj.y);
  return vec4(B(B(uFpRect.z+screenX)-0.5),B(B(uFpRect.w+screenY)-0.5),B(B(rhw*uFpDepth.y)+uFpDepth.x),rhw);}
vec4 fpClipDecal(vec3 v){
  if(v.z>=1.0)return fpClipOf(fpVertexDecal(v),v.z);
  return fpClipLinear(v);}
`;

/** The declarations and functions. `floatFloat` false when the shader
 * already carries FLOAT_FLOAT (the GPU mesh draw does, with its own zero
 * uniform): then `B` and `divRN` are the ones in scope. */
export function frameProjectionGlsl({ zero = 'uFpZero', floatFloat = true } = {}) {
  return `${floatFloat ? `uniform uint ${zero};\n${FLOAT_FLOAT.replace(/\bZERO\b/g, zero)}` : ''}
${FRAME_PROJECTION_UNIFORMS}${FUNCTIONS}`;
}
