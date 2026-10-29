/** The Rust BSP trace kernel (native/script-vm/src/trace.rs, docs/rust-core.md
 * step R3-a): traceRay's zero-extent traversal (ray.mjs) and traceExtent's
 * box trace (extent-trace.mjs) over a model's compiled BSP. Both modules call
 * it once it is loaded. Their JavaScript bodies stay the reference: they run
 * before loading and in hosts that never load it (unit tests), and they
 * answer every case the kernel hands back (`undefined` below): inputs or
 * models the JavaScript throws on or reads as non-numbers, and a traversal
 * deeper than the kernel's scratch stacks. scripts/validate-trace-kernel.mjs
 * compares the two on real levels.
 *
 * Loading: prepareFunction awaits loadTraceKernel() beside the script VM
 * kernel, before any script runs. The instance is the script-vm module on its
 * own ObjectArena memory; the module's shadow stack and statics sit in the
 * arena's reserved low 2 MiB, and every model's arrays are one arena range.
 *
 * Model layout (little-endian, 16-byte aligned range):
 *   header  u32 count, u32 rootOutside (0/1), u32 hull-words address,
 *           u32 hull-word count, 16 bytes padding
 *   node[i] f64 plane[4] (the JavaScript numbers, not rounded), i32 front,
 *           i32 back, i32 ToInt32(flags), i32 collisionBound, u32
 *           (vertexCount > 0), 12 bytes padding            (64 bytes)
 *   words   the leafHulls int32 words
 * A link or hull offset the JavaScript would not index with is stored as -2.
 * Models are immutable after decoding; a model's range is uploaded on first
 * use (WeakMap) and released when the model is collected. The one exception
 * is Level->Model as the moving brush tracker holds it (bsp-occlusion.mjs
 * collisionModel, docs/brush-tracker.md "Collision"): one range at the
 * tracker's node capacity, its node block copied raw from the occlusion
 * kernel's memory and converted in place (trace.rs trace_import_bsp)
 * whenever the tracker's generation or node count changed since the last
 * import.
 *
 * TRACE_KERNEL=js keeps the JavaScript path. TRACE_DIFFERENTIAL=1 runs the
 * JavaScript beside every kernel answer and throws on any difference: values
 * by Object.is, and the result's key order. */
import {compileScriptVm} from './script-vm-kernel.mjs';
import {ObjectArena, RESERVED} from './script-object-arena.mjs';
import {rotationSineTable} from './coords.mjs';
import { NodeAccess } from '../unreal/bsp-model.mjs';

const env = typeof process !== 'undefined' ? process.env : undefined;
const JS_ONLY = env?.TRACE_KERNEL === 'js';
export const TRACE_DIFFERENTIAL = env?.TRACE_DIFFERENTIAL === '1';

const HEADER = 32, NODE = 64, INVALID = -2;
const MISS = 0, HIT = 1;
const f = Math.fround;

/** The loaded kernel, or null (the JavaScript path). */
export let traceKernel = null;
let pending = null;

/** Load the kernel once; later calls return the same promise. */
export function loadTraceKernel() {
  if (JS_ONLY) return Promise.resolve(null);
  return pending ??= load().then(kernel => (traceKernel = kernel));
}

// The level queries' callbacks (native/script-vm/src/hash.rs), answered by
// the query in flight (collision-kernel.mjs sets the host).
let lineCheckHost = null;
export const setLineCheckHost = host => { lineCheckHost = host; };
const lineCheckImports = {
  lc_candidate: id => lineCheckHost.candidate(id),
  lc_mover: id => lineCheckHost.mover(id),
  lc_accept: id => lineCheckHost.accept(id),
};

async function load() {
  const module = await compileScriptVm();
  const arena = new ObjectArena();
  // This instance runs no scripts: every other function the module imports
  // (the interpreter's) is a host fault here.
  const imports = {memory: arena.memory};
  for (const {module: from, name, kind} of WebAssembly.Module.imports(module)) {
    if (from === 'env' && kind === 'function') imports[name] = lineCheckImports[name] ?? (() => {
      throw new Error(`The trace kernel instance does not run scripts (${name})`);
    });
  }
  const instance = await WebAssembly.instantiate(module, {env: imports});
  if (instance.exports.__heap_base.value > RESERVED) throw new Error('Script VM statics exceed the object arena\'s reserved region');
  const kernel = new TraceKernel(instance.exports, arena);
  if (TRACE_DIFFERENTIAL) process.on('exit', () => {
    const s = kernel.stats;
    console.error(`trace kernel differential: ${s.ray} rays, ${s.extent} extents compared; ${s.fallback} handed back; ${s.models} models uploaded, ${s.ineligible} left to JavaScript; ${s.bounds} brush boxes compared (brush-bounds.mjs), ${s.boundsFallback} handed back`);
  });
  return kernel;
}

