/** Extension ScaleWindow / ScaleManagerWindow settings and value natives that
 * the scroll-children milestone left out (reached by the security computer's
 * pan slider, MenuUISliderButtonWindow). Recovered from Extension.dll
 * (SHA-256 93c35502…8b916d9c); evidence and checks:
 * docs/script-window-scale-settings.md. Value formatting (GetValueString),
 * SetValueFormat and the enumeration strings stay explicit boundaries. */
import {x87load as X, x87int32 as I, x87add as A, x87neg as N, x87mul as M, x87div as D,
  x87ftol as T, x87store as S, x87storeDouble, x87cmp} from './script-vm.mjs';
import {msvcrtSprintf} from './script-text-format.mjs';
import {changeThumbPosition} from './script-window-scroll-children.mjs';
import {tickToValue} from './script-window-scroll-movement.mjs';

const f = Math.fround;
const sub = (a, b) => A(a, N(b));
// fcomp + test ah,0x40: C3 is set for equal and for unordered operands.
const sameC3 = (a, b) => { const c = x87cmp(X(a), X(b)); return c === 'eq' || c === 'un'; };
// fcom 0.0 + test ah,1: C0 is set for below and for unordered operands.
const belowZeroC0 = v => { const c = x87cmp(v, X(0)); return c === 'lt' || c === 'un'; };
// The negative-or-NaN clamp of SetTickTexture (fcomp 0.0f; test ah,1).
const clampNegative = v => belowZeroC0(X(v)) ? 0 : f(v);

// ---- ScaleWindow ----------------------------------------------------------

/** SetTickTexture 0x1003d890(texture, bDrawEndTicks, width, height): a
 * negative or NaN size is 0; texture +0x158, width +0x19c, height +0x1a0,
 * bDrawEndTicks into flag bit 2 of +0x164; always AskParentForReconfigure.
 * Exec 0x10040670 defaults bDrawEndTicks TRUE and both sizes 0. */
export function scaleTickTexture(W, win, texture, drawEndTicks, width, height) {
  W.setPtr(win, 0x158, texture);
  W.setF32(win, 0x1a0, clampNegative(height));
  W.setF32(win, 0x19c, clampNegative(width));
  W.setU32(win, 0x164, ((W.u32(win, 0x164) & ~4) | ((drawEndTicks & 1) << 2)) >>> 0);
  W.native.askParentForReconfigure(win);
}

/** SetBorderPattern 0x1003db20 (folded with XListWindow::SetFocusColor):
 * the texture at +0x168, no reconfigure. */
export function scaleBorderPattern(W, win, texture) { W.setPtr(win, 0x168, texture); }

/** SetScaleBorder 0x1003db30 / SetThumbBorder 0x1003dbd0(size, color): the
 * colour (+0x174 / +0x178) always; the size (+0x16c / +0x170) and a
 * reconfigure only when the x87 compare is ordered and unequal. Exec
 * 0x10040980 / 0x10040a20 default the size 0 and the colour to R=G=B=0xff,
 * whose alpha byte is the high byte of the FFrame* argument slot it reuses. */
export function scaleBorder(W, win, sizeOffset, colorOffset, size, color) {
  W.setU32(win, colorOffset, color);
  if (sameC3(W.f32(win, sizeOffset), size)) return;
  W.setF32(win, sizeOffset, size);
  W.native.askParentForReconfigure(win);
}

/** GetThumbSpan 0x1003df20: the span in range mode (+0x164 bit 4), else 0. */
export const scaleThumbSpan = (W, win) => (W.u8(win, 0x164) & 16) ? W.i32(win, 0x1cc) : 0;

/** SetValueRange 0x1003e070(from, to): stores both and ChangeScalePosition(1)
 * when either x87 compare is ordered and unequal. */
export function scaleValueRange(W, win, from, to) {
  if (sameC3(W.f32(win, 0x1d4), from) && sameC3(W.f32(win, 0x1d8), to)) return;
  W.setF32(win, 0x1d4, from); W.setF32(win, 0x1d8, to);
  W.native.changeScalePosition(win, 1);
}

