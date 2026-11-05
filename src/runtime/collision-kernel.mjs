/** The Rust collision hash and line checks (native/script-vm/src/hash.rs,
 * docs/rust-core.md step R3-b), run in the trace kernel's instance
 * (trace-kernel.mjs), where the BSP models already are.
 *
 * - KernelHashStore keeps a level's hash buckets in Rust. createCollisionHash
 *   (collision-hash.mjs) still does every registration check, keeps the
 *   registrations and runs the point, encroachment and fallback line
 *   queries' JavaScript callbacks; only the buckets and the visit order
 *   (hash_candidates) move.
 * - createKernelLineChecks answers level-queries.mjs `lineCheck` and
 *   `multiLineCheck` in one Rust call each (lc_line): cells, visit order,
 *   cylinder and brush primitives, the world trace, MultiLineCheck's join
 *   and qsort, and SingleLineCheck's walk of the sorted hits. Its imports
 *   (the host given to setLineCheckHost below) read live actor state exactly
 *   where the JavaScript does. Its `surfaceScan` runs walking-surface.mjs's
 *   36 scan queries and the floor query in one call (lc_scan), each
 *   candidate read once per call. It answers `undefined` for the
 *   JavaScript to run the query instead: inputs that are not three numbers
 *   each, a query nested inside another, and every case hash.rs hands back
 *   (non-finite values, cells outside the 0..255 domain, a model or trace
 *   the trace kernel hands back, negative extents reaching a trace).
 *
 * HASH_KERNEL=js keeps the JavaScript hash and line checks; SCAN_KERNEL=js
 * only the walking-surface scan. HASH_DIFFERENTIAL=1 keeps a JavaScript hash
 * beside the Rust one (every add, remove and visit order compared) and checks
 * every Rust line check and scan against the JavaScript path;
 * TRACE_DIFFERENTIAL=1 checks the line checks and scans too, so the traces
 * inside them are compared through the JavaScript path's traceRay and
 * traceExtent.
 *
 * The hash starts in the trace kernel's own instance and moves to the
 * runtime's interpreter instance once it exists (`adopt`, `runtimeLineKernel`:
 * game.mjs, after createScriptDoors), where hash.rs reads the object image
 * itself: a candidate's cylinder, isMover and the filter's class and
 * collision-bit tests no longer cross into the JavaScript imports below
 * where the image holds the storage `valuesOf(actor)` reads
 * (collision-image.mjs, docs/collision-hash.md "The hash reads the image").
 * COLLISION_HOST=js keeps every import in JavaScript (and the hash in the
 * trace kernel's instance), =verify also runs each import and throws when
 * its answer differs from the image's, =rust (the default) answers from the
 * image. */
import {traceKernel, setLineCheckHost, TRACE_DIFFERENTIAL, createRuntimeTraceKernel} from './trace-kernel.mjs';
import {cylinderImageHandle, brushImageHandle, serializedCylinder} from './collision-image.mjs';
import {existingHandle} from './script-object-handles.mjs';

const env = typeof process !== 'undefined' ? process.env : undefined;
export const HASH_JS_ONLY = env?.HASH_KERNEL === 'js';
export const HASH_DIFFERENTIAL = env?.HASH_DIFFERENTIAL === '1';
// SCAN_KERNEL=js keeps walking-surface.mjs's scan in JavaScript (its queries
// still go to the kernel line checks).
const SCAN_JS_ONLY = env?.SCAN_KERNEL === 'js';

/** COLLISION_HOST (?collisionHost= in the viewer): 'rust' (default), 'js' or 'verify'. */
export function collisionHostMode() {
  const value = env?.COLLISION_HOST || globalThis.DEUS_EX_COLLISION_HOST || 'rust';
  if (value !== 'rust' && value !== 'js' && value !== 'verify') throw new Error(`COLLISION_HOST must be 'rust', 'js' or 'verify', not '${value}'`);
  return value;
}

// hash.rs Header words.
const H_KEYS = 0, H_HEADS = 1, H_TABLE_CAP = 2, H_TABLE_USED = 3, H_LINK_REG = 4, H_LINK_NEXT = 5, H_LINK_CAP = 6,
  H_LINKS_LIVE = 9, H_STAMPS = 10, H_REG_CAP = 11, H_QUERYING = 13, H_BUSY = 14, H_SCRATCH = 15, H_CACHE = 17, H_IMAGES = 18;
// Header, Hit and Cached sizes (hash.rs).
const HEADER = 80, HIT = 80, CACHED = 80, RECORD = 11;
// lc_candidate answers and hit kinds (hash.rs).
const C_CYLINDER = 0, C_BRUSH_OWNED = 1, C_BRUSH = 2, C_FALLBACK = 3;
const WORLD_RAY = 0, WORLD_EXTENT = 1, CYLINDER = 2, BRUSH_RAY = 3, BRUSH_EXTENT = 4;
const ANSWERED = 0;
// hash.rs's registration descriptor (the header's `images` table, DESC words per id: handle, flags, memo record).
const D_KIND = 1, D_MOVER = 2, D_IMAGE = 4, D_BRUSH = 8, D_STATIC = 16, D_FILTER_SHIFT = 8, DESC = 4;
// A mover's memo record (hash.rs image_brush): Location x3, Rotation x3, model, valid (u32 words), 12 ToWorld f64s from byte 32.
const BRUSH_RECORD = 128;
const keyBits = new Uint32Array(1), keyFloat = new Float32Array(keyBits.buffer);
// hash.rs's CTX layout: [valid, flags, world on the chain, chain length, chain ids...].
const CTX_CHAIN = 4, CTX_CHAIN_MAX = 12;
// Host-only flag: the registration's cylinder was examined for an image (`consider`).
const D_TRIED = 0x80000000;
// SingleLineCheck's class flags, in the order its filter tests them (line-filter.mjs, classFlags below).
const FILTER_LINEAGE = [['engine.levelinfo', 4], ['engine.pawn', 1], ['engine.mover', 2], ['engine.zoneinfo', 8]];

// `candidates`, `movers` and `accepts` count the imports below (the crossings into JavaScript); `checked` the
// image answers COLLISION_HOST=verify compared with them.
export const kernelStats = {queries: 0, answered: 0, handedBack: 0, compared: 0, orders: 0, stores: 0, candidates: 0, movers: 0, accepts: 0,
  checked: 0, adopted: 0, runtime: null};

