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
 * span they were given. With `children`, OccludeFrame's recursion runs too:
 * CreateChildFrame made each child during its parent's OccludeBsp, and each
 * child (newest first, depth first) gets its own SetupDynamics and
 * OccludeBsp (`frames`); `children.frameDynamics` is called before each
 * child's Setup, for the host's own SetupDynamics of that frame (its own
 * candidates, `useFrameCandidates`). */
import { sceneFrameTangent } from './script-window-scene-frame.mjs';
import { x87TanCandidates } from './x87-tan.mjs';
import { createTrackerHost, trackerCapacities, TRACKER, DSURF } from './brush-tracker.mjs';

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
const ZERO3 = [0, 0, 0];
const bitsOf = value => (f32[0] = value, u32[0]);
const fromBits = bits => (u32[0] = bits >>> 0, f32[0]);

// Precision control 24 for double operands (tracker.rs P24): a result
// rounded once to a 24-bit significand.
function twoSum(a, b) {
  const s = a + b, bb = s - a;
  return [s, (a - (s - bb)) + (b - bb)];
}
function round24(s, e) {
  const r = Math.fround(s);
  if (e === 0 || !Number.isFinite(s) || r === s) return r;
  const b = bitsOf(r);
  const other = r > s ? (r > 0 ? fromBits(b - 1) : r < 0 ? fromBits(b + 1) : fromBits(0x80000001))
    : (r > 0 ? fromBits(b + 1) : r < 0 ? fromBits(b - 1) : fromBits(1));
  if (s !== (r + other) * 0.5) return r;
  return (e > 0) === (other > r) ? other : r;
}
/** A float32 `a` times a double `c`, rounded once to 24 bits. */
function mul24(a, c) {
  const hi = Math.fround(c), lo = c - hi;
  const [s, e] = twoSum(a * hi, a * lo);
  return round24(s, e);
}
function split(x) {
  const c = 134217729 * x, hi = c - (c - x);
  return [hi, x - hi];
}
/** A float32 `a` over a double `b`, rounded once to 24 bits. */
function div24(a, b) {
  const q = a / b, r = Math.fround(q);
  if (!Number.isFinite(q) || r === q) return r;
  const bits = bitsOf(r);
  const other = (r > q) === (r > 0) ? fromBits(bits - 1) : fromBits(bits + 1);
  const mid = (r + other) * 0.5;
  if (q !== mid) return r;
  const p = mid * b, [mh, ml] = split(mid), [bh, bl] = split(b);
  const e = ((mh * bh - p) + mh * bl + ml * bh) + ml * bl, residual = (a - p) - e;
  if (residual === 0) return (bits & 1) === 0 ? r : other;
  return (b > 0 ? residual > 0 : residual < 0) === (other > r) ? other : r;
}

/** A child frame's ComputeRenderSize argument for Actor.FOVAngle `fov`
 * (FOV * 0.008726646259971648 rounded to 24 bits inside DrawWorld, stored
 * as a double) and Core appTan's result for it: x87-tan.mjs's FPTAN model,
 * whose candidates must give one Proj.Z (`hx / tan` at 24 bits) for a
 * frame `width` pixels wide. */
export function childFrameTangent(fov, width) {
  const argument = mul24(Math.fround(fov), 0.008726646259971648);
  const tangents = x87TanCandidates(argument);
  if (!tangents?.length) throw new Error(`Child frames require the original appTan for FOV ${fov}`);
  const hx = Math.fround(Math.fround(width) * 0.5);
  if (new Set(tangents.map(t => div24(hx, t))).size !== 1)
    throw new Error(`Child frame FOV ${fov}: FPTAN's last bit decides Proj.Z, which is unmeasured`);
  return { argument, tangent: tangents[0] };
}

// occ_run option bits (occlude.rs FRAME word 46).
export const OCCLUSION_SHOW_PLAYER_CTRL = 1, OCCLUSION_SHINY_SURFACES = 2, OCCLUSION_TOGGLE = 4,
  OCCLUSION_POINTS = 0x100, OCCLUSION_SPRITE_KEYS = 0x200,
  /** The points of the polygons the detail-texture pass can use only (occlude.rs `detail_wanted`; the model's detail table). */
  OCCLUSION_DETAIL = 0x400;

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
  FLAGS: 21, WORDS: 22 });
