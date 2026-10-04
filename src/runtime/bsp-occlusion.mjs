/** URender::OccludeBsp, the original BSP span occlusion, in the Rust core
 * (native/script-vm/src/occlude.rs; docs/bsp-occlusion.md). This module
 * uploads a decoded map's compiled model into the script-VM kernel's memory
 * once, keeps its live state there (NodeFlags, the point cache and its
 * stamp, the zones' LastRenderTime), and runs one frame at a time from the
 * FSceneNode fields ComputeRenderSize produced.
 *
 * A run returns the frame's three draw lists as OccludeBsp builds them
 * (Frame->Draw[0..2], newest first: mirrors, occluding and non-occluding
 * surfaces), each entry with the nodes whose clipped polygons were saved for
 * it (newest first), and the child-frame requests (mirror and sky) with the
 * span they were given. */

/** Engine.Texture's bools packed into the dword UTexture::PolyFlags (+0x80
 * in the retail layout, docs/object-memory.md "Texture"), bit i for the i-th
 * declared bool: Engine.u exports them in reverse declaration order from
 * bInvisible (5040) to bX7 (4972), 32 bools that fill the dword; the
 * bHighColorQuality group starts the next one. OccludeBsp ORs this word into
 * each surface's PolyFlags (0x10b181a3). */
export const TEXTURE_POLYFLAG_BOOLS = Object.freeze(['bInvisible', 'bMasked', 'bTransparent', 'bNotSolid',
  'bEnvironment', 'bSemisolid', 'bModulate', 'bFakeBackdrop', 'bTwoSided', 'bAutoUPan', 'bAutoVPan', 'bNoSmooth',
  'bBigWavy', 'bSmallWavy', 'bWaterWavy', 'bLowShadowDetail', 'bNoMerge', 'bCloudWavy', 'bDirtyShadows',
  'bHighLedge', 'bSpecialLit', 'bGouraud', 'bUnlit', 'bHighShadowDetail', 'bPortal', 'bMirrored', 'bX2', 'bX3',
  'bX4', 'bX5', 'bX6', 'bX7']);

