/**
 * Recovered Extension.dll XWindow / XRootWindow tree bodies used by the Play
 * window host: preferred-size negotiation, child resizing, visibility and
 * initialization tree walks, selectability, timers, root resize/tick/paint
 * traversal.
 *
 * Every function names its original body. They operate on a window world
 * `W` supplied by the host (src/runtime/script-window-host.mjs):
 *   W.f32/u8/u32/i32/ptr(object, offset)       raw native loads
 *   W.setF32/setU8/setU32/setI32/setPtr(...)   raw native stores
 *   W.v.<virtual>(object, ...)                 vtable dispatch (native family
 *                                              override or the XWindow
 *                                              ProcessScript bridge)
 *   W.global(name) / W.setGlobal(name, value)  the .bss layout globals
 *   W.gc.*                                     recovered XGC members
 *   W.native.*                                 other recovered natives
 *                                              (AskParentForReconfigure,
 *                                              ConfigureChild, SetFocusWindow)
 * Float stores go through Math.fround; x87 compares follow the fcomp/fnstsw
 * condition bits noted at each site (C0 = below or unordered, C3 = equal or
 * unordered). Evidence and validation: docs/script-window-host.md,
 * scripts/native-window-tree-oracle.py, scripts/validate-window-tree-natives.mjs.
 */

const f = Math.fround;
export const O = Object.freeze({
  type: 0x28, flags: 0x30, lock: 0x34, surface: 0x38, backgroundStyle: 0x3c,
  x: 0x78, y: 0x7c, width: 0x80, height: 0x84, hAlign: 0x88, vAlign: 0x89,
  hMargin0: 0x8c, hMargin1: 0x90, vMargin0: 0x94, vMargin1: 0x98,
  hardWidth: 0x9c, hardHeight: 0xa0, holdX: 0xa4, holdY: 0xa8, holdWidth: 0xac, holdHeight: 0xb0,
  acceleratorKey: 0xb4, config: 0xb8, cacheInW: 0xbc, cacheInH: 0xc0, cacheOutW: 0xc4, cacheOutH: 0xc8,
  tick: 0xcc, clip: 0xd4, clipW: 0xe4, clipH: 0xe8, background: 0xec,
  visibleSound: 0x10c, invisibleSound: 0x110, rowMajorIndex: 0x11c, colMajorIndex: 0x120,
  firstTimer: 0x128, gGc: 0x130, wGc: 0x134,
  parent: 0x138, firstChild: 0x13c, lastChild: 0x140, prevSibling: 0x144, nextSibling: 0x148,
});
export const ROOT = Object.freeze({
  preferredFocus: 0x178, parentPawn: 0x588, nextRoot: 0x58c, mouseX: 0x590, mouseY: 0x594,
  mouseFlags: 0x5a4, grabbed: 0x5c4, focus: 0x5c8, handleMouseRef: 0x5cc, initCount: 0x5d4,
  renderFlags: 0x5d8, rawBackground: 0x5ec, rawColor: 0x5f8, tickCycles: 0x5fc, paintCycles: 0x600,
  debugFlags: 0x604, debugTexture: 0x608, frameTimer: 0x60c, lastButtonPress: 0x620,
  hMultiplier: 0x730, vMultiplier: 0x734, rootFrame: 0x740,
});

/** x87 `fcomp`: C0 set for below-or-unordered. */
export const c0 = (a, b) => a < b || Number.isNaN(a) || Number.isNaN(b);
/** x87 `fcomp`: C3 set for equal-or-unordered. */
export const c3 = (a, b) => a === b || Number.isNaN(a) || Number.isNaN(b);
/** MSVCRT `_ftol`: truncation toward zero to a signed 32-bit integer. */
export const ftol = value => {
  if (!Number.isFinite(value)) throw new Error('Native _ftol reached a non-finite value');
  return Math.trunc(value) | 0;
};