/** The answers hash.rs gave from the object image without an import: candidates, movers, filter tests. */
export function imageAnswers() {
  const kernel = kernelStats.runtime?.deref();
  if (!kernel) return {candidates: 0, movers: 0, accepts: 0, brushes: 0, serialized: 0};
  const counts = new Uint32Array(kernel.arena.memory.buffer, kernel.x.lc_stats_ptr(), 8);
  return {candidates: counts[0], movers: counts[1], accepts: counts[2], brushes: counts[3], serialized: counts[4]};
}
if (HASH_DIFFERENTIAL || TRACE_DIFFERENTIAL || env?.COLLISION_STATS === '1') process.on('exit', () => {
  const s = kernelStats, image = imageAnswers();
  console.error(`collision kernel differential: ${s.answered} line checks and scans answered in Rust, ${s.compared} compared, ${s.handedBack} handed back; ${s.orders} hash visit orders compared; ${s.stores} hashes; imports: ${s.candidates} candidate, ${s.movers} isMover, ${s.accepts} filter; candidate imports by cause ${JSON.stringify(s.rest)}; ms in the imports ${s.ms.candidate.toFixed(0)} candidate, ${s.ms.mover.toFixed(0)} isMover, ${s.ms.accept.toFixed(0)} filter; from the image: ${image.candidates} cylinder, ${image.serialized} serialized, ${image.brushes} brush, ${image.movers} isMover, ${image.accepts} filter, ${s.checked} compared`);
});

/** A level's hash buckets in a kernel's arena (`kernel`: a runtime's, from
 * `runtimeLineKernel`, else the trace kernel's own), or null (the JavaScript
 * hash): the kernel is not loaded, or HASH_KERNEL=js. */
export function kernelHashStore(kernel = null) {
  if (HASH_JS_ONLY || traceKernel === null) return null;
  return new KernelHashStore(kernel ?? traceKernel);
}

/** The line-check kernel on a runtime's interpreter instance (`vm`: its
 * RustScriptVm), made once per runtime, or null for the trace kernel's
 * instance and the JavaScript imports (COLLISION_HOST=js, HASH_KERNEL=js,
 * SCRIPT_VM=js). */
export function runtimeLineKernel(vm) {
  const mode = collisionHostMode();
  if (mode === 'js' || HASH_JS_ONLY || traceKernel === null || !vm?.exports) return null;
  if (vm.lineKernel === undefined) {
    const kernel = createRuntimeTraceKernel(vm.exports, vm.arena);
    kernel.imageHost = true;
    kernel.verify = mode === 'verify';
    vm.exports.lc_mode(kernel.verify ? 1 : 0);
    vm.lineKernel = kernel;
  }
  // (weakly: the statistics must not keep a left level's arena alive)
  kernelStats.runtime = new WeakRef(vm.lineKernel);
  return vm.lineKernel;
}

// A store's ranges, released once the store is collected (no kernel call
// holds them then). A runtime's arena is reclaimed by its level tick, not here.
const storeRanges = new FinalizationRegistry(({arena, ranges, reclaim}) => {
  for (const [base, size] of ranges) arena.release(base, size);
  if (reclaim) arena.reclaim();
});

