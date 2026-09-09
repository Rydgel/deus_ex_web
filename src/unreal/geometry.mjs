// UE: X forward, Y right, Z up (left-handed). Viewer: X right, Y up, -Z forward.
// Keep one scene unit per Unreal unit; this reflection requires reversed winding.
export const toView = ([x, y, z]) => [y, z, -x];
export const fromView = ([x, y, z]) => [-z, x, y];
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export const POLY = { Invisible: 1, Masked: 2, Translucent: 4, NotSolid: 8, Environment: 16,
  FakeBackdrop: 128, TwoSided: 256, AutoUPan: 512, AutoVPan: 1024, NoSmooth: 2048,
  Modulated: 0x40, Unlit: 0x400000, Portal: 0x4000000, Mirrored: 0x8000000 };

/** UVs stay in texture-pixel coordinates until texture dimensions are known. */
export function surfaceUV(model, surface, point, width, height) {
  const local = sub(point, model.points[surface.base]);
  return [(dot(local, model.vectors[surface.textureU]) + surface.pan[0]) / width,
    (dot(local, model.vectors[surface.textureV]) + surface.pan[1]) / height];
}

export function buildSurfaceGeometry(model, triangles, surfaceIndex, width, height) {
  const surface = model.surfaces[surfaceIndex];
  const sourceNormal = model.vectors[surface.normal];
  const normal = toView(sourceNormal);
  const positions = [], normals = [], uvs = [];
  let degenerate = 0, corrected = 0;
  for (const triangle of triangles) {
    let p = triangle.points.map(index => model.points[index]);
    const alignment = dot(cross(sub(p[1], p[0]), sub(p[2], p[0])), sourceNormal);
    if (Math.abs(alignment) < 1e-6) { degenerate++; continue; }
    // Align every polygon with its authored surface normal, then account for reflection.
    if (alignment > 0) p = [p[0], p[2], p[1]];
    else corrected++;
    for (const point of p) {
      positions.push(...toView(point)); normals.push(...normal);
      uvs.push(...surfaceUV(model, surface, point, width, height));
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals),
    uvs: new Float32Array(uvs), degenerate, corrected };
}
