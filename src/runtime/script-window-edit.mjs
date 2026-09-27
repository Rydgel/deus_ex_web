/**
 * Recovered Extension.dll XEditWindow window bodies (base 0x10000000, SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c). The
 * text-editing methods behind natives 1880-1920 live in script-edit-model.mjs
 * and script-edit-*.mjs; this module holds the lifecycle, caret geometry and
 * the virtual overrides:
 *
 *   ctor 0x10013690, Init 0x1001cea0, CleanUp 0x1001d0b0
 *   YToRow 0x1001e740, XToCol 0x1001e7f0, RowToY 0x1001e930, ColToX 0x1001e9d0
 *   XYToPos 0x1001ec10, PosToXY 0x1001ecd0, ShowCursor 0x1001ef40
 *   ComputeCursorConfig 0x1001f680, ActivateEdit 0x1001fb50
 *   PlayEditSound 0x1001dca0 (exec 0x10022880), AppendText 0x1001e310
 *   Tick 0x100207d0, CursorRequested 0x10020940, ParentRequestedPreferredSize
 *   0x10020ac0, ConfigurationChanged 0x10020ba0, VisibilityChanged 0x10020c60,
 *   Draw 0x10020d00, KeyPressed 0x10021290, VirtualKeyPressed 0x10021480,
 *   MouseButtonPressed 0x10021570, MouseMoved 0x100216b0,
 *   MouseButtonReleased 0x10021760, XWindow::EnableSpecialText 0x1004dbe0
 *
 * Field names are the script EditWindow declarations (Extension.u). `env`
 * supplies the host services: editL(win) (the edit-model memory view),
 * askParentForReconfigure, askParentToShowArea, setSelectability,
 * getRootWindow, getCursorPos, playSound (XWindow::PlaySound 0x10050050),
 * processScript and the virtual table `v`. Evidence:
 * docs/script-large-text-window.md.
 */
import {GC, gcMemory} from './script-gc-state-model.mjs';
import {gcGetTextExtentMethod} from './script-gc-get-text-extent.mjs';
import {gcEnableSpecialText} from './script-gc-enable-special-text.mjs';
import {gcSetTextColor} from './script-gc-set-text-color.mjs';
import {gcSetTileColor} from './script-gc-set-tile-color.mjs';
import {gcSetStyle} from './script-gc-set-style.mjs';
import {gcDrawPattern} from './script-gc-draw-pattern.mjs';
import {gcCharToPixel, gcDrawTextChar, gcDrawTextLine, gcPixelToChar} from './script-gc-text-line.mjs';
import {f32Bits} from './script-gc-draw-model.mjs';
import {LARGE_TEXT, TEXT_ROW, clipToMargins, largeTextConfigurationChanged, largeTextPreferredSize,
  readRowState, rowLeft, textRowAt, textTop, textUnitsOf, visibleRows} from './script-window-large-text.mjs';
import {posToLineCol, setInsertionPointEntry, insertTextVirtual} from './script-edit-model.mjs';
import {x87load as X, x87int32 as I, x87add as A, x87neg as N, x87mul as M, x87div as D, x87store as S,
  x87ftol as T, x87double, x87cmp} from './script-vm.mjs';

export const EDIT = Object.freeze({
  vtable: 0x1005b50c, flags: 0x1d0, insertPos: 0x1d4, insertHookPos: 0x1d8, insertType: 0x1dc,
  selectStart: 0x1e0, selectEnd: 0x1e4, maxSize: 0x1e8, insertTexture: 0x1ec, insertColor: 0x1f0,
  selectTexture: 0x1f4, selectColor: 0x1f8, inverseColor: 0x1fc, editCursor: 0x200, editCursorShadow: 0x204,
  editCursorColor: 0x208, typeSound: 0x20c, deleteSound: 0x210, enterSound: 0x214, moveSound: 0x218,
  bufferList: 0x21c, currentUndo: 0x228, maxUndos: 0x22c, unchangedUndo: 0x230, dragDelay: 0x234,
  blinkDelay: 0x238, blinkStart: 0x23c, blinkPeriod: 0x240, cursorFlags: 0x244,
  insertX: 0x248, insertY: 0x24c, insertWidth: 0x250, insertHeight: 0x254, insertPrefWidth: 0x258,
  insertPrefHeight: 0x25c, showAreaX: 0x260, showAreaY: 0x264, showAreaWidth: 0x268, showAreaHeight: 0x26c,
  insertPreferredCol: 0x270, lastConfigWidth: 0x274, lastConfigHeight: 0x278,
  selectStartRow: 0x27c, selectEndRow: 0x280, selectStartX: 0x284, selectEndX: 0x288,
});
// flags: bEditable 1, bSingleLine 2, bUppercaseOnly 4; cursorFlags:
// bCursorShowing 1, bDragging 2, bSelectWords 4.
const HALF = {neg: 0, sig: 1n, exp: -1};          // double 0.5 at 0x1005aa20
const DRAG_REPEAT = Math.fround(0.1);             // float at 0x1005c4c8
const SHOW_MARGIN = 1;                            // float at 0x1005c4cc
const MIN_ROW_WIDTH = 4;                          // float at 0x1005d3a4
const lt = (a, b) => { const c = x87cmp(a, b); return c === 'lt' || c === 'un'; };   // fcomp C0
const leq = (a, b) => { const c = x87cmp(a, b); return c !== 'gt'; };                // fcomp C0|C3
const W_ = Object.freeze({width: 0x80, height: 0x84, hMargin: 0x154, vMargin: 0x158, vAlign: 0x14d,
  soundVolume: 0x114, specialText: 0x74, gc: 0x130, text: 0x168, textNum: 0x16c});

