/**
 * Recovered Extension.dll window timers: XWindow::AddTimer 0x1004fc20,
 * RemoveTimer 0x1004fd20, InvokeTimers 0x10051340, the exec bodies
 * execAddTimer 0x10054130 (native 1490) / execRemoveTimer 0x10054220 (1491),
 * XRootWindow::GetWindowsTickOffset 0x1003a3b0, and XButtonWindow's activate
 * timer (AddActivateTimer 0x10008510, RemoveActivateTimer 0x10008480,
 * Timer 0x100080e0).
 *
 * A window keeps its active list at +0x128 and its free list at +0x12c. Each
 * 0x20-byte GMalloc node is linked through +0x1c. The script-visible timer ID
 * is the node address. Nodes are registered heap objects, so the destroy
 * module's pointer walk of both lists (XWindow::CleanUp) resolves them.
 *
 * W services: the tree-natives world (u32/i32/f32/ptr and setters, heap),
 * W.tickOffset() (GetWindowsTickOffset(0)), W.allocTimerNode() (GMalloc(0x20)
 * returning a registered heap identity), W.processScript, W.v.timer (the +0x78
 * virtual) and W.native.safeDestroy (reached through UnlockWindow).
 * Evidence and oracle: docs/script-window-input.md,
 * scripts/native-window-timer-oracle.py, scripts/validate-window-timer-diff.mjs.
 */
import {x87load, x87add, x87neg, x87mul, x87div, x87int32, x87ftol, x87store} from './script-vm.mjs';
import {lockWindow, unlockWindow} from './script-window-tree-natives.mjs';

const f = Math.fround;
export const WINDOW_TIMER = Object.freeze({
  first: 0x128, free: 0x12c, flags: 0x30, beingDestroyed: 0x10,
  timeout: 0x00, remaining: 0x04, name: 0x08, loop: 0x0c, clientData: 0x10,
  inUse: 0x14, removed: 0x18, next: 0x1c, size: 0x20,
  // Double 0x10065310 = 1e-6; replacement bits 0x358637bd = 1e-6f.
  minimumTimeout: 1e-6, minimumTimeoutBits: 0x358637bd,
});
export const BUTTON_TIMER = Object.freeze({buttonFlags: 0x174, activateDelay: 0x178, activateTimer: 0x198});
const T = WINDOW_TIMER;
const bitsToFloat = bits => { const view = new DataView(new ArrayBuffer(4)); view.setUint32(0, bits >>> 0, true); return view.getFloat32(0, true); };

const scratch = new DataView(new ArrayBuffer(8));
function loadDouble(value) {
  scratch.setFloat64(0, value, true);
  const bits = scratch.getBigUint64(0, true), exponent = Number((bits >> 52n) & 0x7ffn);
  if (exponent === 0x7ff) throw new Error('GetWindowsTickOffset nonfinite clock is not implemented');
  return {neg: Number(bits >> 63n), sig: (bits & 0xfffffffffffffn) | (exponent ? 0x10000000000000n : 0n),
    exp: exponent ? exponent - 1075 : -1074};
}
/** GetWindowsTickOffset 0x1003a41f-0x1003a42a: fld appSeconds; fsub qword
 * last; fstp dword. The difference of the two doubles rounds once to f32. */
export function windowsTickOffset(now, last) {
  return x87store(x87add(loadDouble(now), x87neg(loadDouble(last))));
}
// x87 fcomp against 0.0f (0x10059884) then `test ah,1`: C0 is set when the
// 80-bit operand is below zero or unordered.
const below0 = v => v.nan !== undefined || (v.inf ? Boolean(v.neg) : Boolean(v.neg) && v.sig !== 0n);
const nameOf = (W, node) => W.heap.read(node, T.name, 'name');

/** XWindow::AddTimer 0x1004fc20(timeout, bLoop, clientData, name). */
export function addTimer(W, win, timeout, loop, clientData, name) {
  // fld timeout; fcomp qword 1e-6; C0 (below or unordered) substitutes 1e-6f.
  let timeoutValue = f(timeout);
  if (!(timeoutValue >= T.minimumTimeout)) timeoutValue = bitsToFloat(T.minimumTimeoutBits);
  if (W.u8(win, T.flags) & T.beingDestroyed) return 0;
  let node = W.u32(win, T.free);
  if (node) W.setU32(win, T.free, W.u32(node, T.next));
  else {
    const identity = W.allocTimerNode();
    node = identity ? W.heap.addressOf(identity) : 0;
    if (!node) return 0;
  }
  W.setF32(node, T.timeout, timeoutValue);
  // GetTickOffset returns the f32 offset in st0; fadd timeout; fstp dword.
  W.setF32(node, T.remaining, x87store(x87add(x87load(W.tickOffset()), x87load(timeoutValue))));
  W.heap.write(node, T.name, 'name', name ?? 'None');
  W.setU32(node, T.loop, loop ? (loop === true ? 1 : loop) : 0);
  W.setI32(node, T.clientData, clientData | 0);
  W.setI32(node, T.inUse, 0);
  W.setI32(node, T.removed, 0);
  W.setU32(node, T.next, W.u32(win, T.first));
  W.setU32(win, T.first, node);
  return node;
}

