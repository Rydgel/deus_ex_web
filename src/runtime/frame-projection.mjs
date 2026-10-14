/** The vertex chain from a frame's view space to the vertices the render
 * device receives (docs/frame-projection.md): Render.dll's projection into
 * ScreenX/ScreenY/RZ, D3DDrv.dll's conversion into the Direct3D
 * screen-space vertex (X, Y, depth, RHW), and the view transform the BSP
 * clipper applies to a model point. It runs at the render pass's precision
 * control 24, which on binary32 operands is one `Math.fround` per x87
 * operation (an operation on two binary32 values rounds the same at 24 bits
 * of significand as in single precision; docs/render-pass-precision.md).
 *
 * This is the CPU reference for the GLSL chain (src/viewer/
 * frame-projection-glsl.mjs); scripts/validate-frame-projection.mjs runs it
 * against the unchanged original under Unicorn (scripts/
 * native-frame-projection-oracle.py). */
const f32 = Math.fround;
const bitsOf = new Uint32Array(1), floatOf = new Float32Array(bitsOf.buffer);
/** A binary32 word as its value. */
export const wordFloat = word => (bitsOf[0] = word, floatOf[0]);
/** A binary32 value as its word. */
export const floatWord = value => (floatOf[0] = value, bitsOf[0]);

/** The projection fields of the master frame words OccludeBsp reads
 * (bsp-occlusion.mjs: coords 0..11, X 12, Y 13, FX15 14, FY15 15, Proj.Z 20,
 * RProj.Z 60) with the render rectangle's offset (the frame's XB and YB). */
export function frameOfWords(words, { x = 0, y = 0 } = {}) {
  return frameOf(Array.from({ length: 12 }, (_, i) => wordFloat(words[i])), words[12] | 0, words[13] | 0,
    wordFloat(words[14]), wordFloat(words[15]), wordFloat(words[20]), wordFloat(words[60]), x, y);
}

/** The same fields from the ComputeRenderSize layout the Rust core keeps for
 * every frame (`fields`: Coords 0..11, FX 12, FY 13, FX15 14, FY15 15, FX2 16,
 * FY2 17, Zoom 18, Proj 19..21, RProj 22..24, PrjXM..PrjYP 25..28) and the
 * frame's rectangle (X, Y, XB, YB). */
export function frameOfFields(fields, { width, height, x = 0, y = 0 }) {
  const f = i => wordFloat(fields[i]);
  return frameOf(Array.from({ length: 12 }, (_, i) => f(i)), width, height, f(14), f(15), f(21), f(24), x, y);
}

function frameOf(coords, width, height, fx15, fy15, projZ, rprojZ, x, y) {
  return { origin: coords.slice(0, 3), axes: [coords.slice(3, 6), coords.slice(6, 9), coords.slice(9, 12)],
    width, height, fx15, fy15, projZ, rprojZ, xb: x, yb: y };
}

/** UD3DRenderDevice::SetRes' projection matrix (D3DDrv 0x1000c40f..0x1000c45b):
 * the far plane is 32767, or 8192 when the viewport's colour depth is 16 bits;
 * `zBias` is _33 = far / (far - 1) stored as binary32 and `zScale` is _43 =
 * -_33 (near = 1). The vertex depth is `rhw * zScale + zBias`, so the viewport's
 * [0, 1] depth range maps view depth 1 to 0 and the far plane to 1. */
export function depthConstants(colorBits = 32) {
  const far = colorBits === 16 ? 8192 : 32767;
  const zBias = f32(far / (far - 1));
  return { zBias, zScale: -zBias };
}

/** ClipBspSurf's view transform of a model point (0x10b14cb0, the inline
 * block per vertex): the point less the frame's origin, then three dot
 * products ((x*ax + y*ay) + z*az), each operation rounded. */
export function viewPoint(frame, [x, y, z]) {
  const dx = f32(x - frame.origin[0]), dy = f32(y - frame.origin[1]), dz = f32(z - frame.origin[2]);
  return frame.axes.map(a => f32(f32(f32(dx * a[0]) + f32(dy * a[1])) + f32(dz * a[2])));
}

/** Render.dll's projection of a view-space point (ClipBspSurf, DrawLodMesh
 * 0x10b10a53, DrawTriangle's clipped points): RZ = Proj.Z / Z; ScreenX =
 * X * RZ + FX15; ScreenY = Y * RZ + FY15. */
export function projectView(frame, [x, y, z]) {
  const rz = f32(frame.projZ / z);
  return { rz, screenX: f32(f32(x * rz) + frame.fx15), screenY: f32(f32(y * rz) + frame.fy15) };
}

/** D3DDrv's vertex from a projected point (DrawComplexSurface 0x10003c05..
 * 0x10003c41, DrawGouraudPolygon 0x10005822..0x10005869): X = (XB + ScreenX)
 * - 0.5, Y likewise (the 0.5 of Direct3D's integer pixel centres), RHW = RZ *
 * RProj.Z, depth = RHW * ZScale + ZBias. */
export function d3dVertex(frame, depth, { rz, screenX, screenY }) {
  const rhw = f32(rz * frame.rprojZ);
  return { sx: f32(f32(frame.xb + screenX) - 0.5), sy: f32(f32(frame.yb + screenY) - 0.5),
    sz: f32(f32(rhw * depth.zScale) + depth.zBias), rhw };
}

/** A model point's vertex (view transform, projection, D3D conversion). */
export function modelVertex(frame, depth, point) {
  const view = viewPoint(frame, point);
  return { view, ...d3dVertex(frame, depth, projectView(frame, view)) };
}