/** XEditWindow::XEditWindow 0x10013690: the XWindow part, FString(ENoInit),
 * the zeroed row arrays and undo array, then the class vtable. */
export function constructEditWindow(W, win, constructWindow) {
  constructWindow(win);
  for (const o of [LARGE_TEXT.rowData, LARGE_TEXT.queryRowData, LARGE_TEXT.tempRowData, EDIT.bufferList])
    for (let i = 0; i < 12; i += 4) W.setU32(win, o + i, 0);
  W.setU32(win, 0, EDIT.vtable);
}

/** XWindow::EnableSpecialText 0x1004dbe0(flag): bit0 of +0x74 and the
 * window GC, then AskParentForReconfigure, only on a change. */
export function enableSpecialText(W, win, flag, env) {
  const word = W.u32(win, W_.specialText);
  if ((word & 1) === flag) return;
  const next = (word & ~1) | (flag & 1);
  W.setU32(win, W_.specialText, next);
  const gc = W.ptr(win, W_.gc);
  if (gc) gcEnableSpecialText(gc, next & 1, W.gc.services);
  env.askParentForReconfigure(win);
}

/** XEditWindow::Init 0x1001cea0 after XLargeTextWindow::Init. The three
 * FColor(r,g,b) stack temporaries reuse the Init argument slot, so their
 * alpha byte is the high byte of the parent pointer. */
export function initEditWindow(W, win, parent, env) {
  env.initLargeText(win, parent);
  W.setU8(win, 0x14c, 0); W.setU8(win, 0x14d, 0);
  W.setF32(win, W_.hMargin, 3); W.setF32(win, W_.vMargin, 0);
  const alpha = ((parent ? W.addressOf(parent) : 0) >>> 24) << 24;
  W.setU32(win, EDIT.flags, (W.u32(win, EDIT.flags) & ~6) | 1);
  W.setI32(win, EDIT.insertPos, 0); W.setI32(win, EDIT.insertHookPos, 0); W.setU8(win, EDIT.insertType, 0);
  W.setI32(win, EDIT.selectStart, 0); W.setI32(win, EDIT.selectEnd, 0); W.setI32(win, EDIT.maxSize, 200000);
  W.setU32(win, EDIT.inverseColor, alpha); W.setU32(win, EDIT.insertColor, alpha | 0xffffff);
  W.setU32(win, EDIT.selectColor, alpha | 0xc4c4c4);
  W.setI32(win, EDIT.currentUndo, 0); W.setI32(win, EDIT.maxUndos, 0x40); W.setI32(win, EDIT.unchangedUndo, 0);
  W.setF32(win, EDIT.blinkStart, 0.75); W.setF32(win, EDIT.blinkPeriod, 1); W.setU32(win, EDIT.dragDelay, 0);
  W.setF32(win, EDIT.blinkDelay, S(A(x87double(W.tickOffset()), X(W.f32(win, EDIT.blinkStart)))));
  for (const o of [EDIT.insertX, EDIT.insertPreferredCol, EDIT.lastConfigWidth, EDIT.lastConfigHeight]) W.setF32(win, o, -1);
  W.setU32(win, EDIT.cursorFlags, (W.u32(win, EDIT.cursorFlags) & ~6) | 1);
  W.setU32(win, EDIT.editCursor, 0);
  for (let o = EDIT.typeSound; o <= EDIT.moveSound; o += 4) W.setU32(win, o, 0);
  for (let o = EDIT.insertY; o <= EDIT.showAreaHeight; o += 4) W.setU32(win, o, 0);
  W.setI32(win, EDIT.selectStartRow, -1); W.setI32(win, EDIT.selectEndRow, -1);
  W.setU32(win, EDIT.selectStartX, 0); W.setU32(win, EDIT.selectEndX, 0);
  enableSpecialText(W, win, 0, env);
  env.setSelectability(win, 1);
  computeCursorConfig(W, win, 1, env);
}

