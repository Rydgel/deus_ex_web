/**
 * The host half of the Rust mesh-light selection (native/script-vm/src/
 * meshlight.rs, docs/play-cpu-plan.md step 2.3): FLightManager::
 * SetupForActor's light choice runs in the interpreter; this module owns the
 * per-handle light slots (filled once per frame from the viewer's light
 * records), the per-actor fade cache blocks, the square-root table and the
 * BSP line check. Host bookkeeping, not an original structure.
 *
 * MESH_LIGHT=js in Node or ?meshLight=js in the viewer keeps
 * mesh-lighting.mjs setupForActor; MESH_LIGHT=verify (?meshLight=verify)
 * runs both, each with its own caches, and throws on any difference.
 */
import {squareRootTable} from './dynamic-lighting.mjs';
import {handleOf} from './script-object-handles.mjs';

export const meshLightMode = () => (typeof process !== 'undefined' && process.env?.MESH_LIGHT)
  || globalThis.DEUS_EX_MESH_LIGHT || 'rust';

const SLOT_WORDS = 10, CACHE_BLOCK = 8 + 16 * 8, OUT_WORDS = 1 + 2 * 120 + 1 + 120;
const SL_STATIC = 1, SL_MOVABLE = 2, SL_SPECIAL = 4, SL_ALIVE = 8, SL_RECORD = 16;
/** A permeating run entry without a live actor (meshlight.rs MISSING). */
export const MESH_LIGHT_MISSING = 0xffffffff;
const bits = new DataView(new ArrayBuffer(4));
const u32 = value => { bits.setFloat32(0, value, true); return bits.getUint32(0, true); };

const CAPACITY = {slots: 'slotCapacity', caches: 'cacheCapacity', indices: 'indicesCapacity'};