/** ValueToTick 0x1003ec20: n = count (range mode) or count - 1; with an
 * equal or unordered range the fraction is 0, else n * (value - from) /
 * (to - from) in x87 precision; then _ftol(t - 0.5) below 0 or unordered,
 * _ftol(t + 0.5) otherwise. */
export function valueToTick(W, win, value) {
  const n = I((W.i32(win, 0x1c4) - ((W.u8(win, 0x164) & 16) ? 0 : 1)) | 0);
  const from = W.f32(win, 0x1d4), to = W.f32(win, 0x1d8);
  const t = sameC3(to, from) ? X(0) : D(M(n, sub(X(value), X(from))), sub(X(to), X(from)));
  return T(belowZeroC0(t) ? sub(t, X(0.5)) : A(t, X(0.5)));
}

/** SetValue 0x1003e120: ChangeThumbPosition(ValueToTick(value), 0, 1). */
export function scaleValue(W, win, value) { changeThumbPosition(W, win, valueToTick(W, win, value), 0, 1); }

/** GetValue 0x1003e1b0: TickToValue(position), stored as float by the exec. */
export const scaleGetValue = (W, win) => S(tickToValue(W, win, W.i32(win, 0x1c8)));

/** GetValues 0x1003e230: from = TickToValue(position); to =
 * TickToValue(position + span) in range mode, else the range's +0x1d4
 * (from) value. Each is stored only through a non-null pointer. */
export function scaleGetValues(W, win) {
  const from = S(tickToValue(W, win, W.i32(win, 0x1c8)));
  const to = (W.u8(win, 0x164) & 16) ? S(tickToValue(W, win, (W.i32(win, 0x1cc) + W.i32(win, 0x1c8)) | 0)) : W.f32(win, 0x1d4);
  return {from, to};
}

// ---- Value strings ---------------------------------------------------------
// Window layout: the format FString (+0x1dc, constructor default "%1.2f"), the
// label array TArray<FString> (Data +0x268, Num +0x26c, Max +0x270; elements
// are 12 bytes), the position (+0x1c8) and the ChangeScalePosition(notify)
// body 0x1003f5a0 that each of these natives ends with.

const enumerationText = (W, win, index) => W.heap.read(W.u32(win, 0x268), index * 12, 'string');

/** SetValueFormat exec 0x100411d0 -> 0x1003e310: FString::operator=(format) on
 * +0x1dc (an empty argument is the shared empty string), then always
 * ChangeScalePosition(1). */
export function scaleValueFormat(W, win, format) {
  W.heap.write(win, 0x1dc, 'string', format);
  W.native.changeScalePosition(win, 1);
}

/** SetEnumeration exec 0x100413b0 -> 0x1003e580(tick, text): a tick outside
 * [0, 0x200) returns at once. Otherwise the array grows to tick + 1 elements
 * (FArray growth, new elements zeroed), element `tick` takes the text, and
 * ChangeScalePosition(1) runs only when `tick` is the current position. */
export function scaleEnumeration(W, win, tick, text) {
  if (tick < 0 || tick >= 0x200) return;
  const count = W.i32(win, 0x26c);
  if (tick >= count) {
    const added = tick - count + 1;
    W.farray.add(win, 0x268, added, 12);
    const data = W.u32(win, 0x268);
    for (let at = data + count * 12; at < data + (count + added) * 12; at += 4) W.heap.mem.write(at, 'u32', 0);
  }
  W.heap.write(W.u32(win, 0x268), tick * 12, 'string', text);
  if (tick === W.i32(win, 0x1c8)) W.native.changeScalePosition(win, 1);
}

/** ClearAllEnumerations exec 0x10041510 -> 0x1003e780: every element string is
 * emptied and released, the array is emptied (Realloc(12) frees the block),
 * then ChangeScalePosition(1). */
export function scaleClearEnumerations(W, win) {
  const count = W.i32(win, 0x26c);
  for (let i = 0; i < count; i++) W.heap.write(W.u32(win, 0x268), i * 12, 'string', '');
  W.farray.empty(win, 0x268, 12);
  W.native.changeScalePosition(win, 1);
}

