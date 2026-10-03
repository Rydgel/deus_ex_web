/**
 * The host half of the GC natives in Rust (native/script-vm/src/gc.rs,
 * docs/play-cpu-plan.md Phase 5): the native heap's arena range, the gate
 * that admits the Rust bodies while the window host paints, and the
 * imports. Host bookkeeping, not an original structure.
 *
 * GC_NATIVE=js in Node or ?gcNative=js in the viewer keeps every GC native
 * in script-window-gc-dispatch.mjs; GC_NATIVE=verify runs each Rust body,
 * then the JavaScript body on the GC image from before it, and throws on any
 * difference in the image or the DrawTile command.
 *
 * The same switch covers PushGC and PopGC (gc.rs vm_gc_push / vm_gc_pop),
 * which the window host's DrawTree and PaintWindows call for every window:
 * under verify each runs again in JavaScript on the heap from before it, and
 * the heap's used bytes and the depth are compared.
 */
import {runGcNative} from './script-window-gc-dispatch.mjs';
import {drawTileCommand} from './script-gc-draw-model.mjs';
import {gcPushGC} from './script-gc-push-gc.mjs';
import {gcPopGC} from './script-gc-pop-gc.mjs';
import {NativeHeapError} from './script-native-heap.mjs';

export const gcNativeMode = () => (typeof process !== 'undefined' && process.env?.GC_NATIVE)
  || globalThis.DEUS_EX_GC_NATIVE || 'rust';

/** The natives gc.rs runs, by index: argument kinds after dispatchGcNative's
 * conversions (int, bool, color, float, object). */
export const GC_RUST_NATIVES = new Map([
  [1212, ['int']], [1230, ['color']], [1240, ['color']], [1242, ['object']], [1256, ['int', 'int']], [1258, ['bool']],
  [1284, ['float', 'float', 'float', 'float', 'float', 'float', 'object']],
  [1285, ['float', 'float', 'float', 'float', 'float', 'float', 'object']],
]);
const GC_SIZE = 0xb8, TILE_WORDS = 15;
const tileFields = words => ({texture: words[0], x: words[1], y: words[2], xl: words[3], yl: words[4], u: words[5], v: words[6],
  ul: words[7], vl: words[8], z: words[9], color: words.slice(10, 14), fog: [0, 0, 0, 0], polyFlags: words[14]});
const sameTile = (a, b) => a.texture === b.texture && a.x === b.x && a.y === b.y && a.xl === b.xl && a.yl === b.yl &&
  a.u === b.u && a.v === b.v && a.ul === b.ul && a.vl === b.vl && a.z === b.z && a.polyFlags === b.polyFlags &&
  a.color.every((c, i) => c === b.color[i]);