/** SETUP.FLAGS bit: not constructed in a root frame (setup.rs C_FLAGS). */
export const SETUP_ROOT_EXCLUDED = 1;
export const SETUP_MESH_NONE = 0, SETUP_MESH_UNKNOWN = 1;
export const SETUP_TEXTURE_NONE = 0, SETUP_TEXTURE_SIZED = 1, SETUP_TEXTURE_UNKNOWN = 2;
/** Setup's result words: status (SETUP_STATUS), X1, Y1, X2, Y2, Z bits and
 * the sprite path's ScreenX, ScreenY and Persp bits. */
export const SETUP_OUT_WORDS = 9;
export const SETUP_STATUS = Object.freeze({ REJECTED: 0, ACCEPTED: 1, UNKNOWN: 3, UNSUPPORTED: 4, NOT_CONSTRUCTED: 5 });

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
  u32[at + SETUP.FLAGS] = c.rootExcluded ? SETUP_ROOT_EXCLUDED : 0;
}

/** A mesh payload's GetRenderBoundingBox fields for meshRecord. */
export const meshRecordFields = payload => ({ box: payload.boundingBox, boxes: payload.arrays.get(0xa8).data,
  scale: payload.scale, origin: payload.origin, rotation: payload.rotation });

/** Frame words for occ_run from FSceneNode field bit patterns: `coords` (12
 * f32 bits: Origin, X, Y, Z axes), `width`/`height` (ints), `fx15`, `fy15`,
 * `fx2`, `fy2`, `fx`, `fy`, `projZ`, `prj` ([PrjXM, PrjYM, PrjXP, PrjYP]),
 * `viewSides` (12), `nearClip` (4), `mirror`, plus the zone number,
 * recursion depth, the renderer's frame counter (0x10b5a700), the level's
 * TimeSeconds, option bits and the viewport's ExtraPolyFlags, and, when
 * `width`/`height` are a render rectangle, `spanWidth` and `spanHeight` (the
 * viewport's size, which the screen span keeps). */
export function occlusionFrameWords(f) {
  const words = [...f.coords, f.width, f.height, f.fx15, f.fy15, f.fx2, f.fy2, f.fx, f.fy, f.projZ, ...f.prj,
    ...f.viewSides, ...(f.nearClip ?? [0, 0, 0, 0]), f.mirror ?? 0x3f800000, f.zoneNumber, f.recursion ?? 0,
    f.frameCounter >>> 0, f.timeBits >>> 0, f.options ?? (OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES),
    f.extraPolyFlags ?? 0, ...(f.uncoords ?? new Array(12).fill(0)), f.rprojZ ?? 0, f.spanWidth ?? 0, f.spanHeight ?? 0, 0];
  if (words.length !== 64) throw new Error(`Occlusion frame has ${words.length} words`);
  return words.map(v => v >>> 0);
}

function masterFrame(kernel, { location, rotation, width, height, fov, orthoZoom = 0, render = null }) {
  const io = new DataView(new ArrayBuffer(8));
  io.setFloat64(0, sceneFrameTangent(fov), true);
  const input = [...location.map(bitsOf), ...rotation.map(v => v >>> 0), width >>> 0, height >>> 0, bitsOf(fov),
    io.getUint32(0, true), io.getUint32(4, true), bitsOf(orthoZoom), 0, 0, 0, 0, 0];
  // The render pass's ComputeRenderSize on the frame (XRootWindow::PreRender,
  // a ViewportWindow's Draw): the render rectangle's size at 24 bits, with
  // the tangent of the 24-bit argument (childFrameTangent).
  if (render) {
    io.setFloat64(0, childFrameTangent(fov, render.width).tangent, true);
    input.splice(12, 5, render.width >>> 0, render.height >>> 0, io.getUint32(0, true), io.getUint32(4, true), 1);
  }
  new Uint32Array(kernel.memory.buffer).set(input, kernel.masterInPtr() >>> 2);
  kernel.masterFrame();
  const words = new Uint32Array(kernel.memory.buffer);
  return { fields: words.slice(kernel.masterOutPtr() >>> 2, (kernel.masterOutPtr() >>> 2) + 70),
    frame: words.slice(kernel.framePtr() >>> 2, (kernel.framePtr() >>> 2) + 64) };
}

/** Upload `model` (src/unreal/model.mjs readModel) with each surface's
 * texture PolyFlags (`surfaceTextureFlags[i]`, 0 without a texture) and
 * each zone's actor key (`zoneActors[i]`, 0 for none: the LevelInfo); the
 * zones' skies come per frame (setZoneSkies). `kernel` is the script-VM
 * kernel's `occlusion` facade. `detailTable` (detail-pass.mjs `detailTable`,
 * 16 words a model surface) is what option OCCLUSION_DETAIL filters the
 * saved polygons with; the host's detail pass reads the same table. */
