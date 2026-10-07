/** Engine's moving brush tracker in the Rust core (native/script-vm/src/
 * tracker.rs; docs/brush-tracker.md), on the occlusion model's memory
 * (bsp-occlusion.mjs): the host sizes every block the tracker can reach,
 * writes the movers and their brush polygons, and reads the model back.
 *
 * A mover spec: `tag` (the owner word the tracker writes into NodeMaps,
 * VertOwners and PointHelper; any nonzero value), `flags` (bStatic 1,
 * bHidden 2), `locationBits`, `rotation` (int32), `prePivotBits`,
 * `mainScale` and `postScale` ({scaleBits, sheerRateBits, sheerAxis}),
 * `specialLit` and `polys`: each {baseBits, normalBits, textureUBits,
 * textureVBits, vertexBits (at most 16), flags, textureKey, textureFlags,
 * iBrushPoly, pan [U, V]}. */

import { readModel } from '../unreal/model.mjs';
import { readPolys } from '../unreal/polys.mjs';
import { ClassDefaults } from '../unreal/classes.mjs';

/** MOVER_TRACKER=off (Node) or ?moverTracker=off keeps movers out of the
 * BSP: drawn whole, frustum-stamped (the earlier Play behaviour). */
export const moverTrackerMode = () => (typeof process !== 'undefined' && process.env?.MOVER_TRACKER)
  || globalThis.DEUS_EX_MOVER_TRACKER || 'on';

/** The constructor's movers (0x1037ace1): every actor with a Brush whose
 * class is a Brush and which is not bStatic, in map order, with its merged
 * defaults and brush polygons (readPolys). The shipped ones are all Movers
 * (a non-static non-Mover brush is a GError in the original). */
export async function collectTrackerMovers(assets, asset, map) {
  const defaults = new ClassDefaults(assets), movers = [];
  for (const a of map.actors) {
    if (!(a.values.Brush > 0)) continue;
    const classes = await defaults.lineage(asset, asset.pkg.exports[a.index - 1].classIndex);
    if (!classes.includes('engine.brush')) continue;
    const values = await defaults.forActor(asset, a);
    if (values.bStatic) continue;
    if (!classes.includes('engine.mover')) throw new Error(`${a.name}: a non-static brush that is not a Mover (GError in the original)`);
    const brush = readModel(asset.pkg, asset.bytes, a.values.Brush);
    movers.push({ name: a.name, classes, values, polys: readPolys(asset.pkg, asset.bytes, brush.polygons) });
  }
  return movers;
}

/** An FScale's words as the tracker reads them (SheerAxis defaults to SHEER_ZX). */
export const scaleWords = s => ({ scaleBits: (s?.scale ?? [1, 1, 1]).map(bits), sheerRateBits: bits(s?.shearRate ?? 0),
  sheerAxis: s?.shearAxis ?? 5 });

/** Each collected mover polygon's texture PolyFlags (`textureFlags`,
 * UTexture +0x80 as bsp-occlusion.mjs texturePolyFlags reads it; 0 without
 * a texture). `cache` maps texture references to flags. */
export async function trackerTextureFlags(assets, asset, movers, readFlags, cache = new Map()) {
  for (const mover of movers) for (const polygon of mover.polys) {
    if (!polygon.texture) { polygon.textureFlags = 0; continue; }
    if (!cache.has(polygon.texture)) cache.set(polygon.texture, readFlags(await assets.resolve(asset, polygon.texture)));
    polygon.textureFlags = cache.get(polygon.texture);
  }
}

/** Mover `i`'s spec (tag 0x40000000 + i) from a collected mover and its
 * current bHidden, Location, Rotation and PrePivot; MainScale, PostScale
 * and bSpecialLit come from its merged defaults. */
