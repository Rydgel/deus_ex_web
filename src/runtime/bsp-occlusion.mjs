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
import { sceneFrameTangent } from './script-window-scene-frame.mjs';
import { createTrackerHost, trackerCapacities, TRACKER } from './brush-tracker.mjs';

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
  OCCLUSION_POINTS = 0x100, OCCLUSION_SPRITE_KEYS = 0x200;

/** FDynamicSprite::Setup's candidate words (setup.rs), one per actor or
 * render-iterator item SetupDynamics constructs a sprite for: the key the
 * frame's Frame->Sprite reports, Actor.DrawType, the mesh record
 * (`meshRecord`; SETUP_MESH_NONE when Mesh is None, SETUP_MESH_UNKNOWN when
 * it has no record), Texture (SETUP_TEXTURE_*) with its USize and VSize,
 * Location, Rotation (int32), DrawScale, PrePivot, bParticles, whether
 * GetAnimSeq(AnimSequence) found a sequence, its StartFrame and NumFrames,
 * and AnimFrame. Floats are written through the f32 view. */
export const SETUP = Object.freeze({ KEY: 0, DRAWTYPE: 1, MESH: 2, TEXTURE: 3, USIZE: 4, VSIZE: 5, LOCATION: 6,
  ROTATION: 9, DRAWSCALE: 12, PREPIVOT: 13, PARTICLES: 16, SEQ: 17, SEQ_START: 18, SEQ_FRAMES: 19, ANIMFRAME: 20,
  WORDS: 21 });
export const SETUP_MESH_NONE = 0, SETUP_MESH_UNKNOWN = 1;
export const SETUP_TEXTURE_NONE = 0, SETUP_TEXTURE_SIZED = 1, SETUP_TEXTURE_UNKNOWN = 2;
/** Setup's result words: status (SETUP_STATUS), X1, Y1, X2, Y2, Z bits and
 * the sprite path's ScreenX, ScreenY and Persp bits. */
export const SETUP_OUT_WORDS = 9;
export const SETUP_STATUS = Object.freeze({ REJECTED: 0, ACCEPTED: 1, UNKNOWN: 3, UNSUPPORTED: 4 });

/** UMesh::GetAnimSeq (Engine 0x1031c000): the first sequence whose FName is
 * `name`. FNames compare by index, and names intern case-insensitively
 * (ASCII folding, script-names.md), so the spellings compare folded. */
export function setupSequence(sequences, name) {
  if (typeof name !== 'string') return null;
  const key = name.toUpperCase();
  for (const sequence of sequences) if (sequence.name.toUpperCase() === key) return sequence;
  return null;
}

/** Pack one Setup candidate at word `at` of `views` (setupCandidates):
 * `key`, `drawType`, `mesh` (a mesh record or SETUP_MESH_*), `texture`
 * (null, {uSize, vSize} or 'unknown'), `location`, `rotation`, `drawScale`,
 * `prePivot`, `particles`, `sequence` (setupSequence's result) and
 * `animFrame`. */
export function packSetupCandidate({ u32, f32, i32 }, at, c) {
  u32[at + SETUP.KEY] = c.key >>> 0;
  u32[at + SETUP.DRAWTYPE] = c.drawType & 255;
  u32[at + SETUP.MESH] = c.mesh >>> 0;
  if (!c.texture) u32[at + SETUP.TEXTURE] = SETUP_TEXTURE_NONE;
  else if (c.texture === 'unknown') u32[at + SETUP.TEXTURE] = SETUP_TEXTURE_UNKNOWN;
  else { u32[at + SETUP.TEXTURE] = SETUP_TEXTURE_SIZED; i32[at + SETUP.USIZE] = c.texture.uSize; i32[at + SETUP.VSIZE] = c.texture.vSize; }
  for (let k = 0; k < 3; k++) {
    f32[at + SETUP.LOCATION + k] = c.location[k];
    i32[at + SETUP.ROTATION + k] = c.rotation?.[k] ?? 0;
    f32[at + SETUP.PREPIVOT + k] = c.prePivot?.[k] ?? 0;
  }
  f32[at + SETUP.DRAWSCALE] = c.drawScale;
  u32[at + SETUP.PARTICLES] = c.particles ? 1 : 0;
  u32[at + SETUP.SEQ] = c.sequence ? 1 : 0;
  i32[at + SETUP.SEQ_START] = c.sequence?.startFrame ?? 0;
  i32[at + SETUP.SEQ_FRAMES] = c.sequence?.numFrames ?? 0;
  f32[at + SETUP.ANIMFRAME] = c.animFrame ?? 0;
}

