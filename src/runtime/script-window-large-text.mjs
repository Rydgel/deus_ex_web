/**
 * Recovered Extension.dll XLargeTextWindow bodies (base 0x10000000, SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c):
 *
 *   ctor 0x10012a50, Init 0x1002d480, CleanUp 0x1002d560, Serialize 0x1002d630
 *   SetText 0x1002d6b0, AppendText 0x1002d730, MakeLinesDirty 0x1002d880
 *   ComputeLineHeight 0x1002d9d0, GenerateLines 0x1002da70
 *   GetTextExtent 0x1002e130, ParentRequestedPreferredSize 0x1002e1d0
 *   ParentRequestedGranularity 0x1002e380, ConfigurationChanged 0x1002e430
 *   Draw 0x1002e500
 *
 * Layout (script LargeTextWindow fields): vSpace +0x174, lineHeight +0x178,
 * textParams +0x17c / rowData +0x194 (the layout used for drawing and by
 * XEditWindow), queryTextParams +0x1a0 / queryRowData +0x1b8 (preferred-size
 * queries), tempRowData +0x1c4 (incremental reflow scratch). XTextParams is
 * {flags (bit0 dirty, bit1 special text), dirtyStart, dirtyCount,
 * normalFont, boldFont, destWidth f32}; an XTextRowData row (0x24 bytes) is
 * {width f32, start, visible length, full length, XTextState[20]}.
 *
 * Unobservable stack garbage in the original is modelled as zero and
 * documented where it is stored: the upper bits of a written XTextParams
 * flags word and the colour floats of the first row's saved state (read only
 * when that state's hasColor byte is set, which it never is).
 *
 * x87: every expression keeps the original extended intermediates
 * (script-vm.mjs x87 model) and rounds once at each fst/fstp.
 * Evidence: docs/script-large-text-window.md.
 */
import {GC, gcMemory} from './script-gc-state-model.mjs';
import {gcGetFontHeightMethod} from './script-gc-get-font-height.mjs';
import {gcIntersect} from './script-gc-intersect.mjs';
import {gcDrawTextLine, gcGetTextLine} from './script-gc-text-line.mjs';
import {farrayRemove, farrayRealloc, farraySetNum, moveBytes} from './script-window-list-model.mjs';
import {setTextNative, appendTextNative} from './script-window-text.mjs';
import {x87load as X, x87int32 as I, x87add as A, x87neg as N, x87mul as M, x87div as D, x87store as S,
  x87ftol as T, x87double, x87cmp, x87fistp} from './script-vm.mjs';

export const LARGE_TEXT = Object.freeze({
  vtable: 0x1005b3e8, vSpace: 0x174, lineHeight: 0x178,
  textParams: 0x17c, rowData: 0x194, queryTextParams: 0x1a0, queryRowData: 0x1b8, tempRowData: 0x1c4,
});
export const TEXT_PARAMS = Object.freeze({flags: 0, dirtyStart: 4, dirtyCount: 8, normalFont: 0xc, boldFont: 0x10, destWidth: 0x14, size: 0x18});
export const TEXT_ROW = Object.freeze({size: 0x24, width: 0, start: 4, length: 8, fullLength: 0xc, state: 0x10});
const W_ = Object.freeze({width: 0x80, height: 0x84, clipY: 0xe0, clipHeight: 0xe8, hAlign: 0x14c, vAlign: 0x14d,
  textFlags: 0x150, hMargin: 0x154, vMargin: 0x158, minLines: 0x15c, maxLines: 0x160, minWidth: 0x164,
  text: 0x168, textNum: 0x16c});

const HALF = {neg: 0, sig: 1n, exp: -1};                 // double 0.5 at 0x1005aa20
const DRAW_EPSILON = x87double(0.00001);                 // double at 0x1005d3a8
const ONE = 1;                                           // float 1.0 at 0x1005aa18
const lt = (a, b) => { const c = x87cmp(a, b); return c === 'lt' || c === 'un'; };   // fcomp C0
const twice = v => A(X(v), X(v));                                                   // fld m; fadd st0,st0