export function createBspOcclusion(kernel, model, { surfaceTextureFlags, zoneActors = [],
  workBytes = 32 << 20, tracker = null, detailTable = null } = {}) {
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
    bounds = block(28 * model.renderBounds.length + 16), zones = block(16 * 64), skyRecords = block(4 * 7 * 64),
    cache = block(8 * Math.max(1, caps.points)), work = block(workBytes),
    dynamics = block(12 * caps.nodes), detail = detailTable?.length ? block(4 * detailTable.length) : 0;
  let sprites = block(36 * 256), spriteCapacity = 256;
  // One view of each kind over the kernel's memory, made again when the memory grew (a new view is an object, and these are read
  // for every tracker header word and node a line check asks).
  let u32View = null, u8View = null, f32View = null;
  const words = () => { const buffer = memory.buffer; return u32View !== null && u32View.buffer === buffer ? u32View : (u32View = new Uint32Array(buffer)); };
  const bytes = () => { const buffer = memory.buffer; return u8View !== null && u8View.buffer === buffer ? u8View : (u8View = new Uint8Array(buffer)); };
  const floats = () => { const buffer = memory.buffer; return f32View !== null && f32View.buffer === buffer ? f32View : (f32View = new Float32Array(buffer)); };
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
      u[(zones >>> 2) + 4 * i + 2] = 0;
    }
    u.fill(0, cache >>> 2, (cache >>> 2) + 2 * Math.max(1, caps.points));
    if (detail) u.set(detailTable, detail >>> 2);
  }
  const trackerHost = tracker ? createTrackerHost(kernel, model, tracker.movers,
    { at: { nodes, verts, points, surfs }, caps, block, words }) : null;
  // collisionModel()'s one object.
  let collision = null;
  const header = [nodes, nodeCount, verts, model.vertices.length, points, pointCount, surfs, model.surfaces.length,
    bounds, model.renderBounds.length, zones, model.zones.length, model.rootOutside, cache, 0, 0xfffffffe,
    dynamics, sprites, 0, detail, detail ? detailTable.length / 16 : 0];
  let stamp = 0;
  // The last run's status words, and its output decoded: the root frame's draw lists, child requests and sprites, then the child
  // frames. `stream` is the root frame's output (address and length in the kernel memory) for the decal block (decal-draw.mjs),
  // valid until the next run; `skipPoints` leaves the saved points to it. `frames` are the child frames in OccludeFrame's order.
  let lastStatus = null;
  const decodeOutput = (st, skipPoints, skipSpritePixels, flatDraw) => {
    // A view: decode copies what it keeps, and runs before the kernel is called again.
    const all = words().subarray(st[5] >>> 2, (st[5] >>> 2) + st[1]);
    return { ...decode(all.subarray(0, st[6]), st, skipPoints, skipSpritePixels, flatDraw),
      frames: decodeFrames(all, st[6], skipPoints, st[5], skipSpritePixels, flatDraw), stream: { at: st[5], words: st[6] } };
  };
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
    spriteCapacity = Math.max(count, 2 * spriteCapacity); sprites = block(36 * spriteCapacity); header[17] = sprites;
  };
  // Setup's mesh records by mesh key, and its candidate and result blocks.
  const meshRecords = new Map();
  let candidates = 0, results = 0, candidateCapacity = 0, views = null, frameCandidatesSet = false;
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
     * (three floats), `rotation` ([pitch, yaw, roll] int32), the viewport's
     * integer `width` and `height`, Actor.FOVAngle `fov` and
     * Actor.OrthoZoom, with the zone from this model. With `render`
     * ({width, height}, the root window's render rectangle) the frame has
     * been through the render pass's ComputeRenderSize at precision control
     * 24 (XRootWindow::PreRender, a ViewportWindow's Draw): the sizes,
     * projection, ViewSides and ViewPlanes of that rectangle, the screen
     * span still the viewport's. Returns `frame`, the words for `run` (its
     * frame counter, TimeSeconds and option words still to set), and
     * `fields`: Coords, FX..PrjYP, ViewSides, ViewPlanes and ZoneNumber. */
    master(camera) {
      setHeader();
      return masterFrame(kernel, camera);
    },
    /** The address meshRecord made for `key`, or undefined (the caller then has the fields made). */
    meshRecordAt(key) { return meshRecords.get(key); },
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
    /** In a `frameDynamics` call (run's `children`): the `count` candidates
     * packed with setupCandidates since are this child frame's own
     * (FDynamicSprite::Setup runs on them, and the accepted ones are its
     * sprites). The sprite list grows to fit, in the model the run reads. */
    useFrameCandidates(count) {
      ensureSprites(count);
      const u = words(), at = kernel.childInPtr() >>> 2;
      u[(kernel.modelPtr() >>> 2) + 17] = sprites;
      u[at + 4] = candidates; u[at + 5] = count;
      frameCandidatesSet = true;
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
     * `{key, x1, y1, x2, y2, zBits, screenBits?}` (ScreenX, ScreenY, Persp bits) with Y1 >= 0, Y2 <= the frame's height
     * and Y1 < Y2 (Setup's checks); or, with `setupCount`, Setup on that
     * many packed candidates (setupCandidates) gives them. */
    run(frameWords, frameSprites = [], { setupCount = -1, skipPoints = false, skipSpritePixels = false, flatDraw = false, children = null } = {}) {
      const viaSetup = setupCount >= 0;
      ensureSprites(viaSetup ? setupCount : frameSprites.length);
      if (!viaSetup) {
        const u = words();
        frameSprites.forEach((sprite, i) => u.set([sprite.key, sprite.x1, sprite.y1, sprite.x2, sprite.y2, sprite.zBits,
          ...(sprite.screenBits ?? [0, 0, 0])].map(v => v >>> 0), (sprites >>> 2) + 9 * i));
        header[18] = frameSprites.length;
      }
      setHeader();
      words().set(frameWords, kernel.framePtr() >>> 2);
      if (viaSetup) setup(setupCount);
      // CreateChildFrame's ComputeRenderSize inputs and the recursion switch.
      if (kernel.childInPtr) {
        const at = kernel.childInPtr() >>> 2;
        if (children) {
          const { tangent } = childFrameTangent(children.fov, frameWords[12]);
          const io = new DataView(new ArrayBuffer(8));
          io.setFloat64(0, tangent, true);
          words().set([bitsOf(children.fov), bitsOf(children.orthoZoom ?? 0), io.getUint32(0, true), io.getUint32(4, true),
            viaSetup ? candidates : 0, viaSetup ? setupCount : 0, 1 | (children.frameDynamics ? 2 : 0), 0], at);
        } else words()[at + 6] = 0;
      } else if (children) throw new Error('The script VM core predates child frames; run npm run build:wasm');
      // OccludeFrame's SetupDynamics for each child frame, between the
      // previous frame's OccludeBsp and the child's own Setup: the host runs
      // the frame's iterators again and gives it its own candidates.
      if (children?.frameDynamics) {
        if (!kernel.setFrameHook) throw new Error('The script VM core predates per-frame dynamics; run npm run build:wasm');
        kernel.setFrameHook((index, kind, parent) => {
          frameCandidatesSet = false;
          children.frameDynamics({ index, kind: kind ? 'sky' : 'mirror', parent });
          if (!frameCandidatesSet) throw new Error(`frameDynamics gave child frame ${index} no candidates (useFrameCandidates)`);
        });
      }
      let status;
      try { status = kernel.run(work, workBytes); } finally { if (children?.frameDynamics) kernel.setFrameHook(null); }
      stamp = words()[(kernel.modelPtr() >>> 2) + 14];
      const st = words().slice(kernel.statusPtr() >>> 2, (kernel.statusPtr() >>> 2) + 8);
      if (status !== 0) throw new Error(`OccludeBsp failed with status ${status}`);
      lastStatus = st;
      return decodeOutput(st, skipPoints, skipSpritePixels, flatDraw);
    },
    /** Validation: the last run's output decoded again with other options (its words stay until the next run). */
    decodeLast({ skipPoints = false, skipSpritePixels = false, flatDraw = false } = {}) {
      if (!lastStatus) throw new Error('No OccludeBsp run to decode');
      return decodeOutput(lastStatus, skipPoints, skipSpritePixels, flatDraw);
    },
    /** Validation: the child frames' Setup results for the watched candidate indices (up to 8), read after a run; `watch([])` stops it. */
    childSetupDebug: {
      watch(indices) {
        if (!kernel.childDebugPtr) return;
        const u = words(), at = kernel.childDebugPtr() >>> 2;
        u[at] = 0; u[at + 1] = indices.length;
        indices.slice(0, 8).forEach((index, i) => { u[at + 2 + i] = index; });
      },
      rows() {
        if (!kernel.childDebugPtr) return [];
        const u = words(), at = kernel.childDebugPtr() >>> 2, out = [];
        for (let r = 0; r < u[at]; r++) out.push({ frame: u[at + 10 + 11 * r], candidate: u[at + 11 + 11 * r], words: [...u.slice(at + 12 + 11 * r, at + 21 + 11 * r)] });
        return out;
      },
    },
    /** Each zone's SkyZone (the zone's actor's, or the LevelInfo's for a
     * zone without one; OccludeBsp reads it at 0x10b183a8 for a
     * fake-backdrop polygon): null for none, else its `location` (floats),
     * `rotation` (pitch, yaw, roll) and `zone` (Region.ZoneNumber), which
     * the sky child frame takes. */
    setZoneSkies(skies) {
      const u = words();
      for (let i = 0; i < model.zones.length; i++) {
        const sky = skies[i];
        if (!sky) { u[(zones >>> 2) + 4 * i + 2] = 0; continue; }
        const at = (skyRecords >>> 2) + 7 * i, location = sky.location ?? ZERO3, rotation = sky.rotation ?? ZERO3;
        u[at] = bitsOf(location[0]); u[at + 1] = bitsOf(location[1]); u[at + 2] = bitsOf(location[2]);
        u[at + 3] = rotation[0] >>> 0; u[at + 4] = rotation[1] >>> 0; u[at + 5] = rotation[2] >>> 0;
        u[at + 6] = (sky.zone ?? 0) >>> 0;
        u[(zones >>> 2) + 4 * i + 2] = skyRecords + 28 * i;
      }
    },
    /** The live NodeFlags byte of node `i` (NF_PolyOccluded 8, NF_BoxOccluded 0x10). */
    nodeFlags: i => bytes()[nodes + 64 * i + 55],
    /** Node `i`'s iSurf (a child request names its node, not its surface). */
    nodeSurf: i => words()[(nodes >>> 2) + 16 * i + 7] | 0,
    /** Node `i`'s polygon as the model holds it now (a tracker fragment where
     * the last Update left it): its points, flat [x, y, z, ...] floats. */
    nodePolygon(i) {
      const u = words(), f = floats(), count = bytes()[nodes + 64 * i + 54];
      const pool = u[(nodes >>> 2) + 16 * i + 6] | 0, out = new Array(3 * count);
      for (let k = 0; k < count; k++) {
        const at = (points >>> 2) + 3 * u[(verts >>> 2) + 2 * (pool + k)];
        out[3 * k] = f[at]; out[3 * k + 1] = f[at + 1]; out[3 * k + 2] = f[at + 2];
      }
      return out;
    },
    /** The moving brush tracker (brush-tracker.mjs) over this model, or
     * null without movers; `blocks` are the model's own. */
    tracker: trackerHost,
    /** Level->Model as UModel::LineCheck traverses it now, the tracker's
     * fragment nodes included (docs/brush-tracker.md "Collision": once
     * NF_IsNew clears they are ordinary nodes of the level model): the
     * fields ray.mjs traceRayFast, extent-trace.mjs traceExtent, point-check.mjs
     * modelPointCheck and zone.mjs pointRegion read (plane, front, back,
     * vertexCount, NodeFlags, iCollisionBound, iSurf, iZone, iLeaf), rootOutside
     * and the static model's LeafHulls (AddNode gives a fragment
     * iCollisionBound -1, 0x1037bb00, so the tracker adds no hull), read from
     * this model's memory. A node
     * object is made at its first read; take a new view after the tracker
     * updated. */
    lineModel() {
      const count = trackerHost ? trackerHost.header(TRACKER.NODES_NUM) : nodeCount, made = new Map();
      const u = words(), b = bytes(), fl = floats();
      const node = i => {
        let n = made.get(i);
        if (!n) {
          const o = (nodes >>> 2) + 16 * i;
          n = { plane: [fl[o], fl[o + 1], fl[o + 2], fl[o + 3]], back: u[o + 8] | 0, front: u[o + 9] | 0,
            vertexCount: b[nodes + 64 * i + 54], flags: b[nodes + 64 * i + 55], collisionBound: u[o + 11] | 0, surface: u[o + 7] | 0,
            zones: [b[nodes + 64 * i + 52], b[nodes + 64 * i + 53]], leaves: [u[o + 14] | 0, u[o + 15] | 0] };
          made.set(i, n);
        }
        return n;
      };
      return { rootOutside: model.rootOutside, leafHulls: model.leafHulls, nodes: new Proxy([], { get(_, key) {
        if (key === 'length') return count;
        const i = typeof key === 'string' ? Number(key) : NaN;
        return Number.isInteger(i) && i >= 0 && i < count ? node(i) : undefined;
      } }) };
    },
    /** The same Level->Model as a node block read in place (fast-line-check.mjs
     * reads each node's plane, children and NodeFlags from it): the kernel's
     * memory, the block's address, the node count the tracker holds now and
     * RootOutside. */
    lineNodes() {
      return { memory, at: nodes, count: trackerHost ? trackerHost.header(TRACKER.NODES_NUM) : nodeCount, rootOutside: model.rootOutside };
    },
    /** Level->Model for the level's collision queries while the tracker
     * lives (docs/brush-tracker.md "Collision"): ULevel::MultiLineCheck's and
     * MultiPointCheck's world checks call Level->Model's LineCheck and
     * PointCheck, and once NF_IsNew clears the tracker's fragments are
     * ordinary nodes of that model, where the movers were last rendered.
     * One object for the tracker's life (level-queries.mjs keys its world
     * model, and trace-kernel.mjs its upload, by identity): `nodes` reads
     * each node from this model's memory at its first read in a tracker
     * generation (lineModel's fields), `surfaces` the static surfaces then
     * each tracker FBspSurf's PolyFlags (AddBrush: the polygon's
     * `PolyFlags & 0x3cffffff`), `trackedSource` the node block for the
     * trace kernel's import (its address, capacity, count and the tracker's
     * generation, which Update bumps whenever it rebuilt a mover). Null
     * without a tracker. */
    collisionModel() {
      if (!trackerHost) return null;
      if (collision) return collision;
      let made = new Map(), madeGeneration = -1;
      const generation = () => trackerHost.header(TRACKER.GENERATION), count = () => trackerHost.header(TRACKER.NODES_NUM);
      const node = i => {
        const g = generation();
        if (g !== madeGeneration) { made = new Map(); madeGeneration = g; }
        let n = made.get(i);
        if (!n) {
          const u = words(), b = bytes(), fl = floats(), o = (nodes >>> 2) + 16 * i;
          n = { plane: [fl[o], fl[o + 1], fl[o + 2], fl[o + 3]], back: u[o + 8] | 0, front: u[o + 9] | 0,
            vertexCount: b[nodes + 64 * i + 54], flags: b[nodes + 64 * i + 55], collisionBound: u[o + 11] | 0, surface: u[o + 7] | 0,
            zones: [b[nodes + 64 * i + 52], b[nodes + 64 * i + 53]], leaves: [u[o + 14] | 0, u[o + 15] | 0] };
          made.set(i, n);
        }
        return n;
      };
      const top = () => trackerHost.header(TRACKER.SURFS_TOP), dsurfs = trackerHost.blocks.dsurfs;
      const surface = i => {
        if (i < top()) return model.surfaces[i];
        if (i >= trackerHost.header(TRACKER.SURFS_NUM)) return undefined;
        const u = words(), o = (dsurfs >>> 2) + DSURF.WORDS * (i - top());
        return { texture: null, flags: u[o + DSURF.FLAGS], dynamic: true, mover: u[o + DSURF.ACTOR] - 0x40000000, ordinal: u[o + DSURF.BRUSHPOLY] };
      };
      const indexed = (length, read) => new Proxy([], { get(_, key) {
        if (key === 'length') return length();
        const i = typeof key === 'string' ? Number(key) : NaN;
        return Number.isInteger(i) && i >= 0 && i < length() ? read(i) : undefined;
      } });
      collision = { rootOutside: model.rootOutside, leafHulls: model.leafHulls, zones: model.zones,
        nodes: indexed(count, node), surfaces: indexed(() => trackerHost.header(TRACKER.SURFS_NUM), surface),
        trackedSource: { memory, at: nodes, capacity: caps.nodes, count, generation } };
      return collision;
    },
    blocks: { nodes, verts, points, surfs },
    /** The detail table as uploaded (`detailTable`): its address and record count, for the kernel's detail pass; null without one. */
    detail: detail ? { table: detail, surfaces: detailTable.length / 16 } : null,
    /** Model.Zones[i].LastRenderTime bits. */
    zoneTime: i => words()[(zones >>> 2) + 4 * i + 1],
    // The tracker goes first (the original deletes GBrushTracker before the
    // level it filtered into: travel and LoadMap, docs/brush-tracker.md).
    dispose() { if (trackerHost?.live()) trackerHost.destroy(); for (const at of blocks.splice(0)) free(at); },
  };
}

/** The child frames' records after the root frame's output (occlude.rs
 * emit_frame): each frame's index, its parent's (0 the root), the kind and
 * node of the request that made it, Recursion, ZoneNumber, Mirror and
 * NearClip bits, the ComputeRenderSize fields (Coords, FX..PrjYP,
 * ViewSides, ViewPlanes), Uncoords, its span, the nodes of every request
 * that made or merged into it (`requests`, in request order: a mirror request
 * passes iSurf 0, so coplanar mirrors of different surfaces in one zone share
 * a frame, 0x10b18b4a) and its OccludeBsp output (`stream`: its address in the
 * kernel memory and word count, for the detail pass). */
/** `count` words from `at` as a plain array (a slice and its spread each made a copy). */
function copyWords(words, at, count) {
  const out = new Array(count);
  for (let k = 0; k < count; k++) out[k] = words[at + k];
  return out;
}
function decodeFrames(words, at, skipPoints, base = 0, boundsOnly = false, flatDraw = false) {
  const frames = [];
  let i = at;
  while (i < words.length) {
    if (words[i] !== 0xfffffffd) throw new Error(`Malformed child frame record at ${i}`);
    const index = words[i + 1], parent = words[i + 2], kind = words[i + 3], iNode = words[i + 4], recursion = words[i + 5], zone = words[i + 6], mirror = words[i + 7];
    const nearClip = copyWords(words, i + 8, 4), fields = copyWords(words, i + 12, 57), uncoords = copyWords(words, i + 69, 12);
    i += 81;
    const startY = words[i], endY = words[i + 1], valid = words[i + 2];
    i += 3;
    // `boundsOnly` (Play's caller reads a span's pixel bounds and a sprite's key alone): the span's [minX, startY, maxX, endY)
    // instead of its lines, as sim-session.mjs spanBounds would compute them, and the sprites' rows stepped over.
    const lines = boundsOnly ? null : [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = startY | 0; y < (endY | 0); y++) {
      const count = words[i++];
      if (boundsOnly) {
        if (count) {
          minX = Math.min(minX, words[i] | 0); maxX = Math.max(maxX, words[i + 2 * count - 1] | 0);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y + 1);
        }
        i += 2 * count;
        continue;
      }
      const line = [];
      for (let k = 0; k < count; k++, i += 2) line.push([words[i] | 0, words[i + 1] | 0]);
      lines.push(line);
    }
    const bounds = boundsOnly ? (minX < maxX && minY < maxY ? [minX, minY, maxX, maxY] : null) : undefined;
    const requestCount = words[i++], requests = new Array(requestCount);
    for (let k = 0; k < requestCount; k++) requests[k] = words[i + k] | 0;
    i += requestCount;
    const length = words[i++];
    const body = decode(words.subarray(i, i + length), [], skipPoints, boundsOnly, flatDraw);
    // The frame's OccludeBsp output where the kernel left it (valid until the next run), for the detail pass.
    const stream = { at: base + 4 * i, words: length };
    i += length;
    frames.push({ index, parent, kind: kind ? 'sky' : 'mirror', iNode: iNode | 0, requests, recursion, zone, mirror, nearClip,
      fields, uncoords, span: { startY: startY | 0, endY: endY | 0, validLines: valid | 0, lines, ...(boundsOnly ? { bounds } : {}) },
      draw: body.draw, drawn: body.drawn, children: body.children, sprites: body.sprites, spriteScreens: body.spriteScreens, stream });
  }
  return frames;
}

