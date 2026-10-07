/**
 * Extension.dll XScaleWindow::Draw 0x1003fb10 and DrawScaleTexture
 * 0x1003f250: the scale (scrollbar) track, its ticks and the thumb, drawn in
 * the render pass (x87 precision control 24, docs/render-pass-precision.md).
 * The scale draw does not run the script DrawWindow (no XWindow::Draw call).
 *
 * Scale members (docs/script-window-scroll-children.md): orientation +0x14c
 * (1 vertical), scale/thumb/tick textures +0x150/+0x154/+0x158, thumb caps
 * +0x15c/+0x160, flags +0x164 (bit0 stretched scale, bit1 stretched thumb,
 * bit2 tick at the start, bit4 span), border pattern +0x168, scale/thumb
 * border widths +0x16c/+0x170 and colours +0x174/+0x178, styles
 * +0x17c/+0x17d/+0x17e, colours +0x17f/+0x183/+0x187 (unaligned dwords),
 * numTicks +0x1c4, span +0x1cc, scale/thumb/tick/cap geometry +0x200..+0x24c,
 * track start/end +0x250/+0x254.
 *
 * Verified with scripts/validate-window-list-family.mjs (the scale cases run
 * the original body in scripts/native-listwindow-family-oracle.py at the
 * render-pass control word 0x007f).
 */
import {gcSetStyle} from './script-gc-set-style.mjs';
import {gcSetTileColor} from './script-gc-set-tile-color.mjs';
import {gcDrawBox} from './script-gc-draw-box.mjs';
import {gcMemory, GC} from './script-gc-state-model.mjs';
import {f32Bits, gcTileEmitGate} from './script-gc-draw-model.mjs';
import {x87load as X, x87double as XD, x87int32 as XI, x87store as S, x87ftol} from './script-vm.mjs';
import {p24add, p24sub, p24mul, p24div} from './x87-pc24.mjs';

/** XScaleWindow::TickToPixel 0x1003ea70 at precision control 24: the track
 * length (less the thumb plus one for a span scale) times the tick over the
 * tick count (at least 1), plus the start and 0.5, truncated by _ftol. */
export function tickToPixel24(W, win, tick) {
  const start = X(W.f32(win, 0x250));
  let length = p24sub(X(W.f32(win, 0x254)), start), den;
  if (W.u8(win, 0x164) & 0x10) {
    length = p24sub(p24add(length, X(1)), X(W.f32(win, W.u8(win, 0x14c) === 1 ? 0x21c : 0x218)));
    den = (W.i32(win, 0x1c4) - W.i32(win, 0x1cc)) | 0;
  } else den = (W.i32(win, 0x1c4) - 1) | 0;
  if (den < 1) den = 1;
  return x87ftol(p24add(p24add(p24div(p24mul(XI(tick), length), XI(den)), start), XD(0.5)));
}

const r = v => X(v);
const above0 = v => v > 0;                                             // fcomp 0.0; test ah,0x41

/** 0x1003f250 DrawScaleTexture(gc, texture, x, y, w, h, bStretch, style,
 * color, borderWidth, borderColor, cap1, cap2, cap1 u/v/w/h, cap2 u/v/w/h).
 * Coordinates are float values; colours are FColor dwords. */