// ---------------------------------------------------------------------------
// Row geometry over the drawing rows (+0x194).
// ---------------------------------------------------------------------------
const rowCount = (W, win) => W.i32(win, LARGE_TEXT.rowData + 4);
const rowField = (W, win, row, field, kind) => W.heap.mem.read(textRowAt(W.heap.mem, W.addressOf(win) + LARGE_TEXT.rowData, row) + field, kind);
function textBlockTop(W, win, n) {
  const lineHeight = W.f32(win, LARGE_TEXT.lineHeight), vAlign = W.u8(win, W_.vAlign);
  let total = M(I(n), X(lineHeight));
  if (n > 1) total = A(M(I(n - 1), X(W.f32(win, LARGE_TEXT.vSpace))), total);
  if (!vAlign) return X(W.f32(win, W_.vMargin));
  const room = A(X(W.f32(win, W_.height)), N(total));
  if (vAlign === 2) return A(room, N(X(W.f32(win, W_.vMargin))));
  return I(T(M(room, HALF)));
}
const rowPitch = (W, win) => A(X(W.f32(win, LARGE_TEXT.vSpace)), X(W.f32(win, LARGE_TEXT.lineHeight)));

/** 0x1001e740 YToRow(y): _ftol((y - top) / (vSpace + lineHeight)) clamped. */
export function yToRow(W, win, y) {
  const n = rowCount(W, win);
  let row = T(D(A(X(y), N(textBlockTop(W, win, n))), rowPitch(W, win)));
  if (row > n - 1) row = n - 1;
  if (row < 0) row = 0;
  return row;
}
/** 0x1001e930 RowToY(row): the x87 top of a row (at least one row counted). */
export function rowToY(W, win, row) {
  const n = Math.max(rowCount(W, win), 1);
  return A(textBlockTop(W, win, n), M(rowPitch(W, win), I(row)));
}
/** 0x1001e7f0 XToCol(row, x): PixelToChar over the row from its aligned left. */
export function xToCol(W, win, row, x) {
  if (row < 0 || row >= rowCount(W, win)) return 0;
  const left = rowLeft(W, win, rowField(W, win, row, TEXT_ROW.width, 'f32'));
  const gc = W.gc.get(win);
  if (!gc) return 0;
  const Lg = gcMemory(gc, W.gc.services), at = textRowAt(W.heap.mem, W.addressOf(win) + LARGE_TEXT.rowData, row);
  const col = gcPixelToChar(Lg, Lg.base, textUnitsOf(W, win), W.heap.mem.read(at + TEXT_ROW.start, 'i32'),
    S(A(X(x), N(X(left)))), W.heap.mem.read(at + TEXT_ROW.length, 'i32'), readRowState(W.heap.mem, at + TEXT_ROW.state));
  W.gc.release(win, gc);
  return col;
}
/** 0x1001e9d0 ColToX(row, col): the x87 left of a column. */
export function colToX(W, win, row, col) {
  const valid = row >= 0 && row < rowCount(W, win);
  const left = rowLeft(W, win, valid ? rowField(W, win, row, TEXT_ROW.width, 'f32') : 0);
  let offset = X(0);
  if (valid) {
    const gc = W.gc.get(win);
    if (gc) {
      const Lg = gcMemory(gc, W.gc.services), at = textRowAt(W.heap.mem, W.addressOf(win) + LARGE_TEXT.rowData, row);
      offset = X(gcCharToPixel(Lg, Lg.base, textUnitsOf(W, win), W.heap.mem.read(at + TEXT_ROW.start, 'i32'), col,
        W.heap.mem.read(at + TEXT_ROW.length, 'i32'), readRowState(W.heap.mem, at + TEXT_ROW.state)));
      W.gc.release(win, gc);
    }
  }
  return A(offset, X(left));
}
/** 0x1001ec10 XYToPos(x, y). */
export function xyToPos(W, win, x, y) {
  if (rowCount(W, win) <= 0) return 0;
  const row = yToRow(W, win, y), col = xToCol(W, win, row, x);
  return rowField(W, win, row, TEXT_ROW.start, 'i32') + col;
}
/** 0x1001ecd0 PosToXY(pos): y (RowToY) before x (ColToX), both stored f32. */
function posToXY(W, win, pos, env) {
  const {line, col} = posToLineCol(env.editL(win), pos);
  const y = S(rowToY(W, win, line));
  return {x: S(colToX(W, win, line, col)), y};
}