export function trackerMoverSpec(mover, i, { hidden, location, rotation, prePivot }) {
  const v = mover.values;
  return { tag: 0x40000000 + i, flags: hidden ? 2 : 0, specialLit: Boolean(v.bSpecialLit),
    locationBits: [...location].map(bits), rotation: [...rotation].map(r => r | 0), prePivotBits: [...prePivot].map(bits),
    mainScale: scaleWords(v.MainScale), postScale: scaleWords(v.PostScale),
    polys: mover.polys.map(p => ({ baseBits: p.base.map(bits), normalBits: p.normal.map(bits), textureUBits: p.textureU.map(bits),
      textureVBits: p.textureV.map(bits), vertexBits: p.vertices.map(x => x.map(bits)), flags: p.flags >>> 0, textureKey: 0,
      textureFlags: p.textureFlags ?? 0, iBrushPoly: p.brushPolygon, pan: p.pan })) };
}

// tracker.rs header words.
export const TRACKER = Object.freeze({ NODES: 0, NODES_NUM: 1, NODES_MAX: 2, TOP: 3, VERTS: 4, VERTS_NUM: 5,
  VERTS_MAX: 6, VTOP: 7, POINTS: 8, POINTS_NUM: 9, POINTS_MAX: 10, PTOP: 11, FIRST_POINT: 12, POINTS_CAP: 13,
  VECTORS: 14, VECTORS_NUM: 15, VECTORS_MAX: 16, VECTORS_TOP: 17, VECTORS_CAP: 18, SURFS: 19, SURFS_NUM: 20,
  SURFS_MAX: 21, SURFS_TOP: 22, DSURFS: 23, SURFS_CAP: 24, MOVERS: 25, MOVER_COUNT: 26, NODEMAPS: 27,
  NODEMAPS_NUM: 28, NODEMAPS_MAX: 29, OWNERS: 30, OWNERS_NUM: 31, OWNERS_MAX: 32, HELPER: 33, HELPER_NUM: 34,
  HELPER_MAX: 35, NODE_CURSOR: 36, VERT_CURSOR: 37, FREE_HEAD: 38, CURRENT: 39, NORMAL: 40, LIST_STALE: 43,
  SCRATCH: 44, SCRATCH_BYTES: 45, NODES_CAP: 46, VERTS_CAP: 47, LIVE: 48, STATUS: 49, HELPER_CAP: 50,
  GENERATION: 51, WORDS: 56 });
/** Mover record words (MV per mover). */
export const MOVER = Object.freeze({ TAG: 0, FLAGS: 1, LOCATION: 2, ROTATION: 5, PREPIVOT: 8, MAINSCALE: 11,
  POSTSCALE: 16, SAVEDPOS: 21, SAVEDROT: 24, MOVERLINK: 27, POLYS: 28, POLY_COUNT: 29, SPECIALLIT: 30, WORDS: 40 });
/** Polygon record words (FPoly). */
export const POLY = Object.freeze({ BASE: 0, NORMAL: 3, TEXU: 6, TEXV: 9, VERT: 12, FLAGS: 60, NUMV: 61,
  ILINK: 62, IBRUSHPOLY: 63, TEXKEY: 64, PAN: 65, TEXFLAGS: 66, WORDS: 68 });
/** Dynamic surface record words. */
export const DSURF = Object.freeze({ TEXKEY: 0, FLAGS: 1, PBASE: 2, VNORMAL: 3, VTEXU: 4, VTEXV: 5, LIGHTMAP: 6,
  BRUSHPOLY: 7, PAN: 8, ACTOR: 9, WORDS: 16 });

/** The block sizes the tracker can reach for a model and its movers:
 * nodes min(2N + 512, 65536) (never below N), verts 2V + 512, a surface
 * and three vectors and a base point per polygon, and dynamic points
 * bounded by the dynamic vertex pool (every used point is one used vert). */
export function trackerCapacities(model, movers) {
  const polys = movers.reduce((n, m) => n + m.polys.length, 0);
  const nodes = model.nodes.length, verts = model.vertices.length;
  const nodeCap = Math.max(nodes, Math.min(2 * nodes + 512, 65536)), vertCap = 2 * verts + 512;
  return { polys, nodes: nodeCap, verts: vertCap, surfs: model.surfaces.length + polys,
    vectors: model.vectors.length + 3 * polys, points: model.points.length + polys + (vertCap - verts),
    nodeMaps: nodeCap - nodes, owners: vertCap - verts, helper: vertCap - verts };
}

