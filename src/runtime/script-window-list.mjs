/**
 * Extension.dll XListWindow family: construction, Init/CleanUp/destructor,
 * every ListWindow native (1720-1812) and the native virtual overrides
 * (ParentRequestedPreferredSize, ParentRequestedGranularity, Draw,
 * MouseButtonPressed/MouseMoved/MouseButtonReleased, KeyPressed,
 * VirtualKeyPressed, VisibilityChanged, Tick).
 *
 * Authority: Extension.dll SHA-256 93c35502…916d9c (preferred base
 * 0x10000000). Every address below is a body of that image; the SDK header
 * ExtList.h names the members (XListWindow, XListRowData, XListColData,
 * XListFieldData). A row id is the XListRowData pointer itself
 * (IndexToRowId 0x1002ecf0 returns rows(i), RowIdToIndex 0x1002ed20 reads
 * row->index). The row/column storage helpers are the recovered model in
 * script-window-list-model.mjs (FillRow, CreateRow, the sort list, qsort,
 * InsertRow, InitColumn, ComputeRowSize, ResizeColumns...); this module adds
 * the remaining methods and the window-level behaviour.
 *
 * Verification: scripts/validate-window-list-family.mjs runs each exec body
 * and virtual from Extension.dll in scripts/native-listwindow-family-oracle.py
 * over the same heap image and compares the window/row/column state, the
 * allocator stream, the script events, the GC image and the draw calls.
 * docs/script-window-list-family.md.
 */
import {
  listMemory, LIST_WINDOW as LW, LIST_ROW, LIST_FIELD, LIST_COL, LIST_FLAGS,
  farrayRealloc, farrayEmpty, farrayRemove, farrayDtor, farraySetNum, fstringAssign, fstringReset, fstringDtor,
  fieldDtor, fieldRangeDtor, colIndexValid, setFieldText, formatListNumber,
  measureField, updateColWidth, recomputeRowHeight, autoExpandColumns, sortRows, buildSortList,
  compareRows, insertRowNode, broadcastSelection, askParentReconfigure, acquireContext,
  releaseContext, columnDtor, parseRow, createRowNode, fieldText, renumberRowIds, selectRowAt,
} from './script-window-list-model.mjs';
import {listWindowSetNumColumns} from './script-window-list-set-num-columns.mjs';
import {listWindowSetColumnType} from './script-window-list-set-column-type.mjs';
import {listWindowSetSortColumn} from './script-window-list-set-sort-column.mjs';
import {listWindowEnableAutoExpandColumns} from './script-window-list-enable-auto-expand-columns.mjs';
import {listWindowEnableMultiSelect} from './script-window-list-enable-multi-select.mjs';
import {listWindowDeleteAllRows} from './script-window-list-delete-all-rows.mjs';
import {listWindowSetColumnWidth} from './script-window-list-set-column-width.mjs';
import {gcSetStyle} from './script-gc-set-style.mjs';
import {gcEnableWordWrap} from './script-gc-enable-word-wrap.mjs';
import {gcSetAlignments} from './script-gc-set-alignments.mjs';
import {gcEnableSpecialText} from './script-gc-enable-special-text.mjs';
import {gcSetTileColor} from './script-gc-set-tile-color.mjs';
import {gcSetTextColor} from './script-gc-set-text-color.mjs';
import {gcSetFonts} from './script-gc-set-fonts.mjs';
import {gcIntersect} from './script-gc-intersect.mjs';
import {gcDrawText} from './script-gc-draw-text.mjs';
import {gcDrawPattern} from './script-gc-draw-pattern.mjs';
import {gcDrawBox} from './script-gc-draw-box.mjs';
import {gcPushGC} from './script-gc-push-gc.mjs';
import {gcPopGC} from './script-gc-pop-gc.mjs';
import {GC} from './script-gc-state-model.mjs';
import {f32Bits} from './script-gc-draw-model.mjs';
import {x87load as X, x87double as XD, x87int32 as XI, x87add, x87neg, x87mul, x87div, x87store as S,
  x87cmp, x87fistp, x87ftol} from './script-vm.mjs';
import {p24add, p24sub, p24mul, p24div} from './x87-pc24.mjs';

const f = Math.fround;

/** XListWindow members (ExtList.h order, MSVC layout). */
export const LIST = Object.freeze({
  vtable: 0x1005b998, size: 0x1d0,
  delimiter: 0x14c, inverseColor: 0x158, highlightTexture: 0x15c, focusTexture: 0x160,
  highlightColor: 0x164, focusColor: 0x168, focusThickness: 0x16c,
  rows: 0x170, rowsNum: 0x174, cols: 0x17c, colsNum: 0x180,
  flags: 0x188,            // bit0 bAutoSort, bit1 bAutoExpandColumns, bit2 bMultiSelect
  colMargin: 0x18c, rowMargin: 0x190,
  hotKeyFlags: 0x194,      // bit0 bHotKeys
  hotKeyCol: 0x198, lineSize: 0x19c, activateSound: 0x1a0, moveSound: 0x1a4,
  numSelected: 0x1a8, focusLine: 0x1ac, anchorLine: 0x1b0,
  dragFlags: 0x1b4,        // bit0 bDragging
  lastIndex: 0x1b8, remainingDelay: 0x1bc, hotKeyString: 0x1c0, hotKeyTimer: 0x1cc,
});
const COL_HIDE = 4;        // XListColData bitfield +0x14: bReverse, bCaseSensitive, bHide
const W_WIDTH = 0x80, W_HEIGHT = 0x84, W_FLAGS = 0x30, W_PARENT = 0x138, W_FONT = 0x54;
const W_CLIP_X = 0xdc, W_CLIP_Y = 0xe0, W_CLIP_W = 0xe4, W_CLIP_H = 0xe8, W_MAXCLICKS = 0xd0;
const IK_LEFT_MOUSE = 1, IK_SHIFT = 0x10, IK_CTRL = 0x11;
/** Float constants of the image: 0.0 (0x10059884), 1e-5 double (0x1005d3a8),
 * 0.5 float (0x10097ae0), 0.5 double (0x1005aa20), 1.0 (0x1005aa18), the 0.1
 * drag repeat (0x1005e8f4). */
const DRAG_REPEAT = f(0.1);

export class ListWindowBoundaryError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'ListWindowBoundaryError'; this.code = 'LIST_WINDOW_BOUNDARY'; Object.assign(this, details); }
}
const boundary = message => { throw new ListWindowBoundaryError(message); };

// ---------------------------------------------------------------------------
// Construction, Init, CleanUp, destructor.
// ---------------------------------------------------------------------------
/** XListWindow::InternalConstructor 0x100162f0 -> ctor 0x10016300: UObject,
 * the XExtensionObject vtable, XClipRect (+0xd4), rows/cols TArrays zeroed,
 * the XListWindow vtable. FStringNoInit members are not touched. */
export function constructListWindow(W, win, constructWindowPart) {
  constructWindowPart(win);
  for (let o = LIST.rows; o < LIST.cols + 12; o += 4) W.setU32(win, o, 0);
  W.setU32(win, 0, LIST.vtable);
}

/** XListWindow::Init 0x1002e900. The three FColor temporaries are built in
 * the parent argument's slot: bytes 0-2 are written and byte 3 keeps the
 * parent pointer's high byte. */
