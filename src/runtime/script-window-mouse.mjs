/**
 * Recovered Extension.dll mouse position, hit testing and show-area requests:
 * XWindow::SetCursorPos 0x1004cca0, XRootWindow::SetRootCursorPos 0x10039d80,
 * ProcessMouseMove 0x1003af50, GetMouseWindow 0x1003b0d0, XWindow::
 * FindWindowByPoint 0x1004f740, IsPointInWindow 0x1004f830,
 * AskParentToShowArea 0x1004e230, XClipRect::Intersect 0x10002b10 and
 * ConvertCoordinates 0x1004fbe0, plus the virtuals they reach (vtable +0x60,
 * +0x8c, +0x9c..+0xb4) for the admitted window families. SetFocusWindow itself
 * is the existing translation in script-window-focus.mjs; setFocusWindow()
 * below supplies its leaves.
 *
 * x87: sums the original keeps on the register stack across compares are
 * carried as 80-bit values (script-vm.mjs), and each fstp rounds once.
 * W: the tree-natives world plus W.v (the virtuals), W.processScript and
 * W.native.playSound. Evidence and oracle: docs/script-window-input.md,
 * scripts/native-window-mouse-focus-oracle.py,
 * scripts/validate-window-mouse-focus-diff.mjs.
 */
import {x87load, x87add, x87neg, x87store} from './script-vm.mjs';
import {getRootWindow, isTraversable, topChild, lowerSibling, clampMousePosition} from './script-window-tree-natives.mjs';
import {setFocusWindowNative} from './script-window-focus.mjs';

const f = Math.fround;
export const MOUSE = Object.freeze({
  type: 0x28, flags: 0x30, x: 0x78, y: 0x7c, width: 0x80, height: 0x84, clip: 0xd4,
  parent: 0x138, lastChild: 0x140, prevSibling: 0x144,
  mouseX: 0x590, mouseY: 0x594, lastX: 0x598, lastY: 0x59c, mouseWindow: 0x5a0, mouseFlags: 0x5a4,
  grabbed: 0x5c4, focus: 0x5c8, focusMode: 0x174, buttonFlags: 0x174,
});
const M = MOUSE;
const L = x87load;
// Exact order of two x87 values: -1, 0, 1, or NaN when unordered.
function order(a, b) {
  if (a.nan !== undefined || b.nan !== undefined) return NaN;
  if (a.inf || b.inf) return Math.sign((a.inf ? (a.neg ? -1 : 1) : 0) - (b.inf ? (b.neg ? -1 : 1) : 0));
  const low = a.exp < b.exp ? a.exp : b.exp;
  const A = (a.neg ? -1n : 1n) * (a.sig << BigInt(a.exp - low)), B = (b.neg ? -1n : 1n) * (b.sig << BigInt(b.exp - low));
  return A < B ? -1 : A > B ? 1 : 0;
}
// fcom condition codes: C0 = below or unordered; C0|C3 = below, equal or unordered.
const below = (a, b) => { const c = order(a, b); return c < 0 || Number.isNaN(c); };
const notAbove = (a, b) => { const c = order(a, b); return c <= 0 || Number.isNaN(c); };
const sub = (a, b) => x87add(a, x87neg(b));
const fadd = (a, b) => x87store(x87add(L(a), L(b)));
const fsub = (a, b) => x87store(sub(L(a), L(b)));
const clipRect = (W, win) => ({ox: W.f32(win, M.clip), oy: W.f32(win, M.clip + 4), cx: W.f32(win, M.clip + 8),
  cy: W.f32(win, M.clip + 12), cw: W.f32(win, M.clip + 16), ch: W.f32(win, M.clip + 20)});

/** XClipRect::Intersect 0x10002b10: `a` is this, `b` the other; updates a. */
export function clipRectIntersect(a, b) {
  let left = fadd(a.ox, a.cx), top = fadd(a.oy, a.cy);
  const otherLeft = fadd(b.cx, b.ox), otherTop = fadd(b.cy, b.oy);
  let right = fadd(left, a.cw);
  const bottom1 = x87add(L(top), L(a.ch)), right2 = x87add(L(otherLeft), L(b.cw));
  const bottom2 = fadd(otherTop, b.ch);
  if (below(L(left), L(otherLeft))) left = otherLeft;
  if (below(L(top), L(otherTop))) top = otherTop;
  if (!notAbove(L(right), right2)) right = x87store(right2);
  const bottom = notAbove(bottom1, L(bottom2)) ? bottom1 : L(bottom2);
  a.cx = fsub(left, a.ox);
  a.cy = fsub(top, a.oy);
  a.cw = fsub(right, left);
  a.ch = x87store(sub(bottom, L(top)));
  return a;
}