/** 0x1001f680 ComputeCursorConfig(bUpdatePreferredCol): the caret box from
 * the insertion type, the glyph box under the caret (GetTextExtent of that
 * character, a space for NUL/whitespace), the show area covering both, and
 * the selection rows and x ends. */
export function computeCursorConfig(W, win, sticky, env) {
  const lineHeight = W.f32(win, LARGE_TEXT.lineHeight);
  let charHeight = lineHeight, charWidth = 8;
  const type = W.u8(win, EDIT.insertType), bottomAligned = type === 1 || type === 2 || type === 4;
  const units = textUnitsOf(W, win), pos = W.i32(win, EDIT.insertPos);
  let ch = pos >= 0 && pos < units.length ? units[pos] : 0;
  if (!ch || (ch >= 9 && ch <= 0xd) || ch === 0x20) ch = 0x20;
  const gc = W.gc.get(win);
  if (gc) {
    const extent = gcGetTextExtentMethod(gc, 0, true, true, String.fromCharCode(ch), W.gc.services);
    charWidth = extent.xExtent; charHeight = extent.yExtent;
    W.gc.release(win, gc);
  }
  const clampTo = (offset, value, floor) => { W.setF32(win, offset, value); if (lt(X(value), X(1))) W.setF32(win, offset, floor); };
  if (type === 0) {
    clampTo(EDIT.insertWidth, W.f32(win, EDIT.insertPrefWidth), 2);
    W.setU32(win, EDIT.insertHeight, W.u32(win, LARGE_TEXT.lineHeight));
  } else if (type === 1 || type === 2) {
    clampTo(EDIT.insertWidth, charWidth, 1);
    if (type === 1) clampTo(EDIT.insertHeight, W.f32(win, EDIT.insertPrefHeight), 2);
    else {
      const vSpace = W.f32(win, LARGE_TEXT.vSpace);
      W.setF32(win, EDIT.insertHeight, S(A(A(X(vSpace), N(I(T(M(X(vSpace), HALF))))), X(lineHeight))));
    }
  } else {
    const texture = () => W.ptr(win, EDIT.insertTexture) ?? W.boundary('XEditWindow::ComputeCursorConfig dereferences a null insertTexture');
    W.setF32(win, EDIT.insertWidth, W.f32(win, EDIT.insertPrefWidth));
    if (lt(X(W.f32(win, EDIT.insertWidth)), X(1))) W.setF32(win, EDIT.insertWidth, W.i32(texture(), 0x34));
    W.setF32(win, EDIT.insertHeight, W.f32(win, EDIT.insertPrefHeight));
    if (lt(X(W.f32(win, EDIT.insertHeight)), X(1))) W.setF32(win, EDIT.insertHeight, W.i32(texture(), 0x38));
  }
  const at = posToXY(W, win, pos, env);
  W.setF32(win, EDIT.insertX, at.x); W.setF32(win, EDIT.insertY, at.y);
  if (sticky) W.setU32(win, EDIT.insertPreferredCol, W.u32(win, EDIT.insertX));
  W.setU32(win, EDIT.showAreaX, W.u32(win, EDIT.insertX));
  W.setU32(win, EDIT.showAreaY, W.u32(win, EDIT.insertY));
  W.setF32(win, EDIT.showAreaHeight, charHeight);
  W.setF32(win, EDIT.showAreaWidth, charWidth);
  const insertWidth = W.f32(win, EDIT.insertWidth), insertHeight = W.f32(win, EDIT.insertHeight);
  if (!bottomAligned) {
    W.setF32(win, EDIT.insertX, S(A(X(W.f32(win, EDIT.insertX)), N(I(T(M(X(insertWidth), HALF)))))));
    W.setF32(win, EDIT.insertY, S(A(I(T(M(A(X(lineHeight), N(X(insertHeight))), HALF))), X(W.f32(win, EDIT.insertY)))));
  } else {
    W.setF32(win, EDIT.insertX, S(A(I(T(M(A(X(charWidth), N(X(insertWidth))), HALF))), X(W.f32(win, EDIT.insertX)))));
    W.setF32(win, EDIT.insertY, S(A(I(T(A(X(lineHeight), N(X(insertHeight))))), X(W.f32(win, EDIT.insertY)))));
  }
  const ix = W.f32(win, EDIT.insertX), iy = W.f32(win, EDIT.insertY);
  if (!leq(X(W.f32(win, EDIT.showAreaX)), X(ix))) {
    W.setF32(win, EDIT.showAreaWidth, S(A(A(X(W.f32(win, EDIT.showAreaX)), N(X(ix))), X(charWidth))));
    W.setF32(win, EDIT.showAreaX, ix);
  }
  if (!leq(X(W.f32(win, EDIT.showAreaY)), X(iy))) {
    W.setF32(win, EDIT.showAreaHeight, S(A(A(X(W.f32(win, EDIT.showAreaY)), N(X(iy))), X(charHeight))));
    W.setF32(win, EDIT.showAreaY, iy);
  }
  const insertRight = A(X(insertWidth), X(ix));
  if (lt(A(X(W.f32(win, EDIT.showAreaX)), X(W.f32(win, EDIT.showAreaWidth))), insertRight))
    W.setF32(win, EDIT.showAreaWidth, S(A(insertRight, N(X(W.f32(win, EDIT.showAreaX))))));
  const insertBottom = A(X(iy), X(insertHeight));
  if (lt(A(X(W.f32(win, EDIT.showAreaHeight)), X(W.f32(win, EDIT.showAreaY))), insertBottom))
    W.setF32(win, EDIT.showAreaHeight, S(A(insertBottom, N(X(W.f32(win, EDIT.showAreaY))))));
  W.setU32(win, EDIT.selectStartX, 0); W.setU32(win, EDIT.selectEndX, 0);
  W.setI32(win, EDIT.selectStartRow, -1); W.setI32(win, EDIT.selectEndRow, -1);
  const start = W.i32(win, EDIT.selectStart), end = W.i32(win, EDIT.selectEnd);
  if (start < end) {
    for (const [pos, row, x] of [[start, EDIT.selectStartRow, EDIT.selectStartX], [end, EDIT.selectEndRow, EDIT.selectEndX]]) {
      const {line, col} = posToLineCol(env.editL(win), pos);
      W.setI32(win, row, line);
      W.setF32(win, x, S(colToX(W, win, line, col)));
    }
  }
}