export function initListWindow(W, win, parent, env) {
  env.windowInit(win, parent);                                         // XWindow::Init 0x1004bb30
  const L = env.L(win);
  setDelimiter(L, 0x3b);                                               // 0x10031220(';')
  const high = (W.addressOf(parent) & 0xff000000) >>> 0;
  W.setU32(win, LIST.inverseColor, high);
  W.setU32(win, LIST.flags, ((W.u32(win, LIST.flags) & ~1) | 6) >>> 0);
  W.setU32(win, LIST.highlightColor, (high | 0xffffff) >>> 0);
  W.setU32(win, LIST.focusColor, (high | 0x808080) >>> 0);
  W.setF32(win, LIST.focusThickness, 1);
  W.setF32(win, LIST.colMargin, 3);
  W.setF32(win, LIST.rowMargin, 1);
  W.setU32(win, W_MAXCLICKS, 2);
  W.setU32(win, LIST.activateSound, 0); W.setU32(win, LIST.moveSound, 0);
  W.setU32(win, LIST.hotKeyFlags, (W.u32(win, LIST.hotKeyFlags) | 1) >>> 0);
  for (const o of [LIST.hotKeyCol, LIST.lineSize, LIST.numSelected, LIST.focusLine, LIST.anchorLine]) W.setU32(win, o, 0);
  W.setU32(win, LIST.dragFlags, (W.u32(win, LIST.dragFlags) & ~1) >>> 0);
  W.setU32(win, LIST.lastIndex, 0); W.setU32(win, LIST.remainingDelay, 0);
  assignEmpty(L, L.base + LIST.hotKeyString);
  W.setU32(win, LIST.hotKeyTimer, 0);
  listWindowSetNumColumns(win, 1, env.listServices);                   // 0x1002fa10
  resetSortColumns(L, 1);                                              // 0x10030b40
  env.setSelectability(win, 1);                                        // XWindow::SetSelectability 0x1004c390
}

/** The inline FString = L"" (0x10099ea8) sequence: skipped when the data
 * already is the empty wstring; otherwise num = max = 0 and Realloc(2). */
function assignEmpty(L, str) {
  if (L.read(str, 'u32') === L.mem.emptyWString) return;
  fstringReset(L, str, 0);
}

/** XListWindow::CleanUp 0x1002ead0 up to its XWindow::CleanUp call. */
export function cleanUpListWindow(L) {
  L.write(L.base + LIST.focusLine, 'u32', 0);
  L.write(L.base + LIST.anchorLine, 'u32', 0);
  const rows = L.base + LIST.rows;
  for (let i = 0; i < L.read(rows + 4, 'i32'); i++) {
    const node = L.read(L.read(rows, 'u32') + 4 * i, 'u32');
    if (!node) continue;
    const fields = node + LIST_ROW.fieldsData;
    for (let j = 0; j < L.read(fields + 4, 'i32'); j++) fieldDtor(L, L.read(fields, 'u32') + j * LIST_FIELD.size); // 0x100368b0(0)
    farrayEmpty(L, fields, LIST_FIELD.size, 0);
    fieldArrayDtor(L, fields);                                          // 0x10036720
    L.free(node);
  }
  L.write(rows + 4, 'i32', 0); L.write(rows + 8, 'i32', 0); farrayRealloc(L, rows, 4);
  const cols = L.base + LIST.cols;
  for (let i = 0; i < L.read(cols + 4, 'i32'); i++) {
    const col = L.read(cols, 'u32') + i * LIST_COL.size;
    fstringReset(L, col + LIST_COL.header, 0);
    fstringReset(L, col + LIST_COL.format, 0);
    fstringReset(L, col + LIST_COL.format, 0);
    tcharArrayDtor(L, col + LIST_COL.format);                           // 0x10003990
    fstringReset(L, col + LIST_COL.header, 0);
    tcharArrayDtor(L, col + LIST_COL.header);
  }
  L.write(cols + 4, 'i32', 0); L.write(cols + 8, 'i32', 0); farrayRealloc(L, cols, LIST_COL.size);
  clearHotKeyString(L);
}

/** 0x10003990 (~TArray<TCHAR>): Remove(0, num, 2), Free(data), zero. */
function tcharArrayDtor(L, array) {
  farrayRemove(L, array, 0, L.read(array + 4, 'i32'), 2);
  const data = L.read(array, 'u32');
  if (data) L.free(data);
  L.write(array, 'u32', 0); L.write(array + 8, 'u32', 0); L.write(array + 4, 'u32', 0);
}
/** 0x10036720 (~TArray<XListFieldData>): per element Empty(2, 0), reset and
 * ~TArray<TCHAR>, then Remove(0, n, 0x18), Free(data), zero. */
function fieldArrayDtor(L, array) {
  const n = L.read(array + 4, 'i32');
  for (let i = 0; i < n; i++) {
    const s = L.read(array, 'u32') + i * LIST_FIELD.size;
    farrayEmpty(L, s, 2, 0); fstringReset(L, s, 0); tcharArrayDtor(L, s);
  }
  farrayRemove(L, array, 0, n, LIST_FIELD.size);
  const data = L.read(array, 'u32');
  if (data) L.free(data);
  L.write(array, 'u32', 0); L.write(array + 8, 'u32', 0); L.write(array + 4, 'u32', 0);
}

/** ~XListWindow 0x10015de0 (members only; the XWindow/UObject chain is the
 * host's): hotKeyString Empty(2,0) + Remove + ~FArray, each column through
 * 0x10016190(0) (0x100161c0), cols Remove + ~FArray, rows Remove + ~FArray,
 * delimiter Empty(2,0) + ~TArray<TCHAR>. */
export function destroyListMembers(L) {
  const hot = L.base + LIST.hotKeyString;
  farrayEmpty(L, hot, 2, 0); farrayRemove(L, hot, 0, L.read(hot + 4, 'i32'), 2); farrayDtor(L, hot);
  const cols = L.base + LIST.cols, n = L.read(cols + 4, 'i32');
  for (let i = 0; i < n; i++) columnDtor(L, L.read(cols, 'u32') + i * LIST_COL.size);
  farrayRemove(L, cols, 0, n, LIST_COL.size); farrayDtor(L, cols);
  const rows = L.base + LIST.rows;
  farrayRemove(L, rows, 0, L.read(rows + 4, 'i32'), 4); farrayDtor(L, rows);
  const delim = L.base + LIST.delimiter;
  farrayEmpty(L, delim, 2, 0); tcharArrayDtor(L, delim);
}

// ---------------------------------------------------------------------------
// Methods.
// ---------------------------------------------------------------------------
const rowsNum = L => L.read(L.base + LIST.rowsNum, 'i32');
const rowAt = (L, i) => L.read(L.read(L.base + LIST.rows, 'u32') + 4 * i, 'u32');
const colAt = (L, c) => L.read(L.base + LIST.cols, 'u32') + c * LIST_COL.size;
const fieldAt = (L, node, c) => L.read(node + LIST_ROW.fieldsData, 'u32') + c * LIST_FIELD.size;
const flag = (L, mask) => L.read(L.base + LIST.flags, 'u32') & mask;
/** A row id handed in by script is a row pointer; reject one the heap does not hold. */
function rowPointer(L, rowId) {
  const node = rowId >>> 0;
  if (node && !L.services.isBlock(node)) boundary(`ListWindow row id 0x${node.toString(16)} is not a row of the heap`);
  return node;
}

/** 0x10031220 SetDelimiter: FString = {ch, 0} (num 2, or 0 for ch 0). */
export function setDelimiter(L, ch) {
  fstringAssign(L, L.base + LIST.delimiter, ch & 0xffff ? String.fromCharCode(ch & 0xffff) : '');
}

/** 0x100316d0 ClearHotKeyString. */
export function clearHotKeyString(L) {
  assignEmpty(L, L.base + LIST.hotKeyString);
  L.write(L.base + LIST.hotKeyTimer, 'u32', 0);
}