/** The text FString as UTF-16 units (the shared L"" when Num is 0). */
export function textUnitsOf(W, win) {
  const num = W.i32(win, W_.textNum), data = W.u32(win, W_.text), mem = W.heap.mem;
  const units = new Uint16Array(num ? num - 1 : 0);
  for (let i = 0; i < units.length; i++) units[i] = mem.read(data + 2 * i, 'u16');
  return units;
}
const readState = (mem, at) => { const s = new Uint8Array(20); for (let i = 0; i < 20; i++) s[i] = mem.read(at + i, 'u8'); return s; };
const writeState = (mem, at, s) => { for (let i = 0; i < 20; i++) mem.write(at + i, 'u8', s[i]); };
const rowAt = (mem, array, index) => mem.read(array, 'u32') + index * TEXT_ROW.size;

/** XLargeTextWindow::XLargeTextWindow 0x10012a50: the XWindow part, then the
 * three row arrays zeroed and the class vtable. */
export function constructLargeTextWindow(W, win, constructWindow) {
  constructWindow(win);
  for (let o = LARGE_TEXT.rowData; o < LARGE_TEXT.rowData + 0xc; o += 4) W.setU32(win, o, 0);
  for (let o = LARGE_TEXT.queryRowData; o < LARGE_TEXT.tempRowData + 0xc; o += 4) W.setU32(win, o, 0);
  W.setU32(win, 0, LARGE_TEXT.vtable);
}

/** 0x1002d9d0 ComputeLineHeight(gc): GetFontHeight(0) raised to 1.0 (fcom C0),
 * or 1.0 without a GC. The x87 result is integer-valued or 1.0. */
export function computeLineHeight(W, gc) {
  if (!gc) return ONE;
  const height = gcGetFontHeightMethod(gc, 0, W.gc.services);
  return lt(X(height), X(ONE)) ? ONE : height;
}

/** XLargeTextWindow::Init 0x1002d480 after XTextWindow::Init. */
export function initLargeTextWindow(W, win, parent, initText, enableTextAsAccelerator) {
  initText(win, parent);
  W.setF32(win, LARGE_TEXT.vSpace, 1);
  W.setF32(win, LARGE_TEXT.lineHeight, 0);
  const gc = W.gc.get(win);
  if (gc) { W.setF32(win, LARGE_TEXT.lineHeight, S(X(computeLineHeight(W, gc)))); W.gc.release(win, gc); }
  W.setU32(win, LARGE_TEXT.queryTextParams, W.u32(win, LARGE_TEXT.queryTextParams) | 1);
  W.setU32(win, LARGE_TEXT.textParams, W.u32(win, LARGE_TEXT.textParams) | 1);
  enableTextAsAccelerator(win, 0);
}

/** 0x1002d880 MakeLinesDirty: bit0 of both XTextParams. */
export function makeLinesDirty(W, win) {
  W.setU32(win, LARGE_TEXT.textParams, W.u32(win, LARGE_TEXT.textParams) | 1);
  W.setU32(win, LARGE_TEXT.queryTextParams, W.u32(win, LARGE_TEXT.queryTextParams) | 1);
}

/** XLargeTextWindow::SetText 0x1002d6b0: MakeLinesDirty, then
 * XTextWindow::SetText 0x10045d50 (`textServices` as for the TextWindow
 * natives). */
export function largeTextSetText(W, win, text, textServices) {
  makeLinesDirty(W, win);
  setTextNative(win, text, textServices);
}
/** XLargeTextWindow::AppendText 0x1002d730: a non-empty text marks
 * [end, end + length) dirty (MakeAreaDirty 0x1002d8b0, `makeAreaDirty`), then
 * XTextWindow::AppendText 0x10045e60. */
export function largeTextAppendText(W, win, text, textServices, makeAreaDirty) {
  const num = W.i32(win, W_.textNum), length = text.split('\0', 1)[0].length;
  if (length > 0) makeAreaDirty(win, num ? num - 1 : 0, 0, length);
  appendTextNative(win, text, textServices);
}

/** XLargeTextWindow::CleanUp 0x1002d560: empty the three row arrays (Num = Max
 * = 0, FArray::Realloc), then XTextWindow::CleanUp. */