class KernelHashStore {
  constructor(kernel) {
    this.ids = new Map();
    this.actors = [];
    this.freeIds = [];
    // Ids removed while a line check is in flight: its answer still names
    // them, so they keep their actor until it returns.
    this.pendingIds = [];
    // Each registration's cells, in the order they were added: `adopt` adds them again in that order, which rebuilds every
    // cell's list (LIFO by add order) as it is.
    this.cellsOf = new Map();
    this.init(kernel);
    kernelStats.stores++;
  }
  /** The hash's ranges in `kernel`'s arena. */
  init(kernel) {
    this.kernel = kernel;
    this.x = kernel.x;
    this.arena = kernel.arena;
    this.ranges = new Map();
    // A mover's memo record by actor (describe): kept across its re-registrations.
    this.records = new Map();
    // Ranges replaced while a query still reads them (the scratch, while a
    // line check's join calls isMover), released when it returns.
    this.deferred = [];
    this.hw = new Uint32Array(0);
    this.worldModel = undefined;
    this.worldBase = 0;
    const tableCap = 8192, linkCap = 8192, regCap = 1024;
    this.h = this.alloc(HEADER);
    const keys = this.alloc(tableCap * 4), heads = this.alloc(tableCap * 4);
    const linkReg = this.alloc(linkCap * 4), linkNext = this.alloc(linkCap * 4);
    const stamps = this.alloc(regCap * 4), scratch = this.alloc(regCap * HIT), cache = this.alloc(regCap * CACHED);
    this.order = this.alloc(regCap * 4);
    // walking-surface scan tables by surface texture list (surfaceTable).
    this.tables = new WeakMap();
    this.x.hash_init(this.h, keys, heads, tableCap, linkReg, linkNext, linkCap, stamps, scratch, cache, regCap);
    // The registration descriptors (hash.rs D_*), where the instance reads the object image.
    this.imageHost = kernel.imageHost === true;
    this.verify = kernel.verify === true;
    if (this.imageHost) {
      const images = this.alloc(regCap * DESC * 4);
      this.header()[H_IMAGES] = images;
      kernel.store = this;
    }
    this.views();
    storeRanges.register(this, {arena: this.arena, ranges: this.ranges, reclaim: !this.imageHost});
  }
  /** The registrations move to `kernel`'s instance (the runtime's, once it exists): its hash holds the same cells in the
   * same list order, and its candidate, isMover and filter answers come from the object image where it holds the
   * storage the JavaScript reads. Nothing is in flight when the runtime appears. */
  adopt(kernel) {
    if (kernel === this.kernel) return;
    if (active || this.querying()) throw new Error('A collision hash does not move to another instance during a query');
    const live = [...this.cellsOf], old = {arena: this.arena, ranges: this.ranges, kernel: this.kernel};
    if (old.kernel.store === this) old.kernel.store = null;
    this.ids = new Map();
    this.actors = [];
    this.freeIds = [];
    this.pendingIds = [];
    this.cellsOf = new Map();
    this.init(kernel);
    for (const [actor, cells] of live) this.add(actor, cells);
    for (const [base, size] of old.ranges) old.arena.release(base, size);
    old.ranges.clear();
    old.arena.reclaim();
    kernelStats.adopted++;
  }
  alloc(size) {
    const base = this.arena.alloc(size);
    this.ranges.set(base, size);
    // A grown memory detaches the trace kernel's views too.
    this.kernel.views();
    return base;
  }
  free(base) {
    this.arena.release(base, this.ranges.get(base));
    this.ranges.delete(base);
    // (A runtime's arena is reclaimed by its level tick, before any actor runs.)
    if (!this.imageHost) this.arena.reclaim();
  }
  /** The header words, re-derived after the memory grew (growth detaches
   * every view of the old buffer). */
  header() {
    if (this.hw.length === 0) this.views();
    return this.hw;
  }
  views() {
    const buffer = this.arena.memory.buffer;
    this.words = new Uint32Array(buffer);
    this.hw = new Uint32Array(buffer, this.h, HEADER / 4);
    this.cand = new Float64Array(buffer, this.x.lc_cand_ptr(), 8);
    this.answer = new Float64Array(buffer, this.x.lc_answer_ptr(), 2 + RECORD * 64);
    this.ctx = new Uint32Array(buffer, this.x.lc_ctx_ptr(), 16);
    this.image = new Float64Array(buffer, this.x.lc_image_ptr(), 8);
    const images = this.imageHost ? this.hw[H_IMAGES] : 0;
    this.desc = images ? new Uint32Array(buffer, images, this.hw[H_REG_CAP] * DESC) : new Uint32Array(0);
    this.brush = new Float64Array(buffer, this.x.lc_brush_ptr(), 12);
  }
  querying() { return this.header()[H_QUERYING] !== 0; }
  setQuerying(value) { this.header()[H_QUERYING] = value ? 1 : 0; }
  /** Room for a registration spanning `count` cells. */
  reserve(id, count) {
    let hw = this.header();
    if (hw[H_LINKS_LIVE] + count > hw[H_LINK_CAP]) {
      let cap = hw[H_LINK_CAP] * 2;
      while (hw[H_LINKS_LIVE] + count > cap) cap *= 2;
      const oldReg = hw[H_LINK_REG], oldNext = hw[H_LINK_NEXT];
      const reg = this.alloc(cap * 4), next = this.alloc(cap * 4);
      this.x.hash_links(this.h, reg, next, cap);
      this.free(oldReg); this.free(oldNext);
      hw = this.header();
    }
    if ((hw[H_TABLE_USED] + count) * 2 > hw[H_TABLE_CAP]) {
      let cap = hw[H_TABLE_CAP] * 2;
      while ((hw[H_TABLE_USED] + count) * 2 > cap) cap *= 2;
      const oldKeys = hw[H_KEYS], oldHeads = hw[H_HEADS];
      const keys = this.alloc(cap * 4), heads = this.alloc(cap * 4);
      this.x.hash_rehash(this.h, keys, heads, cap);
      this.free(oldKeys); this.free(oldHeads);
      hw = this.header();
    }
    if (id >= hw[H_REG_CAP]) {
      let cap = hw[H_REG_CAP] * 2;
      while (id >= cap) cap *= 2;
      const oldStamps = hw[H_STAMPS], oldScratch = hw[H_SCRATCH], oldCache = hw[H_CACHE], oldOrder = this.order, oldImages = hw[H_IMAGES], oldCap = hw[H_REG_CAP];
      const stamps = this.alloc(cap * 4), scratch = this.alloc(cap * HIT), cache = this.alloc(cap * CACHED);
      this.order = this.alloc(cap * 4);
      const images = this.imageHost ? this.alloc(cap * DESC * 4) : 0;
      if (images) {
        // The descriptors move with the registrations (the new range starts zeroed).
        const buffer = this.arena.memory.buffer;
        new Uint32Array(buffer, images, oldCap * DESC).set(new Uint32Array(buffer, oldImages, oldCap * DESC));
      }
      this.x.hash_regs(this.h, stamps, scratch, cache, cap);
      this.header()[H_IMAGES] = images;
      if (oldImages) this.free(oldImages);
      this.free(oldStamps); this.free(oldOrder);
      this.views();
      hw = this.header();
      // A call in flight still reads its scratch and scan cache.
      if (hw[H_BUSY]) this.deferred.push(oldScratch, oldCache);
      else { this.free(oldScratch); this.free(oldCache); }
    }
  }
  releaseDeferred() {
    for (const base of this.deferred) this.free(base);
    this.deferred.length = 0;
  }
  /** AddActor's bucket writes for a checked registration. */
  add(actor, cells) {
    const id = this.freeIds.length ? this.freeIds.pop() : this.actors.length;
    const min = cells.min, max = cells.max;
    const count = Math.max(0, max[0] - min[0] + 1) * Math.max(0, max[1] - min[1] + 1) * Math.max(0, max[2] - min[2] + 1);
    this.reserve(id, count);
    this.ids.set(actor, id);
    this.actors[id] = actor;
    this.cellsOf.set(actor, cells);
    this.x.hash_add(this.h, id, min[0], min[1], min[2], max[0], max[1], max[2]);
    if (this.imageHost) this.describe(id, actor);
  }
  /** The registration's descriptor (hash.rs D_*): its class facts, which its lineage fixes for good, and its cylinder's
   * image where the actor has one now. An actor whose cylinder is not yet its image's (a spawned actor registered before
   * its collision view is installed) is examined again at its first import (`consider`). */
  describe(id, actor) {
    const lineage = actor.lineage;
    let flags = 0, handle = 0, record = 0;
    if (Array.isArray(lineage)) {
      let filter = 0;
      for (const [key, bit] of FILTER_LINEAGE) if (lineage.includes(key)) { filter = bit; break; }
      flags = D_KIND | (lineage.includes('engine.mover') ? D_MOVER : 0) | filter << D_FILTER_SHIFT;
    }
    let held = null;
    if ((handle = cylinderImageHandle(actor)) !== 0) flags |= D_IMAGE | D_TRIED;
    else if ((handle = brushImageHandle(actor)) !== 0) {
      record = this.records.get(actor) ?? 0;
      if (record === 0) this.records.set(actor, record = this.alloc(BRUSH_RECORD));
      flags |= D_BRUSH | D_TRIED;
    } else if ((held = serializedCylinder(actor)) !== null) {
      handle = existingHandle(actor);
      record = this.records.get(actor) ?? 0;
      if (record === 0) this.records.set(actor, record = this.alloc(BRUSH_RECORD));
      new Float64Array(this.arena.memory.buffer, record, 5).set(held);
      flags |= D_STATIC | D_TRIED;
    }
    let desc = this.desc;
    if (desc.length === 0) { this.views(); desc = this.desc; }
    desc[DESC * id] = handle;
    desc[DESC * id + 1] = flags;
    desc[DESC * id + 2] = record;
  }
  /** After the JavaScript's cylinder for `id` (once per registration): whether the actor's cylinder is its image's, and
   * the image identity hash.rs reads it from if so. */
  consider(id, actor) {
    let desc = this.desc;
    if (desc.length === 0) { this.views(); desc = this.desc; }
    const flags = desc[DESC * id + 1];
    if (flags & D_TRIED) return;
    desc[DESC * id + 1] = flags | D_TRIED;
    const handle = cylinderImageHandle(actor);
    if (handle !== 0) { desc[DESC * id] = handle; desc[DESC * id + 1] |= D_IMAGE; }
  }
  /** The import has computed `kind` for `actor` (a brush's, or the cylinder in CAND): COLLISION_HOST=verify compares it
   * with what hash.rs read from the image before the import (nothing, where it gave no answer), and a cylinder's
   * image is examined once (`consider`). */
  checkCandidate(kind, actor, id) {
    if (this.verify) {
      let image = this.image;
      if (image.length === 0) { this.views(); image = this.image; }
      if (image[0] === 1) {
        const c = this.cand;
        if (kind !== C_CYLINDER || !Object.is(image[1], c[0]) || !Object.is(image[2], c[1]) || !Object.is(image[3], c[2])
          || !Object.is(image[4], c[3]) || !Object.is(image[5], c[4]))
          throw new Error(`collision host differential: ${actor.name ?? actor.id} cylinder from its image (${Array.from(image.subarray(1, 6))}) differs from the JavaScript's (${kind === C_CYLINDER ? Array.from(c.subarray(0, 5)) : 'a brush'})`);
        kernelStats.checked++;
      } else if (image[0] === 2)
        throw new Error(`collision host differential: ${actor.name ?? actor.id} is a brush with an owner in the image, the JavaScript's answer is ${kind}`);
      image[0] = 0;
    }
    if (kind === C_CYLINDER) this.consider(id, actor);
  }
  /** The import has set a mover brush's ToWorld (`coords`, from `values`' pose) and model address: COLLISION_HOST=verify
   * compares them with the memo's answer (before the import), and the memo takes this pose and ToWorld. */
  checkBrush(id, actor, values, coords, base) {
    let image = this.image;
    if (image.length === 0) { this.views(); image = this.image; }
    if (this.verify) {
      if (image[0] === 2) {
        const brush = this.brush;
        let same = image[1] === base;
        for (let i = 0; i < 12 && same; i++) same = Object.is(brush[i], coords[i]);
        if (!same) throw new Error(`collision host differential: ${actor.name ?? actor.id} ToWorld from its memo (${Array.from(brush)}, model ${image[1]}) differs from the JavaScript's (${Array.from(coords)}, model ${base})`);
        kernelStats.checked++;
      } else if (image[0] === 1)
        throw new Error(`collision host differential: ${actor.name ?? actor.id} is a brush with a cylinder in the image`);
      image[0] = 0;
    }
    let desc = this.desc;
    if (desc.length === 0) { this.views(); desc = this.desc; }
    const flags = desc[DESC * id + 1];
    if (!(flags & D_BRUSH)) {
      // A mover whose pose was not yet in the image's cells when it was registered: examined once, like a cylinder.
      if (flags & D_TRIED) return;
      desc[DESC * id + 1] = flags | D_TRIED;
      const handle = brushImageHandle(actor);
      if (handle === 0) return;
      let record = this.records.get(actor) ?? 0;
      if (record === 0) this.records.set(actor, record = this.alloc(BRUSH_RECORD));
      desc = this.desc.length === 0 ? (this.views(), this.desc) : this.desc;
      desc[DESC * id] = handle;
      desc[DESC * id + 1] |= D_BRUSH;
      desc[DESC * id + 2] = record;
    }
    this.fillBrush(desc[DESC * id + 2], values, coords, base);
  }
  /** The memo record at `record` takes the pose of `values` and its ToWorld. */
  fillBrush(record, values, coords, base) {
    const words = new Uint32Array(this.arena.memory.buffer, record, BRUSH_RECORD / 4);
    const location = values.Location ?? [0, 0, 0], rotation = values.Rotation ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      keyFloat[0] = location[i];
      words[i] = keyBits[0];
      words[3 + i] = rotation[i] >>> 0;
    }
    words[6] = base;
    new Float64Array(this.arena.memory.buffer, record + 32, 12).set(coords);
    words[7] = 1;
  }
  /** COLLISION_HOST=verify: the image's isMover (word 6) or filter answer (word 7) for the import now answering
   * `answer` (0 or 1): 0 none, else 1 + the image's answer. */
  checkAnswer(what, word, answer, actor) {
    let image = this.image;
    if (image.length === 0) { this.views(); image = this.image; }
    const given = image[word];
    if (given === 0) return;
    if (given !== 1 + answer)
      throw new Error(`collision host differential: ${what} of ${actor?.name ?? actor?.id} from the image is ${given - 1}, the JavaScript's ${answer}`);
    image[word] = 0;
    kernelStats.checked++;
  }
  /** RemoveActor's bucket writes for a checked registration. */
  remove(actor, cells) {
    const id = this.ids.get(actor), min = cells.min, max = cells.max;
    this.x.hash_remove(this.h, id, min[0], min[1], min[2], max[0], max[1], max[2]);
    this.ids.delete(actor);
    this.cellsOf.delete(actor);
    if (active) this.pendingIds.push(id);
    else this.releaseId(id);
  }
  /** `id` is free for another registration (and describes nothing: a query in flight may still ask about it until then). */
  releaseId(id) {
    this.actors[id] = null;
    this.freeIds.push(id);
    if (this.imageHost) {
      if (this.desc.length === 0) this.views();
      this.desc[DESC * id] = 0;
      this.desc[DESC * id + 1] = 0;
      this.desc[DESC * id + 2] = 0;
    }
  }
  releaseIds() {
    for (const id of this.pendingIds) this.releaseId(id);
    this.pendingIds.length = 0;
  }
  /** The registered actors a query over `cells` visits, in its order. */
  candidates(cells) {
    const min = cells.min, max = cells.max;
    const n = this.x.hash_candidates(this.h, min[0], min[1], min[2], max[0], max[1], max[2], this.order);
    if (this.words.length === 0) this.views();
    const words = this.words, at = this.order >>> 2, actors = this.actors, result = new Array(n);
    for (let i = 0; i < n; i++) result[i] = actors[words[at + i]];
    return result;
  }
  /** A walking-surface scan table (hash.rs lc_scan): per node of `model`,
   * for textureForHit's texture of a world hit on it,
   * `textures[model.nodes[item].surface] ?? null`: bit 0 when it stops the
   * scan (its outerName null or 'Ladder'), bit 1 when the prelude's ladder
   * test takes the branch (outerName lowercased 'ladder') or throws, where
   * the floor is not queried. Surface records never change once decoded,
   * so the table is built once per texture list. A tracked Level->Model's
   * nodes change with the tracker (bsp-occlusion.mjs collisionModel): its
   * table, at the tracker's node capacity, is filled again for each
   * generation from the node block's iSurf words. */
  surfaceTable(model, textures) {
    let entry = this.tables.get(textures);
    if (model.trackedSource) return this.trackedSurfaceTable(model, textures, entry);
    if (entry === undefined || entry.model !== model) {
      const nodes = model.nodes, base = this.alloc(Math.max(1, nodes.length));
      const bytes = new Uint8Array(this.arena.memory.buffer, base, nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        const texture = textures[nodes.surface(i)] ?? null;
        let ladder;
        try { ladder = texture?.outerName?.toLowerCase() === 'ladder'; } catch { ladder = true; }
        bytes[i] = (texture && (texture.outerName === null || texture.outerName === 'Ladder') ? 1 : 0) | (ladder ? 2 : 0);
      }
      this.tables.set(textures, entry = {model, base});
    }
    return entry.base;
  }
  trackedSurfaceTable(model, textures, entry) {
    const source = model.trackedSource, count = source.count(), generation = source.generation();
    if (entry === undefined || entry.model !== model) {
      entry = {model, base: this.alloc(Math.max(1, source.capacity)), generation: -1, count: -1, bySurface: new Map()};
      this.tables.set(textures, entry);
    }
    if (entry.generation !== generation || entry.count !== count) {
      const bytes = new Uint8Array(this.arena.memory.buffer, entry.base, count);
      const iSurf = new Int32Array(source.memory.buffer, source.at, 16 * count);
      for (let i = 0; i < count; i++) {
        const surface = iSurf[16 * i + 7];
        let byte = entry.bySurface.get(surface);
        if (byte === undefined) {
          const texture = textures[surface] ?? null;
          let ladder;
          try { ladder = texture?.outerName?.toLowerCase() === 'ladder'; } catch { ladder = true; }
          entry.bySurface.set(surface, byte = (texture && (texture.outerName === null || texture.outerName === 'Ladder') ? 1 : 0) | (ladder ? 2 : 0));
        }
        bytes[i] = byte;
      }
      entry.generation = generation;
      entry.count = count;
    }
    return entry.base;
  }
  /** The level BSP's kernel address (uploaded on first use), 0 where the
   * trace kernel leaves the model to JavaScript. A tracked Level->Model
   * (bsp-occlusion.mjs collisionModel) is asked every time: its import
   * follows the tracker's generation. */
  world(model) {
    if (model !== this.worldModel || model.trackedSource) {
      this.worldModel = model;
      this.worldBase = this.kernel.base(model);
    }
    return this.worldBase;
  }
}