/** 0x10032dc0 ChangeSelectRow (rows[index], full-dword state compare). */
const changeSelectRow = (L, index, state) => selectRowAt(L, index, state);

/** 0x100331a0 ChangeListSelection: the model's parent-chain broadcast. */
const changeListSelection = L => broadcastSelection(L);

/** 0x10032cb0 RemoveRow: Remove(index, 1, 4) and renumber from index. */
export function removeRow(L, node) {
  if (!node) return;
  const index = L.read(node + LIST_ROW.id, 'i32');
  if (index < 0 || index + 1 > rowsNum(L)) boundary('XListWindow::RemoveRow index assertion');
  farrayRemove(L, L.base + LIST.rows, index, 1, 4);
  for (let i = index; i < rowsNum(L); i++) L.write(rowAt(L, i) + LIST_ROW.id, 'i32', i);
}

/** 0x10032a70 CheckPosition: with auto-sort on, rebuilds the sort list and
 * re-inserts the row when its predecessor compares >= 0 or, failing that,
 * when the row compares <= 0 against its successor (the original's test). */
export function checkPosition(L, node) {
  if (!flag(L, LIST_FLAGS.sorting)) return;
  buildSortList(L);
  const index = L.read(node + LIST_ROW.id, 'i32');
  let move = false;
  if (index > 0 && compareRows(L, rowAt(L, index - 1), node) >= 0) move = true;
  else if (index < rowsNum(L) - 1 && !(compareRows(L, node, rowAt(L, index + 1)) > 0)) move = true;
  if (move) { removeRow(L, node); insertRowNode(L, node); }
}

/** 0x10031cb0 SetFieldByValue: the formatted value replaces the text; text
 * columns (type 0) keep a 0.0 value, numeric columns the float. */
function setFieldByValue(L, node, col, value) {
  const colPtr = colAt(L, col), type = L.read(colPtr + LIST_COL.type, 'u8');
  const text = formatListNumber(L, colPtr, type, f(value));
  const field = fieldAt(L, node, col);
  if (type === 0) { fstringAssign(L, field + LIST_FIELD.text, text); L.write(field + LIST_FIELD.value, 'u32', 0); }
  else { L.write(field + LIST_FIELD.value, 'f32', value); fstringAssign(L, field + LIST_FIELD.text, text); }
}

/** SetField 0x1002f170 / SetFieldValue 0x1002f2f0. */
function setFieldCommon(W, win, L, env, node, col, apply) {
  if (!node || !colIndexValid(L, col)) return;
  apply();
  const gc = acquireContext(L);
  measureField(L, gc, node, col);
  releaseContext(L, gc);
  const changed = flag(L, LIST_FLAGS.autoExpand) ? updateColWidth(L, node, col) : 0;
  checkPosition(L, node);
  if (changed) askParentReconfigure(L);
}

/** 0x1002ee20 DeleteRow. */
export function deleteRow(L, node) {
  if (!node) return;
  const notify = changeSelectRow(L, L.read(node + LIST_ROW.id, 'i32'), 0);
  removeRow(L, node);
  if (L.read(L.base + LIST.focusLine, 'u32') === node) L.write(L.base + LIST.focusLine, 'u32', 0);
  if (L.read(L.base + LIST.anchorLine, 'u32') === node) L.write(L.base + LIST.anchorLine, 'u32', 0);
  const fields = node + LIST_ROW.fieldsData;
  for (let i = 0; i < L.read(fields + 4, 'i32'); i++) {
    const s = L.read(fields, 'u32') + i * LIST_FIELD.size;
    fstringReset(L, s, 0); fstringDtor(L, s);                           // 0x10012630 + Core ~FString
  }
  L.write(fields + 4, 'i32', 0); L.write(fields + 8, 'i32', 0); farrayRealloc(L, fields, LIST_FIELD.size);
  fieldRangeDtor(L, fields, 0, L.read(fields + 4, 'i32'));              // 0x10036810(0, num)
  const data = L.read(fields, 'u32');
  if (data) L.free(data);
  L.write(fields, 'u32', 0); L.write(fields + 8, 'u32', 0); L.write(fields + 4, 'u32', 0);
  L.free(node);
  if (notify) changeListSelection(L);
  askParentReconfigure(L);
}

/** 0x1002ef80 ModifyRow. */
export function modifyRow(L, node, text) {
  if (!node) return;
  const changed = parseRow(L, node, text);
  checkPosition(L, node);
  if (changed) askParentReconfigure(L);
}

/** 0x1002f480 SelectRow. */
export function selectRow(L, node, select) {
  if (!node || (L.read(node + LIST_ROW.flags, 'u32') & 1) === (select | 0)) return;
  let notify = 0;
  if (!flag(L, LIST_FLAGS.multiSelect) && select && L.read(L.base + LIST.numSelected, 'i32') > 0)
    for (let i = 0; i < rowsNum(L); i++) notify |= changeSelectRow(L, i, 0);
  notify |= changeSelectRow(L, L.read(node + LIST_ROW.id, 'i32'), select);
  if (notify) changeListSelection(L);
}

/** 0x1002f550 SelectAllRows. */
export function selectAllRows(L, select) {
  const state = flag(L, LIST_FLAGS.multiSelect) ? select : 0;
  let notify = 0;
  for (let i = 0; i < rowsNum(L); i++) notify |= changeSelectRow(L, i, state);
  if (notify) changeListSelection(L);
}

/** 0x10032e30 MoveToRow(row, bChangeSelect, bClearRows, bInvert, bSpanRange, bFocus). */
export function moveToRow(W, L, env, node, changeSelect, clearRows, invert, spanRange, focus) {
  let notify = 0;
  const oldFocus = L.read(L.base + LIST.focusLine, 'u32');
  let clear;
  if (!flag(L, LIST_FLAGS.multiSelect)) { clear = 1; spanRange = 0; } else clear = clearRows;
  const rowIndex = node ? L.read(node, 'i32') : 0;
  if (changeSelect) {
    const focusLine = L.read(L.base + LIST.focusLine, 'u32'), anchorLine = L.read(L.base + LIST.anchorLine, 'u32');
    const focusIndex = focusLine ? L.read(focusLine, 'i32') : 0;
    const anchorIndex = anchorLine ? L.read(anchorLine, 'i32') : focusIndex;
    let span = false;
    if (clear) { for (let i = 0; i < rowsNum(L); i++) notify |= changeSelectRow(L, i, 0); span = true; }
    else if (spanRange) {
      if (anchorIndex < focusIndex) for (let i = anchorIndex; i <= focusIndex; i++) notify |= changeSelectRow(L, i, 0);
      else for (let i = focusIndex; i <= anchorIndex; i++) notify |= changeSelectRow(L, i, 0);
      span = true;
    }
    if (span && spanRange) {
      if (anchorIndex < rowIndex) for (let i = anchorIndex; i <= rowIndex; i++) notify |= changeSelectRow(L, i, 1);
      else for (let i = rowIndex; i <= anchorIndex; i++) notify |= changeSelectRow(L, i, 1);
    } else if (invert) notify |= changeSelectRow(L, rowIndex, ~L.read(rowAt(L, rowIndex) + LIST_ROW.flags, 'u32') & 1);
    else notify |= changeSelectRow(L, rowIndex, 1);
  }
  if (focus && rowIndex >= 0 && rowIndex < rowsNum(L)) setFocusRow(W, L, env, rowAt(L, rowIndex), 1, spanRange ? 0 : 1);
  if (notify) changeListSelection(L);
  const now = L.read(L.base + LIST.focusLine, 'u32');
  if (now !== oldFocus && now) playListSound(W, L, env, L.read(L.base + LIST.moveSound, 'u32'), -1, 1);
}