// ---------------------------------------------------------------------------
// Small ancestry helpers (0x1004c560 GetTabGroupWindow, 0x1004c580
// GetModalWindow, 0x1004c5a0 GetRootWindow): walk +0x138 to the first
// window whose +0x28 type byte is >= 1 / >= 2; the root walk climbs to the
// topmost window and keeps it only when its type is >= 3.
// ---------------------------------------------------------------------------
export function getTabGroupWindow(W, win) {
  for (let w = win; w; w = W.ptr(w, O.parent)) if (W.u8(w, O.type) >= 1) return w;
  return null;
}
export function getModalWindow(W, win) {
  for (let w = win; w; w = W.ptr(w, O.parent)) if (W.u8(w, O.type) >= 2) return w;
  return null;
}
export function getRootWindow(W, win) {
  if (!win) return null;
  let w = win;
  for (let parent = W.ptr(w, O.parent); parent; parent = W.ptr(w, O.parent)) w = parent;
  return W.u8(w, O.type) >= 3 ? w : null;
}

/** 0x1004c650/0x1004c680/0x1004c6b0/0x1004c740 sibling/child walks. */
export function lowerSibling(W, win, visibleOnly) {
  let w = W.ptr(win, O.prevSibling);
  if (visibleOnly) while (w && !(W.u8(w, O.flags) & 1)) w = W.ptr(w, O.prevSibling);
  return w;
}
export function higherSibling(W, win, visibleOnly) {
  let w = W.ptr(win, O.nextSibling);
  if (visibleOnly) while (w && !(W.u8(w, O.flags) & 1)) w = W.ptr(w, O.nextSibling);
  return w;
}
export function topChild(W, win, visibleOnly) {
  let w = W.ptr(win, O.lastChild);
  if (visibleOnly) while (w && !(W.u8(w, O.flags) & 1)) w = W.ptr(w, O.prevSibling);
  return w;
}
export function bottomChild(W, win, visibleOnly) {
  let w = W.ptr(win, O.firstChild);
  if (visibleOnly) while (w && !(W.u8(w, O.flags) & 1)) w = W.ptr(w, O.nextSibling);
  return w;
}

/** 0x1004c140 LockWindow / 0x1004c150 UnlockWindow (SafeDestroy leaf). */
export function lockWindow(W, win) { W.setI32(win, O.lock, W.i32(win, O.lock) + 1); }
export function unlockWindow(W, win) {
  const count = W.i32(win, O.lock);
  if (count > 0) W.setI32(win, O.lock, count - 1);
  if (W.u8(win, O.flags) & 0x10) W.native.safeDestroy(win);
}