/** 0x1001ef40 ShowCursor: restart the blink from the tick offset, show the
 * caret and ask the parent to show the caret area widened by one pixel. */
export function showCursor(W, win, env) {
  W.setU32(win, EDIT.cursorFlags, W.u32(win, EDIT.cursorFlags) | 1);
  W.setF32(win, EDIT.blinkDelay, S(A(x87double(W.tickOffset()), X(W.f32(win, EDIT.blinkStart)))));
  const width = S(A(A(X(SHOW_MARGIN), X(SHOW_MARGIN)), X(W.f32(win, EDIT.showAreaWidth))));
  const x = S(A(X(W.f32(win, EDIT.showAreaX)), N(X(SHOW_MARGIN))));
  env.askParentToShowArea(win, x, W.f32(win, EDIT.showAreaY), width, W.f32(win, EDIT.showAreaHeight));
}

/** 0x1001dca0 PlayEditSound(sound, volume, pitch): XWindow::PlaySound at the
 * centre of the show area. */
export function playEditSound(W, win, sound, volume, pitch, env) {
  const y = S(A(M(X(W.f32(win, EDIT.showAreaHeight)), HALF), X(W.f32(win, EDIT.showAreaY))));
  const x = S(A(M(X(W.f32(win, EDIT.showAreaWidth)), HALF), X(W.f32(win, EDIT.showAreaX))));
  env.playSound(win, sound, volume, pitch, x, y);
}

/** 0x1001fb50 ActivateEdit: EditActivated(this, modified) up the parent chain
 * until one handles it. */
export function activateEdit(W, win, env) {
  const modified = W.i32(win, EDIT.currentUndo) !== W.i32(win, EDIT.unchangedUndo) ? 1 : 0;
  for (let w = win; w; w = W.ptr(w, 0x138)) if (env.v.editActivated(w, win, modified)) break;
}

/** 0x1001e310 AppendText(text): select the end, InsertText(text, 0, 0), then
 * SetInsertionPoint(0, 0). */