/** 0x1002f970 SetFocusRow. */
export function setFocusRow(W, L, env, node, moveTo, anchor) {
  L.write(L.base + LIST.focusLine, 'u32', node);
  if (anchor) L.write(L.base + LIST.anchorLine, 'u32', node);
  if (moveTo) showFocusRow(W, L, env);
}

/** 0x10033040 ShowFocusRow: AskParentToShowArea(0, index * lineSize, width, lineSize). */
export function showFocusRow(W, L, env) {
  const focus = L.read(L.base + LIST.focusLine, 'u32');
  if (!focus) return;
  const lineSize = L.read(L.base + LIST.lineSize, 'f32');
  env.askParentToShowArea(L.object, 0, S(x87mul(XI(L.read(focus, 'i32')), X(lineSize))),
    L.read(L.base + W_WIDTH, 'f32'), lineSize);
}

/** 0x1002f8c0 SetRow. */
export function setRow(W, L, env, node, select, clearRows, drag) {
  if (node) return moveToRow(W, L, env, node, select, clearRows, 0, drag, 1);
  return setFocusRow(W, L, env, 0, 1, drag ? 0 : 1);
}

/** 0x100311f0 GetPageSize: _ftol(clipHeight / lineSize), at least 1. */
export function getPageSize(L) {
  const lineSize = L.read(L.base + LIST.lineSize, 'f32');
  if (!(lineSize > 0)) return 1;
  const pages = x87ftol(x87div(X(L.read(L.base + W_CLIP_H, 'f32')), X(lineSize)));
  return pages < 1 ? 1 : pages;
}

/** 0x1002f790 MoveRow: EMoveList 0 Up, 1 Down, 2 PageUp, 3 PageDown, 4 Home, 5 End. */
export function moveRow(W, L, env, move, select, clearRows, drag) {
  const focus = L.read(L.base + LIST.focusLine, 'u32');
  let index = focus ? L.read(focus, 'i32') : 0xffff0001 | 0;
  switch (move >>> 0) {
    case 0: index = (index - 1) | 0; break;
    case 1: index = (index + 1) | 0; break;
    case 2: index = (index - getPageSize(L)) | 0; break;
    case 3: index = (index + getPageSize(L)) | 0; break;
    case 4: index = 0; break;
    case 5: index = rowsNum(L) - 1; break;
  }
  const num = rowsNum(L);
  if (index > num - 1) index = num - 1;
  if (index < 0) index = 0;
  if (index < num) return setRow(W, L, env, rowAt(L, index), select, clearRows, drag);
  return setFocusRow(W, L, env, 0, 1, drag ? 0 : 1);
}

/** 0x1002f740 GetSelectedRow. */
export function getSelectedRow(L) {
  const focus = L.read(L.base + LIST.focusLine, 'u32');
  if (focus && (L.read(focus + LIST_ROW.flags, 'u32') & 1)) return focus;
  for (let i = 0; i < rowsNum(L); i++) if (L.read(rowAt(L, i) + LIST_ROW.flags, 'u32') & 1) return rowAt(L, i);
  return 0;
}

/** 0x10030b40 ResetSortColumns. */
export function resetSortColumns(L, sort) {
  const n = L.read(L.base + LIST.colsNum, 'i32');
  for (let i = 0; i < n; i++) {
    const c = colAt(L, i);
    L.write(c + LIST_COL.sortPriority, 'i32', sort ? 0 : -1);
    L.write(c + LIST_COL.sortFlags, 'u32', L.read(c + LIST_COL.sortFlags, 'u32') & ~3 >>> 0);
  }
  if (flag(L, LIST_FLAGS.sorting)) sortRows(L);
}

/** 0x10030980 AddSortColumn. */
export function addSortColumn(L, col, reverse, caseSensitive) {
  if (!colIndexValid(L, col)) return;
  const n = L.read(L.base + LIST.colsNum, 'i32');
  for (let i = 0; i < n; i++) {
    const p = colAt(L, i) + LIST_COL.sortPriority, v = L.read(p, 'i32');
    if (v > 0) L.write(p, 'i32', v + 1);
  }
  const c = colAt(L, col);
  L.write(c + LIST_COL.sortPriority, 'i32', 1);
  const flags = L.read(c + LIST_COL.sortFlags, 'u32');
  L.write(c + LIST_COL.sortFlags, 'u32', (((flags ^ reverse) & 1) ^ flags) >>> 0);
  L.write(c + LIST_COL.sortFlags, 'u32', (((caseSensitive & 1) << 1) | (L.read(c + LIST_COL.sortFlags, 'u32') & ~2)) >>> 0);
  if (flag(L, LIST_FLAGS.sorting)) sortRows(L);
}

/** 0x10030a90 RemoveSortColumn. */
export function removeSortColumn(L, col) {
  if (!colIndexValid(L, col)) return;
  L.write(colAt(L, col) + LIST_COL.sortPriority, 'i32', -1);
  if (flag(L, LIST_FLAGS.sorting)) sortRows(L);
}

/** 0x10030c80 EnableAutoSort: full-dword compare with bit 0. */
export function enableAutoSort(L, value) {
  const flags = L.read(L.base + LIST.flags, 'u32');
  if ((flags & 1) === (value | 0)) return;
  const next = (((flags ^ value) & 1) ^ flags) >>> 0;
  L.write(L.base + LIST.flags, 'u32', next);
  if (next & 1) sortRows(L);
}

/** 0x10031130 SetFieldMargins: rowMargin first (ComputeRowSize, reconfigure),
 * then colMargin (ResizeColumns(1) when auto-expanding); fcomp C3 skips. */
export function setFieldMargins(L, width, height) {
  const c3 = (a, b) => a === b || Number.isNaN(a) || Number.isNaN(b);
  if (!c3(L.read(L.base + LIST.rowMargin, 'f32'), f(height))) {
    L.write(L.base + LIST.rowMargin, 'f32', height);
    recomputeRowHeight(L);
    askParentReconfigure(L);
  }
  if (!c3(L.read(L.base + LIST.colMargin, 'f32'), f(width))) {
    L.write(L.base + LIST.colMargin, 'f32', width);
    if (flag(L, LIST_FLAGS.autoExpand)) autoExpandColumns(L, 1);
  }
}

/** 0x100302d0 SetColumnFont: a null font is the window's normal font (+0x54). */
export function setColumnFont(L, col, font) {
  if (!colIndexValid(L, col)) return;
  const use = font || L.read(L.base + W_FONT, 'u32');
  const p = colAt(L, col) + LIST_COL.font;
  if (L.read(p, 'u32') === use) return;
  L.write(p, 'u32', use);
  const gc = acquireContext(L);
  if (gc) {
    for (let i = 0; i < rowsNum(L); i++) measureField(L, gc, rowAt(L, i), col);
    releaseContext(L, gc);
  }
  recomputeRowHeight(L);
  if (flag(L, LIST_FLAGS.autoExpand)) autoExpandColumns(L, 1);
  askParentReconfigure(L);
}

/** 0x1002fd10 SetColumnTitle: the FString assign is skipped only when the
 * title data already is the argument pointer (never for a script string). */
export function setColumnTitle(L, col, title) {
  if (!colIndexValid(L, col)) return;
  fstringAssign(L, colAt(L, col) + LIST_COL.header, title);
  askParentReconfigure(L);
}