/** The tracker over an occlusion's blocks (`at`: nodes, verts, points,
 * surfs; their capacities in `caps`), with its own blocks from `block`. */
export function createTrackerHost(kernel, model, movers, { at, caps, block, words, scratchBytes = 8 << 20 }) {
  if (!kernel.trackerHeaderPtr) throw new Error('The script VM core predates the brush tracker; run npm run build:wasm');
  const vectors = block(12 * caps.vectors), dsurfs = block(4 * DSURF.WORDS * Math.max(1, caps.polys)),
    moverBlock = block(4 * MOVER.WORDS * Math.max(1, movers.length)),
    polyBlock = block(4 * POLY.WORDS * Math.max(1, caps.polys)), nodeMaps = block(8 * Math.max(1, caps.nodeMaps)),
    owners = block(4 * Math.max(1, caps.owners)), helper = block(4 * Math.max(1, caps.helper)),
    scratch = block(scratchBytes);
  const header = new Array(TRACKER.WORDS).fill(0);
  Object.assign(header, {
    [TRACKER.NODES]: at.nodes, [TRACKER.NODES_NUM]: model.nodes.length, [TRACKER.NODES_MAX]: model.nodes.length,
    [TRACKER.VERTS]: at.verts, [TRACKER.VERTS_NUM]: model.vertices.length, [TRACKER.VERTS_MAX]: model.vertices.length,
    [TRACKER.POINTS]: at.points, [TRACKER.POINTS_NUM]: model.points.length, [TRACKER.POINTS_MAX]: model.points.length,
    [TRACKER.POINTS_CAP]: caps.points, [TRACKER.VECTORS]: vectors, [TRACKER.VECTORS_NUM]: model.vectors.length,
    [TRACKER.VECTORS_MAX]: model.vectors.length, [TRACKER.VECTORS_CAP]: caps.vectors, [TRACKER.SURFS]: at.surfs,
    [TRACKER.SURFS_NUM]: model.surfaces.length, [TRACKER.SURFS_MAX]: model.surfaces.length, [TRACKER.DSURFS]: dsurfs,
    [TRACKER.SURFS_CAP]: caps.surfs, [TRACKER.MOVERS]: moverBlock, [TRACKER.MOVER_COUNT]: movers.length,
    [TRACKER.NODEMAPS]: nodeMaps, [TRACKER.OWNERS]: owners, [TRACKER.HELPER]: helper,
    [TRACKER.SCRATCH]: scratch, [TRACKER.SCRATCH_BYTES]: scratchBytes, [TRACKER.NODES_CAP]: caps.nodes,
    [TRACKER.VERTS_CAP]: caps.verts, [TRACKER.HELPER_CAP]: caps.helper });
  const headerAt = () => kernel.trackerHeaderPtr() >>> 2;
  {
    const u = words();
    u.set(header.map(v => v >>> 0), headerAt());
    model.vectors.forEach((v, i) => { for (let k = 0; k < 3; k++) u[(vectors >>> 2) + 3 * i + k] = bits(v[k]); });
    let polyAt = polyBlock >>> 2;
    movers.forEach((m, i) => {
      const o = (moverBlock >>> 2) + MOVER.WORDS * i;
      u.fill(0, o, o + MOVER.WORDS);
      const scale = s => [...s.scaleBits, s.sheerRateBits, s.sheerAxis];
      u.set([m.tag, m.flags, ...m.locationBits, ...m.rotation, ...m.prePivotBits, ...scale(m.mainScale),
        ...scale(m.postScale)].map(v => v >>> 0), o);
      // AMover::PostLoad (0x103af80f): SavedPos (-12345, ...), SavedRot (123, 456, 789).
      u.set([bits(-12345), bits(-12345), bits(-12345), 123, 456, 789, 0xffffffff, polyAt << 2, m.polys.length,
        m.specialLit ? 1 : 0], o + MOVER.SAVEDPOS);
      for (const p of m.polys) {
        u.fill(0, polyAt, polyAt + POLY.WORDS);
        u.set([...p.baseBits, ...p.normalBits, ...p.textureUBits, ...p.textureVBits].map(v => v >>> 0), polyAt);
        p.vertexBits.forEach((v, k) => u.set(v.map(x => x >>> 0), polyAt + POLY.VERT + 3 * k));
        u[polyAt + POLY.FLAGS] = p.flags >>> 0; u[polyAt + POLY.NUMV] = p.vertexBits.length;
        u[polyAt + POLY.IBRUSHPOLY] = p.iBrushPoly >>> 0; u[polyAt + POLY.TEXKEY] = (p.textureKey ?? 0) >>> 0;
        u[polyAt + POLY.PAN] = ((p.pan[0] & 0xffff) | (p.pan[1] << 16)) >>> 0;
        u[polyAt + POLY.TEXFLAGS] = (p.textureFlags ?? 0) >>> 0;
        polyAt += POLY.WORDS;
      }
    });
  }
  const h = i => words()[headerAt() + i];
  const mover = i => (moverBlock >>> 2) + MOVER.WORDS * i;
  return {
    blocks: { vectors, dsurfs, moverBlock, polyBlock, nodeMaps, owners, helper },
    header: h,
    /** GNewBrushTracker: AddBrush every mover, then Update(NULL) at the
     * game thread's precision (`pc64`, the assumption: docs/brush-tracker.md). */
    construct({ pc64 = true } = {}) { return kernel.trackerConstruct(pc64 ? 1 : 0); },
    /** Update(mover `i`, or NULL for -1); SetupDynamics' calls are PC24. */
    update(i, { pc64 = false } = {}) { return kernel.trackerUpdate(i, pc64 ? 1 : 0); },
    flush: i => kernel.trackerFlush(i),
    surfIsDynamic: s => kernel.trackerSurfIsDynamic(s),
    destroy: () => kernel.trackerDestroy(),
    /** A mover's Location (float bits), Rotation and bHidden. */
    setMover(i, { locationBits, rotation, hidden }) {
      const u = words(), o = mover(i);
      if (locationBits) u.set(locationBits.map(v => v >>> 0), o + MOVER.LOCATION);
      if (rotation) u.set(rotation.map(v => v >>> 0), o + MOVER.ROTATION);
      if (hidden !== undefined) u[o + MOVER.FLAGS] = hidden ? u[o + MOVER.FLAGS] | 2 : u[o + MOVER.FLAGS] & ~2;
    },
    /** A mover's record words (validation and Play's mover drawing). */
    moverWords: i => words().slice(mover(i), mover(i) + MOVER.WORDS),
    /** Mover `i`'s fragment nodes (MoverLink, then each iRenderBound). */
    chain(i) {
      const out = [], u = words(), count = h(TRACKER.NODES_NUM);
      let link = u[mover(i) + MOVER.MOVERLINK] | 0;
      while (link !== -1 && link >= 0 && link < count && out.length < count) {
        out.push(link);
        link = u[(h(TRACKER.NODES) >>> 2) + 16 * link + 12] | 0;
      }
      return out;
    },
    /** A tracker surface's mover index (its tag - 0x40000000 when the host
     * tagged movers so) and polygon ordinal, or null for a level surface. */
    surfOwner(iSurf) {
      const top = h(TRACKER.SURFS_TOP);
      if (!h(TRACKER.LIVE) || iSurf < top || iSurf >= h(TRACKER.SURFS_NUM)) return null;
      const u = words(), o = (dsurfs >>> 2) + DSURF.WORDS * (iSurf - top);
      return { tag: u[o + DSURF.ACTOR], ordinal: u[o + DSURF.BRUSHPOLY] };
    },
    live: () => h(TRACKER.LIVE) !== 0,
  };
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function bits(value) { f32[0] = value; return u32[0]; }

/** The level model as the tracker has filtered it (readModel's shape): every
 * node, vert, point and vector the arrays hold now, the static surfaces
 * with their PolyFlags, and each tracker surface (`dynamic`, `mover` its
 * mover index) with its base point and vectors where the last Update
 * left them. `occlusion` is the createBspOcclusion with the tracker over
 * `model`; `memory` the kernel's. `originalNodes` is the node count before
 * the tracker (UModel::PostLoad's Surf.Nodes reach only those). The decal
 * kernel's model and trace model over the moved movers (docs/decals.md). */
export function trackedModel(occlusion, model, memory) {
  const t = occlusion.tracker, { nodes, verts, points } = occlusion.blocks, { vectors, dsurfs } = t.blocks;
  const u = new Uint32Array(memory.buffer), i32 = new Int32Array(memory.buffer), b = new Uint8Array(memory.buffer);
  const f = new Float32Array(memory.buffer), count = k => t.header(k), top = t.header(TRACKER.SURFS_TOP);
  const range = n => Array.from({ length: n }, (_, i) => i);
  const out = { ...model, originalNodes: count(TRACKER.TOP),
    nodes: range(count(TRACKER.NODES_NUM)).map(i => {
      const o = (nodes >>> 2) + 16 * i, at = nodes + 64 * i;
      return { plane: [f[o], f[o + 1], f[o + 2], f[o + 3]], zoneMask: [u[o + 4], u[o + 5]], vertexPool: i32[o + 6],
        surface: i32[o + 7], back: i32[o + 8], front: i32[o + 9], coplanar: i32[o + 10], collisionBound: i32[o + 11],
        renderBound: i32[o + 12], zones: [b[at + 52], b[at + 53]], vertexCount: b[at + 54], flags: b[at + 55],
        leaves: [i32[o + 14], i32[o + 15]] };
    }),
    vertices: range(count(TRACKER.VERTS_NUM)).map(i => ({ point: i32[(verts >>> 2) + 2 * i], side: i32[(verts >>> 2) + 2 * i + 1] })),
    points: range(count(TRACKER.POINTS_NUM)).map(i => [f[(points >>> 2) + 3 * i], f[(points >>> 2) + 3 * i + 1], f[(points >>> 2) + 3 * i + 2]]),
    vectors: range(count(TRACKER.VECTORS_NUM)).map(i => [f[(vectors >>> 2) + 3 * i], f[(vectors >>> 2) + 3 * i + 1], f[(vectors >>> 2) + 3 * i + 2]]),
  };
  out.surfaces = range(count(TRACKER.SURFS_NUM)).map(i => {
    if (i < top) return model.surfaces[i];
    const o = (dsurfs >>> 2) + DSURF.WORDS * (i - top);
    return { texture: null, flags: u[o + DSURF.FLAGS], base: u[o + DSURF.PBASE], normal: u[o + DSURF.VNORMAL],
      textureU: u[o + DSURF.VTEXU], textureV: u[o + DSURF.VTEXV], lightMap: i32[o + DSURF.LIGHTMAP],
      brushPolygon: i32[o + DSURF.BRUSHPOLY], dynamic: true, mover: u[o + DSURF.ACTOR] - 0x40000000 };
  });
  return out;
}

/** `level.decalSource` for script-decal.mjs levelDecals: the tracked model
 * (`trackedModel`), the tracker's generation, its first surface and point
 * capacity, and each mover's surfaces with its actor's live Rotation
 * (`actors[i]` is mover i's actor, `read(actor, name)` the runtime's read). */
export function trackerDecalSource(occlusion, model, memory, actors, read) {
  const t = occlusion.tracker, top = t.header(TRACKER.SURFS_TOP), surfaces = actors.map(() => []);
  for (let s = top; s < t.header(TRACKER.SURFS_NUM); s++) surfaces[t.surfOwner(s).tag - 0x40000000]?.push(s);
  const movers = actors.map((actor, i) => ({ actor, surfaces: surfaces[i], rotation: () => read(actor, 'Rotation') }));
  return { firstSurface: top, pointCapacity: t.header(TRACKER.POINTS_CAP), generation: () => t.header(TRACKER.GENERATION),
    model: () => trackedModel(occlusion, model, memory), movers: () => movers };
}