// ---------------------------------------------------------------------------
// XWindow::QueryPreferredSize helper 0x1004e790
// (int bW, float w, float* outW, int bH, float h, float* outH).
// ---------------------------------------------------------------------------
export function queryPreferredSize(W, win, bW, w, bH, h) {
  let widthSpecified = bW ? 1 : 0, heightSpecified = bH ? 1 : 0;
  w = f(w); h = f(h);
  if (!widthSpecified) {
    const hard = W.f32(win, O.hardWidth);
    if (!c0(hard, 0)) { w = hard; widthSpecified = 1; } else w = -1;
  }
  if (!heightSpecified) {
    const hard = W.f32(win, O.hardHeight);
    if (!c0(hard, 0)) { h = hard; heightSpecified = 1; } else h = -1;
  }
  if (widthSpecified && heightSpecified) return {width: w, height: h};
  const flags = W.u32(win, O.config);
  let outW, outH;
  if (!(flags & 2) && ((flags >>> 3) & 1) === widthSpecified && ((flags >>> 4) & 1) === heightSpecified &&
      c3(w, W.f32(win, O.cacheInW)) && c3(h, W.f32(win, O.cacheInH))) {
    outW = W.f32(win, O.cacheOutW);
    outH = W.f32(win, O.cacheOutH);
  } else {
    W.setF32(win, O.cacheInH, h);
    W.setU32(win, O.config, ((flags & 0xffffffe5) | ((((heightSpecified & 1) << 1) | (widthSpecified & 1)) << 3)) >>> 0);
    W.setF32(win, O.cacheInW, w);
    W.setGlobal('preferredSizeDepth', W.global('preferredSizeDepth') + 1);
    const result = W.v.parentRequestedPreferredSize(win, widthSpecified, w, heightSpecified, h);
    W.setGlobal('preferredSizeDepth', W.global('preferredSizeDepth') - 1);
    outW = widthSpecified ? w : f(result.width);
    outH = heightSpecified ? h : f(result.height);
    W.setF32(win, O.cacheOutH, outH);
    W.setF32(win, O.cacheOutW, outW);
  }
  if (c0(outW, 0)) {
    const texture = W.ptr(win, O.background);
    outW = texture ? f(W.i32(texture, 0x34)) : W.f32(win, O.width);
  }
  if (c0(outH, 0)) {
    const texture = W.ptr(win, O.background);
    outH = texture ? f(W.i32(texture, 0x38)) : W.f32(win, O.height);
  }
  return {width: outW, height: outH};
}
/** 0x1004e5f0 QueryPreferredWidth(queryHeight): helper(0,0,&w,1,queryHeight,0). */
export const queryPreferredWidth = (W, win, height) => queryPreferredSize(W, win, 0, 0, 1, height).width;
/** 0x1004e680 QueryPreferredHeight(queryWidth): helper(1,queryWidth,0,0,0,&h). */
export const queryPreferredHeight = (W, win, width) => queryPreferredSize(W, win, 1, width, 0, 0).height;

/** 0x1004e9e0 QueryGranularity: +0x80 virtual, below-1.0 results clamp to 1.0. */
export function queryGranularity(W, win) {
  const result = W.v.parentRequestedGranularity(win, f(1), f(1));
  let h = f(result.h), v = f(result.v);
  if (c0(h, 1)) h = f(1);
  if (c0(v, 1)) v = f(1);
  return {h, v};
}

// ---------------------------------------------------------------------------
// XWindow::ResizeChild 0x1004eab0.
// ---------------------------------------------------------------------------
export function resizeChild(W, win) {
  const parent = W.ptr(win, O.parent);
  let pw = 0, ph = 0, w = 0, h = 0, bW = 0, bH = 0;
  if (parent) { pw = W.f32(parent, O.width); ph = W.f32(parent, O.height); }
  const hAlign = W.u8(win, O.hAlign);
  if (hAlign === 3) { w = f(pw - (W.f32(win, O.hMargin1) + W.f32(win, O.hMargin0))); bW = 1; }
  if (W.u8(win, O.vAlign) === 3) { h = f(ph - (W.f32(win, O.vMargin1) + W.f32(win, O.vMargin0))); bH = 1; }
  const size = queryPreferredSize(W, win, bW, w, bH, h);
  w = size.width; h = size.height;
  let x, y;
  const h2 = W.u8(win, O.hAlign);
  if (h2 === 1) x = f(ftol((pw - w) * 0.5) + W.f32(win, O.hMargin0));
  else if (h2 === 2) x = f(pw - w - W.f32(win, O.hMargin0));
  else x = W.f32(win, O.hMargin0);
  const v2 = W.u8(win, O.vAlign);
  if (v2 === 1) y = f(ftol((ph - h) * 0.5) + W.f32(win, O.vMargin0));
  else if (v2 === 2) y = f(ph - h - W.f32(win, O.vMargin0));
  else y = W.f32(win, O.vMargin0);
  W.native.configureChild(win, x, y, w, h);
}