/** 0x100306f0 HideColumn: full-dword compare with the bHide bit. */
export function hideColumn(L, col, hide) {
  if (!colIndexValid(L, col)) return;
  const p = colAt(L, col) + LIST_COL.sortFlags, flags = L.read(p, 'u32');
  if (((flags >>> 2) & 1) === (hide | 0)) return;
  L.write(p, 'u32', ((flags & ~COL_HIDE) | ((hide & 1) << 2)) >>> 0);
  askParentReconfigure(L);
}

/** 0x10030d50 FindRowByKey. The hot-key string grows by the typed key; a
 * string of one repeated character cycles by one row from the focus row,
 * any other prefix matches from the focus row itself; ASCII A-Z compare
 * case-insensitively. Returns the row pointer or 0. */
export function findRowByKey(L, key) {
  key &= 0xffff;
  if (!(L.read(L.base + LIST.hotKeyFlags, 'u32') & 1)) return 0;
  const col = L.read(L.base + LIST.hotKeyCol, 'i32');
  if (col < 0 || col >= L.read(L.base + LIST.colsNum, 'i32') || !isHotKeyValid(key) || rowsNum(L) <= 0) return 0;
  const hot = L.base + LIST.hotKeyString, num = L.read(hot + 4, 'i32');
  const unit = key ? 1 : 0;
  if (num) {
    farraySetNum(L, hot, num + unit, 2);                               // FArray::Add(strlen, 2)
    writeUnits(L, L.read(hot, 'u32') + (num - 1) * 2, key);            // appStrcpy over the old terminator
  } else if (key) {
    farraySetNum(L, hot, unit + 1, 2);
    writeUnits(L, L.read(hot, 'u32'), key);
  }
  L.write(L.base + LIST.hotKeyTimer, 'f32', 1);
  const text = L.read(hot + 4, 'i32') ? L.readString(L.read(hot, 'u32')) : '';
  let i = 0;
  while (i < text.length && text.charCodeAt(i) === text.charCodeAt(0)) i++;
  let match;
  if (i >= text.length) match = 1;
  else { const n = L.read(hot + 4, 'i32'); match = n ? n - 1 : 0; }
  const focus = L.read(L.base + LIST.focusLine, 'u32');
  const start = focus ? L.read(focus, 'i32') : 0;
  let index = match > 1 ? start - 1 : start;
  const lower = c => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
  const unitAt = (s, j) => (j < s.length ? s.charCodeAt(j) : 0);
  for (let tried = 0; ;) {
    index++;
    if (index >= rowsNum(L)) index = 0;
    tried++;
    const field = fieldAt(L, rowAt(L, index), col);
    const value = fieldText(L, field);
    let ok = true;
    for (let j = 0; j < match; j++) if (lower(unitAt(value, j)) !== lower(unitAt(text, j))) { ok = false; break; }
    if (ok) return rowAt(L, index);
    if (tried >= rowsNum(L)) return 0;
  }
}
function writeUnits(L, at, key) { L.write(at, 'u16', key); L.write(at + 2, 'u16', 0); }
/** 0x10031690 IsHotKeyValid: a-z, A-Z, 0-9 and '_'. */
export const isHotKeyValid = c => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f;

/** 0x10031370 PlayListSound: from a window whose every ancestor is visible
 * the sound is placed at the clip centre (or the window centre) and the
 * focus row's line; otherwise the centred XWindow::PlaySound overload. */
export function playListSound(W, L, env, sound, volume, pitch) {
  let w = L.object;
  while (w && (W.u8(w, W_FLAGS) & 1)) w = W.ptr(w, W_PARENT);
  if (w) return env.playSound(L.object, sound, volume, pitch);
  const clipW = L.read(L.base + W_CLIP_W, 'f32'), clipH = L.read(L.base + W_CLIP_H, 'f32');
  const clip = clipW > 0 && clipH > 0;
  const x = clip ? S(x87add(x87mul(X(clipW), XD(0.5)), X(L.read(L.base + W_CLIP_X, 'f32'))))
    : S(x87mul(X(L.read(L.base + W_WIDTH, 'f32')), XD(0.5)));
  const focus = L.read(L.base + LIST.focusLine, 'u32');
  const y = focus ? S(x87add(x87mul(XI(L.read(focus, 'i32')), X(L.read(L.base + LIST.lineSize, 'f32'))), X(L.read(L.base + LIST.rowMargin, 'f32'))))
    : clip ? S(x87add(x87mul(X(clipH), XD(0.5)), X(L.read(L.base + W_CLIP_Y, 'f32'))))
    : S(x87mul(X(L.read(L.base + W_HEIGHT, 'f32')), XD(0.5)));
  return env.playSound(L.object, sound, volume, pitch, x, y);
}

/** 0x100330e0 ActivateListRow: only from a fully visible window, the
 * ListRowActivated virtual (+0x108) up the parent chain until one returns
 * nonzero. */
export function activateListRow(W, L, env) {
  let w = L.object;
  while (w && (W.u8(w, W_FLAGS) & 1)) w = W.ptr(w, W_PARENT);
  if (w) return;
  const focus = L.read(L.base + LIST.focusLine, 'u32');
  for (let r = L.object; r; r = W.ptr(r, W_PARENT)) if (env.listRowActivated(r, L.object, focus)) return;
}

// ---------------------------------------------------------------------------
// Virtual overrides.
// ---------------------------------------------------------------------------
/** 0x10033260 ParentRequestedPreferredSize: the visible column widths summed
 * into the width (each sum stored), rows * lineSize as the height. */
export function listPreferredSize(W, win) {
  let width = 0;
  const n = W.i32(win, LIST.colsNum), cols = W.u32(win, LIST.cols);
  for (let i = 0; i < n; i++) {
    const c = cols + i * LIST_COL.size;
    if (!(W.heap.mem.read(c + LIST_COL.sortFlags, 'u8') & COL_HIDE)) width = f(W.heap.mem.read(c + LIST_COL.width, 'f32') + width);
  }
  return {width, height: S(x87mul(XI(W.i32(win, LIST.rowsNum)), X(W.f32(win, LIST.lineSize))))};
}

/** 0x100332c0 ParentRequestedGranularity: (1.0, lineSize), then the XWindow
 * script bridge 0x10050450. */
export function listGranularity(W, win, bridge) {
  return bridge(win, 1, W.f32(win, LIST.lineSize));
}

/** 0x10033d90 VisibilityChanged: the script event, then a newly visible list
 * without a focus row selects and focuses row 0. */
export function listVisibilityChanged(W, win, visible, env) {
  env.processScript(win, 'VisibilityChanged', [Boolean(visible)]);
  const L = env.L(win);
  if (visible && !L.read(L.base + LIST.focusLine, 'u32') && rowsNum(L) > 0) setRow(W, L, env, rowAt(L, 0), 1, 1, 0);
}

/** y / lineSize truncated by _ftol on the game thread (x87, 64-bit). */
const rowFromY = (y, lineSize) => x87ftol(x87div(X(y), X(lineSize)));

/** 0x10033750 MouseButtonPressed: the script event first; a left click
 * focuses the row under the pointer (shift spans, ctrl inverts and keeps the
 * other rows), starts dragging and arms the 0.1 s drag repeat. */