export function editAppendText(W, win, textPtr, env) {
  const L = env.editL(win), num = W.i32(win, W_.textNum), end = num ? num - 1 : 0;
  W.setI32(win, EDIT.selectStart, end); W.setI32(win, EDIT.selectEnd, end); W.setI32(win, EDIT.insertPos, end);
  insertTextVirtual(L, textPtr, 0, 0);
  setInsertionPointEntry(L, 0, 0);
}

/** 0x100207d0 Tick(delta): the caret blink (bEditable) and the drag repeat
 * (bDragging), which re-runs MouseMoved at the cursor. */
export function editTick(W, win, delta, env) {
  if (W.u8(win, EDIT.flags) & 1) {
    const t = A(X(W.f32(win, EDIT.blinkDelay)), N(X(delta)));
    W.setF32(win, EDIT.blinkDelay, S(t));
    if (lt(t, X(0))) {
      const half = M(X(W.f32(win, EDIT.blinkPeriod)), HALF), next = A(X(S(t)), half);
      W.setF32(win, EDIT.blinkDelay, S(next));
      if (lt(next, X(0))) W.setF32(win, EDIT.blinkDelay, S(half));
      W.setU32(win, EDIT.cursorFlags, W.u32(win, EDIT.cursorFlags) ^ 1);
    }
  }
  if (!(W.u8(win, EDIT.cursorFlags) & 2)) return;
  const t = A(X(W.f32(win, EDIT.dragDelay)), N(X(delta)));
  W.setF32(win, EDIT.dragDelay, S(t));
  if (!lt(t, X(0))) return;
  const next = A(t, X(DRAG_REPEAT));
  W.setF32(win, EDIT.dragDelay, S(next));
  if (lt(next, X(0))) W.setF32(win, EDIT.dragDelay, DRAG_REPEAT);
  const {x, y} = env.getCursorPos(win);
  env.v.mouseMoved(win, x, y);
}

/** 0x10020940 CursorRequested: while editing, the edit cursor, else the
 * root's default edit cursor (+0x5a8), else the script event; the shadow and
 * colour outputs are the edit cursor's. Without bEditable the script event
 * alone (XWindow's parameter block, whose shadow slot holds the caller's
 * pointer and is never copied back). */
export function editCursorRequested(W, win, source, x, y, hotX, hotY, color, env) {
  let shadow;
  if (W.u8(win, EDIT.flags) & 1) {
    const root = env.getRootWindow(win);
    shadow = W.ptr(win, EDIT.editCursorShadow); color = W.u32(win, EDIT.editCursorColor);
    const cursor = W.ptr(win, EDIT.editCursor) ?? (root ? W.ptr(root, 0x5a8) : null);
    if (cursor) return {texture: cursor, hotX, hotY, color, shadow};
  }
  const result = env.scriptCursorRequested(win, source, x, y, hotX, hotY, color);
  return shadow === undefined ? result : {...result, shadow};
}

/** 0x10020ac0 ParentRequestedPreferredSize: XLargeTextWindow's, then a
 * single-line height (2 * vMargin + lineHeight) for an open height and the
 * width of " " added for an open width. */
export function editPreferredSize(W, win, bW, w, bH, h) {
  ({width: w, height: h} = largeTextPreferredSize(W, win, bW, w, bH, h));
  if ((W.u8(win, EDIT.flags) & 2) && !bH) {
    const vMargin = W.f32(win, W_.vMargin);
    h = S(A(A(X(vMargin), X(vMargin)), X(W.f32(win, LARGE_TEXT.lineHeight))));
  }
  if (!bW) {
    const gc = W.gc.get(win);
    if (gc) {
      const extent = gcGetTextExtentMethod(gc, 0, true, true, ' ', W.gc.services);
      w = S(A(X(extent.xExtent), X(w)));
      W.gc.release(win, gc);
    }
  }
  return {width: w, height: h};
}

/** 0x10020ba0 ConfigurationChanged: the LargeText layout, then the caret with
 * the preferred column refreshed unless the size is unchanged (fcomp C3). */
export function editConfigurationChanged(W, win, env) {
  largeTextConfigurationChanged(W, win);
  const same = (a, b) => { const c = x87cmp(X(a), X(b)); return c === 'eq' || c === 'un'; };
  const unchanged = same(W.f32(win, EDIT.lastConfigWidth), W.f32(win, W_.width)) &&
    same(W.f32(win, EDIT.lastConfigHeight), W.f32(win, W_.height));
  computeCursorConfig(W, win, unchanged ? 0 : 1, env);
  W.setU32(win, EDIT.lastConfigHeight, W.u32(win, W_.height));
  W.setU32(win, EDIT.lastConfigWidth, W.u32(win, W_.width));
}