/** XWindow::ConvertCoordinates 0x1004fbe0 (static): from-window to to-window. */
export function convertCoordinates(W, from, x, y, to) {
  return {x: x87store(sub(x87add(L(x), L(W.f32(from, M.clip))), L(W.f32(to, M.clip)))),
    y: x87store(sub(x87add(L(y), L(W.f32(from, M.clip + 4))), L(W.f32(to, M.clip + 4))))};
}

/** XWindow::AskParentToShowArea 0x1004e230(x, y, w, h). */
export function askParentToShowArea(W, win, x, y, w, h) {
  if (!W.ptr(win, M.parent)) return;
  let hidden = win;
  while (hidden && (W.u8(hidden, M.flags) & 1)) hidden = W.ptr(hidden, M.parent);
  if (hidden) return;
  const ox = W.f32(win, M.clip), oy = W.f32(win, M.clip + 4);
  const a = {ox, oy, cx: 0, cy: 0, cw: W.f32(win, M.width), ch: W.f32(win, M.height)};
  clipRectIntersect(a, {ox: fadd(ox, x), oy: fadd(oy, y), cx: 0, cy: 0, cw: f(w), ch: f(h)});
  if (notAbove(L(a.cw), L(0)) || notAbove(L(a.ch), L(0))) return;
  const c = clipRect(W, win);
  let left = fadd(c.cx, c.ox), top = fadd(c.oy, c.cy);
  const areaLeft = fadd(a.ox, a.cx), areaTop = fadd(a.oy, a.cy);
  const shownRight = x87add(L(left), L(c.cw));
  let bottom = fadd(top, c.ch);
  const areaRight = fadd(areaLeft, a.cw), areaBottom = fadd(areaTop, a.ch);
  if (below(L(left), L(areaLeft))) left = areaLeft;
  if (below(L(top), L(areaTop))) top = areaTop;
  const right = notAbove(shownRight, L(areaRight)) ? shownRight : L(areaRight);
  if (!notAbove(L(bottom), L(areaBottom))) bottom = areaBottom;
  const width = sub(right, L(left)), height = fsub(bottom, top);
  if (!below(width, L(a.cw)) && !below(L(height), L(a.ch))) return;
  W.v.childRequestedShowArea(W.ptr(win, M.parent), win, a.cx, a.cy, a.cw, a.ch);
  const parent = W.ptr(win, M.parent);
  if (!parent) return;
  const converted = convertCoordinates(W, win, a.cx, a.cy, parent);
  askParentToShowArea(W, W.ptr(win, M.parent), converted.x, converted.y, a.cw, a.ch);
}

/** XWindow::IsPointInWindow 0x1004f830(x, y). */
export function isPointInWindow(W, win, x, y) {
  if (!(x >= 0) || x >= W.f32(win, M.width) || !(y >= 0) || y >= W.f32(win, M.height)) return 0;
  return W.v.queryPointInWindow(win, x, y) ? 1 : 0;
}

/** XWindow::FindWindowByPoint 0x1004f740(x, y) -> {win, x, y} or null. */
export function findWindowByPoint(W, win, x, y) {
  const flags = W.u8(win, M.flags);
  if (!(flags & 1) || !(flags & 2) || !isPointInWindow(W, win, x, y)) return null;
  for (let child = W.ptr(win, M.lastChild); child; child = W.ptr(child, M.prevSibling)) {
    if (W.u8(child, M.type) >= 2) continue;
    const hit = findWindowByPoint(W, child, fsub(x, W.f32(child, M.x)), fsub(y, W.f32(child, M.y)));
    if (hit) return hit;
  }
  return {win, x, y};
}

// The topmost visible type>=2 child, else the root (GetTopChild/GetLowerSibling(1)).
function topModal(W, root) {
  let modal = topChild(W, root, 1);
  while (modal && W.u8(modal, M.type) < 2) modal = lowerSibling(W, modal, 1);
  return modal ?? root;
}