// The line check in flight (at most one: a nested one runs in JavaScript).
let active = false;
let query = null;

const classFlags = [['LevelInfo', 4], ['Pawn', 1], ['Mover', 2], ['ZoneInfo', 8]];

// hash.rs's imports: the reference's reads, in its order.
const lineCheckHost = {
  /** level-queries.mjs's primitive callback up to its primitive: the
   * candidate's values, then its brush model and ToWorld (modelLineCheck,
   * traceRay/traceExtent's kernel entry) or its cylinder
   * (primitiveLineHit's arguments and their conversions). */
  candidate(id) {
    kernelStats.candidates++;
    const q = query, store = q.store, actor = store.actors[id], values = q.valuesOf(actor);
    if (STATS_ON) tallyImport(store, id, actor);
    if (actor.model) {
      const model = actor.model;
      const coords = values && q.brushToWorld(values);
      const kernel = store.kernel, base = kernel.base(model);
      if (base === 0) return C_FALLBACK;
      if (store.cand.length === 0) store.views();
      store.cand[5] = base;
      if (coords) {
        if (!kernel.setOwner(coords)) return C_FALLBACK;
        if (store.imageHost) store.checkBrush(id, actor, values, coords, base);
        return C_BRUSH_OWNED;
      }
      if (store.imageHost) store.checkCandidate(C_BRUSH, actor, id);
      return C_BRUSH;
    }
    const location = values.Location, radius = values.CollisionRadius ?? 0, height = values.CollisionHeight ?? 0;
    if (store.cand.length === 0) store.views();
    const c = store.cand;
    c[0] = location[0]; c[1] = location[1]; c[2] = location[2]; c[3] = radius; c[4] = height;
    if (store.imageHost) store.checkCandidate(C_CYLINDER, actor, id);
    return C_CYLINDER;
  },
  /** multiLineCheck's isMover(actorHit.actor). */
  mover(id) {
    kernelStats.movers++;
    const q = query, store = q.store, answer = q.isA(store.actors[id], 'Mover') ? 1 : 0;
    if (store.verify) store.checkAnswer('isMover', 6, answer, store.actors[id]);
    return answer;
  },
  /** singleLineCheck's test of one candidate: the owner chain, the class
   * flags and the live collision bits. */
  accept(id) {
    kernelStats.accepts++;
    const q = query, answer = accepted(q, id);
    if (q.store.verify) q.store.checkAnswer('filter', 7, answer, id === -1 ? q.world : q.store.actors[id]);
    return answer;
  },
};
// COLLISION_STATS=1 also times the imports (kernelStats.ms: milliseconds in candidate, mover and accept, nested time included).
const clock = () => (globalThis.__realNow ?? performance.now.bind(performance))();
const timedHost = host => {
  const timed = {};
  for (const name of Object.keys(host)) timed[name] = function (id) {
    const start = clock();
    try { return host[name](id); } finally { kernelStats.ms[name] += clock() - start; }
  };
  return timed;
};
kernelStats.ms = {candidate: 0, mover: 0, accept: 0};
// COLLISION_STATS=1: the candidate imports a runtime's hash still makes, by why (kernelStats.rest).
const STATS_ON = env?.COLLISION_STATS === '1';
kernelStats.rest = {};
function tallyImport(store, id, actor) {
  let why;
  if (!store.imageHost) why = 'trace kernel instance';
  else {
    const flags = store.desc[DESC * id + 1];
    why = flags & D_IMAGE ? 'image declined' : flags & D_BRUSH ? 'brush memo miss' : actor.model ? 'brush, no image pose'
      : !actor.collisionValues ? 'serialized values' : actor.controlledPlayer || actor.name === 'JCDentonMale' ? 'player' : 'other live cylinder';
  }
  kernelStats.rest[why] = (kernelStats.rest[why] ?? 0) + 1;
}
setLineCheckHost(env?.COLLISION_STATS === '1' ? timedHost(lineCheckHost) : lineCheckHost);

