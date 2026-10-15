/** The inputs scripts/native-occlusion-oracle.py and the Rust port share
 * (validate-bsp-occlusion.mjs, validate-sprite-setup.mjs): a decoded map's
 * compiled model as the oracle's fixture request, each surface texture's
 * PolyFlags, and Core appTan's measured results for the frame producer. */
import { readTexture } from '../src/unreal/textures.mjs';
import { buildWindowSceneFrame } from '../src/runtime/script-window-scene-frame.mjs';
import { childFrameTangent, texturePolyFlags } from '../src/runtime/bsp-occlusion.mjs';
import { x87TanCandidates } from '../src/runtime/x87-tan.mjs';
import { hex64, measureTangents } from './x87-hardware-tangents.mjs';
import assert from 'node:assert/strict';
import { TRACKER } from '../src/runtime/brush-tracker.mjs';

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export const bits = value => (f32[0] = value, u32[0]);

/** Core appTan's measured qword results for FOV 75 and 90 (the table in
 * script-window-scene-frame.mjs), keyed by the double argument the frame
 * producer passes, for the oracle's Engine ComputeRenderSize. */
export function occlusionTangents() {
  const tangents = {}, io = new DataView(new ArrayBuffer(8));
  for (const [fov, result] of [[75, '3fe88df153d6a676'], [90, '3fefffffffffffff']])
    buildWindowSceneFrame({ location: [0, 0, 0], rotation: [0, 0, 0], width: 64, height: 64, fov, appTan: argument => {
      io.setFloat64(0, argument, true);
      tangents[io.getBigUint64(0, true).toString(16).padStart(16, '0')] = result;
      io.setBigUint64(0, BigInt(`0x${result}`), true);
      return io.getFloat64(0, true);
    } });
  return tangents;
}

/** Each surface's texture PolyFlags (0 without a texture). */
export async function surfaceTextureFlags(assets, asset, model) {
  const textureFlags = new Map(), flags = [];
  for (const surface of model.surfaces) {
    if (!surface.texture) { flags.push(0); continue; }
    if (!textureFlags.has(surface.texture)) {
      const object = await assets.resolve(asset, surface.texture);
      textureFlags.set(surface.texture, texturePolyFlags(readTexture(object.asset, object.index).values));
    }
    flags.push(textureFlags.get(surface.texture));
  }
  return flags;
}

/** Each surface's detail texture for the frame-projection oracle's detail pass (null without one): the detail texture's first
 * mip size and its UScale and VScale words (UTexture::Lock's UScale at LOD 0 is Scale, as docs/decals.md measured), and the
 * Pan words (0: Lock leaves the pan at zero, [docs/frame-projection.md] unverified). */
export async function surfaceDetails(assets, asset, model) {
  const cache = new Map(), details = [];
  for (const surface of model.surfaces) {
    if (!surface.texture) { details.push(null); continue; }
    if (!cache.has(surface.texture)) {
      const object = await assets.resolve(asset, surface.texture);
      const values = readTexture(object.asset, object.index).values;
      let detail = null;
      if (values.DetailTexture) {
        const target = await assets.resolve(object.asset, values.DetailTexture), texture = readTexture(target.asset, target.index);
        const scale = bits(texture.values.DrawScale ?? texture.values.Scale ?? 1);
        detail = { uSize: texture.mips[0].width, vSize: texture.mips[0].height, scaleBits: [scale, scale], panBits: [0, 0],
          name: target.key };
      }
      cache.set(surface.texture, detail);
    }
    details.push(cache.get(surface.texture));
  }
  return details;
}

/** The oracle request's `model`. With `details` (surfaceDetails) each surface also carries its base point, texture axes and
 * detail texture, and the model its vectors, for the facet the detail pass needs. */
export function occlusionModelRequest(model, textureFlags, details = null) {
  const zoneActors = [...new Set(model.zones.map(z => z.actor).filter(a => a > 0))].map(index => ({ index }));
  return {
    nodes: model.nodes.map(n => ({ planeBits: n.plane.map(bits), zoneMask: n.zoneMask, vertexPool: n.vertexPool,
      surface: n.surface, back: n.back, front: n.front, coplanar: n.coplanar, collisionBound: n.collisionBound,
      renderBound: n.renderBound, zones: n.zones, vertexCount: n.vertexCount, flags: n.flags, leaves: n.leaves })),
    verts: model.vertices.map(v => [v.point, v.side]), pointBits: model.points.map(p => p.map(bits)),
    surfs: model.surfaces.map((s, i) => ({ texture: i, flags: s.flags >>> 0,
      ...(details ? { base: s.base, textureU: s.textureU, textureV: s.textureV, detail: details[i] } : {}) })),
    ...(details ? { vectorBits: model.vectors.map(v => v.map(bits)) } : {}),
    textures: textureFlags.map(polyFlags => ({ polyFlags })),
    boundBits: model.renderBounds.map(b => [...b.min.map(bits), ...b.max.map(bits), b.valid ? 1 : 0]),
    zones: model.zones.map(z => ({ actor: z.actor })), zoneActors, rootOutside: model.rootOutside, numZones: model.zones.length,
  };
}