// ---------------------------------------------------------------------------
// Visibility / sensitivity / configuration tree walks.
// ---------------------------------------------------------------------------
/** 0x10050d70 RecomputeInitTree(bool): uninitialized windows adjust root initCount. */
export function recomputeInitTree(W, win, visible) {
  if (!(W.u8(win, O.flags) & 8)) {
    const root = getRootWindow(W, win);
    if (root) W.setI32(root, ROOT.initCount, W.i32(root, ROOT.initCount) + (visible ? 1 : -1));
  }
  for (let child = W.ptr(win, O.firstChild); child; child = W.ptr(child, O.nextSibling))
    if (W.u8(child, O.flags) & 1) recomputeInitTree(W, child, visible);
}
/** 0x10050e30 InvokeVisibilityChange(bool): +0x94 virtual, sound, visible children. */
export function invokeVisibilityChange(W, win, visible) {
  W.v.visibilityChanged(win, visible);
  W.native.playSound(win, W.ptr(win, visible ? O.visibleSound : O.invisibleSound), f(-1), f(1));
  for (let child = W.ptr(win, O.firstChild); child; child = W.ptr(child, O.nextSibling))
    if (W.u8(child, O.flags) & 1) invokeVisibilityChange(W, child, visible);
}
/** 0x10050ef0 InvokeSensitivityChange(bool): +0x98 virtual, sensitive children. */
export function invokeSensitivityChange(W, win, sensitive) {
  W.v.sensitivityChanged(win, sensitive);
  for (let child = W.ptr(win, O.firstChild); child; child = W.ptr(child, O.nextSibling))
    if (W.u8(child, O.flags) & 2) invokeSensitivityChange(W, child, sensitive);
}
/** 0x1004e490 InvalidateTreeConfiguration: +0xb8 |= 1 over the subtree. */
export function invalidateTreeConfiguration(W, win) {
  W.setU32(win, O.config, (W.u32(win, O.config) | 1) >>> 0);
  for (let child = W.ptr(win, O.firstChild); child; child = W.ptr(child, O.nextSibling))
    invalidateTreeConfiguration(W, child);
}
/** 0x1004e520 ReconfigureTree(bool bInvalidate). */
export function reconfigureTree(W, win, invalidate) {
  if (invalidate) invalidateTreeConfiguration(W, win);
  let w = win;
  while (w && (W.u8(w, O.flags) & 1)) w = W.ptr(w, O.parent);
  if (w) return; // a hidden ancestor (or self): nothing reconfigures now
  if (W.u8(win, O.config) & 1) W.native.askParentForReconfigure(win);
  for (let child = W.ptr(win, O.firstChild); child; child = W.ptr(child, O.nextSibling))
    reconfigureTree(W, child, 0);
}
/** 0x1004c1d0 MakeAcceleratorTableDirty: modal +0x584 |= 1. */
export function makeAcceleratorTableDirty(W, win) {
  const modal = getModalWindow(W, win);
  if (modal) W.setU32(modal, 0x584, (W.u32(modal, 0x584) | 1) >>> 0);
}

/** 0x1004c460 IsTraversable(bool bCheckModal). */
export function isTraversable(W, win, checkModal) {
  if (!(W.u8(win, O.flags) & 4)) return 0;
  let candidate = null;
  for (let w = win; w; w = W.ptr(w, O.parent)) {
    const flags = W.u32(w, O.flags);
    if (!(flags & 1) || !(flags & 2)) return 0;
    if (checkModal) {
      if (!candidate && W.u8(w, O.type) >= 2) candidate = w;
      if (W.u8(w, O.type) === 3) {
        let modal = topChild(W, w, 1);
        while (modal && W.u8(modal, O.type) < 2) modal = lowerSibling(W, modal, 1);
        if (!modal) modal = w;
        if (modal !== candidate) return 0;
      }
    }
  }
  return 1;
}

