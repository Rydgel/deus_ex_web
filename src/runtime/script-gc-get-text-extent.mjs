/**
 * Recovered Extension.dll UGC::GetTextExtent translation (native 1280,
 * method body 0x10027bb0, exec trampoline 0x1002c020).
 *
 * The method measures a UTF-16 string against the GC's fonts.  Pipeline:
 *
 *   method loop      0x10027bb0 — per line: call the line scanner, rescan the
 *                    returned span for the line-height max, track the widest
 *                    line, add textVSpacing per line; write xExtent/yExtent.
 *   scan wrapper     0x10029d80 — returns the line-start pointer on progress
 *                    (neg/sbb/and) or 0; copies all 20 state bytes into the
 *                    scanner's by-value arg (the struct copy at 0x10027f70:
 *                    4 single bytes + 4 dwords).
 *   line scanner     0x10029ae0 — word-wrap scan.  Args: start cursor, the
 *                    20-byte state by value, end, destWidth f32, &cursor,
 *                    &state, &len, &width.  destWidth <= 0 (or NaN) becomes
 *                    500000f.  Space class = {9,0xb,0xc,0xd,0x20} (0xa is a
 *                    stop char, checked first).  First char always fits.
 *                    Overflow inside a word with no earlier space boundary
 *                    hard-cuts at the char (path C); with a boundary the line
 *                    cuts at the last space and resumes at the next word
 *                    (path B); a space that overflows sets 'wrapped' and the
 *                    scan continues until a word char arrives (path A).
 *                    '\n' ends the line and sets state byte 2 so the NEXT
 *                    call yields the trailing empty line.
 *   next char        0x100294d0 — consumes special-text escapes when GC
 *                    textFlags bit1 is set: '|b'/|!b bold toggle (state[0]),
 *                    '|c'/|!c 6-digit hex color / restore (state[1], state+4),
 *                    '|p0-7'/|!p palette color / restore, '|&' (state[3]),
 *                    any other token char is returned literally (the '|' is
 *                    swallowed).  Keeps two process globals: a stale lastChar
 *                    and a bang flag — both proven write-only on this path
 *                    (the stale read only executes when the cursor already
 *                    ran out, where the dispatch is skipped).  One-time
 *                    palette init guarded by 0x100a2df4 bit0 writes constant
 *                    data; modelled as the flag alone.
 *   glyph lookup     0x10026880/0x10026950 — in script-font-model.mjs.
 *
 * The line-width accumulator, line heights and extents are f32; glyph metrics
 * are i32 (fild).  All x87 adds round once through fstp — modelled with
 * Math.fround at each store point; integer-valued operands keep the f64
 * intermediates exact, so the results are bit-identical to the 80-bit
 * computation on every reachable input (see docs/script-font-model.md).
 *
 * `gcGetTextExtentMethod` models the method: writeX/writeY model non-null
 * out pointers and the returned fields are null where the pointer was null.
 * `gcGetTextExtent` is the exec-level behaviour (both out params bound).
 */
import {GC, GC_DLL, GC_TEXT_FLAGS, gcMemory} from './script-gc-state-model.mjs';
import {uFontGlyph} from './script-font-model.mjs';

const freeze = Object.freeze;

export const GC_GET_TEXT_EXTENT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.GetTextExtent',
  packageExport: 2098,
  nativeIndex: 1280,
  functionFlags: 0x401,
  serialSize: 40,
  ...GC_DLL,
  execBody: 0x1002c020,
  execEnd: 0x1002c1e2,
  execSha256: 'eca956b6f86eab391d7df8c190a6ea982bf42126dc7baf9e575426fc52bdec82',
  methodBody: 0x10027bb0,
  methodEnd: 0x10027d57,
  methodSha256: '475f0abcf48532338f4c0ca0944ab9190237c44e244a7f8e8452205296498f75',
});