/** A model x87 value stored as the 64-bit double FSTP m64 would. */
function x87doubleNumber(value) {
  const stored = x87storeDouble(value);
  if (stored.nan !== undefined) return NaN;
  if (stored.inf) return stored.neg ? -Infinity : Infinity;
  const magnitude = Number(stored.sig) * 2 ** stored.exp;
  return stored.neg ? -magnitude : magnitude;
}

/** GetValueString exec 0x10041310 -> 0x1003e460: the label of the current
 * position when it exists and is not empty (appStricmp against L""); otherwise
 * appSprintf(buffer, format, (double)GetValue()). GetValue (0x1003e1b0) leaves
 * TickToValue in st0, so FST m32 only spills a copy and the double pushed for
 * the printf is the extended value rounded to 53 bits, not the float32. */
export function scaleValueString(W, win) {
  const position = W.i32(win, 0x1c8);
  if (position >= 0 && position < W.i32(win, 0x26c)) {
    const label = enumerationText(W, win, position);
    if (label !== '') return label;
  }
  return msvcrtSprintf(W.heap.read(win, 0x1dc, 'string'), x87doubleNumber(tickToValue(W, win, position)));
}

// ---- ScaleManagerWindow ---------------------------------------------------

function isDescendant(W, win, child) { for (let w = child; w; w = W.ptr(w, 0x138)) if (w === win) return true; return false; }

/** SetValueField 0x10041c70: a non-descendant is none; when it changes the
 * field (+0x154) is stored, the parent asked to reconfigure and
 * ChangeValueField 0x10041da0 runs (it formats only with a field and a
 * scale; that formatting is an explicit boundary). */
export function managerValueField(W, win, field) {
  if (!isDescendant(W, win, field)) field = null;
  if (W.ptr(win, 0x154) === field) return;
  W.setPtr(win, 0x154, field); W.native.askParentForReconfigure(win);
  if (W.ptr(win, 0x154) && W.ptr(win, 0x158)) W.boundary('ScaleManager.ChangeValueField text formatting is not recovered');
}

/** SetManagerOrientation exec 0x10042950: the byte as a dword at +0x15c and
 * an unconditional reconfigure. */
export function managerOrientation(W, win, value) { W.setU32(win, 0x15c, value & 0xff); W.native.askParentForReconfigure(win); }

/** StretchScaleField exec 0x100429c0 (bit 0 of +0x160) / StretchValueField
 * exec 0x10042a40 (bit 1), both defaulting TRUE, unconditional reconfigure. */
export function managerStretch(W, win, bit, value) {
  W.setU32(win, 0x160, ((W.u32(win, 0x160) & ~(1 << bit)) | ((value & 1) << bit)) >>> 0);
  W.native.askParentForReconfigure(win);
}

/** SetManagerMargins exec 0x10042ac0 (defaults 0, 0): both stored and a
 * reconfigure when either x87 compare against +0x164 / +0x168 is ordered and
 * unequal. */
export function managerMargins(W, win, width, height) {
  if (sameC3(W.f32(win, 0x164), width) && sameC3(W.f32(win, 0x168), height)) return;
  W.setF32(win, 0x164, width); W.setF32(win, 0x168, height);
  W.native.askParentForReconfigure(win);
}

/** SetMarginSpacing exec 0x10042b80 (default 0): +0x16c and a reconfigure
 * when the x87 compare is ordered and unequal. */
export function managerSpacing(W, win, spacing) {
  if (sameC3(W.f32(win, 0x16c), spacing)) return;
  W.setF32(win, 0x16c, spacing); W.native.askParentForReconfigure(win);
}

/** SetManagerAlignments exec 0x10042c00: bytes +0x170 / +0x171 and a
 * reconfigure when either differs. */
export function managerAlignments(W, win, h, v) {
  h &= 0xff; v &= 0xff;
  if (W.u8(win, 0x170) === h && W.u8(win, 0x171) === v) return;
  W.setU8(win, 0x171, v); W.setU8(win, 0x170, h);
  W.native.askParentForReconfigure(win);
}