/** A mesh payload's GetRenderBoundingBox fields for meshRecord. */
export const meshRecordFields = payload => ({ box: payload.boundingBox, boxes: payload.arrays.get(0xa8).data,
  scale: payload.scale, origin: payload.origin, rotation: payload.rotation });

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
    f.extraPolyFlags ?? 0, ...(f.uncoords ?? new Array(12).fill(0)), f.rprojZ ?? 0, 0, 0, 0];
  if (words.length !== 64) throw new Error(`Occlusion frame has ${words.length} words`);
  return words.map(v => v >>> 0);
}

function masterFrame(kernel, { location, rotation, width, height, fov, orthoZoom = 0 }) {
  const io = new DataView(new ArrayBuffer(8));
  io.setFloat64(0, sceneFrameTangent(fov), true);
  const input = [...location.map(bitsOf), ...rotation.map(v => v >>> 0), width >>> 0, height >>> 0, bitsOf(fov),
    io.getUint32(0, true), io.getUint32(4, true), bitsOf(orthoZoom)];
  new Uint32Array(kernel.memory.buffer).set(input, kernel.masterInPtr() >>> 2);
  kernel.masterFrame();
  const words = new Uint32Array(kernel.memory.buffer);
  return { fields: words.slice(kernel.masterOutPtr() >>> 2, (kernel.masterOutPtr() >>> 2) + 70),
    frame: words.slice(kernel.framePtr() >>> 2, (kernel.framePtr() >>> 2) + 64) };
}

/** Upload `model` (src/unreal/model.mjs readModel) with each surface's
 * texture PolyFlags (`surfaceTextureFlags[i]`, 0 without a texture) and
 * each zone's actor key (`zoneActors[i]`, 0 for none: the LevelInfo) and
 * sky (`zoneSkies[i]`, 0 for none). `kernel` is the script-VM kernel's
 * `occlusion` facade. */