export function cleanUpLargeTextWindow(W, win, textCleanUp) {
  const mem = W.heap.mem, base = W.addressOf(win);
  for (const o of [LARGE_TEXT.rowData, LARGE_TEXT.queryRowData, LARGE_TEXT.tempRowData]) {
    mem.write(base + o + 4, 'i32', 0); mem.write(base + o + 8, 'i32', 0);
    farrayRealloc(mem, base + o, TEXT_ROW.size);
  }
  textCleanUp(win);
}

/** ~XLargeTextWindow: the row arrays' ~TArray (their data is already freed by
 * CleanUp unless a destroy skipped it). */
export function destroyLargeTextMembers(W, win) {
  const mem = W.heap.mem, base = W.addressOf(win);
  for (const o of [LARGE_TEXT.rowData, LARGE_TEXT.queryRowData, LARGE_TEXT.tempRowData]) {
    const data = mem.read(base + o, 'u32');
    if (data) mem.free(data);
    for (let i = 0; i < 12; i += 4) mem.write(base + o + i, 'u32', 0);
  }
}

/** 0x1002da70 GenerateLines(gc, params, rows, &lineHeight, width). Returns the
 * f32 line height (stored first through the out pointer). An unchanged
 * XTextParams (flags bits 0-1, width, fonts) reflows only the dirty range:
 * rows from two before the first dirty row are rescanned into tempRowData
 * until a scanned line resynchronises with an old row start and state, and
 * the scratch rows are spliced over the replaced ones. Otherwise every line
 * is regenerated in place. */
