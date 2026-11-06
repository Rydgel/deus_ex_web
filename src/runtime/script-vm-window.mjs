/**
 * The host half of XWindow::DrawTree in Rust (native/script-vm/src/window.rs, dispatch.rs `dispatch_window_event`,
 * docs/script-play-hud.md "The draw tree in Rust"). Host bookkeeping, not an original structure.
 *
 * WINDOW_DRAW=js in Node or ?windowDraw=js in the viewer keeps the draw tree in script-window-tree-natives.mjs `drawTree` and the
 * window events in the host's processScript (the reference); WINDOW_DRAW=verify runs the Rust body and checks that the events it
 * dispatched in Rust are the ones the JavaScript path would have run (see `verify`).
 *
 * WINDOWS = [table, slot count, epoch] (window.rs): the table describes the windows and GCs the walk meets, once each: a slot is
 * [native address, epoch, VM handle, flags]. The epoch advances when a heap object is freed or forgotten (its address can be reused)
 * and when a subtree is delegated to another owner, so every slot is described again.
 */
import {handleOf} from './script-object-handles.mjs';
import {NativeHeapError} from './script-native-heap.mjs';
import {gcPushGC} from './script-gc-push-gc.mjs';
import {O, c0, c3, drawBackground, drawTree as jsDrawTree} from './script-window-tree-natives.mjs';

export const windowDrawMode = () => (typeof process !== 'undefined' && process.env?.WINDOW_DRAW)
  || globalThis.DEUS_EX_WINDOW_DRAW || 'rust';

const SLOTS = 512, SLOT = 16, LOG_CAPACITY = 4096;
/** Slot flag bits (window.rs). */
const F_DRAW_SCRIPT = 1, F_POST_SCRIPT = 2, F_EXTERNAL = 4, F_DRAW_TEXT = 8, F_DRAW_BUTTON = 16;