export function createBspOcclusion(kernel, model, { surfaceTextureFlags, zoneActors = [], zoneSkies = [],
  workBytes = 32 << 20, tracker = null } = {}) {
  const { memory, alloc, free } = kernel;
  const nodeCount = model.nodes.length, pointCount = model.points.length;
  const blocks = [];
  const block = bytes => { const at = alloc(Math.max(16, bytes)); blocks.push(at); return at; };
  // With movers (`tracker.movers`, brush-tracker.mjs), every model block at
  // the size the moving brush tracker can grow it to.
  const caps = tracker ? trackerCapacities(model, tracker.movers) : { nodes: nodeCount, verts: model.vertices.length,
    points: pointCount, surfs: model.surfaces.length };
  const nodes = block(64 * caps.nodes), verts = block(8 * caps.verts),
    points = block(12 * caps.points + 16), surfs = block(8 * caps.surfs),
    bounds = block(28 * model.renderBounds.length + 16), zones = block(16 * 64),
    cache = block(8 * Math.max(1, caps.points)), work = block(workBytes),
    dynamics = block(12 * caps.nodes);
  let sprites = block(24 * 256), spriteCapacity = 256;
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
    u.fill(0, cache >>> 2, (cache >>> 2) + 2 * Math.max(1, caps.points));
  }
  const trackerHost = tracker ? createTrackerHost(kernel, model, tracker.movers,
    { at: { nodes, verts, points, surfs }, caps, block, words: () => new Uint32Array(memory.buffer) }) : null;
  const header = [nodes, nodeCount, verts, model.vertices.length, points, pointCount, surfs, model.surfaces.length,
    bounds, model.renderBounds.length, zones, model.zones.length, model.rootOutside, cache, 0, 0xfffffffe,
    dynamics, sprites, 0, 0];
  let stamp = 0;
  const setHeader = () => {
    header[14] = stamp;
    // The tracker's counts (Nodes, Verts, Points, Surfs grow with it).
    if (trackerHost) {
      header[1] = trackerHost.header(TRACKER.NODES_NUM); header[3] = trackerHost.header(TRACKER.VERTS_NUM);
      header[5] = trackerHost.header(TRACKER.POINTS_NUM); header[7] = trackerHost.header(TRACKER.SURFS_NUM);
    }
    words().set(header, kernel.modelPtr() >>> 2);
  };
  const release = at => { free(at); blocks.splice(blocks.indexOf(at), 1); };
  const ensureSprites = count => {
    if (count <= spriteCapacity) return;
    release(sprites);
    spriteCapacity = Math.max(count, 2 * spriteCapacity); sprites = block(24 * spriteCapacity); header[17] = sprites;
  };
  // Setup's mesh records by mesh key, and its candidate and result blocks.
  const meshRecords = new Map();
  let candidates = 0, results = 0, candidateCapacity = 0, views = null;
  const ensureCandidates = count => {
    if (count <= candidateCapacity) return;
    if (candidates) { release(candidates); release(results); }
    candidateCapacity = Math.max(256, count, 2 * candidateCapacity);
    candidates = block(4 * SETUP.WORDS * candidateCapacity); results = block(4 * SETUP_OUT_WORDS * candidateCapacity);
    views = null;
  };
  const setupViews = () => {
    if (!views || views.u32.buffer !== memory.buffer)
      views = { u32: new Uint32Array(memory.buffer), f32: new Float32Array(memory.buffer), i32: new Int32Array(memory.buffer) };
    return views;
  };
  const setup = count => {
    if (!kernel.setup) throw new Error('The script VM core predates FDynamicSprite::Setup; run npm run build:wasm');
    ensureSprites(count);
    setHeader();
    return kernel.setup(candidates, count, results);
  };
  return {
    /** The master FSceneNode (CreateMasterFrame) for a camera: `location`
     * (three floats), `rotation` ([pitch, yaw, roll] int32), integer
     * `width` and `height`, Actor.FOVAngle `fov` and Actor.OrthoZoom, with
     * the zone from this model. Returns `frame`, the words for `run` (its
     * frame counter, TimeSeconds and option words still to set), and
     * `fields`: Coords, FX..PrjYP, ViewSides, ViewPlanes and ZoneNumber. */
    master(camera) {
      setHeader();
      return masterFrame(kernel, camera);
    },
    /** A mesh's record for Setup (UMesh::GetRenderBoundingBox's fields),
     * made once per `key`: `box` {min, max, valid} (BoundingBox), `boxes`
     * the BoundingBoxes array's bytes (28 per FBox), `scale`, `origin`
     * (floats) and `rotation` (RotOrigin, int32). Returns its address for
     * the candidates' SETUP.MESH word. */
    meshRecord(key, { box, boxes, scale, origin, rotation }) {
      let at = meshRecords.get(key);
      if (at !== undefined) return at;
      const data = block(boxes.byteLength);
      at = block(4 * 18);
      new Uint8Array(memory.buffer).set(boxes, data);
      words().set([...box.min.map(bitsOf), ...box.max.map(bitsOf), box.valid ? 1 : 0, ...scale.map(bitsOf),
        ...origin.map(bitsOf), ...rotation.map(v => v >>> 0), data, boxes.byteLength / 28], at >>> 2);
      meshRecords.set(key, at);
      return at;
    },
    /** Room for `count` Setup candidates: the memory's u32, f32 and i32
     * views and `at`, the first candidate's word index (SETUP.WORDS words
     * each). Valid until the next allocation. */
    setupCandidates(count) {
      ensureCandidates(count);
      return { ...setupViews(), at: candidates >>> 2 };
    },
    /** Setup alone on `count` packed candidates with `frameWords`; returns
     * the results (SETUP_OUT_WORDS words each). Validation access. */
    setupOnly(frameWords, count) {
      words().set(frameWords, kernel.framePtr() >>> 2);
      setup(count);
      return words().slice(results >>> 2, (results >>> 2) + SETUP_OUT_WORDS * count);
    },
    /** Whether the loaded core has FDynamicSprite::Setup (occ_setup). */
    setupSupported: Boolean(kernel.setup),
    /** The last run's Setup results (SETUP_OUT_WORDS words per candidate). */
    setupResults: count => words().slice(results >>> 2, (results >>> 2) + SETUP_OUT_WORDS * count),
    /** One OccludeBsp call on `frameWords` (occlusionFrameWords) with the
     * frame's sprites (FDynamicSprite after Setup), in SetupDynamics order:
     * `{key, x1, y1, x2, y2, zBits}` with Y1 >= 0, Y2 <= the frame's height
     * and Y1 < Y2 (Setup's checks); or, with `setupCount`, Setup on that
     * many packed candidates (setupCandidates) gives them. */
    run(frameWords, frameSprites = [], { setupCount = -1, skipPoints = false } = {}) {
      const viaSetup = setupCount >= 0;
      ensureSprites(viaSetup ? setupCount : frameSprites.length);
      if (!viaSetup) {
        const u = words();
        frameSprites.forEach((sprite, i) => u.set([sprite.key, sprite.x1, sprite.y1, sprite.x2, sprite.y2, sprite.zBits]
          .map(v => v >>> 0), (sprites >>> 2) + 6 * i));
        header[18] = frameSprites.length;
      }
      setHeader();
      words().set(frameWords, kernel.framePtr() >>> 2);
      if (viaSetup) setup(setupCount);
      const status = kernel.run(work, workBytes);
      stamp = words()[(kernel.modelPtr() >>> 2) + 14];
      const st = words().slice(kernel.statusPtr() >>> 2, (kernel.statusPtr() >>> 2) + 8);
      if (status !== 0) throw new Error(`OccludeBsp failed with status ${status}`);
      // `stream` is the output's address and length in the kernel memory, for
      // the decal block (decal-draw.mjs), valid until the next run;
      // `skipPoints` leaves the saved points to it.
      return { ...decode(words().slice(st[5] >>> 2, (st[5] >>> 2) + st[1]), st, skipPoints),
        stream: { at: st[5], words: st[1] } };
    },
    /** Each zone's SkyZone presence (`skies[i]` truthy: the zone's actor,
     * or the LevelInfo for a zone without one, has a SkyZone; OccludeBsp
     * reads it at 0x10b183a8 for a fake-backdrop polygon). */
    setZoneSkies(skies) {
      const u = words();
      for (let i = 0; i < model.zones.length; i++) u[(zones >>> 2) + 4 * i + 2] = skies[i] ? 1 : 0;
    },
    /** The live NodeFlags byte of node `i` (NF_PolyOccluded 8, NF_BoxOccluded 0x10). */
    nodeFlags: i => bytes()[nodes + 64 * i + 55],
    /** Node `i`'s iSurf (a child request names its node, not its surface). */
    nodeSurf: i => words()[(nodes >>> 2) + 16 * i + 7] | 0,
    /** The moving brush tracker (brush-tracker.mjs) over this model, or
     * null without movers; `blocks` are the model's own. */
    tracker: trackerHost,
    blocks: { nodes, verts, points, surfs },
    /** Model.Zones[i].LastRenderTime bits. */
    zoneTime: i => words()[(zones >>> 2) + 4 * i + 1],
    // The tracker goes first (the original deletes GBrushTracker before the
    // level it filtered into: travel and LoadMap, docs/brush-tracker.md).
    dispose() { if (trackerHost?.live()) trackerHost.destroy(); for (const at of blocks.splice(0)) free(at); },
  };
}

function decode(words, status, skipPoints = false) {
  const draw = [[], [], []], children = [], sprites = [];
  let i = 0;
  while (i < words.length) {
    if (words[i] === 0xfffffffe) {
      const [key, startY, endY, valid] = words.slice(i + 1, i + 5);
      i += 5;
      const lines = [];
      for (let y = startY | 0; y < (endY | 0); y++) {
        const count = words[i++], line = [];
        for (let k = 0; k < count; k++, i += 2) line.push([words[i] | 0, words[i + 1] | 0]);
        lines.push(line);
      }
      sprites.push({ key, span: { startY: startY | 0, endY: endY | 0, validLines: valid | 0, lines } });
      continue;
    }
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
      if (skipPoints) { i += 7 * count; polys.push({ iNode: node }); continue; }
      const points = [];
      for (let k = 0; k < count; k++, i += 7) points.push(words.slice(i, i + 7));
      polys.push(count ? { iNode: node, points } : { iNode: node });
    }
    draw[list].push({ iNode: iNode | 0, iSurf: iSurf | 0, iZone, polyFlags: polyFlags >>> 0, zoneKey, polys });
  }
  return { draw, children, sprites, nodesDraw: status[2], polysDraw: status[3] };
}
