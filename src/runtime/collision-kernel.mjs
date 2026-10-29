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
 * traceExtent. */
import {traceKernel, setLineCheckHost, TRACE_DIFFERENTIAL} from './trace-kernel.mjs';

const env = typeof process !== 'undefined' ? process.env : undefined;
export const HASH_JS_ONLY = env?.HASH_KERNEL === 'js';
export const HASH_DIFFERENTIAL = env?.HASH_DIFFERENTIAL === '1';
// SCAN_KERNEL=js keeps walking-surface.mjs's scan in JavaScript (its queries
// still go to the kernel line checks).
const SCAN_JS_ONLY = env?.SCAN_KERNEL === 'js';

// hash.rs Header words.
const H_KEYS = 0, H_HEADS = 1, H_TABLE_CAP = 2, H_TABLE_USED = 3, H_LINK_REG = 4, H_LINK_NEXT = 5, H_LINK_CAP = 6,
  H_LINKS_LIVE = 9, H_STAMPS = 10, H_REG_CAP = 11, H_QUERYING = 13, H_BUSY = 14, H_SCRATCH = 15, H_CACHE = 17;
// Header, Hit and Cached sizes (hash.rs).
const HEADER = 80, HIT = 80, CACHED = 80, RECORD = 11;
// lc_candidate answers and hit kinds (hash.rs).
const C_CYLINDER = 0, C_BRUSH_OWNED = 1, C_BRUSH = 2, C_FALLBACK = 3;
const WORLD_RAY = 0, WORLD_EXTENT = 1, CYLINDER = 2, BRUSH_RAY = 3, BRUSH_EXTENT = 4;
const ANSWERED = 0;

export const kernelStats = {queries: 0, answered: 0, handedBack: 0, compared: 0, orders: 0, stores: 0, candidates: 0, movers: 0, accepts: 0};
if (HASH_DIFFERENTIAL || TRACE_DIFFERENTIAL) process.on('exit', () => {
  const s = kernelStats;
  console.error(`collision kernel differential: ${s.answered} line checks and scans answered in Rust, ${s.compared} compared, ${s.handedBack} handed back; ${s.orders} hash visit orders compared; ${s.stores} hashes; imports: ${s.candidates} candidate, ${s.movers} isMover, ${s.accepts} filter`);
});

/** A level's hash buckets in the trace kernel's arena, or null (the
 * JavaScript hash): the kernel is not loaded, or HASH_KERNEL=js. */
export function kernelHashStore() {
  if (HASH_JS_ONLY || traceKernel === null) return null;
  return new KernelHashStore(traceKernel);
}

// A store's ranges, released once the store is collected (no kernel call
// holds them then).
const storeRanges = new FinalizationRegistry(({arena, ranges}) => {
  for (const [base, size] of ranges) arena.release(base, size);
  arena.reclaim();
});