/** XRootWindow::GetMouseWindow 0x1003b0d0(modal) -> {win, x, y}. */
export function getMouseWindow(W, root, modal = null) {
  modal ??= topModal(W, root);
  let win = W.ptr(root, M.grabbed);
  if (!win) {
    const hit = findWindowByPoint(W, modal, fsub(W.f32(root, M.mouseX), W.f32(modal, M.clip)),
      fsub(W.f32(root, M.mouseY), W.f32(modal, M.clip + 4)));
    win = hit ? hit.win : modal;
  }
  if (!win) return {win: null, x: W.f32(root, M.mouseX), y: W.f32(root, M.mouseY)};
  return {win, x: fsub(W.f32(root, M.mouseX), W.f32(win, M.clip)), y: fsub(W.f32(root, M.mouseY), W.f32(win, M.clip + 4))};
}

// fcomp + `test ah,0x40`: C3 is set for equal or unordered operands.
const same = (a, b) => a === b || Number.isNaN(a) || Number.isNaN(b);

/** XRootWindow::ProcessMouseMove 0x1003af50. */
export function processMouseMove(W, root) {
  if (!(W.u8(root, M.mouseFlags) & 1)) return;
  const modal = topModal(W, root);
  const {win} = getMouseWindow(W, root, modal);
  const old = W.ptr(root, M.mouseWindow);
  if (old !== win) {
    if (old) {
      W.v.mouseLeftWindow(old);
      if (W.u8(modal, M.focusMode) >= 3) setFocusWindow(W, root, null);
    }
    if (win) {
      W.v.mouseEnteredWindow(win);
      if (W.u8(modal, M.focusMode) >= 2) setFocusWindow(W, root, win);
    }
    W.setPtr(root, M.mouseWindow, win);
  }
  if (!same(W.f32(root, M.lastX), W.f32(root, M.mouseX)) || !same(W.f32(root, M.lastY), W.f32(root, M.mouseY))) {
    if (win) W.v.mouseMoved(win, fsub(W.f32(root, M.mouseX), W.f32(win, M.clip)),
      fsub(W.f32(root, M.mouseY), W.f32(win, M.clip + 4)));
    W.setU32(root, M.lastX, W.u32(root, M.mouseX));
    W.setU32(root, M.lastY, W.u32(root, M.mouseY));
  }
  W.setU32(root, M.mouseFlags, W.u32(root, M.mouseFlags) & ~1);
}

/** XRootWindow::SetRootCursorPos 0x10039d80(x, y). */
export function setRootCursorPos(W, root, x, y) {
  W.setF32(root, M.mouseX, x);
  W.setF32(root, M.mouseY, y);
  W.setU32(root, M.mouseFlags, W.u32(root, M.mouseFlags) | 1);
  clampMousePosition(W, root);
  processMouseMove(W, root);
}

/** XWindow::SetCursorPos 0x1004cca0(x, y), native 1453 (exec 0x10052b90). */
export function setCursorPos(W, win, x, y) {
  const root = getRootWindow(W, win);
  if (!root) return;
  setRootCursorPos(W, root, fadd(f(x), W.f32(win, M.clip)), fadd(f(y), W.f32(win, M.clip + 4)));
}

/** XWindow::SetFocusWindow 0x1004f0e0 through the existing translation, with
 * its leaves bound to the recovered bodies: IsTraversable 0x1004c460,
 * AskParentToShowArea 0x1004e230, PlaySound 0x1004ffb0 and the focus virtuals. */
export function setFocusWindow(W, win, target) {
  return setFocusWindowNative(win, target ?? null, focusServices(W));
}
/** The setFocusWindowNative service table over a window world W (also the
 * Play host's native 1440 lifecycle.focus). */
