/** Extension.dll XRootWindow raw background (docs/conversation-camera.md,
 * "Raw background"): the area of the root window that neither the 3D view nor
 * an opaque window covers is filled with rawBackground at rawColor.
 *
 *   DrawRawBackground          0x1003c720
 *   GetRawBackgroundClipList   0x1003c5f0
 *   clip list reset            0x1003c0c0 (Empty, then add one rect)
 *   clip list subtract         0x1003c1d0
 *   GetBottomChild(1)          0x1004c740, GetHigherSibling(1) 0x1004c680
 *
 * An XClipRect is the six dwords of XWindow +0xd4: originX, originY, clipX,
 * clipY, clipWidth, clipHeight. Rects are kept as raw u32 bits (the original
 * copies them with rep movsd); the arithmetic follows each fld/fadd/fsub/fstp
 * on the x87 model, keeping the values the original holds on the FPU stack in
 * the register. DrawRawBackground runs from PaintWindows, inside the render
 * pass, so each FADD and FSUB rounds to 24 bits (x87 precision control 24,
 * x87-pc24.mjs; docs/render-pass-precision.md) and those register values are
 * 24-bit. Checked against the DLL at 0x007f by
 * scripts/validate-root-raw-background.mjs.
 */
import {O, ROOT, bottomChild, higherSibling} from './script-window-tree-natives.mjs';
import {x87load, x87neg as N, x87store, x87cmp} from './script-vm.mjs';
import {p24add as A} from './x87-pc24.mjs';
import {gcDrawPattern} from './script-gc-draw-pattern.mjs';
import {gcDrawStretchedTexture} from './script-gc-draw-stretched-texture.mjs';
import {gcPushGC} from './script-gc-push-gc.mjs';
import {gcPopGC} from './script-gc-pop-gc.mjs';
import {gcEnableDrawing} from './script-gc-enable-drawing.mjs';
import {gcSetStyle} from './script-gc-set-style.mjs';
import {gcSetTileColor} from './script-gc-set-tile-color.mjs';

const io = new DataView(new ArrayBuffer(4));
const bitsOf = value => { io.setFloat32(0, value, true); return io.getUint32(0, true); };
/** FLD m32 of a dword. */
export const ld = bits => {
  bits >>>= 0;
  if ((bits & 0x7f800000) === 0x7f800000 && (bits & 0x7fffff)) return {nan: bits};
  io.setUint32(0, bits, true);
  return x87load(io.getFloat32(0, true));
};
/** FSTP m32: the stored dword. */
export const st = v => v.nan !== undefined ? v.nan >>> 0 : bitsOf(x87store(v));
const ZERO = ld(0);
// fcomp; fnstsw; test ah,1 (C0: below or unordered) and test ah,0x41.
const below = (a, b) => { const r = x87cmp(a, b); return r === 'lt' || r === 'un'; };
const positive = bits => x87cmp(ld(bits), ZERO) === 'gt';
const sub = (a, b) => A(a, N(b));

/** 0x1003c1d0: remove `cut` (a rect) from every rect of `list` (an array of
 * six-dword arrays), in place. Only the rects present on entry are cut; each
 * cut rect becomes up to four strips (top, bottom, left, right), the first
 * nonempty one replacing it and the rest appended; empty rects are then
 * compacted out in order. */