/** 0x10050c90 CheckGrabbedWindow: release a grab on a hidden/insensitive window. */
export function checkGrabbedWindow(W, win) {
  const root = getRootWindow(W, win);
  if (!root) return;
  const grabbed = W.ptr(root, ROOT.grabbed);
  if (!grabbed) return;
  let w = grabbed;
  while (w && (W.u8(w, O.flags) & 1)) w = W.ptr(w, O.parent);
  if (!w) {
    let s = grabbed;
    while (s && (W.u8(s, O.flags) & 2)) s = W.ptr(s, O.parent);
    if (!s) return;
  }
  W.v.mouseGrabLost(grabbed, null);
  W.setPtr(root, ROOT.grabbed, null);
}

/**
 * 0x10050b80 CheckFocusWindow. With a root focus window that is no longer
 * traversable the original searches the top modal's preferred focus and then
 * MoveFocus; those branches are explicit boundaries until a focusable window
 * is reachable in Play (the HUD never takes keyboard focus).
 */
export function checkFocusWindow(W, win) {
  const root = getRootWindow(W, win);
  if (!root) return;
  const focus = W.ptr(root, ROOT.focus);
  if (!focus) return;
  if (isTraversable(W, focus, 1)) return;
  W.boundary('XWindow::CheckFocusWindow with an untraversable focus window (MoveFocus 0x1004ef30)');
}

/** 0x1004c390 SetSelectability(bool). */
export function setSelectability(W, win, selectable) {
  const bit = selectable ? 1 : 0;
  if (((W.u32(win, O.flags) >>> 2) & 1) === bit) return;
  const tabGroup = getTabGroupWindow(W, win);
  W.setU32(win, O.flags, ((W.u32(win, O.flags) & ~4) | (bit << 2)) >>> 0);
  checkFocusWindow(W, win);
  if (!tabGroup) W.boundary('XWindow::SetSelectability without a tab-group ancestor');
  if (W.u8(win, O.flags) & 4) W.native.addWindowToTables(tabGroup, win);
  else W.native.removeWindowFromTables(tabGroup, win);
  if (W.i32(win, O.acceleratorKey)) makeAcceleratorTableDirty(W, win);
}

// ---------------------------------------------------------------------------
// Root window: ResizeRoot 0x1003adf0, ConfigurationChanged 0x1003a660,
// ChildRequestedReconfiguration 0x1003a6d0, ClampMousePosition 0x1003bde0.
// ---------------------------------------------------------------------------
const H_SCALE = f(0.0015625000232830644); // float 0x1006147c (1/640)
const V_SCALE = f(0.0020833334419876337); // float 0x10061478 (1/480)

export function resizeRoot(W, root, canvas) {
  if (!canvas) return;
  const clipX = W.f32(canvas, 0x3c), clipY = W.f32(canvas, 0x40);
  let hm = ftol(clipX * H_SCALE), vm = ftol(clipY * V_SCALE);
  if (hm < 1) hm = 1;
  if (vm < 1) vm = 1;
  if (vm < hm) hm = vm; else if (vm > hm) vm = hm;
  const width = f(clipX / hm);
  W.setI32(root, ROOT.vMultiplier, vm);
  W.setF32(root, O.x, 0); W.setF32(root, O.y, 0);
  W.setU8(root, O.hAlign, 0); W.setU8(root, O.vAlign, 0);
  for (const offset of [O.hMargin0, O.hMargin1, O.vMargin0, O.vMargin1]) W.setF32(root, offset, 0);
  W.setI32(root, ROOT.hMultiplier, hm);
  const height = f(clipY / vm);
  W.setF32(root, O.hardWidth, width);
  W.setF32(root, O.hardHeight, height);
  if (!c3(width, W.f32(root, O.width)) || !c3(height, W.f32(root, O.height)))
    W.native.configureChild(root, 0, 0, width, height);
  clampMousePosition(W, root);
}
export function clampMousePosition(W, root) {
  const maxX = f(W.f32(root, O.width) + W.f32(root, O.x) - 1), x = W.f32(root, O.x);
  let mouseX = W.f32(root, ROOT.mouseX);
  if (!c0(mouseX, x)) mouseX = c0(mouseX, maxX) ? mouseX : maxX; else mouseX = x;
  W.setF32(root, ROOT.mouseX, mouseX);
  const maxY = f(W.f32(root, O.height) + W.f32(root, O.y) - 1), y = W.f32(root, O.y);
  const mouseY = W.f32(root, ROOT.mouseY);
  W.setF32(root, ROOT.mouseY, c0(mouseY, y) ? y : c0(mouseY, maxY) ? mouseY : maxY);
}
/** XRootWindow::ChildRequestedReconfiguration: script event with a zero return. */
export const rootChildRequestedReconfiguration = (W, root, child) =>
  W.processScript(root, 'ChildRequestedReconfiguration', [child], {result: 0});