const ZERO3 = [0, 0, 0];
/** Three plain numbers (int32 when `integer`) into `into[at..at+3]`. */
function triple(v, into, at, integer) {
  if (!Array.isArray(v) || v.length !== 3) return false;
  for (let k = 0; k < 3; k++) {
    const x = v[k];
    if (typeof x !== 'number' || (integer && (!Number.isInteger(x) || x < -0x80000000 || x > 0x7fffffff))) return false;
    into[at + k] = x;
  }
  return true;
}
/** A brush scale record (`{scale, shearRate, shearAxis}`, every field optional) into `into[at..at+5]`. */
function scaleFields(value, into, at) {
  if (value === undefined) value = {};
  if (typeof value !== 'object' || value === null) return false;
  const rate = value.shearRate ?? 0, axis = value.shearAxis ?? 0;
  if (typeof rate !== 'number' || typeof axis !== 'number') return false;
  if (!triple(value.scale ?? ONE3, into, at, false)) return false;
  into[at + 3] = rate; into[at + 4] = axis;
  return true;
}
const ONE3 = [1, 1, 1];
const finite3 = v => !!v && v.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

/** trace.rs's model layout for `model` (header, 64-byte nodes, leaf-hull
 * words): its byte size and a writer into a Wasm memory at a base, or null
 * when the model is not eligible (the JavaScript answers its traces). The
 * trace kernel instance and the script-VM kernel instance (decal-kernel.mjs)
 * both write it. */
export function traceModelLayout(model) {
  const nodes = model?.nodes;
  if (!(nodes instanceof NodeAccess) || !nodes.length || model.rootOutside === undefined) return null;
  const count = nodes.length;
  // The node block holds only float32 planes and bytes: every node is eligible. Hull words are int32 by construction
  // (before the typed tables, words that were not were not uploaded and every hull read as out of range).
  const words = model.leafHulls;
  const wordCount = words instanceof Int32Array ? words.length : 0;
  const size = HEADER + count * NODE + wordCount * 4;
  return {size, write(buffer, base) {
    const wordsAt = base + HEADER + count * NODE;
    const header = new Uint32Array(buffer, base, HEADER / 4);
    header[0] = count; header[1] = model.rootOutside ? 1 : 0; header[2] = wordsAt; header[3] = wordCount;
    const planes = new Float64Array(buffer, base + HEADER, count * NODE / 8);
    const ints = new Int32Array(buffer, base + HEADER, count * NODE / 4);
    const link = v => v === -1 ? -1 : Number.isInteger(v) && v >= 0 && v < count ? v : INVALID;
    for (let i = 0; i < count; i++) {
      const at = i * (NODE / 8), w = i * (NODE / 4) + 8, o = nodes.base + (i << 4);
      planes[at] = nodes.f32[o]; planes[at + 1] = nodes.f32[o + 1]; planes[at + 2] = nodes.f32[o + 2]; planes[at + 3] = nodes.f32[o + 3];
      const bound = nodes.collisionBound(i);
      ints[w] = link(nodes.front(i));
      ints[w + 1] = link(nodes.back(i));
      ints[w + 2] = nodes.flags(i);
      ints[w + 3] = bound === -1 ? -1 : Number.isInteger(bound) && bound >= 0 && bound < wordCount ? bound : INVALID;
      ints[w + 4] = nodes.vertexCount(i) > 0 ? 1 : 0;
    }
    if (wordCount) new Int32Array(buffer, wordsAt, wordCount).set(words);
  }};
}