/** 0x10020c60 VisibilityChanged: the script event, then for a shown window
 * AskParentForReconfigure and ShowCursor. */
export function editVisibilityChanged(W, win, visible, env) {
  env.processScript(win, 'VisibilityChanged', [Boolean(visible)]);
  if (!visible) return;
  env.askParentForReconfigure(win);
  showCursor(W, win, env);
}

/** 0x10020d00 Draw. Without bEditable or focus: XLargeTextWindow::Draw.
 * Otherwise the script DrawWindow, each visible row (at least 4 pixels wide)
 * with fully selected rows on a selectTexture pattern in inverseColor, the
 * selection's end rows glyph by glyph (DrawTextChar) with the colour switched
 * inside [selectStartX, selectEndX), and the caret pattern when showing. */
export function editDraw(W, win, gc, env) {
  if (!(W.u8(win, EDIT.flags) & 1) || !env.isFocusWindow(win)) return env.largeTextDraw(win, gc);
  env.processScript(win, 'DrawWindow', [gc]);
  const s = W.gc.services, Lg = gcMemory(gc, s), mem = W.heap.mem;
  const vSpace = W.f32(win, LARGE_TEXT.vSpace), lineHeight = W.f32(win, LARGE_TEXT.lineHeight);
  const halfSpacing = S(A(X(vSpace), N(I(T(M(X(vSpace), HALF))))));
  const units = textUnitsOf(W, win), top = textTop(W, win);
  const {first, last} = visibleRows(W, win, top, S(A(X(lineHeight), X(vSpace))));
  gcSetTileColor(gc, W.u32(win, EDIT.selectColor), s);
  const textColor = Lg.read(Lg.base + GC.textColor, 'u32');
  const restore = clipToMargins(W, win, gc);
  let rowStep = S(A(X(lineHeight), X(vSpace)));
  let y = S(A(M(I(first), X(rowStep)), X(top)));
  const rowsBase = W.addressOf(win) + LARGE_TEXT.rowData, width = W.f32(win, W_.width);
  const pattern = (x, py, w, h) => gcDrawPattern(gc, ...[x, py, w, h, x, py].map(f32Bits), W.u32(win, EDIT.selectTexture), s);
  for (let row = first; row < last; row++) {
    const at = textRowAt(mem, rowsBase, row);
    let rowWidth = mem.read(at + TEXT_ROW.width, 'f32');
    if (lt(X(rowWidth), X(MIN_ROW_WIDTH))) rowWidth = MIN_ROW_WIDTH;
    const x = rowLeft(W, win, rowWidth);
    const startRow = W.i32(win, EDIT.selectStartRow), endRow = W.i32(win, EDIT.selectEndRow);
    const start = mem.read(at + TEXT_ROW.start, 'i32'), length = mem.read(at + TEXT_ROW.length, 'i32');
    const state = readRowState(mem, at + TEXT_ROW.state), patternY = S(A(X(y), N(X(halfSpacing))));
    if (row !== startRow && row !== endRow) {
      if (row >= startRow && row <= endRow) {
        gcSetTextColor(gc, W.u32(win, EDIT.inverseColor), s);
        pattern(x, patternY, rowWidth, S(A(X(lineHeight), X(vSpace))));
        gcDrawTextLine(Lg, Lg.base, x, y, state, units, start, length);
        gcSetTextColor(gc, textColor, s);
      } else gcDrawTextLine(Lg, Lg.base, x, y, state, units, start, length);
    } else {
      const from = row === startRow ? W.f32(win, EDIT.selectStartX) : x;
      const to = row === endRow ? W.f32(win, EDIT.selectEndX) : S(A(X(x), X(rowWidth)));
      pattern(from, patternY, S(A(X(to), N(X(from)))), rowStep);
      const pen = {v: x}, cursor = {pos: start}, remaining = {v: length};
      let highlighted = 0;
      do {
        if (!lt(X(pen.v), X(from)) && lt(X(pen.v), X(to))) {
          if (!highlighted) { gcSetTextColor(gc, W.u32(win, EDIT.inverseColor), s); highlighted = 1; }
        } else if (highlighted) { gcSetTextColor(gc, textColor, s); highlighted = 0; }
      } while (gcDrawTextChar(Lg, Lg.base, pen, y, state, units, cursor, remaining));
      if (highlighted) gcSetTextColor(gc, textColor, s);
    }
    const step = A(X(lineHeight), X(vSpace));
    rowStep = S(step);
    y = S(A(step, X(y)));
  }
  restore();
  if (!(W.u8(win, EDIT.cursorFlags) & 1) || !W.u32(win, EDIT.insertTexture)) return;
  gcSetStyle(gc, 2, s);
  gcSetTileColor(gc, W.u32(win, EDIT.insertColor), s);
  gcDrawPattern(gc, ...[EDIT.insertX, EDIT.insertY, EDIT.insertWidth, EDIT.insertHeight].map(o => W.u32(win, o)), 0, 0,
    W.u32(win, EDIT.insertTexture), s);
}