/** XWindow::RemoveTimer 0x1004fd20(id). */
export function removeTimer(W, win, id) {
  id >>>= 0;
  if (!id || (W.u8(win, T.flags) & T.beingDestroyed)) return;
  let previous = 0, node = W.u32(win, T.first);
  while (node && node !== id) { previous = node; node = W.u32(node, T.next); }
  if (!node) return;
  W.setI32(node, T.removed, 1);
  if (W.i32(node, T.inUse) > 0) return;
  const next = W.u32(node, T.next);
  if (previous) W.setU32(previous, T.next, next);
  else W.setU32(win, T.first, next);
  W.setU32(node, T.next, W.u32(win, T.free));
  W.setU32(win, T.free, node);
}

/** XWindow::InvokeTimers 0x10051340(delta), reached from TickTree. */
export function invokeTimers(W, win, delta) {
  if (W.u8(win, T.flags) & T.beingDestroyed) return;
  lockWindow(W, win);
  try {
    let node = W.u32(win, T.first);
    while (node) {
      if (W.i32(node, T.removed)) { node = W.u32(node, T.next); continue; }
      // fld remaining; fsub delta; inc inUse; fst remaining; fcomp 0.0f.
      const reduced = x87add(x87load(W.f32(node, T.remaining)), x87neg(x87load(f(delta))));
      W.setI32(node, T.inUse, W.i32(node, T.inUse) + 1);
      W.setF32(node, T.remaining, x87store(reduced));
      if (below0(reduced)) {
        let invocations;
        const timeout = x87load(W.f32(node, T.timeout));
        if (W.u32(node, T.loop)) {
          // fld remaining; fchs; fdiv timeout; _ftol; inc; fild; fmul timeout;
          // fadd remaining; fstp remaining.
          invocations = (x87ftol(x87div(x87neg(x87load(W.f32(node, T.remaining))), timeout)) + 1) | 0;
          W.setF32(node, T.remaining, x87store(x87add(x87mul(x87int32(invocations), timeout),
            x87load(W.f32(node, T.remaining)))));
        } else {
          invocations = 1;
          W.setI32(node, T.removed, 1);
        }
        const name = nameOf(W, node);
        if (name && name !== 'None')
          W.processScript(win, name, [node, invocations, W.i32(node, T.clientData)], {checked: true});
        else W.v.timer(win, node, invocations, W.i32(node, T.clientData));
      }
      if (W.u8(win, T.flags) & T.beingDestroyed) break;
      const next = W.u32(node, T.next), inUse = (W.i32(node, T.inUse) - 1) | 0;
      W.setI32(node, T.inUse, inUse);
      if (inUse <= 0 && W.i32(node, T.removed)) removeTimer(W, win, node);
      node = next;
    }
  } finally {
    unlockWindow(W, win);
  }
}

/** XButtonWindow::RemoveActivateTimer 0x10008480. */
export function removeActivateTimer(W, win) {
  const id = W.u32(win, BUTTON_TIMER.activateTimer);
  if (!id) return;
  removeTimer(W, win, id);
  W.setU32(win, BUTTON_TIMER.activateTimer, 0);
}
/** XButtonWindow::AddActivateTimer 0x10008510: AddTimer(activateDelay, 0, 0, None). */
export function addActivateTimer(W, win) {
  removeActivateTimer(W, win);
  W.setU32(win, BUTTON_TIMER.activateTimer, addTimer(W, win, W.f32(win, BUTTON_TIMER.activateDelay), 0, 0, 'None'));
}
/** XButtonWindow::Timer 0x100080e0 (vtable +0x78 for Button/Toggle/Checkbox).
 * XWindow::Timer 0x100504f0 is `ret 0xc`. */
export function buttonTimer(W, win, id, changeButtonAppearance) {
  if ((id >>> 0) !== W.u32(win, BUTTON_TIMER.activateTimer)) return;
  // and al,0xfe on the low byte of +0x174.
  W.setU32(win, BUTTON_TIMER.buttonFlags, W.u32(win, BUTTON_TIMER.buttonFlags) & ~1);
  changeButtonAppearance(win);
  removeActivateTimer(W, win);
}
