/**
 * Recovered Extension.dll XGC text-line helpers used by XLargeTextWindow and
 * XEditWindow (Extension.dll base 0x10000000, SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c):
 *
 *   GetTextLine     0x10027e50  one wrapped line through the shared scanner
 *   DrawTextLine    0x10028470  one row of glyphs at (x, y)
 *   DrawTextChar    0x100285f0  one glyph with a pen and a remaining count
 *   ConvertPixelPos 0x10029880  column -> width (mode 1) / x -> column (mode 0)
 *   CharToPixel     0x10027fc0  ConvertPixelPos mode 1, returns the width
 *   PixelToChar     0x10028050  ConvertPixelPos mode 0, returns the column
 *
 * Each body copies the caller's 20-byte XTextState (or starts from four zero
 * bytes) and, when its hasColor byte is clear, refreshes the colour floats
 * from the GC text colour (+0x6c) before scanning — the same local-state
 * rule as UGC::DrawText. Text is addressed as UTF-16 units with cursor
 * indices; `end` bounds every read exactly like the native end pointer.
 * The scanner (0x10029ae0), GetNextChar (0x100294d0) and DrawChar
 * (0x10029e40) are the recovered bodies in script-gc-get-text-extent.mjs and
 * script-gc-draw-text.mjs. Evidence: docs/script-large-text-window.md.
 */
import {GC, GC_FLAGS} from './script-gc-state-model.mjs';
import {uFontGlyph} from './script-font-model.mjs';
import {copyTextFloats, nextChar, scanLine, STATE_BOLD, STATE_HAS_COLOR, STATE_SIZE} from './script-gc-get-text-extent.mjs';
import {drawGlyph} from './script-gc-draw-text.mjs';
import {x87load as X, x87int32 as I, x87add as A, x87mul as M, x87store as S, x87cmp} from './script-vm.mjs';

const HALF = {neg: 0, sig: 1n, exp: -1}; // double 0.5 at 0x1005aa20

/** The local XTextState every helper starts from (bytes 0..3 zeroed; the
 * caller's state copied when given; GC text colour when hasColor is 0). */
function localState(L, gcBase, state) {
  const local = new Uint8Array(STATE_SIZE);
  if (state) local.set(state);
  if (!local[STATE_HAS_COLOR]) copyTextFloats(L, gcBase, local);
  return local;
}
const fontFor = (L, gcBase, bold) => L.read(gcBase + (bold ? GC.boldFont : GC.normalFont), 'u32');

/** 0x10027e50 GetTextLine(text, state, len, width, &next, &outState, &len, &width).
 * `start`/`end` index `units`. Returns the scanner's progress flag. */
export function gcGetTextLine(L, gcBase, units, start, end, state, width) {
  const local = localState(L, gcBase, state);
  const cursor = {pos: start};
  const line = scanLine(L, gcBase, cursor, end, local, units, width);
  return {progress: line.progress, next: cursor.pos, state: local, len: line.len, width: line.width};
}

/** 0x10028470 DrawTextLine(x, y, state, text, len): drawing bit, canvas and
 * text gates, then GetNextChar/DrawChar with the pen at x. */
export function gcDrawTextLine(L, gcBase, x, y, state, units, start, len) {
  if (!(L.read(gcBase + GC.flags, 'u8') & GC_FLAGS.drawing)) return;
  if (!L.read(gcBase + GC.canvas, 'u32')) return;
  if (len < 1) return;
  const end = start + len, local = localState(L, gcBase, state);
  let bold = local[STATE_BOLD], font = fontFor(L, gcBase, bold);
  const pen = {v: x}, cursor = {pos: start};
  for (;;) {
    const ch = nextChar(L, gcBase, cursor, end, local, units);
    if (!ch) return;
    if (local[STATE_BOLD] !== bold) { bold = local[STATE_BOLD]; font = fontFor(L, gcBase, bold); }
    if (ch === 0x0a || !font) continue;
    drawGlyph(L, font, ch, local, pen.v, y, pen, null);
  }
}

/** 0x100285f0 DrawTextChar(&penX, &penY, state, &text, &len): one glyph.
 * `penX` is the {v} pen cell DrawChar advances; `cursor.pos` and
 * `remaining.v` are the in/out text pointer and count; `state` (when given)
 * receives the local state back, also after the end. Returns 1 while a
 * character was consumed. */
export function gcDrawTextChar(L, gcBase, penX, penY, state, units, cursor, remaining) {
  if (remaining.v < 1) return 0;
  const end = cursor.pos + remaining.v, local = localState(L, gcBase, state);
  let result = 0;
  const ch = nextChar(L, gcBase, cursor, end, local, units);
  if (ch) {
    const font = fontFor(L, gcBase, local[STATE_BOLD]);
    if (ch !== 0x0a && font && (L.read(gcBase + GC.flags, 'u8') & GC_FLAGS.drawing) && L.read(gcBase + GC.canvas, 'u32'))
      drawGlyph(L, font, ch, local, penX.v, penY, penX, null);
    result = 1;
  }
  remaining.v = Math.max(0, end - cursor.pos);
  if (state) state.set(local);
  return result;
}

/** 0x10029880 ConvertPixelPos. Mode 1 sums the f32 glyph widths while fewer
 * than `column` units were consumed; mode 0 returns the unit count before the
 * glyph whose centre lies right of `x`. Newline and the end stop both. */
function convertPixelPos(L, gcBase, units, start, len, state, mode, column, x) {
  const end = start + len, local = localState(L, gcBase, state), cursor = {pos: start};
  let consumed = 0, acc = 0;
  const glyphWidth = ch => {
    const font = fontFor(L, gcBase, local[STATE_BOLD]);
    return font ? I(uFontGlyph(L, font, ch).uSize) : X(0);
  };
  if (mode) {
    for (;;) {
      const ch = nextChar(L, gcBase, cursor, end, local, units);
      if (!ch || ch === 0x0a || consumed >= column) return acc;
      consumed = cursor.pos - start;
      acc = S(A(glyphWidth(ch), X(acc)));
    }
  }
  for (;;) {
    const ch = nextChar(L, gcBase, cursor, end, local, units);
    if (!ch || ch === 0x0a) return consumed;
    const w = glyphWidth(ch);
    if (x87cmp(A(M(w, HALF), X(acc)), X(x)) === 'gt') return consumed;
    acc = S(A(w, X(acc)));
    consumed = cursor.pos - start;
    const c = x87cmp(X(x), X(acc));
    if (c === 'lt' || c === 'eq' || c === 'un') return consumed;
  }
}

/** 0x10027fc0 CharToPixel(text, column, len, state): the f32 width. */
export const gcCharToPixel = (L, gcBase, units, start, column, len, state) =>
  convertPixelPos(L, gcBase, units, start, len, state, 1, column, 0);
/** 0x10028050 PixelToChar(text, x, len, state): the column. */
export const gcPixelToChar = (L, gcBase, units, start, x, len, state) =>
  convertPixelPos(L, gcBase, units, start, len, state, 0, 0, x);
