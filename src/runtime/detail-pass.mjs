/** D3DDrv's detail-texture pass over a facet's saved polygons (UD3DRenderDevice::DrawComplexSurface
 * 0x1000486e..0x10004d0b, docs/frame-projection.md "Detail textures"): the CPU reference the Rust core's port and Play's
 * draw are compared with, itself compared with the original run under Unicorn
 * (scripts/validate-detail-pass.mjs).
 *
 * Three layers; layer k has the fade distance D = 380 * 0.2367985^k and the texture scale 4.223^k (both stored as binary32
 * after each layer's multiply). A vertex is inside a layer when its view depth is below D. A polygon with no inside vertex
 * is skipped; the others become a Sutherland-Hodgman clip of the polygon at depth D: for each vertex in order, the vertex
 * where the edge from the previous one crosses D (when exactly one of the two is inside), then the vertex itself when it is
 * inside. Inside vertices repeat the base pass' X, Y, depth and RHW with colour 0x808080 | alpha << 24, alpha = min(255,
 * round((D / Z - 1) * 100)) (the x87 round to nearest even, unsigned compare); the clip vertex has the layer's clip depth
 * (1/D * ZScale + ZBias), RHW 1/D, colour 0x808080 and X = ((t * ScreenX_prev * Z_prev + s * ScreenX_cur * Z_cur) * (1/D)
 * + XB) - 0.5 (Y alike), t = (Z_cur - D) / (Z_cur - Z_prev), s = 1 - t. Texture coordinates are (U - Pan) * UScale * layer
 * scale with U the vertex' MapCoords projection ((dz*Uz + dy*Uy) + dx*Ux, d the view-space point less the facet's origin),
 * mixed by s and t on the clip vertex; UIndex and VIndex (SetTexture) say which of the two vertex slots takes U and V.
 *
 * Every operation is one `Math.fround` (the render pass runs at precision control 24: docs/render-pass-precision.md). */
import { d3dVertex, viewPoint } from './frame-projection.mjs';

const f32 = Math.fround;
const bitsOf = new Uint32Array(1), floatOf = new Float32Array(bitsOf.buffer);
const wordFloat = word => (bitsOf[0] = word, floatOf[0]);
const floatWord = value => (floatOf[0] = value, bitsOf[0]);

export const DETAIL_LAYERS = 3;
/** D3DDrv's constants: 380.0 (an immediate), the layers' fade and scale factors (0x10018640, 0x10018644), 100.0. */
export const DETAIL_FIRST_DISTANCE = 380;
export const DETAIL_FADE = wordFloat(0x3e727b4d), DETAIL_SCALE = wordFloat(0x408722d1), ALPHA_SCALE = 100;