export class WindowHost {
  constructor(vm) {
    this.vm = vm;
    this.mode = windowDrawMode();
    this.x = null;
    this.at = 0;
    this.epoch = 1;
    // Whether the window events dispatch in Rust during the paint in flight (paint).
    this.events = false;
    // WINDOW_DRAW=verify: the phases compared so far.
    this.verified = 0;
    // The paint in flight: {W, heap, canvas, hm, vm_}.
    this.ctx = null;
  }
  attach(x) {
    this.x = x;
    const arena = this.vm.arena;
    this.at = x.vm_windows_ptr();
    this.eventsAt = x.vm_window_events_ptr();
    this.faultAt = x.vm_window_fault_ptr();
    const bytes = SLOTS * SLOT, table = arena.alloc(bytes), log = this.mode === 'verify' ? arena.alloc(4 * LOG_CAPACITY) : 0, view = arena.view;
    arena.bytes.fill(0, table, table + bytes);
    view.setUint32(this.at, table, true);
    view.setUint32(this.at + 4, SLOTS, true);
    view.setUint32(this.at + 8, this.epoch, true);
    if (log) {
      view.setUint32(this.at + 12, 1, true);
      view.setUint32(this.at + 16, log, true);
      view.setUint32(this.at + 20, LOG_CAPACITY, true);
    }
  }
  /** A heap object was freed or forgotten, or a subtree was delegated: every slot is described again. */
  invalidate() {
    this.epoch = (this.epoch + 1) >>> 0 || 1;
    if (this.at) this.vm.arena.view.setUint32(this.at + 8, this.epoch, true);
  }
  /** Whether the Rust body may draw the tree of `heap` now: the GC stack bodies run in Rust for it, no allocation log wants every
   * window's name, and the host can describe a window. */
  ready(heap, W) {
    return this.mode !== 'js' && this.x !== null && typeof W.drawInfo === 'function' && this.vm.gc.stackReady(heap) &&
      !globalThis.__gcAllocLog;
  }
  /** The host's paint begins (`on`) or ends: the window events dispatch in Rust in between (dispatch.rs WINDOW_EVENTS), when the
   * runtime's event path is its own. Returns whether they do. */
  paint(on) {
    this.events = on && this.mode !== 'js' && this.x !== null && this.vm.events.windowEventsAllowed();
    this.vm.arena.view.setUint32(this.eventsAt, this.events ? 1 : 0, true);
    return this.events;
  }
  /** processScript(win, DrawWindow | PostDrawWindow (`which` 0 | 1), [gc]) through the Rust event cache, for the families whose own draw
   * runs the script event from JavaScript (the Text, Button and Checkbox draws). True when Rust handled it (ran the body, or found
   * no script to run); false when the caller must dispatch in JavaScript. */
  event(win, which, gc) {
    const x = this.x, pointer = x.__stack_pointer.value;
    let status;
    try {
      status = x.vm_window_event(handleOf(win), which, handleOf(gc));
    } finally {
      x.__stack_pointer.value = pointer;
    }
    return status >= 0;
  }
  /** DrawTree of `root` in Rust. Returns false when it did not run (the caller draws in JavaScript). */
  drawTree(W, heap, root, canvas, hm, vm, debugTexture, frameTimer) {
    if (debugTexture || !this.ready(heap, W)) return false;
    const gc = this.vm.gc;
    gc.useHeap(heap);
    this.ctx = {W, heap, canvas, hm, vm, frameTimer};
    const x = this.x, pointer = x.__stack_pointer.value, stack = this.vm.runtime.frameStack(), index = stack.index, top = stack.top;
    const depth = this.vm.depth;
    let status;
    const verifying = this.mode === 'verify';
    let expected = null;
    if (verifying) {
      this.vm.arena.view.setUint32(this.at + 24, 0, true);
      expected = [];
      this.plan(W, heap, root, expected);
    }
    try {
      status = x.vm_draw_tree(heap.addressOf(root), heap.addressOf(canvas), hm >>> 0, vm >>> 0);
    } finally {
      x.__stack_pointer.value = pointer;
      this.ctx = null;
      if (stack.top !== top || stack.index !== index) stack.restore(index, top);
      if (this.vm.depth !== depth) this.vm.depth = depth;
    }
    if (status === 2) {
      const address = this.vm.arena.view.getUint32(this.faultAt, true);
      throw new NativeHeapError(`Native heap address 0x${address.toString(16)} is outside heap storage`, {address});
    }
    if (verifying) this.verify(expected);
    return true;
  }
  /** WINDOW_DRAW=verify: the windows and phases the JavaScript body's tests would draw, from the tree as it stands before the paint
   * (`address * 2 + phase` as window.rs logs them): external subtrees, the GC and visible flag, the clip. */
  plan(W, heap, win, out) {
    if (W.externalSubtree?.(win)) return;
    const gc = W.ptr(win, O.gGc);
    if (!gc || !(W.u8(win, O.flags) & 1)) return;
    if (c0(W.f32(win, O.clipW), 0) || c3(W.f32(win, O.clipW), 0)) return;
    if (c0(W.f32(win, O.clipH), 0) || c3(W.f32(win, O.clipH), 0)) return;
    const address = heap.addressOf(win);
    out.push(address * 2);
    for (let child = W.ptr(win, O.firstChild); child; child = W.ptr(child, O.nextSibling)) this.plan(W, heap, child, out);
    out.push(address * 2 + 1);
  }
  verify(expected) {
    const view = this.vm.arena.view, length = view.getUint32(this.at + 24, true), log = view.getUint32(this.at + 16, true);
    if (length >= LOG_CAPACITY) return;
    this.verified += length;
    const got = Array.from({length}, (_, i) => view.getUint32(log + 4 * i, true));
    // (the 32-bit words of window.rs: address * 2 + phase wraps like the plan's number, which stays below 2^33)
    const same = got.length === expected.length && got.every((word, i) => word === expected[i] >>> 0);
    if (!same) {
      const at = got.findIndex((word, i) => word !== (expected[i] ?? -1) >>> 0);
      throw new Error(`WINDOW_DRAW verify: the Rust draw tree visited ${length} phases, the reference plans ${expected.length}; first difference at ${at}: `
        + `rust ${got[at] === undefined ? 'end' : `0x${(got[at] >>> 1).toString(16)}/${got[at] & 1}`}, plan ${expected[at] === undefined ? 'end' : `0x${(expected[at] / 2 | 0).toString(16)}/${expected[at] & 1}`}`);
    }
  }
  imports() {
    return {
      js_window_info: (address, slot) => this.info(address, slot),
      js_window_tree: address => {
        const c = this.ctx;
        jsDrawTree(c.W, c.heap.objectAt(address), c.canvas, null, c.frameTimer, c.hm, c.vm);
      },
      js_window_phase: (address, gcAddress, which) => {
        const c = this.ctx, win = c.heap.objectAt(address), gc = c.heap.objectAt(gcAddress);
        if (which === 0) c.W.v.draw(win, gc);
        else c.W.v.postDraw(win, gc);
      },
      js_window_background: (address, gcAddress) => {
        const c = this.ctx;
        drawBackground(c.W, c.heap.objectAt(address), c.heap.objectAt(gcAddress));
      },
      js_window_event: (address, gcAddress) => {
        const c = this.ctx;
        c.W.processScript(c.heap.objectAt(address), 'DrawWindow', [c.heap.objectAt(gcAddress)]);
      },
      js_window_destroy: address => {
        const c = this.ctx;
        c.W.native.safeDestroy(c.heap.objectAt(address));
      },
      js_window_gc_push: gcAddress => {
        const c = this.ctx;
        return gcPushGC(c.heap.objectAt(gcAddress), c.W.gc.services);
      },
    };
  }
  /** js_window_info: the handle and draw flags of the window or GC at `address`, into the slot; 0 for an address that names no
   * object. */
  info(address, slot) {
    const c = this.ctx;
    let object;
    try { object = c.heap.objectAt(address); } catch { return 0; }
    if (!object) return 0;
    const view = this.vm.arena.view, details = c.W.drawInfo(object);
    view.setUint32(slot + 8, handleOf(object), true);
    view.setUint32(slot + 12, details ? (details.draw ? F_DRAW_SCRIPT : 0) | (details.post ? F_POST_SCRIPT : 0) |
      (details.external ? F_EXTERNAL : 0) | (details.text ? F_DRAW_TEXT : 0) | (details.button ? F_DRAW_BUTTON : 0) : 0, true);
    return 1;
  }
}