/** The oracle's model from the occlusion's memory after the tracker
 * filtered movers in: every node, vert, point and surface (with its texture
 * PolyFlags) the arrays hold, and the tracker's original surface count. */
export function trackedModelRequest(occlusion, base, memory) {
  const t = occlusion.tracker, { nodes, verts, points, surfs } = occlusion.blocks;
  const u = new Uint32Array(memory.buffer), i32 = new Int32Array(memory.buffer), b = new Uint8Array(memory.buffer);
  const count = k => t.header(k), range = n => Array.from({ length: n }, (_, i) => i);
  return { ...base,
    nodes: range(count(TRACKER.NODES_NUM)).map(i => {
      const o = (nodes >>> 2) + 16 * i, at = nodes + 64 * i;
      return { planeBits: [...u.subarray(o, o + 4)], zoneMask: [u[o + 4], u[o + 5]], vertexPool: i32[o + 6], surface: i32[o + 7],
        back: i32[o + 8], front: i32[o + 9], coplanar: i32[o + 10], collisionBound: i32[o + 11], renderBound: i32[o + 12],
        zones: [b[at + 52], b[at + 53]], vertexCount: b[at + 54], flags: b[at + 55], leaves: [i32[o + 14], i32[o + 15]] };
    }),
    verts: range(count(TRACKER.VERTS_NUM)).map(i => [i32[(verts >>> 2) + 2 * i], i32[(verts >>> 2) + 2 * i + 1]]),
    pointBits: range(count(TRACKER.POINTS_NUM)).map(i => [...u.subarray((points >>> 2) + 3 * i, (points >>> 2) + 3 * i + 3)]),
    surfs: range(count(TRACKER.SURFS_NUM)).map(i => ({ texture: i, flags: u[(surfs >>> 2) + 2 * i] })),
    textures: range(count(TRACKER.SURFS_NUM)).map(i => ({ polyFlags: u[(surfs >>> 2) + 2 * i + 1] })),
    brushTracker: { originalSurfs: count(TRACKER.SURFS_TOP) } };
}

// The render pass's ComputeRenderSize (docs/render-pass-precision.md "The 3D
// frame's projection"): XRootWindow::PreRender leaves the frame's X and Y a
// render rectangle and calls ComputeRenderSize again at precision control
// 24, so appTan's argument is the 24-bit FOV product.
let hardware;
const checked = new Set();

/** Core appTan's qword result (16 hex digits, keyed by its double argument
 * as the oracle looks it up) for the render pass's ComputeRenderSize at
 * Actor.FOVAngle `fov` on a frame `width` pixels wide: the real-x87
 * measurement when the runner exists (FOV 75 and 90; it must be one of the
 * FPTAN model's candidates), else the model's. */
export function renderPassTangent(fov, width, label = 'render pass appTan') {
  const { argument, tangent } = childFrameTangent(fov, width), key = hex64(argument);
  if (hardware === undefined)
    hardware = measureTangents([75, 90].map(f => hex64(childFrameTangent(f, 1024).argument)), label);
  const measured = hardware?.get(key) ?? null;
  if (measured && !checked.has(key)) {
    const candidates = x87TanCandidates(argument).map(hex64);
    assert.ok(candidates.includes(measured), `FPTAN model candidates ${candidates} miss the hardware tangent ${measured}`);
    checked.add(key);
  }
  return { [key]: measured ?? hex64(tangent) };
}
/** How many distinct render-pass arguments were checked against hardware. */
export const renderPassTangentsMeasured = () => checked.size;

/** A render rectangle inside a width x height viewport (what XRootWindow::
 * PreRender leaves in the frame's XB, YB, X, Y): `clip` below 1 shrinks
 * it. */
export function renderRectangle(width, height, random, clip = 1) {
  const w = clip < 1 ? Math.max(48, Math.floor(width * (0.45 + random() * 0.55))) : width;
  const h = clip < 1 ? Math.max(48, Math.floor(height * (0.45 + random() * 0.55))) : height;
  return { width: w, height: h, x: clip < 1 ? Math.floor(random() * (width - w + 1)) : 0, y: clip < 1 ? Math.floor(random() * (height - h + 1)) : 0 };
}