export function generateLines(W, win, gc, paramsOffset, rowsOffset, width, writeLineHeight) {
  const mem = W.heap.mem, base = W.addressOf(win), Lg = gcMemory(gc, W.gc.services), g = Lg.base;
  const lineHeight = S(X(computeLineHeight(W, gc)));
  writeLineHeight?.(lineHeight);
  const params = base + paramsOffset, rows = base + rowsOffset, temp = base + LARGE_TEXT.tempRowData;
  const flags = ((Lg.read(g + GC.textFlags, 'u32') >>> 1) & 1) << 1;
  const normal = Lg.read(g + GC.normalFont, 'u32'), bold = Lg.read(g + GC.boldFont, 'u32');
  const units = textUnitsOf(W, win), end = units.length;
  const widthCompare = x87cmp(X(width), X(mem.read(params + TEXT_PARAMS.destWidth, 'f32')));
  const unchanged = !((mem.read(params, 'u32') ^ flags) & 3) && (widthCompare === 'eq' || widthCompare === 'un') &&
    normal === mem.read(params + TEXT_PARAMS.normalFont, 'u32') && bold === mem.read(params + TEXT_PARAMS.boldFont, 'u32');
  const storeRow = (at, pos, line, state) => {
    mem.write(at + TEXT_ROW.start, 'i32', pos);
    mem.write(at + TEXT_ROW.length, 'i32', line.len);
    mem.write(at + TEXT_ROW.fullLength, 'i32', line.next - pos);
    writeState(mem, at + TEXT_ROW.state, state);
    mem.write(at + TEXT_ROW.width, 'f32', line.width);
  };
  if (!unchanged) {
    let allocated = mem.read(rows + 4, 'i32'), count = 0, pos = 0, state = new Uint8Array(20);
    for (;;) {
      const line = gcGetTextLine(Lg, g, units, pos, end, state, width);
      if (!line.progress) break;
      count++;
      if (count > allocated) { farraySetNum(mem, rows, mem.read(rows + 4, 'i32') + count - allocated, TEXT_ROW.size); allocated = count; }
      storeRow(rowAt(mem, rows, count - 1), pos, line, state);
      state = line.state; pos = line.next;
    }
    if (count > 0) { const at = rowAt(mem, rows, count - 1) + TEXT_ROW.fullLength; mem.write(at, 'i32', mem.read(at, 'i32') + 1); }
    if (count < allocated) farrayRemove(mem, rows, count, allocated - count, TEXT_ROW.size);
  } else if (mem.read(params + TEXT_PARAMS.dirtyCount, 'i32') > 0) {
    const dirtyStart = mem.read(params + TEXT_PARAMS.dirtyStart, 'i32');
    const dirtyEnd = mem.read(params + TEXT_PARAMS.dirtyCount, 'i32') + dirtyStart;
    const num = mem.read(rows + 4, 'i32'), start = i => mem.read(rowAt(mem, rows, i) + TEXT_ROW.start, 'i32');
    let first = 0;
    while (first < num && !(dirtyStart < start(first))) first++;
    first -= 2; if (first < 0) first = 0;
    let resume = first;
    while (resume < num && !(dirtyEnd < start(resume))) resume++;
    resume++;
    const scratch = mem.read(temp + 4, 'i32');
    if (scratch > 0) farrayRemove(mem, temp, 0, scratch, TEXT_ROW.size);
    let pos = 0, state = new Uint8Array(20);
    if (num > 0) { const at = rowAt(mem, rows, first); pos = mem.read(at + TEXT_ROW.start, 'i32'); state = readState(mem, at + TEXT_ROW.state); }
    const sameState = (at, s) => {
      if (mem.read(at, 'u8') !== s[0] || mem.read(at + 3, 'u8') !== s[3] || mem.read(at + 1, 'u8') !== s[1]) return false;
      if (!s[1]) return true;
      const view = new DataView(s.buffer);
      for (let i = 4; i < 20; i += 4) {
        const c = x87cmp(X(mem.read(at + i, 'f32')), X(view.getFloat32(i, true)));
        if (c !== 'eq' && c !== 'un') return false;
      }
      return true;
    };
    for (;;) {
      const line = gcGetTextLine(Lg, g, units, pos, end, state, width);
      if (!line.progress) break;
      const k = mem.read(temp + 4, 'i32');
      farraySetNum(mem, temp, k + 1, TEXT_ROW.size);
      storeRow(rowAt(mem, temp, k), pos, line, state);
      state = line.state; pos = line.next;
      while (resume < num && start(resume) < pos) resume++;
      if (resume >= num || start(resume) !== pos) continue;
      if (sameState(rowAt(mem, rows, resume) + TEXT_ROW.state, state)) break;
      resume++;
    }
    const oldNum = mem.read(rows + 4, 'i32'), replaced = Math.min(resume, oldNum) - first;
    const generated = mem.read(temp + 4, 'i32');
    if (generated > replaced) {
      const extra = generated - replaced;
      farraySetNum(mem, rows, oldNum + extra, TEXT_ROW.size);
      const data = mem.read(rows, 'u32');
      moveBytes(mem, data + (extra + first) * TEXT_ROW.size, data + first * TEXT_ROW.size, (oldNum - first) * TEXT_ROW.size);
    } else farrayRemove(mem, rows, first, replaced - generated, TEXT_ROW.size);
    for (let j = 0; j < generated; j++)
      moveBytes(mem, rowAt(mem, rows, first + j), rowAt(mem, temp, j), TEXT_ROW.size);
    const total = mem.read(rows + 4, 'i32');
    if (first + generated >= total && total > 0) {
      const at = rowAt(mem, rows, total - 1) + TEXT_ROW.fullLength; mem.write(at, 'i32', mem.read(at, 'i32') + 1);
    }
  }
  mem.write(params, 'u32', flags);
  mem.write(params + TEXT_PARAMS.dirtyStart, 'i32', 0);
  mem.write(params + TEXT_PARAMS.dirtyCount, 'i32', 0);
  mem.write(params + TEXT_PARAMS.normalFont, 'u32', normal);
  mem.write(params + TEXT_PARAMS.boldFont, 'u32', bold);
  mem.write(params + TEXT_PARAMS.destWidth, 'f32', width);
  return lineHeight;
}

/** 0x1002e130 GetTextExtent(rows, &lineHeight, &w, &h): the widest row, and
 * n * lineHeight + (n - 1) * vSpace (lineHeight alone without rows). */
export function largeTextExtent(W, win, rowsOffset, lineHeight) {
  const mem = W.heap.mem, rows = W.addressOf(win) + rowsOffset, num = mem.read(rows + 4, 'i32');
  if (num <= 0) return {width: 0, height: lineHeight};
  let width = 0;
  for (let i = 0; i < num; i++) {
    const rowWidth = mem.read(rowAt(mem, rows, i) + TEXT_ROW.width, 'f32');
    if (lt(X(width), X(rowWidth))) width = rowWidth;
  }
  const lines = M(I(num), X(lineHeight));
  const height = num > 1 ? S(A(M(I(num - 1), X(W.f32(win, LARGE_TEXT.vSpace))), lines)) : S(lines);
  return {width, height};
}