export function focusServices(W) {
  const slots = {0xa8: 'focusEnteredWindow', 0xac: 'focusLeftWindow', 0xb0: 'focusEnteredDescendant', 0xb4: 'focusLeftDescendant'};
  return {
    read: (object, offset, kind) => W.heap.read(object, offset, kind),
    write: (object, offset, kind, value) => W.heap.write(object, offset, kind, value),
    checkFocusable: ({object, flag}) => isTraversable(W, object, flag),
    focusGeometry: ({object}) => askParentToShowArea(W, object, 0, 0, W.f32(object, M.width), W.f32(object, M.height)),
    // The +0x104/+0x108 sound dword read by the translation, as its heap identity.
    focusTween: ({object, argument}) => W.native.playSound(object, argument ? W.heap.objectAt(argument) : null, -1, 1),
    dispatchVirtual: ({object, slot, argument}) => {
      const name = slots[slot];
      if (!name) throw new Error(`SetFocusWindow reached unknown virtual +0x${slot.toString(16)}`);
      return argument === null ? W.v[name](object) : W.v[name](object, argument);
    },
  };
}

/** Mouse/focus virtuals for the admitted families. Every admitted vtable keeps
 * XWindow's QueryPointInWindow 0x10003430 (returns 1), MouseEntered/LeftWindow
 * 0x10003680/0x10003690, Focus*Descendant 0x100036c0/0x100036e0 and
 * ChildRequestedShowArea 0x100035b0; Button/Toggle override MouseMoved
 * 0x10007e30 and FocusEntered/LeftWindow 0x10007fc0/0x10008050. */
const COLOR_KEYS = ['r', 'g', 'b', 'a'].map(k => `core.object.color.${k}`);
const unpackColor = n => Object.fromEntries(COLOR_KEYS.map((k, i) => [k, (n >>> (8 * i)) & 255]));
const packColor = c => COLOR_KEYS.reduce((n, k, i) => n | ((c?.[k] ?? 0) & 255) << (8 * i), 0) >>> 0;

export function mouseFocusVirtuals(W, {familyOf, processScript, changeButtonAppearance, boundary}) {
  const button = win => ['extension.buttonwindow', 'extension.togglewindow'].includes(familyOf(win));
  const script = (win, name, args = [], options) => processScript(win, name, args, options);
  return {
    queryPointInWindow: () => 1,
    mouseMoved(win, x, y) {
      script(win, 'MouseMoved', [x, y]);
      if (!button(win) || !(W.u8(win, M.buttonFlags) & 2)) return;
      const inside = (W.u8(win, M.flags) & 1) && isPointInWindow(W, win, x, y);
      W.setU32(win, M.buttonFlags, inside ? W.u32(win, M.buttonFlags) | 1 : W.u32(win, M.buttonFlags) & ~1);
      changeButtonAppearance(win);
    },
    mouseEnteredWindow: win => script(win, 'MouseEnteredWindow'),
    mouseLeftWindow: win => script(win, 'MouseLeftWindow'),
    focusEnteredWindow(win) { script(win, 'FocusEnteredWindow'); if (button(win)) changeButtonAppearance(win); },
    focusLeftWindow(win) { script(win, 'FocusLeftWindow'); if (button(win)) changeButtonAppearance(win); },
    focusEnteredDescendant: (win, child) => script(win, 'FocusEnteredDescendant', [child]),
    focusLeftDescendant: (win, child) => script(win, 'FocusLeftDescendant', [child]),
    childRequestedShowArea: (win, child, x, y, w, h) => script(win, 'ChildRequestedShowArea', [child, x, y, w, h]),
    rawMouseButtonPressed: (win,x,y,key,action)=>script(win,'RawMouseButtonPressed',
      [x,y,key&0xff,action&0xff],{result:false})?1:0,
    mouseButtonPressed: (win,x,y,key,count)=>script(win,'MouseButtonPressed',
      [x,y,key&0xff,count],{result:false})?1:0,
    mouseButtonReleased: (win,x,y,key,count)=>script(win,'MouseButtonReleased',
      [x,y,key&0xff,count],{result:false})?1:0,
    // vtable +0x64: XWindow::CursorRequested 0x10003440 copies hotX, hotY and
    // newColor back. It seeds shadowTexture with the caller's pointer value and
    // never copies it back, so a script's shadow is discarded (passed as None here).
    cursorRequested(win, source, x, y, hotX, hotY, color) {
      const args = [source, x, y, hotX, hotY, unpackColor(color), null];
      const texture = processScript(win, 'CursorRequested', args, {result: null}) ?? null;
      return {texture, hotX: f(args[3]), hotY: f(args[4]), color: packColor(args[5])};
    },
  };
}