/** The filter's answer for hit `id` (u32::MAX, the world hit, arrives as a signed -1): lc_accept's body. */
function accepted(q, id) {
  const flags = q.flags, actor = id === -1 ? q.world : q.store.actors[id];
  for (let owner = q.source; owner; owner = owner.owner) if (owner === actor) return 0;
  let recognized = false;
  for (const [kind, required] of classFlags) {
    if (!q.isA(actor, kind)) continue;
    if (!(flags & required)) return 0;
    recognized = true;
    break;
  }
  if (!recognized) {
    if (!(flags & 0x10)) return 0;
    const bits = actor.collisionBits;
    if (flags & 0x20 && !(bits & 0x10) && (bits & 0x0c) !== 0x0c) return 0;
  }
  return 1;
}

const three = v => Array.isArray(v) && v.length === 3 && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'number';

/** Line checks for createLevelQueries answered by hash.rs; `undefined`
 * where the JavaScript answers. */
export function createKernelLineChecks({store, model: staticModel, worldModel = () => staticModel, levelInfo, valuesOf, isA, brushToWorld}) {
  const context = {store, valuesOf, isA, brushToWorld, source: null, flags: 0, world: null};
  // lc_line on the kernel: its status. Only one runs at a time (see
  // `active`), and a nested one runs in JavaScript. In the trace kernel's
  // instance no other frame is live under it, and in a runtime's the frames
  // below are the interpreter's, so the shadow stack pointer is what it was
  // when the call began: an import that throws leaves the stack pointer
  // lowered, and `finish` puts it back, and the flags.
  let stackPointer = 0;
  function start(source, flags, worldActor) {
    active = true;
    query = context;
    context.source = source;
    context.flags = flags;
    context.world = worldActor;
    stackPointer = store.x.__stack_pointer.value;
    kernelStats.queries++;
    if (store.imageHost) describeQuery(source, flags, worldActor);
  }
  // hash.rs's context for the filter tests it answers from the descriptors (CTX): the flags, whether the world actor
  // is on the source's owner chain, and the registration ids of the chain's other members (accept's first test is
  // `owner === actor` for each owner of the source, itself first). The chain is walked once here instead of once
  // per examined hit: no script runs in a query, so it does not change in one. A getter that throws, or a chain
  // longer than the table, leaves the tests to the import (which walks it as the reference does).
  function describeQuery(source, flags, worldActor) {
    let ctx = store.ctx;
    if (ctx.length === 0) { store.views(); ctx = store.ctx; }
    const ids = store.ids;
    let count = 0, worldOn = 0, valid = 1;
    try {
      let steps = 0;
      for (let owner = source; owner; owner = owner.owner) {
        if (++steps > CTX_CHAIN_MAX) { valid = 0; break; }
        if (owner === worldActor) worldOn = 1;
        const id = ids.get(owner);
        if (id !== undefined) ctx[CTX_CHAIN + count++] = id;
      }
    } catch { valid = 0; }
    ctx[1] = flags;
    ctx[2] = worldOn;
    ctx[3] = count;
    ctx[0] = valid;
  }
  // After lc_line and the answer's hit objects (its ids name their actors
  // until here).
  function finish(status) {
    active = false;
    query = null;
    context.source = null;
    context.world = null;
    const ctx = store.ctx;
    if (store.imageHost && ctx.length) ctx[0] = 0;
    if (status === -1) {
      // An import threw through the Rust frames.
      store.x.__stack_pointer.value = stackPointer;
      store.image.fill(0);
      const words = store.header();
      words[H_QUERYING] = 0;
      words[H_BUSY] = 0;
    } else if (status === ANSWERED) kernelStats.answered++;
    else kernelStats.handedBack++;
    if (store.deferred.length) store.releaseDeferred();
    if (store.pendingIds.length) store.releaseIds();
  }
  const free = () => {
    const hw = store.header();
    return !active && hw[H_QUERYING] === 0 && hw[H_BUSY] === 0;
  };
  // A lineCheck result's fields textureForHit and WalkTexture read, from a
  // scan record (actor -2: no hit accepted).
  // The scan's answer is written into these (a result, a selected hit and a floor hit with their vectors, for each scan of each walking
  // pawn): valid until the next surfaceScan; walkingSurfacePrelude reads them at once, and WalkTexture's script event copies its arguments.
  const scanResult = {index: 0, selected: null, floor: null};
  const scanSlots = [{actor: null, item: undefined, location: [0, 0, 0], normal: [0, 0, 0]}, {actor: null, item: undefined, location: [0, 0, 0], normal: [0, 0, 0]}];
  function scanHit(answer, at, world, slot) {
    const id = answer[at + 9], kind = answer[at + 10], hit = scanSlots[slot], location = hit.location, normal = hit.normal;
    hit.actor = id === -2 ? null : id === -1 ? world : store.actors[id];
    hit.item = id !== -2 && (kind === WORLD_RAY || kind === BRUSH_RAY) ? answer[at + 7] : undefined;
    location[0] = answer[at + 1]; location[1] = answer[at + 2]; location[2] = answer[at + 3];
    normal[0] = answer[at + 4]; normal[1] = answer[at + 5]; normal[2] = answer[at + 6];
    return hit;
  }
  // The hit objects of answer records [from, count), linked, as
  // multiLineCheck builds them (world: the query's world actor; model: the
  // Level->Model it traced, level-queries.mjs worldModel).
  function hitObjects(answer, from, count, world, model) {
    const hits = new Array(count - from);
    let next = null;
    for (let i = count - 1; i >= from; i--) {
      const at = 2 + RECORD * i, id = answer[at + 9], kind = answer[at + 10];
      const time = answer[at], location = [answer[at + 1], answer[at + 2], answer[at + 3]];
      const normal = [answer[at + 4], answer[at + 5], answer[at + 6]];
      let hit;
      if (kind === CYLINDER) hit = {outside: false, location, normal, time, actor: store.actors[id], next};
      else {
        const node = answer[at + 7], penetrating = answer[at + 8] !== 0;
        const actor = id === -1 ? world : store.actors[id];
        if (kind === WORLD_RAY) hit = {time, normal, location, node, penetrating, primitive: model, item: node, actor, next};
        else if (kind === BRUSH_RAY) hit = {time, normal, location, node, penetrating, primitive: actor.model, item: node, actor, next};
        else hit = {time, normal, location, node, penetrating, actor, next};
      }
      hits[i - from] = next = hit;
    }
    return hits;
  }
  return {
    /** level-queries.mjs lineCheck: singleLineCheck over multiLineCheck. */
    lineCheck(start_, end, extent, flags, extra, source) {
      if (!three(start_) || !three(end) || !three(extent) || typeof flags !== 'number' || typeof extra !== 'number') return undefined;
      const worldActor = flags & 4 ? levelInfo : null, model = worldModel();
      const world = worldActor ? store.world(model) : 0;
      if (worldActor && world === 0 || !free()) return undefined;
      start(source, flags, worldActor);
      let status = -1;
      try {
        status = store.x.lc_line(store.h, world, start_[0], start_[1], start_[2], end[0], end[1], end[2],
          extent[0], extent[1], extent[2], extra, flags & 0x17 ? 1 : 0, 1);
        if (status !== ANSWERED) return undefined;
        const answer = store.answer.length ? store.answer : (store.views(), store.answer), count = answer[0];
        if (count === 0) return {time: 1, actor: null, location: [0, 0, 0], normal: [0, 0, 0], outside: true};
        const next = count > 1 ? hitObjects(answer, 1, count, worldActor, model)[0] : null;
        // singleLineCheck copies the accepted hit's fields into the result.
        const id = answer[11], kind = answer[12], node = answer[9];
        const actor = id === -1 ? worldActor : store.actors[id];
        const primitive = kind === WORLD_RAY ? model : kind === BRUSH_RAY ? actor.model : undefined;
        const item = kind === WORLD_RAY || kind === BRUSH_RAY ? node : undefined;
        return {time: answer[2], actor, location: [answer[3], answer[4], answer[5]], normal: [answer[6], answer[7], answer[8]],
          next, primitive, item, outside: false};
      } finally {
        finish(status);
      }
    },
    /** lineCheck for a caller that reads only `outside` and `actor` (corona-scan's visibility helper): the same lc_line call and
     * the accepted hit's actor from its record, with no hit object (a lineCheck result is an object, two vectors and a chain of
     * hit objects). Sets `into.outside` and `into.actor` and returns true, or returns false where lineCheck answers
     * `undefined` and the JavaScript line check runs instead. */
    probe(into, start_, end, extent, flags, extra, source) {
      if (!three(start_) || !three(end) || !three(extent) || typeof flags !== 'number' || typeof extra !== 'number') return false;
      const worldActor = flags & 4 ? levelInfo : null, model = worldModel();
      const world = worldActor ? store.world(model) : 0;
      if (worldActor && world === 0 || !free()) return false;
      start(source, flags, worldActor);
      let status = -1;
      try {
        status = store.x.lc_line(store.h, world, start_[0], start_[1], start_[2], end[0], end[1], end[2],
          extent[0], extent[1], extent[2], extra, flags & 0x17 ? 1 : 0, 1);
        if (status !== ANSWERED) return false;
        const answer = store.answer.length ? store.answer : (store.views(), store.answer);
        if (answer[0] === 0) { into.outside = true; into.actor = null; return true; }
        const id = answer[11];
        into.outside = false;
        into.actor = id === -1 ? worldActor : store.actors[id];
        return true;
      } finally {
        finish(status);
      }
    },
    /** walking-surface.mjs's scan and floor queries (see lc_scan), for a
     * pawn whose lineCheck is `lineCheck(a, b, [0, 0, 0], 6, 0, source)` here
     * and whose textureForHit reads `textures[textureModel.nodes[hit.item]
     * .surface] ?? null` for hits on `worldActor`. Returns the last scan
     * query's and the floor query's hits as {actor, item, location, normal}
     * (all textureForHit and the WalkTexture dispatch read; the floor null
     * where the ladder branch will not ask for it), `index` the last scan
     * query run; undefined for the JavaScript scan. */
    surfaceScan(start_, ends, position, floorEnd, source, textureModel, textures, worldActor) {
      const model = worldModel();
      if (SCAN_JS_ONLY || textureModel !== model || worldActor !== levelInfo || !levelInfo || store.ids.has(levelInfo) || !Array.isArray(textures)
        || !three(start_) || !three(position) || !three(floorEnd) || !Array.isArray(ends) || ends.length !== 4) return undefined;
      for (const end of ends) if (!Array.isArray(end) || typeof end[0] !== 'number' || typeof end[1] !== 'number') return undefined;
      const world = store.world(model);
      if (world === 0 || !free()) return undefined;
      const table = store.surfaceTable(model, textures);
      start(source, 6, levelInfo);
      let status = -1;
      try {
        status = store.x.lc_scan(store.h, world, table, start_[0], start_[1], start_[2], ends[0][0], ends[0][1], ends[1][0], ends[1][1],
          ends[2][0], ends[2][1], ends[3][0], ends[3][1], position[0], position[1], position[2], floorEnd[2]);
        if (status !== ANSWERED) return undefined;
        const answer = store.answer.length ? store.answer : (store.views(), store.answer);
        scanResult.index = answer[0];
        scanResult.selected = scanHit(answer, 2, levelInfo, 0);
        scanResult.floor = answer[1] ? scanHit(answer, 2 + RECORD, levelInfo, 1) : null;
        return scanResult;
      } finally {
        finish(status);
      }
    },
    /** level-queries.mjs multiLineCheck. */
    multiLineCheck({end, start: start_, extent, checkActors, worldActor, extra = 0}) {
      if (!three(start_) || !three(end) || !three(extent) || typeof extra !== 'number') return undefined;
      const model = worldModel(), world = worldActor ? store.world(model) : 0;
      if (worldActor && world === 0 || !free()) return undefined;
      start(null, 0, worldActor);
      let status = -1;
      try {
        status = store.x.lc_line(store.h, world, start_[0], start_[1], start_[2], end[0], end[1], end[2],
          extent[0], extent[1], extent[2], extra, checkActors ? 1 : 0, 0);
        if (status !== ANSWERED) return undefined;
        const answer = store.answer.length ? store.answer : (store.views(), store.answer);
        return hitObjects(answer, 0, answer[0], worldActor, model);
      } finally {
        finish(status);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Differential checks.

const exact = (key, v) => typeof v === 'number' && (Object.is(v, -0) || !Number.isFinite(v)) ? (Object.is(v, -0) ? '-0' : String(v)) : v;
const describe = v => v && typeof v === 'object' ? (v.name ?? v.id ?? v.key ?? (v.nodes?.length !== undefined ? '<model>' : '<object>')) : v;

/** Two line-check results (a hit, an array of hits, or a lineCheck result)
 * equal: the same keys in the same order, numbers by Object.is, vectors
 * element by element, `next` chains recursively, and every other object
 * (actors, models) by identity. Returns a path to the first difference or
 * null. */
export function lineResultDifference(a, b, path = '') {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path} array`;
    if (a.length !== b.length) return `${path}.length ${a.length} ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = typeof a[i] === 'number' || typeof b[i] === 'number'
        ? (Object.is(a[i], b[i]) ? null : `${path}[${i}] ${exact(0, a[i])} ${exact(0, b[i])}`)
        : lineResultDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? null : `${path} ${describe(a)} ${describe(b)}`;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.join() !== kb.join()) return `${path} keys ${ka.join()} | ${kb.join()}`;
  for (const key of ka) {
    const u = a[key], v = b[key];
    let d;
    if (typeof u === 'number' || typeof v === 'number') d = Object.is(u, v) ? null : `${path}.${key} ${exact(0, u)} ${exact(0, v)}`;
    else if (key === 'next' || key === 'location' || key === 'normal') d = lineResultDifference(u, v, `${path}.${key}`);
    else d = u === v ? null : `${path}.${key} ${describe(u)} ${describe(v)}`;
    if (d) return d;
  }
  return null;
}

/** HASH_DIFFERENTIAL / TRACE_DIFFERENTIAL: the JavaScript path must answer
 * as the kernel did. */
export function checkLineKernel(name, result, reference, inputs) {
  let expected;
  try {
    expected = reference();
  } catch (error) {
    throw new Error(`${name} collision kernel differential: the JavaScript throws (${error.message}) where the kernel answers; ${JSON.stringify(inputs, exact)}`);
  }
  kernelStats.compared++;
  const difference = lineResultDifference(result, expected);
  if (difference !== null) throw new Error(`${name} collision kernel differential mismatch at${difference}; ${JSON.stringify(inputs, exact)}`);
}

/** HASH_DIFFERENTIAL: a hash with createCollisionHash's interface whose
 * buckets are the Rust store's (`kernel`) and that keeps a JavaScript hash
 * (`reference`) beside it: every registration change runs on both, with
 * the same result or error, and every query's visit order is compared
 * before the kernel hash runs its callbacks. */
export function createDifferentialHash(kernel, reference) {
  const same = (name, run) => {
    let result, error, expected, expectedError;
    try { result = run(kernel); } catch (e) { error = e; }
    try { expected = run(reference); } catch (e) { expectedError = e; }
    if (error || expectedError) {
      if (!error || !expectedError || error.message !== expectedError.message || error.constructor !== expectedError.constructor)
        throw new Error(`hash differential: ${name} ${error ? `throws ${error.message}` : 'answers'} where the JavaScript hash ${expectedError ? `throws ${expectedError.message}` : 'answers'}`);
      throw error;
    }
    return [result, expected];
  };
  const order = (name, run) => {
    const [actual, expected] = same(name, run);
    kernelStats.orders++;
    if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i]))
      throw new Error(`hash differential: ${name} visits ${actual.map(describe).join(',')} where the JavaScript hash visits ${expected.map(describe).join(',')}`);
  };
  return {
    mode: kernel.mode,
    kernel, reference,
    addActor(...args) {
      const [result, expected] = same('addActor', hash => hash.addActor(...args));
      if (JSON.stringify(result) !== JSON.stringify(expected)) throw new Error('hash differential: addActor results differ');
      return result;
    },
    removeActor(...args) {
      const [result, expected] = same('removeActor', hash => hash.removeActor(...args));
      if (result !== expected) throw new Error('hash differential: removeActor results differ');
      return result;
    },
    actorPointCheck({position, extent = [0, 0, 0]}, primitivePointCheck) {
      return this.actorLineCheck({start: position, end: position, extent, extraNodeFlags: 0},
        (actor, args) => primitivePointCheck(actor, {position: args.start, extent: args.extent, extraNodeFlags: 0}));
    },
    actorEncroachmentCheck(query, primitiveCheck) {
      order('actorEncroachmentCheck', hash => hash.boundsCandidates(query));
      return kernel.actorEncroachmentCheck(query, primitiveCheck);
    },
    actorLineCheck(query, primitiveLineCheck) {
      order('actorLineCheck', hash => hash.lineCandidates(query));
      return kernel.actorLineCheck(query, primitiveLineCheck);
    },
    lineCandidates: query => kernel.lineCandidates(query),
    boundsCandidates: query => kernel.boundsCandidates(query),
  };
}