export function listMouseButtonPressed(W, win, x, y, button, clicks, env) {
  const result = env.processScript(win, 'MouseButtonPressed', [f(x), f(y), button & 0xff, clicks | 0], {result: false});
  if ((button & 0xff) !== IK_LEFT_MOUSE) return result ? 1 : 0;
  const L = env.L(win), lineSize = L.read(L.base + LIST.lineSize, 'f32'), num = rowsNum(L);
  if (lineSize > 0 && num > 0) {
    let index = rowFromY(f(y), lineSize);
    if (index > num - 1) index = num - 1;
    if (index < 0) index = 0;
    const shift = env.isKeyDown(win, IK_SHIFT), ctrlInvert = env.isKeyDown(win, IK_CTRL), ctrlKeep = env.isKeyDown(win, IK_CTRL);
    moveToRow(W, L, env, rowAt(L, index), 1, ctrlKeep ? 0 : 1, ctrlInvert, shift, 1);
    L.write(L.base + LIST.lastIndex, 'i32', index);
    L.write(L.base + LIST.dragFlags, 'u32', L.read(L.base + LIST.dragFlags, 'u32') | 1);
    L.write(L.base + LIST.remainingDelay, 'f32', S(x87add(X(env.tickOffset()), X(DRAG_REPEAT))));
  }
  return 1;
}

/** 0x100338c0 MouseMoved: the script event; while dragging, a new row under
 * the pointer extends the selection span from the anchor. */
export function listMouseMoved(W, win, x, y, env) {
  env.processScript(win, 'MouseMoved', [f(x), f(y)]);
  const L = env.L(win);
  if (!(L.read(L.base + LIST.dragFlags, 'u32') & 1)) return;
  const lineSize = L.read(L.base + LIST.lineSize, 'f32'), num = rowsNum(L);
  if (!(lineSize > 0) || num <= 0) return;
  let index = rowFromY(f(y), lineSize);
  if (index > num - 1) index = num - 1;
  if (index < 0) index = 0;
  if (index === L.read(L.base + LIST.lastIndex, 'i32')) return;
  L.write(L.base + LIST.lastIndex, 'i32', index);
  moveToRow(W, L, env, rowAt(L, index), 1, 0, 0, 1, 1);
}

/** 0x100339c0 MouseButtonReleased: the script event; a left release stops
 * dragging and a multi-click on a row focuses it, plays the activate sound
 * and activates it. */
export function listMouseButtonReleased(W, win, x, y, button, clicks, env) {
  const result = env.processScript(win, 'MouseButtonReleased', [f(x), f(y), button & 0xff, clicks | 0], {result: false});
  if ((button & 0xff) !== IK_LEFT_MOUSE) return result ? 1 : 0;
  const L = env.L(win);
  L.write(L.base + LIST.dragFlags, 'u32', L.read(L.base + LIST.dragFlags, 'u32') & ~1 >>> 0);
  const lineSize = L.read(L.base + LIST.lineSize, 'f32'), num = rowsNum(L);
  if ((clicks | 0) > 1 && lineSize > 0 && num > 0) {
    const index = rowFromY(f(y), lineSize);
    if (index >= 0 && index < num) {
      setFocusRow(W, L, env, rowAt(L, index), 1, 1);
      playListSound(W, L, env, L.read(L.base + LIST.activateSound, 'u32'), -1, 1);
      activateListRow(W, L, env);
    }
  }
  return 1;
}

/** 0x10033ae0 KeyPressed: the script event with the key as a one-character
 * FString; a valid hot key (with hot keys on) jumps to the matching row and
 * is always handled. */
export function listKeyPressed(W, win, key, env) {
  key &= 0xffff;
  const L = env.L(win);
  // The temporary FString {key, 0}: Realloc(2) to num = max = (key ? 2 : 0).
  const temp = L.services.scratchString;
  fstringAssign(L, temp, key ? String.fromCharCode(key) : '');
  let result = env.processScript(win, 'KeyPressed', [key ? String.fromCharCode(key) : ''], {result: false}) ? 1 : 0;
  L.write(temp + 4, 'i32', 0); L.write(temp + 8, 'i32', 0); farrayRealloc(L, temp, 2);
  farrayRemove(L, temp, 0, L.read(temp + 4, 'i32'), 2);
  const data = L.read(temp, 'u32');
  if (data) L.free(data);
  L.write(temp, 'u32', 0); L.write(temp + 4, 'u32', 0); L.write(temp + 8, 'u32', 0);
  if (isHotKeyValid(key) && (L.read(L.base + LIST.hotKeyFlags, 'u32') & 1)) {
    const node = findRowByKey(L, key);
    if (node) setRow(W, L, env, node, 1, 1, 0);
    result = 1;
  }
  return result;
}

/** 0x10033ca0 VirtualKeyPressed: the script event (ListWindow.uc moves the
 * focus); arrows and Escape clear the hot-key string; Enter plays the
 * activate sound, activates the focus row and is handled. */
export function listVirtualKeyPressed(W, win, key, repeat, env) {
  key &= 0xff;
  let result = env.processScript(win, 'VirtualKeyPressed', [key, Boolean(repeat)], {result: false}) ? 1 : 0;
  const L = env.L(win);
  if (key === 0x25 || key === 0x27 || key === 0x26 || key === 0x28 || key === 0x1b) clearHotKeyString(L);
  if (key === 0x0d) {
    playListSound(W, L, env, L.read(L.base + LIST.activateSound, 'u32'), -1, 1);
    activateListRow(W, L, env);
    result = 1;
  }
  return result;
}

/** 0x10033e50 Tick: the drag repeat (MouseMoved virtual at the cursor every
 * 0.1 s) and the hot-key timeout. */
export function listTick(W, win, delta, env) {
  const L = env.L(win);
  // fld; fsub delta; fst (store); fcomp 0.0 on the unrounded difference.
  if (L.read(L.base + LIST.dragFlags, 'u32') & 1) {
    const left = x87add(X(L.read(L.base + LIST.remainingDelay, 'f32')), x87neg(X(f(delta))));
    L.write(L.base + LIST.remainingDelay, 'f32', S(left));
    const c = x87cmp(left, X(0));
    if (c === 'lt' || c === 'un') {                                    // test ah,1: C0 (below or unordered)
      L.write(L.base + LIST.remainingDelay, 'f32', DRAG_REPEAT);
      const {x, y} = env.getCursorPos(win);
      env.mouseMoved(win, x, y);                                       // vtable +0x9c
    }
  }
  if (L.read(L.base + LIST.hotKeyTimer, 'f32') > 0) {
    const left = x87add(X(L.read(L.base + LIST.hotKeyTimer, 'f32')), x87neg(X(f(delta))));
    L.write(L.base + LIST.hotKeyTimer, 'f32', S(left));
    if (x87cmp(left, X(0)) !== 'gt') clearHotKeyString(L);             // test ah,0x41: not above
  }
}

/** 0x10033350 Draw, inside the render pass (x87 precision control 24,
 * docs/render-pass-precision.md): the visible row range from the clip
 * rectangle, the selection highlight pattern per selected row, each visible
 * column's fields clipped to their cell with the column alignment and font,
 * the focus box when the list has the keyboard focus, then XWindow::Draw
 * (the script DrawWindow). */