export class GcHost {
  constructor(vm) {
    this.vm = vm;
    this.mode = gcNativeMode();
    this.heap = null;
    this.services = null;
    this.epoch = 0;
  }
  attach(x) {
    this.x = x;
    this.hostAt = x.vm_gc_ptr();
    this.argsAt = x.vm_gc_args_ptr();
    this.tileAt = x.vm_gc_tile_ptr();
    this.snapAt = x.vm_gc_snap_ptr();
    this.statusAt = x.vm_gc_status_ptr();
  }
  /** The heap stack bodies run in Rust for `heap` (arena-backed). */
  stackReady(heap) { return this.mode !== 'js' && heap.region > 0; }
  /** gcPushGC(gc) in Rust: the depth, or undefined when the JavaScript body
   * must run (an empty free list allocates a node). */
  push(heap, services, gc) {
    const base = gc?.base ?? heap.objectAddress(gc);
    this.useHeap(heap);
    if (this.mode === 'verify') return this.verifyStack(heap, () => this.x.vm_gc_push(base), () => gcPushGC(gc, services));
    const depth = this.x.vm_gc_push(base);
    return this.status(depth);
  }
  /** gcPopGC(gc, gcNum) in Rust (it always completes or faults). */
  pop(heap, services, gc, gcNum) {
    const base = gc?.base ?? heap.objectAddress(gc);
    this.useHeap(heap);
    if (this.mode === 'verify') { this.verifyStack(heap, () => this.x.vm_gc_pop(base, gcNum | 0), () => gcPopGC(gc, gcNum, services)); return; }
    this.x.vm_gc_pop(base, gcNum | 0);
    this.status(undefined);
  }
  /** GC_HOST's heap words for `heap` (open() writes them too). */
  useHeap(heap) {
    if (this.heapWords === heap) return;
    this.heapWords = heap;
    const view = this.vm.arena.view;
    view.setUint32(this.hostAt, heap.region, true);
    view.setUint32(this.hostAt + 4, heap.capacity, true);
  }
  status(value) {
    const view = this.vm.arena.view, status = view.getUint32(this.statusAt, true);
    if (status === 0) return value;
    if (status === 1) return undefined;
    const address = view.getUint32(this.statusAt + 4, true);
    throw new NativeHeapError(`Native heap address 0x${address.toString(16)} is outside heap storage`, {address});
  }
  verifyStack(heap, rust, js) {
    const used = heap.used, before = heap.bytes.slice(0, used);
    let rustValue = rust();
    const status = this.vm.arena.view.getUint32(this.statusAt, true);
    // PushGC's allocation case returns before any store.
    if (status === 1) return undefined;
    if (status === 2) rustValue = 'fault';
    const after = heap.bytes.slice(0, used);
    heap.bytes.set(before, 0);
    let jsValue, error = null;
    try { jsValue = js(); } catch (thrown) { if (!(thrown instanceof NativeHeapError)) throw thrown; jsValue = 'fault'; error = thrown; }
    const now = heap.bytes.subarray(0, used), at = now.findIndex((b, i) => b !== after[i]);
    if (at >= 0) throw new Error(`GC_NATIVE verify: stack body differs at heap +0x${at.toString(16)} (rust ${after[at]}, js ${now[at]})`);
    if (rustValue !== jsValue) throw new Error(`GC_NATIVE verify: stack body result rust ${rustValue} js ${jsValue}`);
    if (error) throw error;
    return jsValue;
  }
  /** Whether the lowering may emit GC_EFFECT. */
  get lowerable() { return this.mode !== 'js'; }
  /** The window host starts painting: admit the Rust bodies when its native
   * dispatch would reach dispatchGcNative for every index gc.rs runs. */
  open({heap, services, handleNative}) {
    const runtime = this.vm.runtime;
    const gate = this.mode !== 'js' && heap.region > 0 && runtime.windowLifecycle?.handleNative === handleNative &&
      !Object.hasOwn(runtime, 'invokeNative') && ![...GC_RUST_NATIVES.keys()].some(index => runtime.boundaryNatives?.has(index));
    this.heap = heap;
    this.services = services;
    this.heapWords = heap;
    this.write([heap.region, heap.capacity, gate ? 1 : 0, this.mode === 'verify' ? 1 : 0, ++this.epoch]);
  }
  close() { this.vm.arena.view.setUint32(this.hostAt + 8, 0, true); }
  /** A heap object was freed or forgotten: cached addresses are stale. */
  invalidate() {
    if (this.heap) this.vm.arena.view.setUint32(this.hostAt + 16, ++this.epoch, true);
  }
  write(words) {
    const view = this.vm.arena.view;
    words.forEach((word, i) => view.setUint32(this.hostAt + 4 * i, word >>> 0, true));
  }
  args(index) {
    const view = this.vm.arena.view, count = GC_RUST_NATIVES.get(index).length;
    return Array.from({length: count}, (_, i) => view.getUint32(this.argsAt + 4 * i, true));
  }
  tile() {
    const view = this.vm.arena.view;
    return Array.from({length: TILE_WORDS}, (_, i) => view.getUint32(this.tileAt + 4 * i, true));
  }
  call(slot, canvas, command) {
    const crossed = this.services.callVirtual(slot, canvas, command);
    if (crossed && typeof crossed.then === 'function') throw new Error('canvas DrawTile boundary suspended');
  }
  imports() {
    const vm = this.vm;
    return {
      js_gc_address: (handle, receiver) => {
        const object = vm.identity(handle);
        if (!object) return 0;
        if (receiver) {
          // gcMemory's objectAddress: a receiver without a heap image runs
          // the JavaScript path, which raises the body's error.
          let base;
          try { base = object.base ?? this.heap.objectAddress(object); } catch { return 0; }
          return Number.isInteger(base) && base > 0 ? base >>> 0 : 0;
        }
        return this.heap.addressOf(object) >>> 0;
      },
      js_gc_tile: (slot, canvas) => this.call(slot, canvas, drawTileCommand(tileFields(this.tile()))),
      js_gc_native: (index, handle) => { runGcNative(index, vm.identity(handle), this.args(index), this.services); },
      js_gc_verify: (index, handle, base) => this.verify(index, vm.identity(handle), base),
    };
  }
  verify(index, receiver, base) {
    const heap = this.heap, at = base - heap.base, bytes = () => heap.bytes.slice(at, at + GC_SIZE);
    const draw = index === 1284 || index === 1285, words = draw ? this.tile() : null;
    const rustTile = words && words[0] ? tileFields(words) : null;
    const rust = bytes();
    heap.bytes.set(new Uint8Array(this.vm.arena.memory.buffer, this.snapAt, GC_SIZE), at);
    const services = this.services, callVirtual = services.callVirtual;
    let jsTile = null;
    services.callVirtual = (slot, canvas, command) => { jsTile = command; return callVirtual(slot, canvas, command); };
    try { runGcNative(index, receiver, this.args(index), services); } finally { services.callVirtual = callVirtual; }
    const js = bytes();
    const at0 = js.findIndex((b, i) => b !== rust[i]);
    if (at0 >= 0) throw new Error(`GC_NATIVE verify: native ${index} GC image differs at +0x${at0.toString(16)} (rust ${rust[at0]}, js ${js[at0]})`);
    if (draw && (Boolean(rustTile) !== Boolean(jsTile) || (rustTile && !sameTile(rustTile, jsTile))))
      throw new Error(`GC_NATIVE verify: native ${index} DrawTile differs: rust ${JSON.stringify(rustTile)} js ${JSON.stringify(jsTile && tileFields([jsTile.texture, jsTile.x, jsTile.y, jsTile.xl, jsTile.yl, jsTile.u, jsTile.v, jsTile.ul, jsTile.vl, jsTile.z, ...jsTile.color, jsTile.polyFlags]))}`);
  }
}
