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
 *
 * Uniforms (all from one pass frame, frame-projection.mjs `uniforms`):
 *   uFpOn      1 when the pass has a frame, else the host camera projects
 *   uFpOrigin, uFpAxisX/Y/Z   Frame->Coords
 *   uFpProj    (Proj.Z, RProj.Z, FX15, FY15)
 *   uFpRect    (X, Y, XB, YB)
 *   uFpDepth   (_33, _43, horizontal flip)
 */
import { FLOAT_FLOAT } from './gpu-mesh-glsl.mjs';

export const FRAME_PROJECTION_UNIFORMS = `
uniform float uFpOn;
uniform vec3 uFpOrigin,uFpAxisX,uFpAxisY,uFpAxisZ;
uniform vec4 uFpProj,uFpRect;
uniform vec3 uFpDepth;
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
// The vertex in clip space: w is the view depth, so the rasterizer's
// perspective division and clipping act on the exact screen position, depth
// and RHW (the mapping to normalized device coordinates is the host's). A
// point nearer than the near plane (view depth 1, where the depth is 0) takes
// the same mapping in its linear form, which clips there.
vec4 fpClip(vec3 v){
  float flip=uFpDepth.z;
  if(v.z>=1.0){
    vec4 d=fpVertex(v);
    float nx=(d.x+0.5-uFpRect.z)*(2.0/uFpRect.x)-1.0;
    float ny=1.0-(d.y+0.5-uFpRect.w)*(2.0/uFpRect.y);
    float nz=2.0*d.z-1.0;
    return vec4(flip*nx*v.z,ny*v.z,nz*v.z,v.z);}
  float a=2.0*uFpProj.x/uFpRect.x,b=2.0*uFpProj.z/uFpRect.x-1.0;
  float c=2.0*uFpProj.x/uFpRect.y,e=1.0-2.0*uFpProj.w/uFpRect.y;
  float zb=uFpDepth.x;
  return vec4(flip*(a*v.x+b*v.z),e*v.z-c*v.y,(2.0*zb-1.0)*v.z-2.0*zb*uFpProj.y*uFpProj.x,v.z);}
`;

/** The declarations and functions. `floatFloat` false when the shader
 * already carries FLOAT_FLOAT (the GPU mesh draw does, with its own zero
 * uniform): then `B` and `divRN` are the ones in scope. */
export function frameProjectionGlsl({ zero = 'uFpZero', floatFloat = true } = {}) {
  return `${floatFloat ? `uniform uint ${zero};\n${FLOAT_FLOAT.replace(/\bZERO\b/g, zero)}` : ''}
${FRAME_PROJECTION_UNIFORMS}${FUNCTIONS}`;
}