// ---------------------------------------------------------------------------
// Ticking: XRootWindow::RootTick 0x1003be90 / TickTree 0x1003bfc0,
// XWindow::InvokeTimers 0x10051340, InitializeWindows 0x1003bc80.
// ---------------------------------------------------------------------------
export function tickTree(W, win, delta) {
  if (!win) return;
  lockWindow(W, win);
  try {
    tickTree(W, higherSibling(W, win, 0), delta);
    if (W.u8(win, O.flags) & 0x10) return;
    W.v.tick(win, delta);
    if (W.u8(win, O.flags) & 0x10) return;
    if (W.u8(win, O.tick) & 1) W.processScript(win, 'Tick', [f(delta)]);
    if (W.u8(win, O.flags) & 0x10) return;
    invokeTimers(W, win, delta);
    if (W.u8(win, O.flags) & 0x10) return;
    tickTree(W, bottomChild(W, win, 0), delta);
  } finally {
    unlockWindow(W, win);
  }
}
export function invokeTimers(W, win, delta) {
  if (W.u8(win, O.flags) & 0x10) return;
  lockWindow(W, win);
  try {
    if (W.u32(win, O.firstTimer)) W.boundary('XWindow::InvokeTimers with an armed AddTimer timer (0x10051340)');
  } finally { unlockWindow(W, win); }
}
export function rootTick(W, root, delta) {
  lockWindow(W, root);
  try {
    W.setI32(root, ROOT.tickCycles, 0);
    tickTree(W, root, delta);
    if (W.u8(root, ROOT.debugFlags) & 2) W.boundary('XRootWindow::RootTick debug frame timer (bShowFrames)');
  } finally { unlockWindow(W, root); }
}
export function initializeWindows(W, root) {
  if (W.i32(root, ROOT.initCount) > 0) invokeWindowReady(W, root, root);
  if (W.i32(root, ROOT.initCount) !== 0)
    W.boundary('XRootWindow::InitializeWindows initCount assertion (0x1003bcc4)');
}
export function invokeWindowReady(W, root, win) {
  for (let child = bottomChild(W, win, 1); child; child = higherSibling(W, child, 1)) invokeWindowReady(W, root, child);
  if (!(W.u8(win, O.flags) & 8)) {
    W.processScript(win, 'WindowReady', [], {checked: true});
    W.setU32(win, O.flags, (W.u32(win, O.flags) | 8) >>> 0);
    W.setI32(root, ROOT.initCount, W.i32(root, ROOT.initCount) - 1);
  }
}