export class MeshLightHost {
  constructor(vm) {
    this.vm = vm;
    this.provider = null;
    this.frame = 0;
    this.slots = 0; this.slotCapacity = 0;
    this.caches = 0; this.cacheCapacity = 0;
    this.scratch = 0; this.scratchWords = 0;
    this.out = 0;
    this.members = 0; this.membersCapacity = 0; this.memberSet = null;
    this.indices = 0; this.indicesCapacity = 0;
  }
  attach(x) {
    this.x = x;
    this.stateAt = x.ml_state_ptr();
    new Uint32Array(this.vm.arena.memory.buffer, x.ml_sqrt_ptr(), 2048).set(squareRootTable());
    this.out = this.vm.arena.alloc(4 * OUT_WORDS);
  }
  get view() { return this.vm.arena.view; }
  writeState() {
    const view = this.view, at = this.stateAt;
    view.setUint32(at, this.slots, true); view.setUint32(at + 4, this.slotCapacity, true);
    view.setUint32(at + 8, this.caches, true); view.setUint32(at + 12, this.cacheCapacity, true);
    view.setUint32(at + 16, this.frame, true);
    view.setUint32(at + 20, this.members, true); view.setUint32(at + 24, this.membersCapacity, true);
    view.setUint32(at + 28, this.indices, true); view.setUint32(at + 32, this.indicesCapacity, true);
  }
  /** The membership bytes of `live` (a view's Level.Actors set, rebuilt
   * with actorsEpoch), rebuilt when the set object changes. */
  membership(live) {
    if (live === this.memberSet) return;
    this.memberSet = live;
    let top = 0;
    const handles = [];
    for (const actor of live) if (actor) { const handle = handleOf(actor); handles.push(handle); top = Math.max(top, handle); }
    const arena = this.vm.arena;
    if (top >= this.membersCapacity) {
      if (this.members) arena.release(this.members, this.membersCapacity);
      this.membersCapacity = Math.max(4096, (top + 1) * 2);
      this.members = arena.alloc(this.membersCapacity);
    }
    arena.bytes.fill(0, this.members, this.members + this.membersCapacity);
    for (const handle of handles) arena.bytes[this.members + handle] = 1;
  }
  /** Grow a handle-indexed table of `words` u32 per handle to hold `handle`. */
  grow(kind, handle, words) {
    const key = CAPACITY[kind], capacity = this[key];
    if (handle < capacity) return;
    const next = Math.max(4096, (handle + 1) * 2), arena = this.vm.arena, bytes = 4 * words;
    const base = arena.alloc(next * bytes);
    arena.bytes.fill(0, base, base + next * bytes);
    if (this[kind]) {
      arena.bytes.copyWithin(base, this[kind], this[kind] + capacity * bytes);
      arena.release(this[kind], capacity * bytes);
    }
    this[kind] = base; this[key] = next;
    if (kind === 'caches' && this.context) { this.context.caches = base; this.context.cacheCapacity = next; }
    this.writeState();
  }
  /** A light view's selection context: its own fade caches (each view is
   * one FLightManager). */
  context() {
    return {provider: null, frame: 0, caches: 0, cacheCapacity: 0};
  }
  /** A new frame of `context`'s view: its light records come from
   * `provider`: {alive(handle), light(handle) -> {values, location, index}
   * (the light record), trace(location, lightLocation) -> clear}. */
  beginFrame(context, provider) {
    context.provider = provider;
    context.frame = this.frame = (this.frame + 1) >>> 0 || 1;
  }
  /** js_ml_index: the light record's index of `handle`, entered. */
  lightIndex(handle) {
    this.grow('indices', handle, 1);
    const index = this.provider.index(handle) >>> 0;
    this.vm.arena.view.setUint32(this.indices + 4 * handle, (index + 1) >>> 0, true);
    return index;
  }
  use(context) {
    this.provider = context.provider; this.frame = context.frame;
    this.membership(context.provider.live);
    this.caches = context.caches; this.cacheCapacity = context.cacheCapacity;
    this.context = context;
    this.writeState();
  }
  /** js_ml_light: the slot of `handle` for this frame; with `needRecord`
   * the light record's fields (a record is made only when needed, as the
   * JavaScript selection makes it). */
  fillLight(handle, needRecord) {
    this.grow('slots', handle, SLOT_WORDS);
    const view = this.view, at = this.slots + 4 * SLOT_WORDS * handle;
    const fresh = view.getUint32(at, true) !== this.frame;
    const alive = fresh ? this.provider.alive(handle) : Boolean(view.getUint32(at + 20, true) & SL_ALIVE);
    view.setUint32(at, this.frame, true);
    if (!needRecord) { view.setUint32(at + 20, alive ? SL_ALIVE : 0, true); return; }
    const record = this.provider.light(handle), v = record.values;
    view.setUint32(at + 4, v.LightType & 255, true);
    view.setUint32(at + 8, v.LightEffect & 255, true);
    view.setUint32(at + 12, v.LightBrightness & 255, true);
    view.setUint32(at + 16, v.LightRadius & 255, true);
    view.setUint32(at + 20, SL_RECORD | (alive ? SL_ALIVE : 0) | (v.bStatic ? SL_STATIC : 0) |
      (v.bMovable ? SL_MOVABLE : 0) | (v.bSpecialLit ? SL_SPECIAL : 0), true);
    for (let i = 0; i < 3; i++) view.setUint32(at + 24 + 4 * i, u32(record.location[i]), true);
    view.setUint32(at + 36, record.index >>> 0, true);
  }
  /** js_ml_cache: `handle`'s cache block, allocated absent. */
  cacheBlock(handle) {
    this.grow('caches', handle, 1);
    const view = this.view, at = this.caches + 4 * handle;
    let block = view.getUint32(at, true);
    if (!block) {
      block = this.vm.arena.alloc(CACHE_BLOCK);
      this.vm.arena.bytes.fill(0, block, block + CACHE_BLOCK);
      view.setUint32(at, block, true);
    }
    return block;
  }
  imports() {
    return {
      js_ml_light: (handle, record) => this.fillLight(handle, record),
      js_ml_trace: (ax, ay, az, lx, ly, lz) => this.provider.trace([ax, ay, az], [lx, ly, lz]) ? 1 : 0,
      js_ml_cache: handle => this.cacheBlock(handle),
      js_ml_index: handle => this.lightIndex(handle),
    };
  }
  /** The selection for one draw: {added: [[handle, fade]...], traced:
   * [handle...]} in order. */
  select(context, actorHandle, location, specialLit, step, frameCount, perm, leaf) {
    this.use(context);
    const words = perm.length + leaf.length;
    if (words > this.scratchWords) {
      if (this.scratch) this.vm.arena.release(this.scratch, 4 * this.scratchWords);
      this.scratchWords = Math.max(256, words * 2);
      this.scratch = this.vm.arena.alloc(4 * this.scratchWords);
    }
    let view = this.view;
    perm.forEach((handle, i) => view.setUint32(this.scratch + 4 * i, handle, true));
    leaf.forEach((handle, i) => view.setUint32(this.scratch + 4 * (perm.length + i), handle, true));
    this.x.ml_select(actorHandle, u32(location[0]), u32(location[1]), u32(location[2]), specialLit ? 1 : 0, step,
      frameCount >>> 0, this.scratch, perm.length, this.scratch + 4 * perm.length, leaf.length, this.out);
    view = this.view;
    const added = [], traced = [], count = view.getUint32(this.out, true);
    if (count === MESH_LIGHT_MISSING) return {missing: view.getUint32(this.out + 4, true)};
    for (let i = 0; i < count; i++)
      added.push([view.getUint32(this.out + 4 + 8 * i, true), view.getUint32(this.out + 8 + 8 * i, true)]);
    const t = this.out + 4 + 8 * count, n = view.getUint32(t, true);
    for (let i = 0; i < n; i++) traced.push(view.getUint32(t + 4 + 4 * i, true));
    return {added, traced};
  }
}
