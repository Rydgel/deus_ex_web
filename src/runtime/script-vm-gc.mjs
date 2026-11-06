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
import {drawTileCommand, transientTileCommand} from './script-gc-draw-model.mjs';
import {gcPushGC} from './script-gc-push-gc.mjs';
import {gcPopGC} from './script-gc-pop-gc.mjs';
import {NativeHeapError} from './script-native-heap.mjs';
import {gcDrawText, glyphCommandFromWords} from './script-gc-draw-text.mjs';
import {UFontModelBoundaryError} from './script-font-model.mjs';

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
    this.glyphAt = x.vm_gc_glyph_ptr();
    this.texcAt = x.vm_gc_texc_ptr();
    this.textUnits = 0;
    this.textCapacity = 0;
    this.textServices = null;
    this.allocated = false;
    // What verify compared (the stress validator prints it).
    this.textVerify = {compared: 0, skipped: 0, commands: 0};
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
  /** UGC::DrawText through the Rust body (text.rs) for `object`: true when it ran (the JavaScript body then must not). The text's
   * units go to an arena buffer, truncated at the first NUL as the reference's textUnitsShared does; the realize cache's head and
   * count live in Rust (`bindTexCache`). */
  drawText(heap, services, object, destX, destY, destWidth, destHeight, text) {
    if (this.mode === 'js' || !(heap.region > 0)) return false;
    if (this.mode === 'verify') return this.verifyText(heap, services, object, destX, destY, destWidth, destHeight, text);
    return this.runText(heap, services, object, destX, destY, destWidth, destHeight, text);
  }
  runText(heap, services, object, destX, destY, destWidth, destHeight, text) {
    const base = object.base ?? heap.objectAddress(object);
    this.useHeap(heap);
    this.bindTexCache(services.texCache);
    const previousServices = this.textServices, previousHeap = this.textHeap;
    this.textServices = services;
    this.textHeap = heap;
    let length = text.indexOf('\0');
    if (length < 0) length = text.length;
    if (length > this.textCapacity) {
      const capacity = Math.max(length, 2 * this.textCapacity, 256);
      this.textUnits = this.vm.arena.alloc(2 * capacity);
      this.textCapacity = capacity;
    }
    // (the allocation may grow the memory, detaching an earlier view)
    const view = this.vm.arena.view, units = this.textUnits;
    for (let i = 0; i < length; i++) view.setUint16(units + 2 * i, text.charCodeAt(i), true);
    const x = this.x, pointer = x.__stack_pointer.value;
    try {
      x.vm_gc_draw_text(base, destX >>> 0, destY >>> 0, destWidth >>> 0, destHeight >>> 0, units, length);
    } finally {
      x.__stack_pointer.value = pointer;
      this.textServices = previousServices;
      this.textHeap = previousHeap;
    }
    return true;
  }
  /** GC_NATIVE=verify: the Rust body, then the JavaScript body from the heap before it, and a difference in what they leave (the GC
   * image, the GC stack's nodes, the realize cache's records and head and count) or hand the renderer (the DrawTile commands in
   * order, with the texture Lock calls) throws. The commands of the JavaScript run are the ones forwarded. A PushGC that had to
   * allocate a node leaves the two runs different heaps (each allocates): that call is not compared. */
  verifyText(heap, services, object, destX, destY, destWidth, destHeight, text) {
    const base = object.base ?? heap.objectAddress(object), cache = services.texCache;
    const ranges = this.textRanges(heap, base, cache), snapshot = ranges.map(([at, size]) => heap.bytes.slice(at - heap.base, at - heap.base + size));
    const head = cache.head, count = cache.count;
    const recorded = [], derived = this.derivedServices(services, recorded);
    this.allocated = false;
    this.runText(heap, derived, object, destX, destY, destWidth, destHeight, text);
    if (this.allocated) { this.textVerify.skipped++; this.replay(services, recorded); return true; }
    const rust = ranges.map(([at, size]) => heap.bytes.slice(at - heap.base, at - heap.base + size)), rustCache = [cache.head, cache.count];
    ranges.forEach(([at], i) => heap.bytes.set(snapshot[i], at - heap.base));
    cache.head = head;
    cache.count = count;
    const expected = [], reference = this.derivedServices(services, expected, true);
    gcDrawText(object, destX, destY, destWidth, destHeight, text, reference);
    ranges.forEach(([at, size], i) => {
      const js = heap.bytes.subarray(at - heap.base, at - heap.base + size), at0 = js.findIndex((b, j) => b !== rust[i][j]);
      if (at0 >= 0) throw new Error(`GC_NATIVE verify: DrawText leaves heap +0x${(at + at0 - heap.base).toString(16)} different (range ${i} of ${ranges.length}, +0x${at0.toString(16)} of 0x${size.toString(16)}; rust ${rust[i][at0]}, js ${js[at0]}; ${JSON.stringify(text.slice(0, 40))})`);
    });
    if (rustCache[0] !== cache.head || rustCache[1] !== cache.count)
      throw new Error(`GC_NATIVE verify: DrawText realize cache head/count rust ${rustCache}, js ${[cache.head, cache.count]}`);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (recorded.length !== expected.length || recorded.some((entry, i) => !same(entry, expected[i])))
      throw new Error(`GC_NATIVE verify: DrawText commands differ: rust ${JSON.stringify(recorded.find((e, i) => !same(e, expected[i])))}`
        + ` js ${JSON.stringify(expected.find((e, i) => !same(recorded[i], e)))} (${recorded.length} against ${expected.length})`);
    this.textVerify.compared++;
    this.textVerify.commands += expected.length;
    this.replay(services, expected);
    return true;
  }
  /** The ranges DrawText can write: the GC, the nodes of its two stacks and the realize cache's records. */
  textRanges(heap, base, cache) {
    const ranges = [[base, 0xb8]], seen = new Set([base]);
    for (const first of [heap.mem.read(base + 0xac, 'u32'), heap.mem.read(base + 0xb0, 'u32')])
      for (let node = first; node && !seen.has(node) && ranges.length < 256; node = heap.mem.read(node + 0xac, 'u32')) { seen.add(node); ranges.push([node, 0xb8]); }
    for (const record of [...cache.records, cache.static]) ranges.push([record, 0x84]);
    return ranges;
  }
  /** `services` with callVirtual recording the tile commands (the texture Lock and Unlock calls run as they do): into `out`. With
   * `reference`, the JavaScript bodies of DrawText, PushGC and PopGC. */
  derivedServices(services, out, reference = false) {
    const derived = Object.create(services);
    Object.defineProperty(derived, 'callVirtual', {value: (slot, object, command) => {
      if (slot !== 3 && slot !== 4) return services.callVirtual(slot, object, command);
      out.push({slot, object, command: {...command, color: [...command.color]}});
      return undefined;
    }});
    if (reference) for (const name of ['drawText', 'pushGC', 'popGC']) Object.defineProperty(derived, name, {value: undefined});
    return derived;
  }
  replay(services, commands) {
    for (const {slot, object, command} of commands) services.callVirtual(slot, object, command);
  }
  /** The realize cache's JavaScript object (`services.texCache`) reads and writes its head and count where Rust keeps them (TEXC:
   * head, count, the five records, the static record). */
  bindTexCache(cache) {
    if (cache.rustBound === this) return;
    const vm = this.vm, at = this.texcAt, head = cache.head, count = cache.count;
    Object.defineProperty(cache, 'head', {get: () => vm.arena.view.getUint32(at, true), set: v => vm.arena.view.setUint32(at, v >>> 0, true),
      configurable: true, enumerable: true});
    Object.defineProperty(cache, 'count', {get: () => vm.arena.view.getUint32(at + 4, true), set: v => vm.arena.view.setUint32(at + 4, v >>> 0, true),
      configurable: true, enumerable: true});
    const view = vm.arena.view;
    view.setUint32(at, head >>> 0, true);
    view.setUint32(at + 4, count >>> 0, true);
    cache.records.forEach((record, i) => view.setUint32(at + 8 + 4 * i, record >>> 0, true));
    view.setUint32(at + 28, cache.static >>> 0, true);
    Object.defineProperty(cache, 'rustBound', {value: this, configurable: true});
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
    // (the Rust window draws' DrawText hands its glyphs to these)
    this.textServices = services;
    this.textHeap = heap;
    if (this.mode !== 'js' && services.texCache) this.bindTexCache(services.texCache);
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
      js_gc_tile: (slot, canvas) => {
        // The window host's callVirtual reads the block at the call (`transientPayloads`): the words go straight into one reused block.
        if (this.services.transientPayloads !== true) return this.call(slot, canvas, drawTileCommand(tileFields(this.tile())));
        const view = this.vm.arena.view, at = this.tileAt, word = i => view.getUint32(at + 4 * i, true);
        return this.call(slot, canvas, transientTileCommand(word(0), word(1), word(2), word(3), word(4), word(5), word(6), word(7), word(8), word(9),
          word(10), word(11), word(12), word(13), word(14)));
      },
      // UGC::DrawText in Rust (text.rs): the glyph's DrawTile, the realize cache's texture Lock and Unlock, PushGC's allocation and
      // the JavaScript body's errors.
      js_gc_glyph: (slot, object) => {
        const view = this.vm.arena.view, at = this.glyphAt, w = this.glyphWords ??= new Array(16);
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + 4 * i, true);
        const crossed = this.textServices.callVirtual(slot, object, glyphCommandFromWords(this.textServices, w));
        if (crossed && typeof crossed.then === 'function') throw new Error('DrawGlyphTile boundary suspended');
      },
      js_gc_tex_lock: (slot, texture, record, b0, b4, ri) => {
        const crossed = this.textServices.callVirtual(slot, texture, {record, b0, b4, arg3: 0xffffffff, ri});
        if (crossed && typeof crossed.then === 'function') throw new Error('TextureLock boundary suspended');
      },
      js_gc_tex_unlock: (slot, texture, record) => {
        const crossed = this.textServices.callVirtual(slot, texture, {record});
        if (crossed && typeof crossed.then === 'function') throw new Error('TextureUnlock boundary suspended');
      },
      // GC_NATIVE=verify, a DrawText made by the Rust window draws (text.rs draw_text): the units are read back into the string the
      // JavaScript body takes, and verifyText runs both bodies.
      js_gc_text_verify: (base, destX, destY, destWidth, destHeight, units, end) => {
        const view = this.vm.arena.view;
        let text = '';
        for (let i = 0; i < end; i++) text += String.fromCharCode(view.getUint16(units + 2 * i, true));
        const heap = this.heap, object = heap.objectAt(base);
        this.verifyText(heap, this.services, object, destX, destY, destWidth, destHeight, text);
      },
      js_gc_text_push: gc => { this.allocated = true; return gcPushGC(this.textHeap.objectAt(gc), this.textServices); },
      js_gc_text_fail: (kind, value) => {
        if (kind === 1) throw new NativeHeapError(`Native heap address 0x${(value >>> 0).toString(16)} is outside heap storage`, {address: value >>> 0});
        throw new UFontModelBoundaryError(value === 0 ? 'UFont glyph lookup with zero charsPerPage hits a native #DE'
          : 'UFont glyph lookup produced a negative page/index (reads outside the table - unverifiable)', {kind: 'DIVISOR'});
      },
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