/** `flatDraw` (Play's caller, which reads each entry's surface and zone and its polygons' nodes alone): the draw lists as arrays,
 * not an object per entry and per polygon (about a sixth of the simulation worker's allocation; docs/live-heap.md "Allocation and
 * the long frame"). `drawn.entries[list]` holds each entry's iSurf, iZone and polygon count, in the list's order, and
 * `drawn.nodes[list]` its polygons' iNode in the same order; `draw` is null. The polygons' points are skipped, and the child
 * requests' spans have no lines (their kind and node are what that caller reads). */
function decode(words, status, skipPoints = false, skipSpritePixels = false, flatDraw = false) {
  const draw = flatDraw ? null : [[], [], []], children = [], sprites = [], spriteScreens = [];
  // The flat lists are written into scratch arrays that live between decodes and copied out at the end, exact in size (a JavaScript
  // array grown by push leaves its old backing stores behind, and every list of every frame grew from empty).
  if (flatDraw) { flatEntryCounts[0] = flatEntryCounts[1] = flatEntryCounts[2] = 0; flatNodeCounts[0] = flatNodeCounts[1] = flatNodeCounts[2] = 0; }
  const drawn = flatDraw;
  let i = 0;
  while (i < words.length) {
    if (words[i] === 0xfffffffe) {
      // key, the sprite's Z, Setup's ScreenX, ScreenY, Persp (bits; docs/frame-projection.md "Sprites"), span.
      const key = words[i + 1], startY = words[i + 6], endY = words[i + 7], valid = words[i + 8];
      spriteScreens.push({ key, zBits: words[i + 2], screenBits: [words[i + 3], words[i + 4], words[i + 5]] });
      i += 9;
      if (skipSpritePixels) {
        // The caller reads only the sprite's key: step over its rows.
        for (let y = startY | 0; y < (endY | 0); y++) i += 2 * words[i] + 1;
        sprites.push({ key, span: { startY: startY | 0, endY: endY | 0, validLines: valid | 0, lines: [] } });
        continue;
      }
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
      const kind = words[i + 1], iNode = words[i + 2], iSurf = words[i + 3], zone = words[i + 4], startY = words[i + 5], endY = words[i + 6], valid = words[i + 7];
      i += 8;
      const lines = [];
      for (let y = startY | 0; y < (endY | 0); y++) {
        if (drawn) { i += 2 * words[i] + 1; continue; }
        const count = words[i++], line = [];
        for (let k = 0; k < count; k++, i += 2) line.push([words[i] | 0, words[i + 1] | 0]);
        lines.push(line);
      }
      children.push({ kind: kind ? 'sky' : 'mirror', iNode: iNode | 0, iSurf: iSurf | 0, zone,
        span: { startY: startY | 0, endY: endY | 0, validLines: valid | 0, lines } });
      continue;
    }
    const list = words[i], iNode = words[i + 1], iSurf = words[i + 2], iZone = words[i + 3], polyFlags = words[i + 4], zoneKey = words[i + 5], polyCount = words[i + 6];
    i += 7;
    if (drawn) {
      if (!(list < 3)) throw new Error(`Malformed draw list ${list} at ${i - 7}`);
      let nodes = flatNodes[list], at = flatNodeCounts[list], entries = flatEntries[list];
      const entryAt = flatEntryCounts[list];
      if (at + polyCount > nodes.length) flatNodes[list] = nodes = grown(nodes, at + polyCount, Uint32Array);
      if (entryAt + 3 > entries.length) flatEntries[list] = entries = grown(entries, entryAt + 3, Int32Array);
      entries[entryAt] = iSurf | 0; entries[entryAt + 1] = iZone; entries[entryAt + 2] = polyCount;
      flatEntryCounts[list] = entryAt + 3;
      for (let p = 0; p < polyCount; p++) { nodes[at++] = words[i]; i += 2 + 7 * words[i + 1]; }
      flatNodeCounts[list] = at;
      continue;
    }
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
  return { draw, drawn: drawn ? flatLists() : null, children, sprites, spriteScreens, nodesDraw: status[2], polysDraw: status[3] };
}
const flatEntryCounts = new Int32Array(3), flatNodeCounts = new Int32Array(3);
const flatEntries = [new Int32Array(1536), new Int32Array(1536), new Int32Array(1536)];
const flatNodes = [new Uint32Array(2048), new Uint32Array(2048), new Uint32Array(2048)];
function grown(array, need, Type) {
  const made = new Type(Math.max(need, 2 * array.length));
  made.set(array);
  return made;
}
/** The decode's flat lists, copied out of the scratch: `entries[list]` and `nodes[list]` are views of one exact Int32Array and one
 * exact Uint32Array (the lists' nodes in list order, which is how sim-session.mjs drawnOf takes the frame's whole node list
 * without a copy). */
function flatLists() {
  const e0 = flatEntryCounts[0], e1 = flatEntryCounts[1], e2 = flatEntryCounts[2], n0 = flatNodeCounts[0], n1 = flatNodeCounts[1], n2 = flatNodeCounts[2];
  const entries = new Int32Array(e0 + e1 + e2), nodes = new Uint32Array(n0 + n1 + n2);
  let at = 0;
  for (let list = 0; list < 3; list++) { const from = flatEntries[list]; for (let k = 0, n = flatEntryCounts[list]; k < n; k++) entries[at++] = from[k]; }
  at = 0;
  for (let list = 0; list < 3; list++) { const from = flatNodes[list]; for (let k = 0, n = flatNodeCounts[list]; k < n; k++) nodes[at++] = from[k]; }
  return { entries: [entries.subarray(0, e0), entries.subarray(e0, e0 + e1), entries.subarray(e0 + e1)],
    nodes: [nodes.subarray(0, n0), nodes.subarray(n0, n0 + n1), nodes.subarray(n0 + n1)] };
}