/** 0x1002e1d0 ParentRequestedPreferredSize. Lays the text out into the query
 * rows at the queried width less both margins (word wrap and a queried width
 * only); min/max lines against the drawing rows' count (+0x198) replace the
 * height with the font height (GetFontHeight(1)); then margins and minWidth. */
export function largeTextPreferredSize(W, win, bW, w, bH, h) {
  const gc = W.gc.get(win);
  if (!gc) return {width: w, height: h};
  const hMargin = W.f32(win, W_.hMargin), vMargin = W.f32(win, W_.vMargin), vSpace = W.f32(win, LARGE_TEXT.vSpace);
  let destWidth = 0;
  if (bW && (W.u8(win, W_.textFlags) & 1)) {
    const inner = A(X(w), N(twice(hMargin)));
    destWidth = lt(inner, X(0)) ? 0 : S(inner);
  }
  let lineHeight = 0;
  lineHeight = generateLines(W, win, gc, LARGE_TEXT.queryTextParams, LARGE_TEXT.queryRowData, destWidth, v => { lineHeight = v; });
  ({width: w, height: h} = largeTextExtent(W, win, LARGE_TEXT.queryRowData, lineHeight));
  if (!bH) {
    const minLines = W.i32(win, W_.minLines), maxLines = W.i32(win, W_.maxLines);
    if (minLines >= 0 || maxLines >= 0) {
      const fontHeight = S(X(gcGetFontHeightMethod(gc, 1, W.gc.services)));
      const rows = W.i32(win, LARGE_TEXT.rowData + 4);
      const linesHeight = n => S(A(M(I(n - 1), X(vSpace)), M(I(n), X(fontHeight))));
      if (minLines >= 0 && minLines > rows) h = linesHeight(minLines);
      if (maxLines >= 0 && rows > maxLines) h = linesHeight(maxLines);
    }
  }
  w = S(A(twice(hMargin), X(w)));
  h = S(A(twice(vMargin), X(h)));
  if (!bW && lt(X(w), X(W.f32(win, W_.minWidth)))) w = W.f32(win, W_.minWidth);
  W.gc.release(win, gc);
  return {width: w, height: h};
}

/** 0x1002e380 ParentRequestedGranularity: (1.0, lineHeight + vSpace) from the
 * GC, then XWindow::ParentRequestedGranularity 0x10050450 (`bridge`). */
export function largeTextGranularity(W, win, hg, vg, bridge) {
  const gc = W.gc.get(win);
  if (gc) {
    vg = S(A(X(computeLineHeight(W, gc)), X(W.f32(win, LARGE_TEXT.vSpace))));
    hg = 1;
    W.gc.release(win, gc);
  }
  return bridge(win, hg, vg);
}

/** 0x1002e430 ConfigurationChanged: GenerateLines into the drawing rows at the
 * width less both margins (word wrap), or unwrapped. No script event. */
export function largeTextConfigurationChanged(W, win) {
  const gc = W.gc.get(win);
  if (!gc) return;
  const destWidth = W.u8(win, W_.textFlags) & 1 ? S(A(X(W.f32(win, W_.width)), N(twice(W.f32(win, W_.hMargin))))) : 0;
  generateLines(W, win, gc, LARGE_TEXT.textParams, LARGE_TEXT.rowData, destWidth, v => W.setF32(win, LARGE_TEXT.lineHeight, v));
  W.gc.release(win, gc);
}

/** The first text row's y (vAlign: 0 top margin, 2 bottom less the margin,
 * else centred through _ftol) — shared by both Draw bodies. */