export function drawScaleTexture(W, win, gc, a) {
  const s = W.gc.services, Lg = gcMemory(gc, s), g = Lg.base;
  const savedStyle = Lg.read(g + GC.style, 'u8'), savedTile = Lg.read(g + 0x54, 'u32');
  let {x, y, w, h} = a;
  const vertical = W.u8(win, 0x14c) === 1;
  const pattern = (px, py, pw, ph, u, v, ul, vl, texture) =>
    gcTileEmitGate(Lg, {x: px, y: py, w: pw, h: ph, u, v, ul, vl, texture});   // XGC::DrawIconPattern 0x10028770
  gcSetStyle(gc, a.style, s);
  if (above0(a.borderWidth)) {
    const border = W.u32(win, 0x168);
    if (border) {
      gcSetTileColor(gc, a.borderColor, s);
      gcDrawBox(gc, f32Bits(x), f32Bits(y), f32Bits(w), f32Bits(h), 0, 0, f32Bits(a.borderWidth), border, s);
    }
    x = S(p24add(r(x), r(a.borderWidth)));
    y = S(p24add(r(y), r(a.borderWidth)));
    const twice = p24add(r(a.borderWidth), r(a.borderWidth));
    w = S(p24sub(r(w), twice));
    h = S(p24sub(r(h), twice));
  }
  gcSetTileColor(gc, a.color, s);
  if (a.cap1 && above0(a.cap1w) && above0(a.cap1h) && above0(w) && above0(h)) {
    if (vertical) {
      pattern(x, y, a.cap1w, a.cap1h, a.cap1u, a.cap1v, 0, a.cap1h, a.cap1);
      y = S(p24add(r(y), r(a.cap1h))); h = S(p24sub(r(h), r(a.cap1h)));
    } else {
      pattern(x, y, a.cap1w, a.cap1h, a.cap1u, a.cap1v, a.cap1w, 0, a.cap1);
      x = S(p24add(r(x), r(a.cap1w))); w = S(p24sub(r(w), r(a.cap1w)));
    }
  }
  if (a.cap2 && above0(a.cap2w) && above0(a.cap2h) && above0(w) && above0(h)) {
    if (vertical) {
      pattern(x, S(p24sub(p24add(r(y), r(h)), r(a.cap2h))), a.cap2w, a.cap2h, a.cap2u, a.cap2v, 0, a.cap2h, a.cap2);
      h = S(p24sub(r(h), r(a.cap2h)));
    } else {
      pattern(S(p24sub(p24add(r(x), r(w)), r(a.cap2w))), y, a.cap2w, a.cap2h, a.cap2u, a.cap2v, a.cap2w, 0, a.cap2);
      w = S(p24sub(r(w), r(a.cap2w)));
    }
  }
  if (a.texture && above0(w) && above0(h)) {
    if (vertical) pattern(x, y, w, h, 0, 0, 0, a.stretch ? 0 : h, a.texture);
    else pattern(x, y, w, h, 0, 0, a.stretch ? 0 : w, 0, a.texture);
  }
  gcSetStyle(gc, savedStyle, s);
  gcSetTileColor(gc, savedTile, s);
}

/** 0x1003fb10 XScaleWindow::Draw: the track (scale texture, its border and
 * colour), each tick (TickToPixel, centred by _ftol(size * 0.5)), then the
 * thumb with its caps. */
export function scaleDraw(W, win, gc) {
  const f32 = off => W.f32(win, off), u32 = off => W.u32(win, off);
  const flags = u32(0x164), none = {cap1: 0, cap2: 0, cap1u: 0, cap1v: 0, cap1w: 0, cap1h: 0, cap2u: 0, cap2v: 0, cap2w: 0, cap2h: 0};
  drawScaleTexture(W, win, gc, {...none, texture: u32(0x150), x: f32(0x200), y: f32(0x204), w: f32(0x208), h: f32(0x20c),
    stretch: flags & 1, style: W.u8(win, 0x17c), color: u32(0x17f), borderWidth: f32(0x16c), borderColor: u32(0x174)});
  const tick = u32(0x158);
  if (tick) {
    let count = W.i32(win, 0x1c4), first = 0;
    if (flags & 0x10) count++;
    if (!(flags & 4)) { first = 1; count--; }
    const vertical = W.u8(win, 0x14c) === 1;
    for (let i = first; i < count; i++) {
      const pixel = tickToPixel24(W, win, i);
      const half = x87ftol(p24mul(X(f32(vertical ? 0x22c : 0x228)), XD(0.5)));
      const at = S(p24sub(XI(pixel), XI(half)));
      // The border colour temporary's alpha is stale stack; a zero border never reads it.
      drawScaleTexture(W, win, gc, {...none, texture: tick, x: vertical ? f32(0x220) : at, y: vertical ? at : f32(0x224),
        w: f32(0x228), h: f32(0x22c), stretch: 0, style: W.u8(win, 0x17e), color: u32(0x187), borderWidth: 0, borderColor: 0});
    }
  }
  drawScaleTexture(W, win, gc, {texture: u32(0x154), x: f32(0x210), y: f32(0x214), w: f32(0x218), h: f32(0x21c),
    stretch: (flags >>> 1) & 1, style: W.u8(win, 0x17d), color: u32(0x183), borderWidth: f32(0x170), borderColor: u32(0x178),
    cap1: u32(0x15c), cap2: u32(0x160), cap1u: f32(0x230), cap1v: f32(0x234), cap1w: f32(0x238), cap1h: f32(0x23c),
    cap2u: f32(0x240), cap2v: f32(0x244), cap2w: f32(0x248), cap2h: f32(0x24c)});
}