/** x87 FISTP with the default rounding control: round to nearest, ties to even. */
export function roundEven(value) {
  const floor = Math.floor(value), diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** A vertex' MapCoords projection (D3DDrv 0x10004082..0x100040cb): the view-space point less the facet's origin, dotted
 * with the U and V axes, z and y terms first. */
export function rawUV(facet, [x, y, z]) {
  const dx = f32(x - facet.origin[0]), dy = f32(y - facet.origin[1]), dz = f32(z - facet.origin[2]);
  const dot = a => f32(f32(f32(dz * a[2]) + f32(dy * a[1])) + f32(dx * a[0]));
  return [dot(facet.u), dot(facet.v)];
}

/** The facet's MapCoords in the frame's view space as Render.dll DrawFrame makes them: the base point as ClipBspSurf
 * transforms a model point (its origin block 0x10b1aab7 has the same operations), the texture axes through Core's
 * FVector::TransformVectorBy (0x10119e40: ((x*A.x + y*A.y) + z*A.z) for each of the frame's axes A). */
export function facetOf(frame, base, u, v) {
  const axis = ([x, y, z]) => frame.axes.map(a => f32(f32(f32(x * a[0]) + f32(y * a[1])) + f32(z * a[2])));
  return { origin: viewPoint(frame, base), u: axis(u), v: axis(v) };
}

/** What SetTexture(0, texture) leaves in stage 0 for a texture of `uSize` x `vSize` texels (its first mip, shift 0) and
 * UScale = VScale = `scale` (D3DDrv 0x10008e15..0x10008e97): the longer side takes the first vertex coordinate, and the
 * scales are 1 / (size * scale) as binary32. */
export function detailStage(uSize, vSize, scale) {
  const uIndex = uSize < vSize ? 1 : 0;
  return { uIndex, vIndex: 1 - uIndex, uScale: f32(1 / f32(uSize * scale)), vScale: f32(1 / f32(vSize * scale)) };
}

/** The per-surface table the Rust pass reads (detail.rs): sixteen words a model surface, zero for a surface without a detail
 * texture. `details[i]` is surfaceDetails' entry (scripts/occlusion-request.mjs: the first mip's size, the UScale words, the
 * Pan words). */
export const DETAIL_TABLE_WORDS = 16;
export function detailTable(model, details) {
  const table = new Uint32Array(DETAIL_TABLE_WORDS * model.surfaces.length);
  model.surfaces.forEach((surface, i) => {
    const d = details[i];
    if (!d) return;
    const stage = detailStage(d.uSize, d.vSize, wordFloat(d.scaleBits[0]));
    table.set([1, ...model.points[surface.base].map(floatWord), ...model.vectors[surface.textureU].map(floatWord),
      ...model.vectors[surface.textureV].map(floatWord), stage.uIndex, stage.vIndex, floatWord(stage.uScale), floatWord(stage.vScale),
      d.panBits[0], d.panBits[1]], DETAIL_TABLE_WORDS * i);
  });
  return table;
}

/** The pass for one facet. `points` are the polygons' FTransform fields ({ x, y, z, screenX, screenY, rz } as floats),
 * `facet` the view-space MapCoords ({ origin, u, v }), `stage` the detail texture's { uIndex, vIndex, uScale, vScale },
 * `pan` its [X, Y]. Returns the fans in drawing order: { layer, poly, first, vertices } with each vertex as seven words
 * (X, Y, depth, RHW, colour, the words at vertex + 0x14 and + 0x18). */
export function detailFans(frame, depth, facet, stage, pan, polys) {
  const fans = [];
  const uvOf = polys.map(poly => poly.map(p => rawUV(facet, [p.x, p.y, p.z])));
  const base = polys.map(poly => poly.map(p => d3dVertex(frame, depth, { rz: p.rz, screenX: p.screenX, screenY: p.screenY })));
  let distance = f32(DETAIL_FIRST_DISTANCE), scale = f32(1);
  for (let layer = 0; layer < DETAIL_LAYERS; layer++) {
    const rhwD = f32(1 / distance), clipDepth = f32(f32(rhwD * depth.zScale) + depth.zBias);
    let first = 0;
    for (const [k, poly] of polys.entries()) {
      const inside = poly.map(p => p.z < distance);
      if (inside.some(Boolean)) {
        const vertices = [];
        const put = (sx, sy, sz, rhw, color, u, v) => {
          const words = [floatWord(sx), floatWord(sy), floatWord(sz), floatWord(rhw), color >>> 0, 0, 0];
          words[5 + stage.uIndex] = floatWord(u);
          words[5 + stage.vIndex] = floatWord(v);
          vertices.push(words);
        };
        for (let i = 0, previous = poly.length - 1; i < poly.length; previous = i++) {
          const a = poly[i], b = poly[previous];
          if (inside[i] !== inside[previous]) {
            const t = f32(f32(a.z - distance) / f32(a.z - b.z)), s = f32(f32(1) - t);
            // (the previous vertex' term + the current one's) * (1/D), then + XB, then - 0.5, each stored binary32. The
            // instructions multiply X's previous term as (t * ScreenX) * Z and Y's as (ScreenY * Z) * t (0x10004a88, 0x10004abd).
            const screen = (previousTerm, sa, offset) => f32(f32(f32(f32(previousTerm + f32(f32(sa * a.z) * s)) * rhwD) + offset) - 0.5);
            const x = screen(f32(f32(t * b.screenX) * b.z), a.screenX, frame.xb), y = screen(f32(f32(b.screenY * b.z) * t), a.screenY, frame.yb);
            // (s * U_cur + t * U_prev - Pan) * UScale * layer scale
            const mixed = c => f32(f32(f32(f32(f32(s * uvOf[k][i][c]) + f32(t * uvOf[k][previous][c])) - pan[c]) * (c ? stage.vScale : stage.uScale)) * scale);
            const u = mixed(0), v = mixed(1);
            put(x, y, clipDepth, rhwD, 0x808080, u, v);
          }
          if (inside[i]) {
            const alpha = Math.min(255, roundEven(f32(f32(f32(distance / a.z) - 1) * ALPHA_SCALE)) >>> 0);
            const color = (alpha << 24 | 0x808080) >>> 0;
            const u = f32(f32(f32(uvOf[k][i][0] - pan[0]) * stage.uScale) * scale);
            const v = f32(f32(f32(uvOf[k][i][1] - pan[1]) * stage.vScale) * scale);
            const own = base[k][i];
            put(own.sx, own.sy, own.sz, own.rhw, color, u, v);
          }
        }
        fans.push({ layer, poly: k, first, vertices });
      }
      first += poly.length;
    }
    scale = f32(scale * DETAIL_SCALE);
    distance = f32(distance * DETAIL_FADE);
  }
  return fans;
}