class TraceKernel {
  constructor(exports, arena) {
    this.x = exports;
    this.arena = arena;
    // The shadow stack's base, where a call from JavaScript starts
    // (collision-kernel.mjs restores it after an import throws).
    this.stackBase = exports.__stack_pointer.value;
    this.models = new WeakMap();
    this.lastModel = null;
    this.lastBase = 0;
    // No kernel call is in flight when a finalizer runs, so the range is
    // reusable at once.
    this.registry = new FinalizationRegistry(({base, size}) => { arena.release(base, size); arena.reclaim(); });
    this.stats = {ray: 0, extent: 0, fallback: 0, models: 0, ineligible: 0, imports: 0, bounds: 0, boundsFallback: 0};
    // Tracked models (collisionModel objects) -> {base, wordsAt, wordCount, generation, count}.
    this.trackedModels = new WeakMap();
    this.views();
    // Core FGlobalMath's float32 sine table (coords.mjs), for bounds.rs's ToWorld.
    new Uint32Array(this.arena.memory.buffer, exports.sine_ptr(), 0x4000).set(new Uint32Array(rotationSineTable().buffer));
  }
  /** Re-derive the result and owner views after the memory grew. */
  views() {
    const buffer = this.arena.memory.buffer;
    this.out = new Float64Array(buffer, this.x.trace_out_ptr(), 9);
    this.owner = new Float64Array(buffer, this.x.trace_owner_ptr(), 12);
    this.boundsIn = new Float64Array(buffer, this.x.bounds_in_ptr(), 25);
    this.boundsOut = new Float64Array(buffer, this.x.bounds_out_ptr(), 6);
  }
  /** UModel::GetCollisionBoundingBox of an owned brush (brush-bounds.mjs): the
   * world box of `model` at the pose `owner` holds, or undefined for the
   * JavaScript reference to answer (an owner field that is not the plain numbers
   * the reference reads, or a case bounds.rs hands back). */
  brushBounds(model, owner) {
    const bounds = model?.bounds;
    if (!bounds) return undefined;
    const i = this.boundsIn;
    if (!triple(bounds.min, i, 19, false) || !triple(bounds.max, i, 22, false)) return undefined;
    if (!triple(owner.Location ?? ZERO3, i, 0, false) || !triple(owner.Rotation ?? ZERO3, i, 3, true) ||
      !triple(owner.PrePivot ?? ZERO3, i, 16, false)) return undefined;
    if (!scaleFields(owner.PostScale, i, 6) || !scaleFields(owner.MainScale, i, 11)) return undefined;
    if (this.x.brush_bounds() !== 1) { this.stats.boundsFallback++; return undefined; }
    this.stats.bounds++;
    const o = this.boundsOut;
    return {min: [o[0], o[1], o[2]], max: [o[3], o[4], o[5]], valid: true};
  }
  /** The model's range, uploading it on first use; 0 leaves it to JavaScript. */
  base(model) {
    if (model?.trackedSource) return this.tracked(model);
    if (model === this.lastModel) return this.lastBase;
    if (typeof model !== 'object' || model === null) return 0;
    let base = this.models.get(model);
    if (base === undefined) this.models.set(model, base = this.upload(model));
    this.lastModel = model;
    this.lastBase = base;
    return base;
  }
  upload(model) {
    const layout = traceModelLayout(model);
    if (!layout) return this.ineligible();
    const base = this.arena.alloc(layout.size);
    this.views();
    layout.write(this.arena.memory.buffer, base);
    this.registry.register(model, {base, size: layout.size});
    this.stats.models++;
    return base;
  }
  /** A tracked Level->Model's range, imported again when the tracker
   * rebuilt a mover since the last import; 0 leaves it to JavaScript. */
  tracked(model) {
    const source = model.trackedSource, count = source.count(), generation = source.generation();
    let entry = this.trackedModels.get(model);
    if (entry === undefined) {
      if (model.rootOutside === undefined || !(source.capacity > 0)) return this.ineligible();
      // traceModelLayout's hull rule: words that are not all int32 are not uploaded.
      const words = model.leafHulls, wordCount = words instanceof Int32Array ? words.length : 0;
      const size = HEADER + source.capacity * NODE + wordCount * 4, base = this.arena.alloc(size);
      this.views();
      const wordsAt = base + HEADER + source.capacity * NODE;
      if (wordCount) new Int32Array(this.arena.memory.buffer, wordsAt, wordCount).set(words);
      entry = {base, wordsAt, wordCount, generation: -1, count: -1};
      this.trackedModels.set(model, entry);
      this.registry.register(model, {base, size});
      this.stats.models++;
    }
    if (entry.generation !== generation || entry.count !== count) {
      if (count === 0 || count > source.capacity) return 0;
      new Uint8Array(this.arena.memory.buffer, entry.base + HEADER, count * NODE)
        .set(new Uint8Array(source.memory.buffer, source.at, count * NODE));
      this.x.trace_import_bsp(entry.base, count, model.rootOutside ? 1 : 0, entry.wordsAt, entry.wordCount);
      entry.generation = generation;
      entry.count = count;
      this.stats.imports++;
    }
    return entry.base;
  }
  ineligible() {
    this.stats.ineligible++;
    return 0;
  }
  setOwner(coords) {
    if (coords.length !== 12) return false;
    const owner = this.owner;
    for (let i = 0; i < 12; i++) {
      const v = coords[i];
      if (typeof v !== 'number') return false;
      owner[i] = v;
    }
    return true;
  }
  result() {
    const o = this.out;
    return {time: o[0], normal: [o[1], o[2], o[3]], location: [o[4], o[5], o[6]], node: o[7], penetrating: o[8] !== 0};
  }
  /** traceRay's result, or undefined for the JavaScript to answer. */
  ray(model, start, end, extraNodeFlags, ownerCoords) {
    const base = this.base(model);
    if (base === 0 || !start || !end) return undefined;
    let owned = 0;
    if (ownerCoords) {
      if (!this.setOwner(ownerCoords)) return undefined;
      owned = 1;
    }
    this.stats.ray++;
    const status = this.x.trace_ray(base, start[0], start[1], start[2], end[0], end[1], end[2], extraNodeFlags | 0, owned);
    if (status === HIT) return this.result();
    if (status === MISS) return null;
    this.stats.fallback++;
    return undefined;
  }
  /** Whether traceRay (zero extent, no owner, no extra node flags) finds no hit, as a boolean, or undefined for the JavaScript to
   * answer: the same call as `ray`, without the result object a hit builds. */
  rayClear(model, start, end) {
    const base = this.base(model);
    if (base === 0 || !start || !end) return undefined;
    this.stats.ray++;
    const status = this.x.trace_ray(base, start[0], start[1], start[2], end[0], end[1], end[2], 0, 0);
    if (status === MISS) return true;
    if (status === HIT) return false;
    this.stats.fallback++;
    return undefined;
  }
  /** traceExtent's result, or undefined for the JavaScript to answer. */
  extent(model, start, end, extent, ownerCoords) {
    if (!finite3(start) || !finite3(end) || !finite3(extent)) return undefined;
    const x0 = f(extent[0]), x1 = f(extent[1]), x2 = f(extent[2]);
    if (x0 === 0 && x1 === 0 && x2 === 0 || x0 < 0 || x1 < 0 || x2 < 0) return undefined;
    const base = this.base(model);
    if (base === 0) return undefined;
    let owned = 0;
    if (ownerCoords) {
      if (!this.setOwner(ownerCoords)) return undefined;
      owned = 1;
    }
    this.stats.extent++;
    const status = this.x.trace_extent(base, start[0], start[1], start[2], end[0], end[1], end[2], x0, x1, x2, owned);
    if (status === HIT) return this.result();
    if (status === MISS) return null;
    this.stats.fallback++;
    return undefined;
  }
}

/** Trace results equal by Object.is on every number, with the same keys in
 * the same order. */
export function sameTraceResult(a, b) {
  if (a === null || b === null) return a === b;
  const same = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
  return Object.is(a.time, b.time) && Object.is(a.node, b.node) && a.penetrating === b.penetrating &&
    same(a.location, b.location) && same(a.normal, b.normal) && Object.keys(a).join() === Object.keys(b).join();
}

const exact = (key, v) => typeof v === 'number' && (Object.is(v, -0) || !Number.isFinite(v)) ? (Object.is(v, -0) ? '-0' : String(v)) : v;

/** TRACE_DIFFERENTIAL: the JavaScript body must answer exactly as the kernel
 * did. */
export function checkTraceKernel(name, result, reference, inputs) {
  let expected;
  try {
    expected = reference();
  } catch (error) {
    throw new Error(`${name} kernel differential: the JavaScript throws (${error.message}) where the kernel answers ${JSON.stringify(result, exact)}; ${JSON.stringify(inputs, exact)}`);
  }
  if (!sameTraceResult(result, expected))
    throw new Error(`${name} kernel differential mismatch: ${JSON.stringify({...inputs, kernel: result, javascript: expected}, exact)}`);
}