class KernelHashStore {
  constructor(kernel) {
    this.kernel = kernel;
    this.x = kernel.x;
    this.arena = kernel.arena;
    this.ids = new Map();
    this.actors = [];
    this.freeIds = [];
    // Ids removed while a line check is in flight: its answer still names
    // them, so they keep their actor until it returns.
    this.pendingIds = [];
    this.ranges = new Map();
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
    this.views();
    storeRanges.register(this, {arena: this.arena, ranges: this.ranges});
    kernelStats.stores++;
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
    this.arena.reclaim();
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
      const oldStamps = hw[H_STAMPS], oldScratch = hw[H_SCRATCH], oldCache = hw[H_CACHE], oldOrder = this.order;
      const stamps = this.alloc(cap * 4), scratch = this.alloc(cap * HIT), cache = this.alloc(cap * CACHED);
      this.order = this.alloc(cap * 4);
      this.x.hash_regs(this.h, stamps, scratch, cache, cap);
      this.free(oldStamps); this.free(oldOrder);
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
    this.x.hash_add(this.h, id, min[0], min[1], min[2], max[0], max[1], max[2]);
  }
  /** RemoveActor's bucket writes for a checked registration. */
  remove(actor, cells) {
    const id = this.ids.get(actor), min = cells.min, max = cells.max;
    this.x.hash_remove(this.h, id, min[0], min[1], min[2], max[0], max[1], max[2]);
    this.ids.delete(actor);
    if (active) this.pendingIds.push(id);
    else {
      this.actors[id] = null;
      this.freeIds.push(id);
    }
  }
  releaseIds() {
    for (const id of this.pendingIds) {
      this.actors[id] = null;
      this.freeIds.push(id);
    }
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
setLineCheckHost({
  /** level-queries.mjs's primitive callback up to its primitive: the
   * candidate's values, then its brush model and ToWorld (modelLineCheck,
   * traceRay/traceExtent's kernel entry) or its cylinder
   * (primitiveLineHit's arguments and their conversions). */
  candidate(id) {
    kernelStats.candidates++;
    const q = query, store = q.store, actor = store.actors[id], values = q.valuesOf(actor);
    if (actor.model) {
      const model = actor.model;
      const coords = values && q.brushToWorld(values);
      const kernel = store.kernel, base = kernel.base(model);
      if (base === 0) return C_FALLBACK;
      if (store.cand.length === 0) store.views();
      store.cand[5] = base;
      if (coords) return kernel.setOwner(coords) ? C_BRUSH_OWNED : C_FALLBACK;
      return C_BRUSH;
    }
    const location = values.Location, radius = values.CollisionRadius ?? 0, height = values.CollisionHeight ?? 0;
    if (store.cand.length === 0) store.views();
    const c = store.cand;
    c[0] = location[0]; c[1] = location[1]; c[2] = location[2]; c[3] = radius; c[4] = height;
    return C_CYLINDER;
  },
  /** multiLineCheck's isMover(actorHit.actor). */
  mover(id) {
    kernelStats.movers++;
    const q = query;
    return q.isA(q.store.actors[id], 'Mover') ? 1 : 0;
  },
  /** singleLineCheck's test of one candidate: the owner chain, the class
   * flags and the live collision bits. */
  accept(id) {
    kernelStats.accepts++;
    // The world hit's id, u32::MAX, arrives as a signed i32.
    const q = query, flags = q.flags, actor = id === -1 ? q.world : q.store.actors[id];
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
  },
});

const three = v => Array.isArray(v) && v.length === 3 && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'number';

/** Line checks for createLevelQueries answered by hash.rs; `undefined`
 * where the JavaScript answers. */
export function createKernelLineChecks({store, model: staticModel, worldModel = () => staticModel, levelInfo, valuesOf, isA, brushToWorld}) {
  const x = store.x;
  const context = {store, valuesOf, isA, brushToWorld, source: null, flags: 0, world: null};
  // lc_line on the kernel: its status. Only one runs at a time (see
  // `active`), so no other frame of the instance is live under it and the
  // shadow stack starts at its base: an import that throws leaves the stack
  // pointer lowered, and `finish` puts back the base and the flags.
  function start(source, flags, worldActor) {
    active = true;
    query = context;
    context.source = source;
    context.flags = flags;
    context.world = worldActor;
    kernelStats.queries++;
  }
  // After lc_line and the answer's hit objects (its ids name their actors
  // until here).
  function finish(status) {
    active = false;
    query = null;
    context.source = null;
    context.world = null;
    if (status === -1) {
      // An import threw through the Rust frames.
      x.__stack_pointer.value = stackBase;
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
  const stackBase = store.kernel.stackBase;
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
        status = x.lc_line(store.h, world, start_[0], start_[1], start_[2], end[0], end[1], end[2],
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
        status = x.lc_line(store.h, world, start_[0], start_[1], start_[2], end[0], end[1], end[2],
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
        status = x.lc_scan(store.h, world, table, start_[0], start_[1], start_[2], ends[0][0], ends[0][1], ends[1][0], ends[1][1],
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
        status = x.lc_line(store.h, world, start_[0], start_[1], start_[2], end[0], end[1], end[2],
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