export function listDraw(W, win, gc, env) {
  const s = W.gc.services, L = env.L(win), b = L.base;
  const lineSize = L.read(b + LIST.lineSize, 'f32');
  gcPushGC(gc, s);
  let first = 0, last = 0, nCols = 0;
  if (lineSize > 0) {
    const clipY = X(L.read(b + W_CLIP_Y, 'f32'));
    const t = S(p24div(p24add(clipY, XD(1e-5)), X(lineSize)));
    first = x87fistp(p24sub(X(t), X(0.5)));
    const bottom = S(p24div(p24add(X(L.read(b + W_CLIP_H, 'f32')), clipY), X(lineSize)));
    last = appCeil(bottom);
    if (last > rowsNum(L)) last = rowsNum(L);
    if (first < 0) first = 0;
    nCols = L.read(b + LIST.colsNum, 'i32');
  }
  gcSetStyle(gc, 2, s);
  gcEnableWordWrap(gc, 0, s);
  gcSetAlignments(gc, 0, 0, s);
  gcEnableSpecialText(gc, 0, s);
  gcSetTileColor(gc, L.read(b + LIST.highlightColor, 'u32'), s);
  const width = L.read(b + W_WIDTH, 'u32');
  for (let i = first; i < last; i++) {
    if (!(L.read(rowAt(L, i) + LIST_ROW.flags, 'u32') & 1)) continue;
    const y = S(p24mul(XI(i), X(lineSize)));
    gcDrawPattern(gc, 0, f32Bits(y), width, f32Bits(lineSize), 0, 0, L.read(b + LIST.highlightTexture, 'u32'), s);
  }
  const colMargin = X(L.read(b + LIST.colMargin, 'f32')), rowMargin = X(L.read(b + LIST.rowMargin, 'f32'));
  let colX = 0;
  for (let c = 0; c < nCols; c++) {
    const col = colAt(L, c);
    if (L.read(col + LIST_COL.sortFlags, 'u8') & COL_HIDE) continue;
    const font = L.read(col + LIST_COL.font, 'u32');
    gcSetFonts(gc, font, font, s);
    const colW = L.read(col + LIST_COL.width, 'f32');
    let y = S(p24mul(XI(first), X(lineSize)));
    for (let r = first; r < last; r++) {
      const node = rowAt(L, r), field = fieldAt(L, node, c);
      gcSetTextColor(gc, L.read(node + LIST_ROW.flags, 'u32') & 1 ? L.read(b + LIST.inverseColor, 'u32') : L.read(col + LIST_COL.packed, 'u32'), s);
      const saved = [];
      for (let o = 0; o < 24; o += 4) saved.push(W.heap.mem.read(W.addressOf(gc) + GC.originX + o, 'u32'));
      const cellH = S(p24sub(X(lineSize), p24add(rowMargin, rowMargin)));
      const cellW = S(p24sub(X(colW), p24add(colMargin, colMargin)));
      const cellY = S(p24add(X(y), rowMargin));
      const cellX = S(p24add(X(colX), colMargin));
      gcIntersect(gc, cellX, cellY, cellW, cellH, s);
      const align = L.read(col + LIST_COL.flagByte, 'u8');
      const fieldW = L.read(field + LIST_FIELD.width, 'f32'), fieldH = L.read(field + LIST_FIELD.height, 'f32');
      let tx;
      if (align === 0) tx = S(p24add(X(colX), colMargin));
      else if (align === 2) tx = S(p24add(p24sub(X(colW), X(fieldW)), p24sub(X(colX), colMargin)));
      else tx = S(p24add(p24mul(p24sub(X(colW), X(fieldW)), XD(0.5)), X(colX)));
      const ty = S(p24add(p24add(p24sub(X(lineSize), X(fieldH)), p24sub(X(y), rowMargin)), X(1)));
      const num = L.read(field + LIST_FIELD.textCount, 'u32');
      const text = num ? L.readString(L.read(field + LIST_FIELD.text, 'u32')) : '';
      gcDrawText(gc, f32Bits(tx), f32Bits(ty), L.read(field + LIST_FIELD.width, 'u32'), L.read(field + LIST_FIELD.height, 'u32'), text, s);
      saved.forEach((v, o) => W.heap.mem.write(W.addressOf(gc) + GC.originX + 4 * o, 'u32', v));  // XGC::SetClipRect 0x10026f00
      y = S(p24add(X(y), X(lineSize)));
    }
    colX = S(p24add(X(colW), X(colX)));
  }
  const focus = L.read(b + LIST.focusLine, 'u32');
  if (env.isFocusWindow(win) && focus) {
    const index = L.read(focus, 'i32');
    if (index >= first && index < last) {
      gcSetTileColor(gc, L.read(b + LIST.focusColor, 'u32'), s);
      gcDrawBox(gc, 0, f32Bits(S(p24mul(XI(index), X(lineSize)))), width, f32Bits(lineSize), 0, 0,
        L.read(b + LIST.focusThickness, 'u32'), L.read(b + LIST.focusTexture, 'u32'), s);
    }
  }
  gcPopGC(gc, -1, s);
  env.windowDraw(win, gc);                                             // XWindow::Draw 0x10003bf0
}

/** Core appCeil 0x10102a09 -> 0x10123300: _ftol(ceil((double)value)). */
const appCeil = v => x87ftol(XD(Math.ceil(v)));

// ---------------------------------------------------------------------------
// Natives 1720-1812 (exec bodies 0x10033f50-0x100366f0; defaults from the
// parameter slots each exec initialises before its GNatives evaluation).
// ---------------------------------------------------------------------------
const packColor = c => ['r', 'g', 'b', 'a'].reduce((w, k, i) => w | ((c?.[`core.object.color.${k}`] ?? 0) & 255) << (8 * i), 0) >>> 0;
const unpackColor = w => Object.fromEntries(['r', 'g', 'b', 'a'].map((k, i) => [`core.object.color.${k}`, (w >>> (8 * i)) & 255]));