/** A texture's PolyFlags from its property values. */
export function texturePolyFlags(values) {
  let flags = 0;
  TEXTURE_POLYFLAG_BOOLS.forEach((name, i) => { if (values?.[name]) flags |= 1 << i; });
  return flags >>> 0;
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bitsOf = value => (f32[0] = value, u32[0]);

// occ_run option bits (occlude.rs FRAME word 46).
export const OCCLUSION_SHOW_PLAYER_CTRL = 1, OCCLUSION_SHINY_SURFACES = 2, OCCLUSION_TOGGLE = 4,
  OCCLUSION_POINTS = 0x100;

/** Frame words for occ_run from FSceneNode field bit patterns: `coords` (12
 * f32 bits: Origin, X, Y, Z axes), `width`/`height` (ints), `fx15`, `fy15`,
 * `fx2`, `fy2`, `fx`, `fy`, `projZ`, `prj` ([PrjXM, PrjYM, PrjXP, PrjYP]),
 * `viewSides` (12), `nearClip` (4), `mirror`, plus the zone number,
 * recursion depth, the renderer's frame counter (0x10b5a700), the level's
 * TimeSeconds, option bits and the viewport's ExtraPolyFlags. */
export function occlusionFrameWords(f) {
  const words = [...f.coords, f.width, f.height, f.fx15, f.fy15, f.fx2, f.fy2, f.fx, f.fy, f.projZ, ...f.prj,
    ...f.viewSides, ...(f.nearClip ?? [0, 0, 0, 0]), f.mirror ?? 0x3f800000, f.zoneNumber, f.recursion ?? 0,
    f.frameCounter >>> 0, f.timeBits >>> 0, f.options ?? (OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES),
    f.extraPolyFlags ?? 0];
  if (words.length !== 48) throw new Error(`Occlusion frame has ${words.length} words`);
  return words.map(v => v >>> 0);
}

/** Upload `model` (src/unreal/model.mjs readModel) with each surface's
 * texture PolyFlags (`surfaceTextureFlags[i]`, 0 without a texture) and
 * each zone's actor key (`zoneActors[i]`, 0 for none: the LevelInfo) and
 * sky (`zoneSkies[i]`, 0 for none). `kernel` is the script-VM kernel's
 * `occlusion` facade. */
export function createBspOcclusion(kernel, model, { surfaceTextureFlags, zoneActors = [], zoneSkies = [],
  workBytes = 32 << 20 } = {}) {
  const { memory, alloc, free } = kernel;
  const nodeCount = model.nodes.length, pointCount = model.points.length;
  const blocks = [];
  const block = bytes => { const at = alloc(Math.max(16, bytes)); blocks.push(at); return at; };
  const nodes = block(64 * nodeCount), verts = block(8 * model.vertices.length),
    points = block(12 * pointCount + 16), surfs = block(8 * model.surfaces.length),
    bounds = block(28 * model.renderBounds.length + 16), zones = block(16 * 64),
    cache = block(8 * Math.max(1, pointCount)), work = block(workBytes);
  const words = () => new Uint32Array(memory.buffer), bytes = () => new Uint8Array(memory.buffer);
  {
    const u = words(), b = bytes();
    model.nodes.forEach((n, i) => {
      const o = (nodes >>> 2) + 16 * i;
      for (let k = 0; k < 4; k++) u[o + k] = bitsOf(n.plane[k]);
      u[o + 4] = n.zoneMask[0]; u[o + 5] = n.zoneMask[1];
      u.set([n.vertexPool, n.surface, n.back, n.front, n.coplanar, n.collisionBound, n.renderBound].map(v => v >>> 0), o + 6);
      b.set([n.zones[0], n.zones[1], n.vertexCount, n.flags], nodes + 64 * i + 52);
      u[o + 14] = n.leaves[0] >>> 0; u[o + 15] = n.leaves[1] >>> 0;
    });
    model.vertices.forEach((v, i) => { u[(verts >>> 2) + 2 * i] = v.point; u[(verts >>> 2) + 2 * i + 1] = v.side >>> 0; });
    model.points.forEach((p, i) => { for (let k = 0; k < 3; k++) u[(points >>> 2) + 3 * i + k] = bitsOf(p[k]); });
    model.surfaces.forEach((s, i) => {
      u[(surfs >>> 2) + 2 * i] = s.flags >>> 0;
      u[(surfs >>> 2) + 2 * i + 1] = (surfaceTextureFlags?.[i] ?? 0) >>> 0;
    });
    model.renderBounds.forEach((box, i) => {
      const o = (bounds >>> 2) + 7 * i;
      for (let k = 0; k < 3; k++) { u[o + k] = bitsOf(box.min[k]); u[o + 3 + k] = bitsOf(box.max[k]); }
      u[o + 6] = box.valid ? 1 : 0;
    });
    u.fill(0, zones >>> 2, (zones >>> 2) + 256);
    for (let i = 0; i < model.zones.length; i++) {
      u[(zones >>> 2) + 4 * i] = (zoneActors[i] ?? 0) >>> 0;
      u[(zones >>> 2) + 4 * i + 2] = (zoneSkies[i] ?? 0) >>> 0;
    }
    u.fill(0, cache >>> 2, (cache >>> 2) + 2 * Math.max(1, pointCount));
  }
  const header = [nodes, nodeCount, verts, model.vertices.length, points, pointCount, surfs, model.surfaces.length,
    bounds, model.renderBounds.length, zones, model.zones.length, model.rootOutside, cache, 0, 0xfffffffe];
  let stamp = 0;
  return {
    /** One OccludeBsp call on `frameWords` (occlusionFrameWords). */
    run(frameWords) {
      header[14] = stamp;
      words().set(header, kernel.modelPtr() >>> 2);
      words().set(frameWords, kernel.framePtr() >>> 2);
      const status = kernel.run(work, workBytes);
      stamp = words()[(kernel.modelPtr() >>> 2) + 14];
      const st = words().slice(kernel.statusPtr() >>> 2, (kernel.statusPtr() >>> 2) + 8);
      if (status !== 0) throw new Error(`OccludeBsp failed with status ${status}`);
      return decode(words().slice(st[5] >>> 2, (st[5] >>> 2) + st[1]), st);
    },
    /** The live NodeFlags byte of node `i` (NF_PolyOccluded 8, NF_BoxOccluded 0x10). */
    nodeFlags: i => bytes()[nodes + 64 * i + 55],
    /** Model.Zones[i].LastRenderTime bits. */
    zoneTime: i => words()[(zones >>> 2) + 4 * i + 1],
    dispose() { for (const at of blocks.splice(0)) free(at); },
  };
}

function decode(words, status) {
  const draw = [[], [], []], children = [];
  let i = 0;
  while (i < words.length) {
    if (words[i] === 0xffffffff) {
      const [kind, iNode, iSurf, zone, startY, endY, valid] = words.slice(i + 1, i + 8);
      i += 8;
      const lines = [];
      for (let y = startY | 0; y < (endY | 0); y++) {
        const count = words[i++], line = [];
        for (let k = 0; k < count; k++, i += 2) line.push([words[i] | 0, words[i + 1] | 0]);
        lines.push(line);
      }
      children.push({ kind: kind ? 'sky' : 'mirror', iNode: iNode | 0, iSurf: iSurf | 0, zone,
        span: { startY: startY | 0, endY: endY | 0, validLines: valid | 0, lines } });
      continue;
    }
    const [list, iNode, iSurf, iZone, polyFlags, zoneKey, polyCount] = words.slice(i, i + 7);
    i += 7;
    const polys = [];
    for (let p = 0; p < polyCount; p++) {
      const node = words[i] | 0, count = words[i + 1];
      i += 2;
      const points = [];
      for (let k = 0; k < count; k++, i += 7) points.push(words.slice(i, i + 7));
      polys.push(count ? { iNode: node, points } : { iNode: node });
    }
    draw[list].push({ iNode: iNode | 0, iSurf: iSurf | 0, iZone, polyFlags: polyFlags >>> 0, zoneKey, polys });
  }
  return { draw, children, nodesDraw: status[2], polysDraw: status[3] };
}