export class GcGetTextExtentBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcGetTextExtentBoundaryError';
    this.code = `GC_GET_TEXT_EXTENT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcGetTextExtentBoundaryError(message, details);
};

/** State byte indices inside the 20-byte per-measurement iterator state.
 *  Exported for UGC::DrawText — it runs the same two-state iterator pair
 *  (emit state + scan state) through these helpers. */
export const STATE_BOLD = 0;
export const STATE_HAS_COLOR = 1;
export const STATE_CONTINUED = 2; // newline pending — set by the scanner on '\n'
export const STATE_AMP = 3;
export const STATE_COLOR = 4;     // 4 x f32 rgba at +4..+0x13
export const STATE_SIZE = 20;

/**
 * Palette the one-time init at 0x100294eb writes into 0x100a2dd4 — eight
 * packed {r,g,b,0} byte records: black, white, red, green, yellow, blue,
 * magenta, cyan.  The |p escape scales channels by the f64 constant at
 * 0x1005e3e8 (bit pattern 0x3f70101010101027 — a distinct 1/255 constant,
 * NOT the +0x58/+0x6c tile/text scale at 0x1005e3c0).
 */
const PALETTE = freeze([
  freeze([0, 0, 0]), freeze([255, 255, 255]), freeze([255, 0, 0]),
  freeze([0, 255, 0]), freeze([255, 255, 0]), freeze([0, 0, 255]),
  freeze([255, 0, 255]), freeze([0, 255, 255]),
]);
const TEXT_COLOR_SCALE_BITS = 0x3f70101010101027n;
const TEXT_COLOR_SCALE = (() => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, TEXT_COLOR_SCALE_BITS, true);
  return view.getFloat64(0, true);
})();

/** Process globals the iterator keeps (Extension .bss). */
let gLastChar = 0;    // 0x100a2dd0 — write-only on the observable path
let gBang = 0;        // 0x100a2dcc — '|!' prefix flag, write-only
let gPaletteInit = 0; // 0x100a2df4 — set once; palette data is constant

/** The FString data as UTF-16 code units, truncated at the first NUL —
 *  the same bound appStrlen gives the method body. */
export function textUnits(text) {
  if (typeof text !== 'string')
    fail('GC.GetTextExtent requires the text string', {kind: 'REFERENCE', value: text});
  let len = text.indexOf('\0');
  if (len < 0) len = text.length;
  const units = new Uint16Array(len);
  for (let i = 0; i < len; i++) units[i] = text.charCodeAt(i);
  return units;
}

export const stateView = state => new DataView(state.buffer, state.byteOffset, STATE_SIZE);
const writeStateF32 = (state, offset, value) =>
  stateView(state).setFloat32(offset, Math.fround(value), true);
export const copyTextFloats = (L, gcBase, state) => {
  const view = stateView(state);
  for (let i = 0; i < 4; i++)
    view.setUint32(STATE_COLOR + i * 4, L.read(gcBase + GC.textFloats + i * 4, 'u32'), true);
};

/** 0x100292f0: parse two hex digits at *cursor into byteOut; partial parses
 *  keep the high nibble.  Returns 1 on a complete pair, else 0. */
function parseHexByte(cur, end, units, byteOut) {
  byteOut.v = 0;
  if (cur.pos >= end) return 0;
  let c = units[cur.pos];
  if (c >= 0x30 && c <= 0x39) byteOut.v = (c << 4) & 0xff;
  else if ((c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)) byteOut.v = ((c + 9) << 4) & 0xff;
  else return 0;
  cur.pos++;
  if (cur.pos >= end) return 0;
  c = units[cur.pos];
  if (c >= 0x30 && c <= 0x39) byteOut.v |= c - 0x30;
  else if (c >= 0x61 && c <= 0x66) byteOut.v |= c - 0x57;
  else if (c >= 0x41 && c <= 0x46) byteOut.v |= c - 0x37;
  else return 0;
  cur.pos++;
  return 1;
}

/** 0x100293d0: '|cRRGGBB' — three hex bytes into state+4/+8/+0xc as f32. */
function parseColor(cur, end, state, units) {
  const r = {v: 0}, g = {v: 0}, b = {v: 0};
  if (parseHexByte(cur, end, units, r) && parseHexByte(cur, end, units, g))
    parseHexByte(cur, end, units, b);
  writeStateF32(state, STATE_COLOR, r.v * TEXT_COLOR_SCALE);
  writeStateF32(state, STATE_COLOR + 4, g.v * TEXT_COLOR_SCALE);
  writeStateF32(state, STATE_COLOR + 8, b.v * TEXT_COLOR_SCALE);
}

/** 0x100294d0: advance *cursor past escapes, return the next renderable
 *  UTF-16 unit (0 at the end).  Mutates cur.pos and the 20-byte state. */
export function nextChar(L, gcBase, cur, end, state, units) {
  if (!gPaletteInit) gPaletteInit = 1;
  state[STATE_AMP] = 0;
  for (;;) {
    if (cur.pos >= end) { gLastChar = 0; break; }
    if (!(L.read(gcBase + GC.textFlags, 'u32') & GC_TEXT_FLAGS.specialText)
        || units[cur.pos] !== 0x7c) {
      gLastChar = units[cur.pos];
      cur.pos++;
      break;
    }
    cur.pos++;
    let cx;
    if (cur.pos < end) {
      cx = units[cur.pos];
      if (cx >= 0x41 && cx <= 0x5a) cx += 0x20;
      gLastChar = cx;
    } else {
      cx = gLastChar; // stale global — the dispatch below is skipped here
    }
    if (cx === 0x21) {
      gBang = 1;
      cur.pos++;
      if (cur.pos < end) {
        cx = units[cur.pos];
        if (cx >= 0x41 && cx <= 0x5a) cx += 0x20;
        gLastChar = cx;
      } else {
        cx = gLastChar;
      }
    } else {
      gBang = 0;
    }
    if (cur.pos >= end) { gLastChar = 0; break; }
    if (cx === 0x62) {                              // 'b' — bold toggle
      cur.pos++;
      state[STATE_BOLD] = gBang === 0 ? 1 : 0;
    } else if (cx === 0x63) {                       // 'c' — color
      cur.pos++;
      if (gBang === 0) parseColor(cur, end, state, units);
      else copyTextFloats(L, gcBase, state);
      state[STATE_HAS_COLOR] = gBang === 0 ? 1 : 0;
    } else if (cx === 0x70) {                       // 'p' — palette
      cur.pos++;
      if (cur.pos < end) {
        if (gBang !== 0) {
          copyTextFloats(L, gcBase, state);
          state[STATE_HAS_COLOR] = 0;
        } else {
          const d = units[cur.pos];
          gLastChar = d;
          if (d >= 0x30 && d < 0x38) {
            cur.pos++;
            gLastChar = (d - 0x30) & 0xffff;
            const rgb = PALETTE[gLastChar];
            writeStateF32(state, STATE_COLOR, rgb[0] * TEXT_COLOR_SCALE);
            writeStateF32(state, STATE_COLOR + 4, rgb[1] * TEXT_COLOR_SCALE);
            writeStateF32(state, STATE_COLOR + 8, rgb[2] * TEXT_COLOR_SCALE);
            state[STATE_HAS_COLOR] = 1;
          }
        }
      }
    } else if (cx === 0x26) {                       // '&'
      cur.pos++;
      state[STATE_AMP] = 1;
    } else {                                        // unknown token → literal
      gLastChar = units[cur.pos];
      cur.pos++;
      break;
    }
    if (cur.pos >= end) { gLastChar = 0; break; }
  }
  if (cur.pos > end) cur.pos = end;
  return gLastChar;
}

/**
 * 0x10029ae0 + the 0x10029d80 wrapper: scan one line.  `cursor`/`state` are
 * the caller's; the scanner works on a by-value copy and writes both back.
 * Returns {start, len, width(f32), progress} — progress 0 models the
 * wrapper's null return (line-start pointer on success).
 */
export function scanLine(L, gcBase, cursor, end, state, units, destWidth) {
  let destW = destWidth;
  if (!(destW > 0)) destW = 500000;
  const savedByte2 = state[STATE_CONTINUED];
  const start = cursor.pos;
  const work = state.slice();
  work[STATE_CONTINUED] = 0;
  let font = work[STATE_BOLD] ? L.read(gcBase + GC.boldFont, 'u32')
                              : L.read(gcBase + GC.normalFont, 'u32');
  let runW = 0;
  let savedW = 0;
  let firstChar = 1;
  let inWord = 1;
  let wordStart = 0;
  let wordEnd = 0;
  let wrapped = 0;
  const snapA = new Uint8Array(STATE_SIZE);
  const snapB = new Uint8Array(STATE_SIZE);
  const cur = {pos: start};
  let outCursor, outLenEnd, outW;
  for (;;) {
    snapB.set(work);
    const charPos = cur.pos;
    const ch = nextChar(L, gcBase, cur, end, work, units);
    if (ch === 0 || ch === 0x0a) {
      outLenEnd = wrapped ? wordEnd : charPos;
      outW = wrapped ? savedW : runW;
      if (ch === 0x0a) work[STATE_CONTINUED] = 1;
      outCursor = cur.pos;
      break;
    }
    if ((ch >= 9 && ch <= 0x0d) || ch === 0x20) {
      if (inWord === 0) {
        inWord = 1;
        wordEnd = charPos;
        savedW = runW;
      }
    } else if (inWord !== 0) {
      if (wrapped !== 0) {
        outW = savedW;
        work.set(snapB);
        outCursor = charPos;
        outLenEnd = wordEnd;
        break;
      }
      snapA.set(snapB);
      inWord = 0;
      wordStart = charPos;
    }
    if (work[STATE_BOLD] !== snapB[STATE_BOLD])
      font = work[STATE_BOLD] ? L.read(gcBase + GC.boldFont, 'u32')
                              : L.read(gcBase + GC.normalFont, 'u32');
    if (font === 0) { firstChar = 0; continue; }
    const sum = runW + uFontGlyph(L, font, ch).uSize;
    if (!(sum > destW)) { runW = Math.fround(sum); firstChar = 0; continue; }
    if (firstChar !== 0) { runW = Math.fround(sum); firstChar = 0; continue; }
    if (wordEnd === 0) {
      outW = runW;
      work.set(snapB);
      outCursor = charPos;
      outLenEnd = charPos;
      break;
    }
    if (wordStart <= wordEnd) {
      wrapped = 1;
      runW = Math.fround(sum);
      firstChar = 0;
      continue;
    }
    outW = savedW;
    work.set(snapA);
    outCursor = wordStart;
    outLenEnd = wordEnd;
    break;
  }
  cursor.pos = outCursor;
  state.set(work);
  return {start, len: outLenEnd - start, width: outW,
          progress: outCursor > start || savedByte2 !== 0 ? 1 : 0};
}

/**
 * The method's measurement loop on already-decoded UTF-16 units — shared by
 * UGC::DrawText, which calls the same GetTextExtent body (0x10027bb0) with
 * f32(wrapInt) when its vAlign byte is non-zero.
 */
export function gcTextExtentUnits(L, destWidth, units) {
  const state = new Uint8Array(STATE_SIZE);
  const cursor = {pos: 0};
  const end = units.length;
  let totalY = 0;
  let lineH = 0;
  let maxX = 0;
  let bold = state[STATE_BOLD];
  let font = L.read(L.base + GC.normalFont, 'u32');
  for (;;) {
    const line = scanLine(L, L.base, cursor, end, state, units, destWidth);
    if (!line.progress) break;
    const lineEnd = line.start + line.len;
    const rescan = {pos: line.start};
    for (;;) {
      const ch = nextChar(L, L.base, rescan, lineEnd, state, units);
      if (ch === 0) break;
      const cl = state[STATE_BOLD];
      if (cl !== bold) {
        font = cl ? L.read(L.base + GC.boldFont, 'u32')
                  : L.read(L.base + GC.normalFont, 'u32');
        bold = cl;
      }
      if (ch === 0x0a || font === 0) continue;
      const h = uFontGlyph(L, font, ch).vSize;
      if (!(lineH >= h)) lineH = h;
    }
    if (!(lineH >= 1) && font !== 0)
      lineH = uFontGlyph(L, font, 0x20).vSize;
    if (!(maxX >= line.width)) maxX = line.width;
    totalY = Math.fround(lineH + L.read(L.base + GC.textVSpacing, 'f32') + totalY);
    lineH = 0;
  }
  return {xExtent: maxX, yExtent: Math.fround(lineH + totalY)};
}

export function gcGetTextExtentMethod(object, destWidth, writeX, writeY, text, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.GetTextExtent requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  const m = gcTextExtentUnits(L, destWidth, textUnits(text));
  return {xExtent: writeX ? m.xExtent : null, yExtent: writeY ? m.yExtent : null};
}

export function gcGetTextExtent(object, destWidth, text, services = {}) {
  return gcGetTextExtentMethod(object, destWidth, true, true, text, services);
}

export const execGcGetTextExtent = gcGetTextExtent;