export function dispatchListWindowNative(W, call, env, refValue) {
  if (call.index < 1720 || call.index > 1812) return {handled: false};
  const win = call.receiver;
  const arg = (i, fallback) => (i < call.argumentCount ? (refValue(call.evaluateArgument(i)) ?? fallback) : fallback);
  const out = (i, v) => { const a = call.evaluateArgument(i); if (a?.reference) a.set(v); };
  const L = env.L(win), b = L.base;
  const row = i => rowPointer(L, arg(i, 0) | 0);
  const int = (i, d = 0) => arg(i, d) | 0;
  const bool = (i, d) => (arg(i, d) ? 1 : 0);
  const ptr = (i) => W.addressOf(arg(i, null));
  const col = i => int(i);
  let value;
  switch (call.index) {
    case 1720: { const i = int(0); value = i >= 0 && i < rowsNum(L) ? rowAt(L, i) : 0; break; }      // 0x1002ecf0
    case 1721: { const n = row(0); value = n ? L.read(n, 'i32') : -1; break; }                       // 0x1002ed20
    case 1722: { const n = row(0), v = int(1); if (n) L.write(n + LIST_ROW.clientData, 'i32', v); break; } // 0x1002ed40
    case 1724: { const n = row(0), v = ptr(1); if (n) L.write(n + LIST_ROW.clientData, 'u32', v); break; }
    case 1723: { const n = row(0); value = n ? L.read(n + LIST_ROW.clientData, 'i32') : 0; break; }   // 0x1002ed60
    case 1725: { const n = row(0); const a = n ? L.read(n + LIST_ROW.clientData, 'u32') : 0; value = a ? W.heap.objectAt(a) : null; break; }
    case 1730: { const text = String(arg(0, '')), data = int(1); value = createAndInsert(L, text, data); break; }
    case 1731: deleteRow(L, row(0)); break;
    case 1732: { const n = row(0); modifyRow(L, n, String(arg(1, ''))); break; }
    case 1733: listWindowDeleteAllRows(win, env.listServices); break;
    case 1734: { const n = row(0), c = col(1), text = String(arg(2, ''));
      setFieldCommon(W, win, L, env, n, c, () => setFieldText(L, n, c, text)); break; }
    case 1735: { const n = row(0), c = col(1); value = n && colIndexValid(L, c) ? fieldText(L, fieldAt(L, n, c)) : ''; break; }
    case 1736: { const n = row(0), c = col(1), v = f(arg(2, 0));
      setFieldCommon(W, win, L, env, n, c, () => setFieldByValue(L, n, c, v)); break; }
    case 1737: { const n = row(0), c = col(1); value = n && colIndexValid(L, c) ? L.read(fieldAt(L, n, c) + LIST_FIELD.value, 'f32') : 0; break; }
    case 1740: value = rowsNum(L); break;
    case 1741: value = L.read(b + LIST.numSelected, 'i32'); break;
    case 1742: { const n = row(0); selectRow(L, n, bool(1, true)); break; }
    case 1743: selectAllRows(L, bool(0, true)); break;
    case 1744: { const n = row(0), clear = bool(1, true), invert = bool(2, false), span = bool(3, false);
      if (n) moveToRow(W, L, env, n, 1, clear, invert, span, 0); break; }
    case 1745: { const n = row(0); selectRow(L, n, n && (L.read(n + LIST_ROW.flags, 'u32') & 1) ? 0 : 1); break; }
    case 1746: { const n = row(0); value = Boolean(n && (L.read(n + LIST_ROW.flags, 'u32') & 1)); break; }
    case 1747: value = getSelectedRow(L); break;
    case 1750: { const move = int(0) & 0xff, select = bool(1, true), clear = bool(2, true), drag = bool(3, false);
      moveRow(W, L, env, move, select, clear, drag); break; }
    case 1751: { const n = row(0), select = bool(1, true), clear = bool(2, true), drag = bool(3, false);
      setRow(W, L, env, n, select, clear, drag); break; }
    case 1755: { const n = row(0), moveTo = bool(1, true), anchor = bool(2, true); setFocusRow(W, L, env, n, moveTo, anchor); break; }
    case 1756: value = L.read(b + LIST.focusLine, 'u32'); break;
    case 1760: listWindowSetNumColumns(win, int(0), env.listServices); break;
    case 1761: value = L.read(b + LIST.colsNum, 'i32'); break;
    case 1762: autoExpandColumns(L, bool(0, false)); break;                                            // ResizeColumns 0x1002fc40
    case 1765: { const c = col(0); setColumnTitle(L, c, String(arg(1, ''))); break; }
    case 1766: { const c = col(0); value = colIndexValid(L, c) ? (L.read(colAt(L, c) + LIST_COL.header + 4, 'u32') ? L.readString(L.read(colAt(L, c) + LIST_COL.header, 'u32')) : '') : ''; break; }
    case 1767: { const c = col(0); listWindowSetColumnWidth(win, c, f(arg(1, 0)), env.listServices); break; }
    case 1768: { const c = col(0); value = colIndexValid(L, c) && !(L.read(colAt(L, c) + LIST_COL.sortFlags, 'u8') & COL_HIDE) ? L.read(colAt(L, c) + LIST_COL.width, 'f32') : 0; break; }
    case 1769: { const c = col(0), a = int(1) & 0xff; if (colIndexValid(L, c)) L.write(colAt(L, c) + LIST_COL.flagByte, 'u8', a); break; }
    case 1770: { const c = col(0); value = colIndexValid(L, c) ? L.read(colAt(L, c) + LIST_COL.flagByte, 'u8') : 0; break; }
    case 1771: { const c = col(0), color = packColor(arg(1, null)); if (colIndexValid(L, c)) L.write(colAt(L, c) + LIST_COL.packed, 'u32', color); break; }
    // 0x10030210: an invalid column returns (0,0,0) with the alpha byte of the column argument's slot.
    case 1772: { const c = col(0); out(1, unpackColor(colIndexValid(L, c) ? L.read(colAt(L, c) + LIST_COL.packed, 'u32') : (c & 0xff000000) >>> 0)); break; }
    case 1773: { const c = col(0); setColumnFont(L, c, ptr(1)); break; }
    case 1774: { const c = col(0); const a = colIndexValid(L, c) ? L.read(colAt(L, c) + LIST_COL.font, 'u32') : L.read(b + W_FONT, 'u32'); value = a ? W.heap.objectAt(a) : null; break; }
    case 1775: { const c = col(0), type = int(1) & 0xff, fmt = String(arg(2, '')); listWindowSetColumnType(win, c, type, fmt.length ? fmt : null, env.listServices); break; }
    case 1776: { const c = col(0); value = colIndexValid(L, c) ? L.read(colAt(L, c) + LIST_COL.type, 'u8') : 0; break; }
    case 1777: { const c = col(0); hideColumn(L, c, bool(1, true)); break; }
    case 1778: { const c = col(0); value = colIndexValid(L, c) ? Boolean((L.read(colAt(L, c) + LIST_COL.sortFlags, 'u32') >>> 2) & 1) : true; break; }
    case 1780: { const c = col(0); listWindowSetSortColumn(win, c, bool(1, false), bool(2, false), env.listServices); break; }
    case 1781: { const c = col(0); addSortColumn(L, c, bool(1, false), bool(2, false)); break; }
    case 1782: removeSortColumn(L, col(0)); break;
    case 1783: resetSortColumns(L, bool(0, true)); break;
    case 1784: sortRows(L); break;
    case 1785: { const v = bool(0, true), flags = L.read(b + LIST.hotKeyFlags, 'u32'); L.write(b + LIST.hotKeyFlags, 'u32', (((flags ^ v) & 1) ^ flags) >>> 0); break; }
    case 1786: L.write(b + LIST.hotKeyCol, 'i32', int(0)); break;
    case 1790: enableAutoSort(L, bool(0, true)); break;
    case 1791: value = Boolean(flag(L, 1)); break;
    case 1792: listWindowEnableAutoExpandColumns(win, bool(0, true), env.listServices); break;
    case 1793: value = Boolean(flag(L, 2)); break;
    case 1794: listWindowEnableMultiSelect(win, bool(0, true), env.listServices); break;
    case 1795: value = Boolean(flag(L, 4)); break;
    case 1800: { const w = f(arg(0, 0)), h = f(arg(1, 0)); setFieldMargins(L, w, h); break; }
    case 1801: out(0, L.read(b + LIST.colMargin, 'f32')); out(1, L.read(b + LIST.rowMargin, 'f32')); break;
    case 1802: value = getPageSize(L); break;
    // execSetDelimiter 0x100361f0 passes the string's first unit (L"" for an empty string).
    case 1803: { const text = String(arg(0, '')); setDelimiter(L, text.length ? text.charCodeAt(0) : 0); break; }
    case 1804: L.write(b + LIST.inverseColor, 'u32', packColor(arg(0, null))); break;
    case 1805: L.write(b + LIST.highlightTexture, 'u32', ptr(0)); break;
    case 1806: L.write(b + LIST.highlightColor, 'u32', packColor(arg(0, null))); break;
    case 1807: L.write(b + LIST.focusTexture, 'u32', ptr(0)); break;                                  // 0x1000db90
    case 1808: L.write(b + LIST.focusColor, 'u32', packColor(arg(0, null))); break;                    // 0x1003db20
    case 1809: L.write(b + LIST.focusThickness, 'f32', f(arg(0, 0))); break;
    case 1810: showFocusRow(W, L, env); break;
    case 1811: { const a = ptr(0), m = ptr(1); L.write(b + LIST.activateSound, 'u32', a); L.write(b + LIST.moveSound, 'u32', m); break; }
    case 1812: { const sound = ptr(0), volume = f(arg(1, -1)), pitch = f(arg(2, 1)); playListSound(W, L, env, sound, volume, pitch); break; }
    default: return {handled: false};
  }
  return {handled: true, value};
}

/** 0x1002ed80 AddRow: CreateRow, InsertRow and AskParentForReconfigure. */
function createAndInsert(L, text, clientData) {
  const node = createRowNode(L, text, clientData | 0);
  if (node) { insertRowNode(L, node); askParentReconfigure(L); }
  return node;
}

export {renumberRowIds, sortRows};