export function textTop(W, win) {
  const n = W.i32(win, LARGE_TEXT.rowData + 4), lineHeight = W.f32(win, LARGE_TEXT.lineHeight);
  let total = M(I(n), X(lineHeight));
  if (n > 1) total = A(M(I(n - 1), X(W.f32(win, LARGE_TEXT.vSpace))), total);
  const vAlign = W.u8(win, W_.vAlign), height = X(W.f32(win, W_.height));
  if (!vAlign) return W.f32(win, W_.vMargin);
  if (vAlign === 2) return S(A(A(height, N(total)), N(X(W.f32(win, W_.vMargin)))));
  return S(I(T(M(A(height, N(total)), HALF))));
}
/** The visible row range from the window clip (fistp of the first row less
 * one half, Core appCeil of the last, clamped to [0, n]). */
export function visibleRows(W, win, top, rowStep) {
  const n = W.i32(win, LARGE_TEXT.rowData + 4), clipY = W.f32(win, W_.clipY);
  const q = S(D(A(A(X(clipY), DRAW_EPSILON), N(X(top))), X(rowStep)));
  let first = x87fistp(A(X(q), N(X(0.5))));
  const lastValue = S(D(A(A(X(W.f32(win, W_.clipHeight)), X(clipY)), N(X(top))), X(rowStep)));
  let last = T(X(Math.ceil(lastValue)));       // Core appCeil 0x10123300: ceil(double) -> _ftol
  if (last > n) last = n;
  if (first < 0) first = 0;
  return {first, last};
}
/** A row's x for the horizontal alignment (0 margin, 2 right less margin,
 * else centred through _ftol). */
export function rowLeft(W, win, rowWidth) {
  const hAlign = W.u8(win, W_.hAlign), hMargin = W.f32(win, W_.hMargin), width = X(W.f32(win, W_.width));
  if (!hAlign) return hMargin;
  if (hAlign === 2) return S(A(A(width, N(X(rowWidth))), N(X(hMargin))));
  return S(I(T(M(A(width, N(X(rowWidth))), HALF))));
}
/** GC clip save / Intersect(margins) / SetClipRect 0x10026f00 restore. */
export function clipToMargins(W, win, gc) {
  const Lg = gcMemory(gc, W.gc.services), saved = [];
  for (let i = 0; i < 6; i++) saved.push(Lg.read(Lg.base + GC.originX + 4 * i, 'u32'));
  const hMargin = W.f32(win, W_.hMargin), vMargin = W.f32(win, W_.vMargin);
  const innerHeight = S(A(X(W.f32(win, W_.height)), N(twice(vMargin))));
  const innerWidth = S(A(X(W.f32(win, W_.width)), N(twice(hMargin))));
  gcIntersect(gc, hMargin, vMargin, innerWidth, innerHeight, W.gc.services);
  return () => saved.forEach((word, i) => Lg.write(Lg.base + GC.originX + 4 * i, 'u32', word));
}

/** 0x1002e500 Draw: script DrawWindow (XWindow::Draw 0x10003bf0), then each
 * visible row through DrawTextLine inside the margins. */
export function largeTextDraw(W, win, gc) {
  W.processScript(win, 'DrawWindow', [gc]);
  const mem = W.heap.mem, rows = W.addressOf(win) + LARGE_TEXT.rowData, units = textUnitsOf(W, win);
  const lineHeight = W.f32(win, LARGE_TEXT.lineHeight), vSpace = W.f32(win, LARGE_TEXT.vSpace);
  const top = textTop(W, win), rowStep = S(A(X(lineHeight), X(vSpace)));
  const {first, last} = visibleRows(W, win, top, rowStep);
  const restore = clipToMargins(W, win, gc), Lg = gcMemory(gc, W.gc.services);
  let y = S(A(M(A(X(lineHeight), X(vSpace)), I(first)), X(top)));
  for (let row = first; row < last; row++) {
    const at = rowAt(mem, rows, row);
    const x = rowLeft(W, win, mem.read(at + TEXT_ROW.width, 'f32'));
    gcDrawTextLine(Lg, Lg.base, x, y, readState(mem, at + TEXT_ROW.state), units,
      mem.read(at + TEXT_ROW.start, 'i32'), mem.read(at + TEXT_ROW.length, 'i32'));
    y = S(A(A(X(lineHeight), X(vSpace)), X(y)));
  }
  restore();
}
export {readState as readRowState, rowAt as textRowAt};