/** 0x10021290 KeyPressed(key): the script event, then while editing a
 * printable key other than '`' and '~' goes through InsertText (with undo)
 * from the static buffer 0x1009b318 and plays typeSound. */
export function editKeyPressed(W, win, key, env) {
  let result = env.processScript(win, 'KeyPressed', [key ? String.fromCharCode(key) : ''], {result: false}) ? 1 : 0;
  if (!(W.u8(win, EDIT.flags) & 1) || key === 0x60 || key === 0x7e || key < 0x20) return result;
  const buffer = env.keyBuffer();
  W.heap.mem.write(buffer, 'u16', key); W.heap.mem.write(buffer + 2, 'u16', 0);
  if (insertTextVirtual(env.editL(win), buffer, 1, 0)) {
    playEditSound(W, win, W.ptr(win, EDIT.typeSound), W.f32(win, W_.soundVolume), 1, env);
    result = 1;
  }
  return result;
}

/** 0x10021480 VirtualKeyPressed(key, bRepeat): Enter plays enterSound and, on
 * an editable single-line window, activates the edit; else the script event. */
export function editVirtualKeyPressed(W, win, key, repeat, env) {
  if (key === 0x0d) {
    playEditSound(W, win, W.ptr(win, EDIT.enterSound), W.f32(win, W_.soundVolume), 1, env);
    const flags = W.u32(win, EDIT.flags);
    if ((flags & 2) && (flags & 1)) { activateEdit(W, win, env); return 1; }
  }
  return env.processScript(win, 'VirtualKeyPressed', [key & 0xff, Boolean(repeat)], {result: false}) ? 1 : 0;
}

/** 0x10021570 MouseButtonPressed: the script event; a left press while
 * editing starts a drag (word selection with Ctrl or on an even click
 * count), arms the 0.1 s drag repeat and moves the insertion point (Shift
 * extends). */
export function editMouseButtonPressed(W, win, x, y, key, count, env) {
  let result = env.processScript(win, 'MouseButtonPressed', [x, y, key & 0xff, count], {result: false}) ? 1 : 0;
  if (key !== 1 || !(W.u8(win, EDIT.flags) & 1)) return result;
  let flags = (W.u32(win, EDIT.cursorFlags) & ~4) | ((env.isKeyDown(win, 0x11) & 1) << 2);
  if ((count - 1) % 2 === 1) flags |= 4;
  W.setU32(win, EDIT.cursorFlags, flags | 2);
  W.setF32(win, EDIT.dragDelay, S(A(x87double(W.tickOffset()), X(DRAG_REPEAT))));
  const pos = xyToPos(W, win, x, y);
  setInsertionPointEntry(env.editL(win), pos, env.isKeyDown(win, 0x10));
  return 1;
}
/** 0x100216b0 MouseMoved: the script event, then drag the insertion point. */
export function editMouseMoved(W, win, x, y, env) {
  env.processScript(win, 'MouseMoved', [x, y]);
  if (W.u8(win, EDIT.cursorFlags) & 2) setInsertionPointEntry(env.editL(win), xyToPos(W, win, x, y), 1);
}
/** 0x10021760 MouseButtonReleased: the script event; a left release ends the
 * drag and word selection and is consumed while editing. */
export function editMouseButtonReleased(W, win, x, y, key, count, env) {
  let result = env.processScript(win, 'MouseButtonReleased', [x, y, key & 0xff, count], {result: false}) ? 1 : 0;
  if (key === 1) {
    W.setU32(win, EDIT.cursorFlags, W.u32(win, EDIT.cursorFlags) & ~6);
    if (W.u8(win, EDIT.flags) & 1) result = 1;
  }
  return result;
}