/** XWindow::MoveFocus 0x1004ef30(direction EMove, bWrap) -> the root focus.
 * `moveTabGroup(root, direction)` is XWindow::MoveTabGroup 0x1004f440
 * (script-window-root-tick.mjs). */
export function moveFocus(W, win, direction, wrap, {getTabGroupWindow, moveTabGroup}) {
  const root = getRootWindow(W, win);
  if (!root) return null;
  const focus = W.ptr(root, M.focus);
  if (!focus) { moveTabGroup(root, direction); return W.ptr(root, M.focus); }
  const group = getTabGroupWindow(W, focus);
  if (!group) return W.ptr(root, M.focus);
  if (!wrap) wrap = (W.u32(group, 0x164) >>> 2) & 1;
  const rowMajor = direction === 0 || direction === 1;
  const table = rowMajor ? 0x14c : 0x158;
  let index = W.i32(focus, rowMajor ? 0x11c : 0x120);
  if (index < 0) throw new Error('XWindow::MoveFocus assertion (line 0x91a): tab index is negative');
  const start = index, count = W.farray.num(group, table);
  let backward = direction === 0 || direction === 2;
  for (let remaining = count; ; ) {
    if (backward) {
      if (--index < 0) { if (wrap) index = count - 1; else { index = start; backward = false; } }
    } else if (++index >= count) { if (wrap) index = 0; else { index = start; backward = true; } }
    const candidate = W.farray.ptr(group, table, index);
    if (isTraversable(W, candidate, 1)) { setFocusWindow(W, root, candidate); break; }
    if (--remaining <= 0) { moveTabGroup(root, direction); break; }
  }
  return W.ptr(root, M.focus);
}

/** XWindow::QueryCursor 0x1004f910(x, y) from the mouse window up its parents:
 * the CursorRequested virtual (+0x64), else the default cursor (+0xf0..+0x100),
 * moving the point into each parent. A hot spot that is negative, NaN or not
 * inside the texture becomes (USize >> 1) - 1 / (VSize >> 1) - 1. */
export function queryCursor(W, win, x, y) {
  for (let w = win; w; w = W.ptr(w, M.parent)) {
    // FColor(255,255,255) in a stack slot whose alpha byte is never written; the
    // cursor draw reads only RGB, so it is modelled as 0.
    let hotX = -1, hotY = -1, color = 0x00ffffff, shadow = null;
    let cursor = null;
    const requested = W.v.cursorRequested(w, win, x, y, hotX, hotY, color);
    // XEditWindow::CursorRequested also writes the shadow out parameter.
    if (requested.shadow !== undefined) shadow = requested.shadow;
    if (requested.texture) ({texture: cursor, hotX, hotY, color} = requested);
    else {
      cursor = W.ptr(w, 0xf0);
      if (cursor) { shadow = W.ptr(w, 0xf4); hotX = W.f32(w, 0xf8); hotY = W.f32(w, 0xfc); color = W.u32(w, 0x100); }
    }
    if (cursor) {
      const fit = (hot, size) => !(hot >= 0) || !(size > hot) ? f((size >> 1) - 1) : hot;
      return {cursor, shadow, color, hotX: fit(hotX, W.i32(cursor, 0x34)), hotY: fit(hotY, W.i32(cursor, 0x38))};
    }
    x = fadd(x, W.f32(w, M.x)); y = fadd(y, W.f32(w, M.y));
  }
  return null;
}

/** The cursor branch of XRootWindow::PaintWindows 0x1003ac0a-0x1003acb8: with
 * a mouse grab and ShowCursor (+0x5a4 bit 3), draw the queried cursor at the
 * mouse position less its hot spot: the shadow in style 4, then the cursor in
 * style 2 with its tile colour. `mouse` is PaintWindows' GetMouseWindow. */
export function paintCursor(W, root, gc, mouse) {
  const found = mouse?.win ? queryCursor(W, mouse.win, mouse.x, mouse.y) : null;
  if (!found) return;
  const x = fsub(W.f32(root, M.mouseX), found.hotX), y = fsub(W.f32(root, M.mouseY), found.hotY);
  if (found.shadow) { W.gc.setStyle(gc, 4); W.gc.drawIcon(gc, x, y, found.shadow); }
  W.gc.setStyle(gc, 2);
  W.gc.setTileColor(gc, found.color);
  W.gc.drawIcon(gc, x, y, found.cursor);
}