export function subtractClipRect(cut, list) {
  const count = list.length;
  for (let i = 0; i < count; i++) {
    const R = list[i], C = R.slice();
    let left = st(A(ld(C[0]), ld(C[2])));
    let top = st(A(ld(C[1]), ld(C[3])));
    const cutLeft = st(A(ld(cut[2]), ld(cut[0])));
    const cutTop = st(A(ld(cut[3]), ld(cut[1])));
    let right = st(A(ld(left), ld(C[4])));
    let bottom = A(ld(top), ld(C[5]));
    const cutRight = A(ld(cutLeft), ld(cut[4]));
    const cutBottom = st(A(ld(cutTop), ld(cut[5])));
    if (below(ld(left), ld(cutLeft))) left = cutLeft;
    if (below(ld(top), ld(cutTop))) top = cutTop;
    if (x87cmp(ld(right), cutRight) === 'gt') right = st(cutRight);
    if (x87cmp(bottom, ld(cutBottom)) === 'gt') bottom = ld(cutBottom);
    C[2] = st(sub(ld(left), ld(C[0])));
    C[3] = st(sub(ld(top), ld(C[1])));
    C[4] = st(sub(ld(right), ld(left)));
    C[5] = st(sub(bottom, ld(top)));
    if (!positive(C[4]) || !positive(C[5])) continue;
    const rRight = A(ld(R[4]), ld(R[2]));
    const cRight = A(ld(C[4]), ld(C[2]));
    const rBottom = A(ld(R[5]), ld(R[3]));
    const cBottom = st(A(ld(C[5]), ld(C[3])));
    const ox = st(ld(C[0])), oy = st(ld(C[1]));
    const pieces = [
      [ox, oy, st(ld(R[2])), st(ld(R[3])), st(ld(R[4])), st(sub(ld(C[3]), ld(R[3])))],
      [ox, oy, st(ld(R[2])), cBottom, st(ld(R[4])), st(sub(rBottom, ld(cBottom)))],
      [ox, oy, st(ld(R[2])), st(ld(C[3])), st(sub(ld(C[2]), ld(R[2]))), st(ld(C[5]))],
      [ox, oy, st(cRight), st(ld(C[3])), st(sub(rRight, cRight)), st(ld(C[5]))],
    ];
    R[5] = 0;
    let first = true;
    for (const piece of pieces) {
      if (!positive(piece[4]) || !positive(piece[5])) continue;
      if (first) { list[i] = piece; first = false; }
      else list.push(piece);
    }
  }
  let kept = 0;
  for (const rect of list) if (positive(rect[4]) && positive(rect[5])) list[kept++] = rect;
  list.length = kept;
  return list;
}

const clipRect = (W, win) => Array.from({length: 6}, (_, i) => W.u32(win, O.clip + 4 * i));

/** 0x1003c5f0 GetRawBackgroundClipList(win, list): for win = NULL the list
 * restarts as the root's clip rect less the rendered area (bRender, bit 0 of
 * +0x5d8: all of it, or with bClipRender, bit 1, the renderX/Y/Width/Height
 * rect at +0x5dc..+0x5e8 in the root's origin). A window with
 * bDrawRawBackground (+0x38 bit 0) passes the list to its visible children,
 * bottom to top; any other window removes its own clip rect. */
export function rawBackgroundClipList(W, root, win = null, list = []) {
  if (!win) {
    win = root;
    list.length = 0;
    list.push(clipRect(W, root));
    const flags = W.u32(root, ROOT.renderFlags);
    if (flags & 1) {
      const rect = clipRect(W, root);
      if (flags & 2) for (let i = 0; i < 4; i++) rect[2 + i] = W.u32(root, 0x5dc + 4 * i);
      subtractClipRect(rect, list);
    }
  }
  if (W.u8(win, O.surface) & 1) {
    for (let child = bottomChild(W, win, 1); child; child = higherSibling(W, child, 1))
      rawBackgroundClipList(W, root, child, list);
  } else subtractClipRect(clipRect(W, win), list);
  return list;
}

/** 0x1003c720 DrawRawBackground(gc, texture, color): PushGC, EnableDrawing(1),
 * SetStyle(1), SetTileColor(color), then per rect of the clip list at
 * (clipX+originX, clipY+originY) DrawStretchedTexture from (0,0) over
 * rawBackgroundWidth/Height (+0x5f0/+0x5f4) when bStretchRawBackground (+0x5d8
 * bit 2), else DrawPattern anchored at that point; then PopGC. Both draws
 * return at once for a null texture. */
export function drawRawBackground(W, root, gc, texture, color) {
  const s = W.gc.services;
  gcPushGC(gc, s);
  gcEnableDrawing(gc, 1, s);
  gcSetStyle(gc, 1, s);
  gcSetTileColor(gc, color >>> 0, s);
  const list = rawBackgroundClipList(W, root);
  const count = list.length;
  for (let i = 0; i < count; i++) {
    const r = list[i];
    const x = st(A(ld(r[2]), ld(r[0]))), y = st(A(ld(r[3]), ld(r[1])));
    if (W.u8(root, ROOT.renderFlags) & 4)
      gcDrawStretchedTexture(gc, x, y, r[4], r[5], 0, 0, W.u32(root, 0x5f0), W.u32(root, 0x5f4), texture, s);
    else gcDrawPattern(gc, x, y, r[4], r[5], x, y, texture, s);
  }
  gcPopGC(gc, -1, s);
}