// ---------------------------------------------------------------------------
// Drawing: XWindow::DrawTree 0x10051490 and XRootWindow::PaintWindows
// 0x1003aab0 (without the debug-frame and statistics overlays, which are
// explicit boundaries when their root flags are set).
// ---------------------------------------------------------------------------
export function drawTree(W, win, canvas, debugTexture, frameTimer, hMultiplier, vMultiplier) {
  lockWindow(W, win);
  try {
    const gc = W.ptr(win, O.gGc);
    if (!canvas || !gc || !(W.u8(win, O.flags) & 1)) return;
    if (c0(W.f32(win, O.clipW), 0) || c3(W.f32(win, O.clipW), 0)) return;
    if (c0(W.f32(win, O.clipH), 0) || c3(W.f32(win, O.clipH), 0)) return;
    W.canvasComputeRenderSize(canvas);
    const saved = W.gc.push(gc);
    W.gc.setCanvas(gc, canvas);
    W.gc.setMultipliers(gc, hMultiplier, vMultiplier);
    const texture = W.ptr(win, O.background);
    if (W.u8(win, O.backgroundStyle) && texture) {
      const stretch = W.u32(win, O.surface) & 2;
      const vl = stretch ? W.i32(texture, 0x38) : 0, ul = stretch ? W.i32(texture, 0x34) : 0;
      W.gc.drawIconPattern(gc, 0, 0, W.f32(win, O.width), W.f32(win, O.height), 0, 0, f(ul), f(vl), texture);
    }
    W.setGlobal('granularityDepth', W.global('granularityDepth') + 1);
    W.v.draw(win, gc);
    for (let child = W.ptr(win, O.firstChild); child; child = W.ptr(child, O.nextSibling))
      drawTree(W, child, canvas, debugTexture, frameTimer, hMultiplier, vMultiplier);
    W.v.postDraw(win, gc);
    W.setGlobal('granularityDepth', W.global('granularityDepth') - 1);
    if (debugTexture) W.boundary('XWindow::DrawTree debug frames (bShowFrames)');
    W.gc.pop(gc, saved);
  } finally {
    unlockWindow(W, win);
  }
}

export function paintWindows(W, root, canvas) {
  const gc = W.ptr(root, O.gGc);
  if (!canvas || !gc) return;
  getMouseWindow(W, root);
  W.setI32(root, ROOT.paintCycles, 0);
  const saved = W.gc.push(gc);
  W.gc.setCanvas(gc, canvas);
  W.gc.setMultipliers(gc, W.i32(root, ROOT.hMultiplier), W.i32(root, ROOT.vMultiplier));
  drawRawBackground(W, root, gc, W.ptr(root, ROOT.rawBackground), W.u32(root, ROOT.rawColor));
  const debugTexture = (W.u32(root, ROOT.debugFlags) & 2) ? W.ptr(root, ROOT.debugTexture) : null;
  const frameTimer = f(W.f32(root, ROOT.frameTimer) / 1);
  drawTree(W, root, canvas, debugTexture, frameTimer, W.i32(root, ROOT.hMultiplier), W.i32(root, ROOT.vMultiplier));
  W.gc.pop(gc, saved);
  const saved2 = W.gc.push(gc);
  W.gc.enableDrawing(gc, 1);
  W.gc.setCanvas(gc, canvas);
  W.gc.setMultipliers(gc, W.i32(root, ROOT.hMultiplier), W.i32(root, ROOT.vMultiplier));
  if (W.i32(root, ROOT.handleMouseRef) && (W.u8(root, ROOT.mouseFlags) & 8))
    W.boundary('XRootWindow::PaintWindows cursor drawing (QueryCursor 0x1004f910)');
  if (W.u8(root, ROOT.debugFlags) & 1) W.boundary('XRootWindow::PaintWindows statistics overlay (bShowStats)');
  W.gc.pop(gc, saved2);
  W.gc.cleanUp();
}

/**
 * 0x1003b0d0 GetMouseWindow(modal, &x, &y): the mouse window only feeds the
 * cursor branch of PaintWindows. Its hit test is reached only when that
 * branch draws, so it is evaluated lazily there (see paintWindows).
 */
function getMouseWindow() { return null; }

/**
 * 0x1003c720 DrawRawBackground: raw backgrounds fill the unrendered area
 * outside the 3D view. Play renders the whole viewport (bRender set, no
 * render clip) and DeusExRootWindow leaves rawBackground unset, so the body
 * returns before its clip-list work; any other configuration is a boundary.
 */
function drawRawBackground(W, root, gc, texture) {
  if (!texture) return;
  W.boundary('XRootWindow::DrawRawBackground with a raw background texture (0x1003c720)');
}
