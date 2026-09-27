// Shared XEditWindow runtime model for the recovered Extension.dll bodies.
//
// Faithful translation layer shared by the per-native script-edit-*.mjs
// bindings. All offsets, flag masks, and helper semantics come from the
// original Extension.dll bodies documented in docs/script-edit-model.md.
// Virtual calls, allocator calls, and UI service calls stay explicit services
// so each native module can reproduce the binary's call sequence.
//
// Recovered bodies (Extension.dll image base 0x10000000):
//   0x1001ed90  FString assign (assignString)
//   0x1001d4a0  SetInsertionPoint entry -> 0x1001f140
//   0x1001f140  setInsertionPointCore
//   0x1001f010  updateSelection
//   0x1001f300  wordStart
//   0x1001f350  wordEnd
//   0x1001ddc0  setTextChangedFlag
//   0x1001ddf0  ClearUndo
//   0x10020290  trimUndo
//   0x1001fab0  textChangedBroadcast
//   0x10045fb0  EnableWordWrap
//   0x10021830  FilterChar
//   0x1001fbf0  filterText
//   0x1001e3c0  InsertText virtual
//   0x1001e260  SetText virtual
//   0x1001fe20  replaceSelection
//   0x10020450  pushUndo
//   0x1002d8b0  textChangedRange
//   0x10012630  FString reset helper (num=0; max=arg; Realloc)
//   0x100126d0  bounded FArray::Remove wrapper
//   0x10003990  Extension-side FString teardown
//
// Leaf boundaries (probe stubs / JS services):
//   0x1001f680  UpdateCaret
//   0x1001ef40  ResetBlink
//   0x1001e7f0  ColumnFromX
//   0x1004e060  AskParentForReconfigure
//   vtable+0x114 TextChanged
//   Core !UObject::FindFunction (script FilterChar override lookup) and the
//   script FilterChar call (services.scriptFilterChar)

import {
  growArrayMax,
  moveBytes,
  zeroBytes,
  farrayRealloc,
  farraySetNum,
  farrayEmpty,
  farrayRemove,
  farrayDtor,
  fstringReset,
  fstringDtor,
} from './script-window-list-model.mjs';

export class EditWindowModelBoundaryError extends Error {
  constructor(message) {
    super(`EditWindow model boundary: ${message}`);
    this.name = 'EditWindowModelBoundaryError';
  }
}

export const EDIT_WINDOW_DLL = Object.freeze({
  dll: 'Extension.dll',
  imageBase: 0x10000000,
  oracleBase: 0x12000000,
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
});

// XTextWindow + XEditWindow object layout (docs/script-edit-model.md tables).
export const EDIT_WINDOW = Object.freeze({
  height: 0xe8,
  parent: 0x138,
  hAlign: 0x14c,
  vAlign: 0x14d,
  textFlags: 0x150,
  marginLeft: 0x154,
  marginRight: 0x158,
  text: 0x168,
  textNum: 0x16c,
  textMax: 0x170,
  lineSpacing: 0x174,
  lineHeight: 0x178,
  relayoutFlags: 0x17c,
  pendingPos: 0x180,
  pendingLen: 0x184,
  linesData: 0x194,
  linesCount: 0x198,
  linesMax: 0x19c,
  relayoutFlags2: 0x1a0,
  pendingPos2: 0x1a4,
  pendingLen2: 0x1a8,
  lines2Data: 0x1b8,
  lines2Count: 0x1bc,
  lines2Max: 0x1c0,
  flags: 0x1d0,
  insertionPoint: 0x1d4,
  anchor: 0x1d8,
  ipType: 0x1dc,
  selStart: 0x1e0,
  selEnd: 0x1e4,
  maxSize: 0x1e8,
  ipTexture: 0x1ec,
  ipColor: 0x1f0,
  selTexture: 0x1f4,
  selColor: 0x1f8,
  selTextColor: 0x1fc,
  cursor0: 0x200,
  cursor1: 0x204,
  cursor2: 0x208,
  sound0: 0x20c,
  sound1: 0x210,
  sound2: 0x214,
  sound3: 0x218,
  undoData: 0x21c,
  undoNum: 0x220,
  undoMax: 0x224,
  undoPos: 0x228,
  maxUndos: 0x22c,
  savedUndoPos: 0x230,
  blinkOn: 0x23c,
  blinkOff: 0x240,
  stateFlags: 0x244,
  prefWidth: 0x258,
  prefHeight: 0x25c,
  stickyX: 0x270,
});

export const EDIT_LINE = Object.freeze({ size: 0x24, x: 0, start: 4, visibleLen: 8, fullLen: 0xc });
export const EDIT_UNDO = Object.freeze({ size: 0x1c, pos: 0, oldText: 4, newText: 0x10 });
export const EDIT_FLAGS = Object.freeze({ editing: 1, singleLine: 2, uppercase: 4 });
export const EDIT_STATE = Object.freeze({ caretVisible: 1, wordSelect: 4 });
export const TEXT_FLAG_WORD_WRAP = 1;

// Image-space addresses of the process-global edit cells (RVA in Extension.dll).
export const EDIT_GLOBALS = Object.freeze({
  clipboard: 0x9ae00,
  emptyWString: 0x99ea8,
  convertBuffer: 0xaead0,
  convertFlag: 0xaeac8,
  filterCharName: 0x9b380,
});

const modelFail = message => {
  throw new EditWindowModelBoundaryError(message);
};

export function rejectAsyncEdit(value, label) {
  if (value && typeof value.then === 'function') {
    modelFail(`EditWindow ${label} suspended`);
  }
  return value;
}

function requireMem(services) {
  const mem = services && services.mem;
  if (!mem || typeof mem.read !== 'function' || typeof mem.write !== 'function'
      || typeof mem.alloc !== 'function' || typeof mem.free !== 'function'
      || typeof mem.realloc !== 'function' || typeof mem.readString !== 'function'
      || typeof mem.allocString !== 'function') {
    modelFail('EditWindow requires a raw native heap service (mem)');
  }
  return mem;
}

/** Checked accessors over the injected byte-addressable heap service. */
export function editMemory(object, services) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    modelFail('EditWindow requires a canonical window object');
  }
  const mem = requireMem(services);
  const base = rejectAsyncEdit(
    services.objectAddress ? services.objectAddress(object) : object.base,
    'objectAddress',
  );
  if (typeof base !== 'number' || !Number.isInteger(base) || base <= 0) {
    modelFail('EditWindow requires the window heap address');
  }
  const sync = (value, label) => rejectAsyncEdit(value, label);
  const int32 = value => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      modelFail('EditWindow heap read returned a non-integer');
    }
    return value | 0;
  };
  const uint32 = value => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      modelFail('EditWindow heap read returned a non-integer');
    }
    return value >>> 0;
  };
  const float32 = value => {
    if (typeof value !== 'number') {
      modelFail('EditWindow heap read returned a non-number');
    }
    return Math.fround(value);
  };
  const checked = kind => {
    if (kind === 'i32' || kind === 'i16' || kind === 'i8') return int32;
    if (kind === 'u32' || kind === 'u16' || kind === 'u8') return uint32;
    if (kind === 'f32') return float32;
    return modelFail(`EditWindow unsupported heap kind ${kind}`);
  };
  const read = (address, kind) => checked(kind)(sync(mem.read(address, kind), `read 0x${address.toString(16)}`));
  const write = (address, kind, value) => sync(mem.write(address, kind, value), `write 0x${address.toString(16)}`);
  const alloc = (size, tag) => uint32(sync(mem.alloc(size, tag), 'alloc'));
  const free = address => sync(mem.free(address), 'free');
  const realloc = (address, size, tag) => uint32(sync(mem.realloc(address, size, tag), 'realloc'));
  const readString = address => {
    const text = sync(mem.readString(address), 'readString');
    if (typeof text !== 'string') modelFail('EditWindow readString returned a non-string');
    return text;
  };
  const allocString = text => uint32(sync(mem.allocString(text), 'allocString'));
  return {mem, object, services, base, read, write, alloc, free, realloc, readString, allocString};
}

function requireService(L, name) {
  const fn = L.services && L.services[name];
  if (typeof fn !== 'function') {
    modelFail(`EditWindow requires services.${name}`);
  }
  return fn;
}

function modelAssert(cond, what) {
  if (!cond) modelFail(`assert failed: ${what}`);
}

// ---------------------------------------------------------------------------
// Wide-character helpers (Core appStrlen/appStrcpy/appStrncpy equivalents).

function emptyWString(L) {
  const ptr = L.mem.emptyWString;
  if (!Number.isInteger(ptr)) {
    throw new EditWindowModelBoundaryError('memory service lacks emptyWString');
  }
  return ptr;
}

export function wcharLen(L, ptr) {
  let n = 0;
  while (L.read(ptr + n * 2, 'u16') !== 0) n += 1;
  return n;
}

function wcharCopy(L, dst, src) {
  let i = 0;
  for (;;) {
    const ch = L.read(src + i * 2, 'u16');
    L.write(dst + i * 2, 'u16', ch);
    if (ch === 0) return;
    i += 1;
  }
}

// Core appStrncpy (0x101233c0): wcsncpy(dst, src, n) then dst[n-1] = 0 —
// the forced terminator overwrites the nth copied slot, so callers pass n+1.
function wcharCopyN(L, dst, src, n) {
  let i = 0;
  for (; i < n; i += 1) {
    const ch = L.read(src + i * 2, 'u16');
    L.write(dst + i * 2, 'u16', ch);
    if (ch === 0) {
      i += 1;
      break;
    }
  }
  for (; i < n; i += 1) L.write(dst + i * 2, 'u16', 0);
  L.write(dst + (n - 1) * 2, 'u16', 0);
}

// ---------------------------------------------------------------------------
// FString / FArray helpers recovered from the Extension.dll bodies.

// 0x100126d0 — bounds-checked FArray::Remove(&str, index, count, 2).
function boundedRemove(L, str, index, count) {
  const num = L.read(str + 4, 'i32');
  modelAssert(index >= 0, 'boundedRemove index');
  modelAssert(index <= num, 'boundedRemove index>num');
  modelAssert(index + count <= num, 'boundedRemove overflow');
  farrayRemove(L, str, index, count, 2);
}

function freeIfData(L, str) {
  const data = L.read(str, 'u32');
  if (data !== 0) L.free(data);
}

// 0x10003990 — Extension-side FString destroy: Remove(0, num, 2) then Free.
function extFStringDtor(L, str) {
  const num = L.read(str + 4, 'i32');
  modelAssert(num >= 0, 'fstring dtor num');
  farrayRemove(L, str, 0, num, 2);
  freeIfData(L, str);
  L.write(str, 'u32', 0);
  L.write(str + 4, 'i32', 0);
  L.write(str + 8, 'i32', 0);
}

// Shared stack-temp FString teardown used by the Enable* bodies and the
// InsertText accept path: reset(,0) + FArray::Remove(0, 0, 2) + Free-if-data.
export function tempFStringTeardown(L, str) {
  fstringReset(L, str, 0);
  farrayRemove(L, str, 0, 0, 2);
  freeIfData(L, str);
}

// Core FArray::Insert(&array, index, count, elemSize) — 0x10106ff0.
export function farrayInsert(L, array, index, count, elemSize) {
  const num = L.read(array + 4, 'i32');
  const newNum = num + count;
  L.write(array + 4, 'i32', newNum);
  if (newNum > L.read(array + 8, 'i32')) {
    L.write(array + 8, 'i32', growArrayMax(newNum));
    farrayRealloc(L, array, elemSize);
  }
  const data = L.read(array, 'u32');
  const tail = num - index;
  if (tail > 0) {
    moveBytes(
      L,
      data + (index + count) * elemSize,
      data + index * elemSize,
      tail * elemSize,
    );
  }
}

// 0x1001ed90 — assignString(dst FString*, src wchar*, n).
// n < 0 means appStrlen(src); src == NULL reads the shared L"".
export function assignString(L, dst, src, n) {
  let srcPtr = src;
  if (srcPtr === 0) srcPtr = emptyWString(L);
  let len = n;
  if (len < 0) len = wcharLen(L, srcPtr);
  const num = L.read(dst + 4, 'i32');
  const dstLen = num !== 0 ? num - 1 : 0;
  const diff = len - dstLen;
  if (diff > 0) {
    if (num !== 0) farraySetNum(L, dst, num + diff, 2);
    else farraySetNum(L, dst, diff + 1, 2);
  } else if (diff < 0) {
    if (len > 0) {
      farrayRemove(L, dst, len, dstLen - len, 2);
    } else {
      L.write(dst + 4, 'i32', 0);
      L.write(dst + 8, 'i32', 0);
      farrayRealloc(L, dst, 2);
    }
  }
  if (len > 0) wcharCopyN(L, L.read(dst, 'u32'), srcPtr, len + 1);
}

// ---------------------------------------------------------------------------
// Text accessors.

export function textLen(L) {
  const num = L.read(L.base + EDIT_WINDOW.textNum, 'i32');
  return num !== 0 ? num - 1 : 0;
}

function textData(L) {
  const num = L.read(L.base + EDIT_WINDOW.textNum, 'i32');
  return num !== 0 ? L.read(L.base + EDIT_WINDOW.text, 'u32') : emptyWString(L);
}

// ---------------------------------------------------------------------------
// Leaf service wrappers (0x1001f680 / 0x1001ef40 / 0x1001e7f0 / 0x1004e060 /
// vtable+0x114 / FindFunction).

export function updateCaret(L, sticky) {
  return rejectAsyncEdit(
    requireService(L, 'updateCaret')(L.object, L.base, sticky | 0), 'updateCaret') | 0;
}

export function resetBlink(L) {
  rejectAsyncEdit(requireService(L, 'resetBlink')(L.object, L.base), 'resetBlink');
}

export function columnFromX(L, line, xBits) {
  return rejectAsyncEdit(
    requireService(L, 'columnFromX')(L.object, L.base, line | 0, xBits | 0), 'columnFromX') | 0;
}

export function askParentForReconfigure(L) {
  rejectAsyncEdit(
    requireService(L, 'askParentForReconfigure')(L.object, L.base), 'askParentForReconfigure');
}

function textChangedLeaf(L, receiver, changed) {
  return rejectAsyncEdit(
    requireService(L, 'textChanged')(L.object, receiver, L.base, changed | 0), 'textChanged') | 0;
}

function findFilterChar(L) {
  return rejectAsyncEdit(
    requireService(L, 'findFilterChar')(L.object, L.base), 'findFilterChar') | 0;
}

// ---------------------------------------------------------------------------
// Recovered shared methods.

// 0x1001ddc0 — SetTextChangedFlag body.
export function setTextChangedFlag(L, bSet) {
  const saved = bSet !== 0 ? -1 : L.read(L.base + EDIT_WINDOW.undoPos, 'i32');
  L.write(L.base + EDIT_WINDOW.savedUndoPos, 'i32', saved);
}

// Per-record teardown used by ClearUndo (0x1001de48 sequence).
function destroyUndoRecordClear(L, rec) {
  fstringReset(L, rec + EDIT_UNDO.oldText, 0);
  fstringReset(L, rec + EDIT_UNDO.newText, 0);
  fstringReset(L, rec + EDIT_UNDO.newText, 0);
  boundedRemove(L, rec + EDIT_UNDO.newText, 0, L.read(rec + EDIT_UNDO.newText + 4, 'i32'));
  farrayDtor(L, rec + EDIT_UNDO.newText);
  fstringReset(L, rec + EDIT_UNDO.oldText, 0);
  extFStringDtor(L, rec + EDIT_UNDO.oldText);
}

// 0x1001ddf0 — ClearUndo.
export function clearUndo(L) {
  const undoPos = L.read(L.base + EDIT_WINDOW.undoPos, 'i32');
  const saved = L.read(L.base + EDIT_WINDOW.savedUndoPos, 'i32');
  L.write(L.base + EDIT_WINDOW.savedUndoPos, 'i32', undoPos - saved !== 0 ? -1 : 0);
  L.write(L.base + EDIT_WINDOW.undoPos, 'i32', 0);
  const num = L.read(L.base + EDIT_WINDOW.undoNum, 'i32');
  const data = L.read(L.base + EDIT_WINDOW.undoData, 'u32');
  for (let i = 0; i < num; i += 1) {
    destroyUndoRecordClear(L, data + i * EDIT_UNDO.size);
  }
  L.write(L.base + EDIT_WINDOW.undoNum, 'i32', 0);
  L.write(L.base + EDIT_WINDOW.undoMax, 'i32', 0);
  farrayRealloc(L, L.base + EDIT_WINDOW.undoData, EDIT_UNDO.size);
}

// XEditWindow::CleanUp 0x1001d0b0 (before XLargeTextWindow::CleanUp): each
// undo record through the ClearUndo teardown, then Num = Max = 0 and
// FArray::Realloc(0x1c). currentUndo and unchangedUndo are left as they are.
export function cleanUpUndo(L) {
  for (let i = 0; i < L.read(L.base + EDIT_WINDOW.undoNum, 'i32'); i += 1) {
    destroyUndoRecordClear(L, L.read(L.base + EDIT_WINDOW.undoData, 'u32') + i * EDIT_UNDO.size);
  }
  L.write(L.base + EDIT_WINDOW.undoNum, 'i32', 0);
  L.write(L.base + EDIT_WINDOW.undoMax, 'i32', 0);
  farrayRealloc(L, L.base + EDIT_WINDOW.undoData, EDIT_UNDO.size);
}

// Per-record teardown used by trimUndo (0x10020328 sequence: Empty/Empty then
// the B destructor chain then the A destructor chain).
function destroyUndoRecordTrim(L, rec) {
  farrayEmpty(L, rec + EDIT_UNDO.oldText, 2, 0);
  farrayEmpty(L, rec + EDIT_UNDO.newText, 2, 0);
  fstringReset(L, rec + EDIT_UNDO.newText, 0);
  boundedRemove(L, rec + EDIT_UNDO.newText, 0, L.read(rec + EDIT_UNDO.newText + 4, 'i32'));
  farrayDtor(L, rec + EDIT_UNDO.newText);
  fstringReset(L, rec + EDIT_UNDO.oldText, 0);
  extFStringDtor(L, rec + EDIT_UNDO.oldText);
}

// 0x10020290 — trimUndo.
export function trimUndo(L) {
  const maxUndos = L.read(L.base + EDIT_WINDOW.maxUndos, 'i32');
  if (maxUndos < 0) return;
  const num = L.read(L.base + EDIT_WINDOW.undoNum, 'i32');
  if (num <= maxUndos) return;
  const excess = num - maxUndos;
  modelAssert(num >= 0, 'trimUndo num');
  modelAssert(excess <= num, 'trimUndo excess');
  const data = L.read(L.base + EDIT_WINDOW.undoData, 'u32');
  for (let i = 0; i < excess; i += 1) {
    destroyUndoRecordTrim(L, data + i * EDIT_UNDO.size);
  }
  farrayRemove(L, L.base + EDIT_WINDOW.undoData, 0, excess, EDIT_UNDO.size);
  let undoPos = L.read(L.base + EDIT_WINDOW.undoPos, 'i32') - excess;
  let saved = L.read(L.base + EDIT_WINDOW.savedUndoPos, 'i32') - excess;
  if (undoPos < 0) undoPos = 0;
  if (saved < 0) saved = -1;
  L.write(L.base + EDIT_WINDOW.undoPos, 'i32', undoPos);
  L.write(L.base + EDIT_WINDOW.savedUndoPos, 'i32', saved);
}

// 0x1001f010 — updateSelection.  With no drag (ip == anchor) and word-select
// mode clear the selection collapses to (-1, -1); otherwise the selection is
// [min(ip, anchor), max(ip, anchor)] and word-select mode snaps the ends to
// word boundaries and moves ip to the dragged end.
export function updateSelection(L) {
  const ip = L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32');
  const anchor = L.read(L.base + EDIT_WINDOW.anchor, 'i32');
  const st = L.read(L.base + EDIT_WINDOW.stateFlags, 'i32');
  if (ip === anchor && (st & EDIT_STATE.wordSelect) === 0) {
    L.write(L.base + EDIT_WINDOW.selStart, 'i32', -1);
    L.write(L.base + EDIT_WINDOW.selEnd, 'i32', -1);
    return;
  }
  const forward = anchor <= ip;
  if (forward) {
    L.write(L.base + EDIT_WINDOW.selStart, 'i32', anchor);
    L.write(L.base + EDIT_WINDOW.selEnd, 'i32', ip);
  } else {
    L.write(L.base + EDIT_WINDOW.selStart, 'i32', ip);
    L.write(L.base + EDIT_WINDOW.selEnd, 'i32', anchor);
  }
  if ((st & EDIT_STATE.wordSelect) === 0) return;
  const start = wordStart(L, L.read(L.base + EDIT_WINDOW.selStart, 'i32'));
  L.write(L.base + EDIT_WINDOW.selStart, 'i32', start);
  const end = wordEnd(L, L.read(L.base + EDIT_WINDOW.selEnd, 'i32'));
  L.write(L.base + EDIT_WINDOW.selEnd, 'i32', end);
  L.write(L.base + EDIT_WINDOW.insertionPoint, 'i32', forward ? end : start);
}

// 0x1001f300 — wordStart(pos): scan back over non-whitespace.
export function wordStart(L, pos) {
  const num = L.read(L.base + EDIT_WINDOW.textNum, 'i32');
  const data = num !== 0 ? L.read(L.base + EDIT_WINDOW.text, 'u32') : emptyWString(L);
  let p = data + pos * 2 - 2;
  while (p >= data) {
    const ch = L.read(p, 'u16');
    if ((ch >= 9 && ch <= 0xd) || ch === 0x20) break;
    p -= 2;
  }
  return Math.floor((p - data + 2) / 2);
}

// 0x1001f350 — wordEnd(pos): scan forward over non-whitespace.
export function wordEnd(L, pos) {
  const num = L.read(L.base + EDIT_WINDOW.textNum, 'i32');
  const len = num !== 0 ? num - 1 : 0;
  const data = num !== 0 ? L.read(L.base + EDIT_WINDOW.text, 'u32') : emptyWString(L);
  let p = data + pos * 2;
  const end = data + len * 2;
  while (p < end) {
    const ch = L.read(p, 'u16');
    if ((ch >= 9 && ch <= 0xd) || ch === 0x20) break;
    p += 2;
  }
  return (p - data) >> 1;
}

// 0x1001eba0 — posToLineCol(pos): clamps pos to [0, len], scans the +0x194
// line table from the last record down for the first start <= pos and
// returns {line, col}; (0, 0) when no record qualifies or the table is empty.
// The native writes the two results through separate NULL-guarded out
// pointers (the second offset shifts across a mid-body pop); callers that
// pass NULL for col are modelled by ignoring it.
export function posToLineCol(L, pos) {
  const len = textLen(L);
  const count = L.read(L.base + EDIT_WINDOW.linesCount, 'i32');
  let p = pos | 0;
  if (p > len) p = len;
  if (p < 0) p = 0;
  const data = L.read(L.base + EDIT_WINDOW.linesData, 'u32');
  let line = count - 1;
  while (line >= 0
      && L.read(data + line * EDIT_LINE.size + EDIT_LINE.start, 'i32') > p) {
    line -= 1;
  }
  if (line < 0) return {line: 0, col: 0};
  return {
    line,
    col: p - L.read(data + line * EDIT_LINE.size + EDIT_LINE.start, 'i32'),
  };
}

// 0x1001f200 — moveToLine(line, bExtend): clamps the target line to
// [0, count - 1], resolves the column through the ColumnFromX leaf on the
// stickyX (+0x270) float bits, clamps the position to [0, len] and moves the
// caret; bExtend keeps the anchor.  Ends with updateSelection /
// updateCaret(0) / resetBlink.
export function moveToLine(L, line, bExtend) {
  const len = textLen(L);
  const count = L.read(L.base + EDIT_WINDOW.linesCount, 'i32');
  let l = line | 0;
  if (l > count - 1) l = count - 1;
  if (l < 0) l = 0;
  let pos = 0;
  if (l < count) {
    const data = L.read(L.base + EDIT_WINDOW.linesData, 'u32');
    const xBits = L.read(L.base + EDIT_WINDOW.stickyX, 'u32');
    const col = columnFromX(L, l, xBits);
    pos = L.read(data + l * EDIT_LINE.size + EDIT_LINE.start, 'i32') + col;
  }
  if (pos > len) pos = len;
  if (pos < 0) pos = 0;
  L.write(L.base + EDIT_WINDOW.insertionPoint, 'i32', pos);
  if (!bExtend) L.write(L.base + EDIT_WINDOW.anchor, 'i32', pos);
  updateSelection(L);
  updateCaret(L, 0);
  resetBlink(L);
}

// 0x1001f3b0 — nextWord(pos): finds the line holding pos; past the line's
// visible end returns start + fullLen.  Otherwise scans forward skipping
// non-whitespace then whitespace to the next word start; reaching the line
// end returns start + fullLen - 1.  Out-of-range line -> 0.
export function nextWord(L, pos) {
  const {line} = posToLineCol(L, pos);
  const count = L.read(L.base + EDIT_WINDOW.linesCount, 'i32');
  if (line < 0 || line >= count) return 0;
  const data = textData(L);
  const linesData = L.read(L.base + EDIT_WINDOW.linesData, 'u32');
  const rec = linesData + line * EDIT_LINE.size;
  const start = L.read(rec + EDIT_LINE.start, 'i32');
  const lineEnd = start + L.read(rec + EDIT_LINE.visibleLen, 'i32');
  let p = data + (pos | 0) * 2;
  const end = data + lineEnd * 2;
  if (p >= end) return start + L.read(rec + EDIT_LINE.fullLen, 'i32');
  let seenSpace = 0;
  while (p < end) {
    const ch = L.read(p, 'u16');
    if ((ch >= 9 && ch <= 0xd) || ch === 0x20) {
      seenSpace = 1;
    } else if (seenSpace) {
      break;
    }
    p += 2;
  }
  if (p >= end) return start + L.read(rec + EDIT_LINE.fullLen, 'i32') - 1;
  return (p - data) >> 1;
}

// 0x1001f550 — prevWord(pos): finds the line holding pos; at the line start
// returns max(pos - 1, 0).  Otherwise scans back from pos - 1 skipping
// whitespace then non-whitespace and returns the index after the stop;
// reaching the line start yields that start.  Out-of-range line -> 0.
export function prevWord(L, pos) {
  const {line} = posToLineCol(L, pos);
  const count = L.read(L.base + EDIT_WINDOW.linesCount, 'i32');
  if (line < 0 || line >= count) return 0;
  const data = textData(L);
  const linesData = L.read(L.base + EDIT_WINDOW.linesData, 'u32');
  const start = L.read(linesData + line * EDIT_LINE.size + EDIT_LINE.start, 'i32');
  const lineStart = data + start * 2;
  let p = data + (pos | 0) * 2;
  if (p === lineStart) return Math.max(pos - 1, 0);
  let seenNonSpace = 0;
  for (;;) {
    p -= 2;
    if (p < lineStart) break;
    const ch = L.read(p, 'u16');
    if ((ch >= 9 && ch <= 0xd) || ch === 0x20) {
      if (seenNonSpace) break;
    } else {
      seenNonSpace = 1;
    }
  }
  const result = (p - data + 2) >> 1;
  return result < 0 ? 0 : result;
}

// 0x1001f140 — setInsertionPointCore (reached via the 0x1001d4a0 SEH entry).
export function setInsertionPointCore(L, pos, bExtend) {
  const len = textLen(L);
  let p = pos | 0;
  if (p < 0) p = 0;
  if (p > len) p = len;
  L.write(L.base + EDIT_WINDOW.insertionPoint, 'i32', p);
  if (!bExtend) L.write(L.base + EDIT_WINDOW.anchor, 'i32', p);
  updateSelection(L);
  updateCaret(L, 1);
  resetBlink(L);
}

export function setInsertionPointEntry(L, pos, bExtend) {
  setInsertionPointCore(L, pos, bExtend);
}

// 0x1001fab0 — walk the parent chain invoking TextChanged on each ancestor.
export function textChangedBroadcast(L) {
  let receiver = L.base;
  while (receiver !== 0) {
    const changed = L.read(L.base + EDIT_WINDOW.undoPos, 'i32')
      !== L.read(L.base + EDIT_WINDOW.savedUndoPos, 'i32') ? 1 : 0;
    if (textChangedLeaf(L, receiver, changed) !== 0) break;
    receiver = L.read(receiver + EDIT_WINDOW.parent, 'u32');
  }
}

// 0x10045fb0 — EnableWordWrap: textFlags bit 0 + parent reconfigure.
export function enableWordWrap(L, bWrap) {
  const flags = L.read(L.base + EDIT_WINDOW.textFlags, 'i32');
  if ((flags & TEXT_FLAG_WORD_WRAP) === bWrap) return;
  L.write(L.base + EDIT_WINDOW.textFlags, 'i32',
    (flags & ~TEXT_FLAG_WORD_WRAP) | (bWrap & TEXT_FLAG_WORD_WRAP));
  askParentForReconfigure(L);
}

// 0x10021830 — FilterChar body: uppercase mapping then the script-override
// lookup (FindFunction(FilterChar, 0)). A script FilterChar(out string chStr)
// runs through ProcessEvent with chStr = the character (empty for NUL) and a
// result slot preset to 1; a true result stores chStr's first unit (0 for an
// empty string, the shared L"") back into the character. The parameter
// FString is torn down afterwards (host-side string: no native blocks).
export function filterCharVirtual(L, chAddr) {
  const flags = L.read(L.base + EDIT_WINDOW.flags, 'i32');
  if ((flags & EDIT_FLAGS.uppercase) !== 0) {
    const ch = L.read(chAddr, 'u16');
    if (ch >= 0x61 && ch <= 0x7a) L.write(chAddr, 'u16', ch - 0x20);
  }
  if (findFilterChar(L) === 0) return 1;
  const ch = L.read(chAddr, 'u16');
  const call = rejectAsyncEdit(requireService(L, 'scriptFilterChar')(L.object, ch ? String.fromCharCode(ch) : ''), 'scriptFilterChar');
  if (!call.result) return 0;
  L.write(chAddr, 'u16', call.text.length ? call.text.charCodeAt(0) : 0);
  return 1;
}

// 0x1001fbf0 — filterText(text, out). Binary rule: empty/NULL input returns 1;
// otherwise 1 iff out.num > 1.
export function filterText(L, textPtr, out) {
  const src = textPtr !== 0 ? textPtr : emptyWString(L);
  const inputLen = wcharLen(L, src);
  const charSlot = L.mem.charSlot;
  if (!Number.isInteger(charSlot)) {
    throw new EditWindowModelBoundaryError('memory service lacks charSlot');
  }
  L.write(charSlot, 'u16', 0);
  L.write(charSlot + 2, 'u16', 0);
  if (L.read(out, 'u32') !== emptyWString(L)) {
    // Reset out to a copy of the shared L"".
    let n = 0;
    if (L.read(emptyWString(L), 'u16') !== 0) n = wcharLen(L, emptyWString(L)) + 1;
    L.write(out + 8, 'i32', n);
    L.write(out + 4, 'i32', n);
    farrayRealloc(L, out, 2);
    const num = L.read(out + 4, 'i32');
    if (num !== 0) {
      moveBytes(L, L.read(out, 'u32'), emptyWString(L), num * 2);
    }
  }
  for (let i = 0; i < inputLen; i += 1) {
    const ch = L.read(src + i * 2, 'u16');
    const flags = L.read(L.base + EDIT_WINDOW.flags, 'i32');
    if ((flags & EDIT_FLAGS.singleLine) !== 0 && ch === 0xa) continue;
    L.write(charSlot + 4, 'u32', ch);
    if (filterCharVirtual(L, charSlot + 4) === 0) continue;
    const ch16 = L.read(charSlot + 4, 'u16');
    L.write(charSlot, 'u16', ch16);
    const outNum = L.read(out + 4, 'i32');
    if (outNum !== 0) {
      const addLen = wcharLen(L, charSlot);
      const newNum = outNum + addLen;
      L.write(out + 4, 'i32', newNum);
      if (newNum > L.read(out + 8, 'i32')) {
        L.write(out + 8, 'i32', growArrayMax(newNum));
        farrayRealloc(L, out, 2);
      }
      wcharCopy(L, L.read(out, 'u32') + (outNum - 1) * 2, charSlot);
    } else {
      if (ch16 === 0) continue;
      const newNum = wcharLen(L, charSlot) + 1;
      L.write(out + 4, 'i32', newNum);
      if (newNum > L.read(out + 8, 'i32')) {
        L.write(out + 8, 'i32', growArrayMax(newNum));
        farrayRealloc(L, out, 2);
      }
      wcharCopy(L, L.read(out, 'u32'), charSlot);
    }
  }
  if (inputLen <= 0) return 1;
  const outNum = L.read(out + 4, 'i32');
  if (outNum === 0) return 0;
  return outNum - 1 > 0 ? 1 : 0;
}

// 0x10020450 — pushUndo(pos, oldPtr, oldLen, newPtr, newLen).
export function pushUndo(L, pos, oldPtr, oldLen, newPtr, newLen) {
  let aPtr = oldPtr;
  if (aPtr === 0) aPtr = emptyWString(L);
  let aLen = oldLen;
  if (aLen < 0) aLen = wcharLen(L, aPtr);
  let bPtr = newPtr;
  if (bPtr === 0) bPtr = emptyWString(L);
  let bLen = newLen;
  if (bLen < 0) bLen = wcharLen(L, bPtr);
  if (aLen < 1 && bLen < 1) return;
  const undo = L.base + EDIT_WINDOW.undoData;
  let coalesced = false;
  if (!(aLen >= 1 && bLen >= 1)) {
    const undoPos = L.read(L.base + EDIT_WINDOW.undoPos, 'i32');
    const saved = L.read(L.base + EDIT_WINDOW.savedUndoPos, 'i32');
    if (undoPos > 0 && undoPos !== saved) {
      const data = L.read(undo, 'u32');
      const prev = data + (undoPos - 1) * EDIT_UNDO.size;
      const aNum = L.read(prev + EDIT_UNDO.oldText + 4, 'i32');
      if (!(aNum !== 0 && aNum - 1 >= 1)) {
        if (aLen < 1) {
          const prevBLen0 = L.read(prev + EDIT_UNDO.newText + 4, 'i32');
          const prevBLen = prevBLen0 !== 0 ? prevBLen0 - 1 : 0;
          const prevPos = L.read(prev + EDIT_UNDO.pos, 'i32');
          if (pos === prevPos + prevBLen) {
            farrayInsert(L, prev + EDIT_UNDO.newText, prevBLen, bLen, 2);
            const bData = L.read(prev + EDIT_UNDO.newText, 'u32');
            if (bLen > 0) wcharCopyN(L, bData + prevBLen * 2, bPtr, bLen + 1);
            else L.write(bData + prevBLen * 2, 'u16', 0);
            coalesced = true;
          }
        }
      }
    }
  }
  const num = L.read(undo + 4, 'i32');
  const uPos = L.read(L.base + EDIT_WINDOW.undoPos, 'i32');
  if (uPos < num) {
    const n = num - uPos;
    const data = L.read(undo, 'u32');
    for (let i = uPos; i < uPos + n; i += 1) {
      const rec = data + i * EDIT_UNDO.size;
      fstringReset(L, rec + EDIT_UNDO.oldText, 0);
      fstringReset(L, rec + EDIT_UNDO.newText, 0);
      fstringDtor(L, rec + EDIT_UNDO.newText);
      fstringDtor(L, rec + EDIT_UNDO.oldText);
    }
    farrayRemove(L, undo, uPos, n, EDIT_UNDO.size);
    if (L.read(L.base + EDIT_WINDOW.savedUndoPos, 'i32') > uPos) {
      L.write(L.base + EDIT_WINDOW.savedUndoPos, 'i32', -1);
    }
  }
  if (!coalesced) {
    const count = L.read(undo + 4, 'i32');
    farraySetNum(L, undo, count + 1, EDIT_UNDO.size);
    const data = L.read(undo, 'u32');
    const rec = data + count * EDIT_UNDO.size;
    zeroBytes(L, rec, EDIT_UNDO.size);
    L.write(rec + EDIT_UNDO.pos, 'i32', pos);
    assignString(L, rec + EDIT_UNDO.oldText, aPtr, aLen);
    assignString(L, rec + EDIT_UNDO.newText, bPtr, bLen);
    L.write(L.base + EDIT_WINDOW.undoPos, 'i32',
      L.read(L.base + EDIT_WINDOW.undoPos, 'i32') + 1);
  }
  trimUndo(L);
}

// 0x1002d8b0 — textChangedRange(ip, selLen, insLen): pending relayout ranges
// and line-record start fixups for both line tables.
export function textChangedRange(L, ip, selLen, insLen) {
  const d = insLen - selLen;
  const fixLines = (flagsOff, posOff, lenOff, dataOff, countOff) => {
    if (L.read(L.base + lenOff, 'i32') > 0) {
      L.write(L.base + flagsOff, 'i32', L.read(L.base + flagsOff, 'i32') | 1);
      return;
    }
    L.write(L.base + posOff, 'i32', ip);
    L.write(L.base + lenOff, 'i32', insLen);
    if (insLen < 1) L.write(L.base + lenOff, 'i32', 1);
    const count = L.read(L.base + countOff, 'i32');
    const data = L.read(L.base + dataOff, 'u32');
    // Only a row starting after ip moves (0x1002d90e `jle` skips the rest);
    // a moved start that lands at or before ip becomes ip + 1.
    for (let i = 0; i < count; i += 1) {
      const rec = data + i * EDIT_LINE.size;
      const start = L.read(rec + EDIT_LINE.start, 'i32');
      if (start <= ip) continue;
      L.write(rec + EDIT_LINE.start, 'i32', start + d);
      if (start + d <= ip) L.write(rec + EDIT_LINE.start, 'i32', ip + 1);
    }
  };
  fixLines(
    EDIT_WINDOW.relayoutFlags, EDIT_WINDOW.pendingPos, EDIT_WINDOW.pendingLen,
    EDIT_WINDOW.linesData, EDIT_WINDOW.linesCount,
  );
  fixLines(
    EDIT_WINDOW.relayoutFlags2, EDIT_WINDOW.pendingPos2, EDIT_WINDOW.pendingLen2,
    EDIT_WINDOW.lines2Data, EDIT_WINDOW.lines2Count,
  );
}

// 0x1001fe20 — replaceSelection(text, bRecordUndo, bExtend).
export function replaceSelection(L, textPtr, bRecordUndo, bExtend) {
  const selStart = L.read(L.base + EDIT_WINDOW.selStart, 'i32');
  const selEnd = L.read(L.base + EDIT_WINDOW.selEnd, 'i32');
  const selLen = selEnd > selStart ? selEnd - selStart : 0;
  let insLen = textPtr !== 0 ? wcharLen(L, textPtr) : 0;
  const text = L.base + EDIT_WINDOW.text;
  const maxSize = L.read(L.base + EDIT_WINDOW.maxSize, 'i32');
  if (maxSize > 0) {
    const len = textLen(L);
    if (len > maxSize) {
      const count = len - maxSize;
      modelAssert(maxSize >= 0, 'replaceSelection truncate index');
      modelAssert(maxSize + count <= L.read(text + 4, 'i32'), 'replaceSelection truncate range');
      farrayRemove(L, text, maxSize, count, 2);
      const data = L.read(text, 'u32');
      L.write(data + maxSize * 2, 'u16', 0);
      clearUndo(L);
      setTextChangedFlag(L, 1);
      askParentForReconfigure(L);
      setInsertionPointEntry(L, 0, 0);
      return;
    }
    if (selLen < insLen) {
      const len2 = textLen(L);
      const over = len2 - maxSize - selLen + insLen;
      if (over > 0) {
        insLen -= over;
        if (insLen < 0) return;
      }
    }
  }
  if (selLen <= 0 && insLen <= 0) return;
  if (selEnd > selStart) L.write(L.base + EDIT_WINDOW.insertionPoint, 'i32', selStart);
  const ip = L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32');
  if (bRecordUndo) {
    const num = L.read(text + 4, 'i32');
    const srcBase = num !== 0 ? L.read(text, 'u32') : emptyWString(L);
    pushUndo(L, ip, srcBase + ip * 2, selLen, textPtr, insLen);
  }
  if (selLen < insLen) {
    const d = insLen - selLen;
    const num = L.read(text + 4, 'i32');
    if (num !== 0) {
      farraySetNum(L, text, num + d, 2);
      const data = L.read(text, 'u32');
      moveBytes(L, data + (ip + d) * 2, data + ip * 2, (num - ip) * 2);
    } else {
      farrayInsert(L, text, ip, d + 1, 2);
    }
  } else if (selLen > insLen) {
    const d = selLen - insLen;
    const len = textLen(L);
    if (len - d > 0) {
      farrayRemove(L, text, ip, d, 2);
    } else {
      L.write(text + 4, 'i32', 0);
      L.write(text + 8, 'i32', 0);
      farrayRealloc(L, text, 2);
    }
  }
  if (insLen > 0) {
    const data = L.read(text, 'u32');
    for (let i = 0; i < insLen; i += 1) {
      L.write(data + (ip + i) * 2, 'u16', L.read(textPtr + i * 2, 'u16'));
    }
  }
  const numAfter = L.read(text + 4, 'i32');
  if (numAfter !== 0) {
    const data = L.read(text, 'u32');
    L.write(data + (numAfter - 1) * 2, 'u16', 0);
  }
  textChangedBroadcast(L);
  textChangedRange(L, ip, selLen, insLen);
  askParentForReconfigure(L);
  L.write(L.base + EDIT_WINDOW.anchor, 'i32', ip);
  setInsertionPointEntry(L, ip + insLen, bExtend);
}

// 0x10050710 — convertPipes(text): '|n' -> LF translation accumulated in
// the process-static FString (mem.convertBuffer, native 0x100aead0) with
// the init-once flag byte (mem.convertFlag, native 0x100aeac8).  A run
// scratch (mem.convertRun, native 0x100add98) collects translated chars
// and flushes every 0x800 BYTES (1024 wchars — the binary compares the
// byte distance at 0x10050831-0x10050842; the doc once said "0x800
// wchars", which was a units slip).  `|` followed by 'n' emits LF and
// consumes both; `|` followed by anything else emits the '|' and the
// following char verbatim; a trailing '|' is kept.  The atexit
// registration of the static's destructor has no heap effect and is not
// modelled.
export function convertPipes(L, textPtr) {
  const statik = L.mem.convertBuffer;
  const flagCell = L.mem.convertFlag;
  const run = L.mem.convertRun;
  if (![statik, flagCell, run].every(Number.isInteger)) {
    throw new EditWindowModelBoundaryError(
      'memory service lacks convertPipes scratch cells');
  }
  const empty = emptyWString(L);
  if ((L.read(flagCell, 'u8') & 1) === 0) {
    L.write(flagCell, 'u8', L.read(flagCell, 'u8') | 1);
    L.write(statik, 'u32', 0);
    L.write(statik + 4, 'i32', 0);
    L.write(statik + 8, 'i32', 0);
  }
  // 0x1005076b-0x100507e0: if the static still holds a buffer (not L""),
  // reset it to a copy of the shared empty string.
  if (L.read(statik, 'u32') !== empty) {
    let n = 0;
    if (L.read(empty, 'u16') !== 0) n = wcharLen(L, empty) + 1;
    L.write(statik + 4, 'i32', n);
    L.write(statik + 8, 'i32', n);
    farrayRealloc(L, statik, 2);
    const num = L.read(statik + 4, 'i32');
    if (num !== 0) moveBytes(L, L.read(statik, 'u32'), empty, num * 2);
  }
  // Append the NUL-terminated run buffer to the static (0x10050844 /
  // 0x100508f4): path A (static nonempty) uses FArray::Add + appStrcpy at
  // data + (num-1)*2; path B (static empty) skips an empty run, sets
  // num = runLen + 1, grows max via growArrayMax, appStrcpy at data.
  const flush = writeAt => {
    L.write(writeAt, 'u16', 0);
    const num = L.read(statik + 4, 'i32');
    if (num !== 0) {
      const runLen = wcharLen(L, run);
      farrayInsert(L, statik, num, runLen, 2);
      wcharCopy(L, L.read(statik, 'u32') + (num - 1) * 2, run);
      return;
    }
    if (L.read(run, 'u16') === 0) return;
    const newNum = wcharLen(L, run) + 1;
    L.write(statik + 4, 'i32', newNum);
    if (newNum > L.read(statik + 8, 'i32')) {
      L.write(statik + 8, 'i32', growArrayMax(newNum));
      farrayRealloc(L, statik, 2);
    }
    wcharCopy(L, L.read(statik, 'u32'), run);
  };
  let p = textPtr;
  let w = run;
  for (;;) {
    let ch = L.read(p, 'u16');
    if (ch === 0) {
      // 0x100508f4: final flush, then return static data or L"".
      flush(w);
      return L.read(statik + 4, 'i32') !== 0 ? L.read(statik, 'u32') : empty;
    }
    if (ch === 0x7c) { // '|'
      p += 2;
      if (L.read(p, 'u16') === 0x6e) { // 'n'
        L.write(w, 'u16', 0xa);
        w += 2;
      } else {
        L.write(w, 'u16', 0x7c);
        ch = L.read(p, 'u16');
        w += 2;
        if (ch !== 0) {
          L.write(w, 'u16', ch);
          w += 2;
        }
      }
    } else {
      L.write(w, 'u16', ch);
      w += 2;
    }
    if (L.read(p, 'u16') !== 0) p += 2;
    if (((w - run) & ~1) >= 0x800) {
      flush(w); // 0x10050844: mid-run flush on the 0x800-byte boundary
      w = run;
    }
  }
}

// 0x1001e3c0 — InsertText virtual body (text, bKeepUndo, bExtend).
// The temp FString lives in the heap scratch cell that mirrors the native
// stack temp.
export function insertTextVirtual(L, textPtr, bKeepUndo, bExtend) {
  const temp = L.mem.scratchInsert;
  if (!Number.isInteger(temp)) {
    throw new EditWindowModelBoundaryError('memory service lacks scratchInsert');
  }
  L.write(temp, 'u32', 0);
  L.write(temp + 4, 'i32', 0);
  L.write(temp + 8, 'i32', 0);
  const accepted = filterText(L, textPtr, temp);
  if (accepted === 0) {
    L.write(temp + 4, 'i32', 0);
    L.write(temp + 8, 'i32', 0);
    farrayRealloc(L, temp, 2);
    boundedRemove(L, temp, 0, L.read(temp + 4, 'i32'));
    freeIfData(L, temp);
    return 0;
  }
  if (!bKeepUndo) {
    clearUndo(L);
    setTextChangedFlag(L, 1);
  }
  const tnum = L.read(temp + 4, 'i32');
  const filtered = tnum !== 0 ? L.read(temp, 'u32') : emptyWString(L);
  replaceSelection(L, filtered, bKeepUndo, bExtend);
  tempFStringTeardown(L, temp);
  return 1;
}

// 0x100201d0 — deleteChar core (bBackspace, bKeepUndo).  When no selection
// is active (selEnd <= selStart) it selects the one char backward
// (bBackspace, guarded by ip <= 0) or forward (guarded by ip >= textLen);
// the guard only skips the selection write — replaceSelection still runs.
export function deleteCharCore(L, bBackspace, bKeepUndo) {
  const selEnd = L.read(L.base + EDIT_WINDOW.selEnd, 'i32');
  const selStart = L.read(L.base + EDIT_WINDOW.selStart, 'i32');
  if (selEnd <= selStart) {
    let p = L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32');
    if (bBackspace !== 0) {
      if (p <= 0) {
        replaceSelection(L, 0, bKeepUndo, 0);
        return;
      }
      p -= 1;
    } else if (p >= textLen(L)) {
      replaceSelection(L, 0, bKeepUndo, 0);
      return;
    }
    L.write(L.base + EDIT_WINDOW.selStart, 'i32', p);
    L.write(L.base + EDIT_WINDOW.selEnd, 'i32', p + 1);
  }
  replaceSelection(L, 0, bKeepUndo, 0);
}

// 0x1001e560 — DeleteChar virtual (vtable +0x128): when bKeepUndo is 0 it
// clears the undo history and marks the text changed BEFORE the deletion
// attempt, so a backspace at position 0 still wipes undo history.
export function deleteCharVirtual(L, bBackspace, bKeepUndo) {
  if (bKeepUndo === 0) {
    clearUndo(L);
    setTextChangedFlag(L, 1);
  }
  deleteCharCore(L, bBackspace, bKeepUndo);
}

// 0x1001e0a0 — Undo: nothing when undoPos <= 0; otherwise decrement
// undoPos, restore selection = [rec.pos, rec.pos + rec.newLen), ip =
// rec.pos, then replace with the record's old text (no undo recording,
// bExtend = 1).
export function undoEdit(L) {
  const pos = L.read(L.base + EDIT_WINDOW.undoPos, 'i32');
  if (pos <= 0) return;
  const np = pos - 1;
  L.write(L.base + EDIT_WINDOW.undoPos, 'i32', np);
  const rec = L.read(L.base + EDIT_WINDOW.undoData, 'u32') + np * EDIT_UNDO.size;
  const start = L.read(rec + EDIT_UNDO.pos, 'i32');
  L.write(L.base + EDIT_WINDOW.selStart, 'i32', start);
  const newNum = L.read(rec + EDIT_UNDO.newText + 4, 'i32');
  const newLen = newNum !== 0 ? newNum - 1 : 0;
  L.write(L.base + EDIT_WINDOW.selEnd, 'i32', start + newLen);
  L.write(L.base + EDIT_WINDOW.insertionPoint, 'i32', start);
  const oldNum = L.read(rec + EDIT_UNDO.oldText + 4, 'i32');
  const src = oldNum !== 0 ? L.read(rec + EDIT_UNDO.oldText, 'u32') : emptyWString(L);
  replaceSelection(L, src, 0, 1);
}

// 0x1001e170 — Redo: nothing when undoPos > undoNum - 1; otherwise select
// [rec.pos, rec.pos + rec.oldLen), ip = rec.pos, advance undoPos, and
// replace with the record's new text (no undo recording, bExtend = 1).
export function redoEdit(L) {
  const count = L.read(L.base + EDIT_WINDOW.undoNum, 'i32') - 1;
  const pos = L.read(L.base + EDIT_WINDOW.undoPos, 'i32');
  if (pos > count) return;
  const rec = L.read(L.base + EDIT_WINDOW.undoData, 'u32') + pos * EDIT_UNDO.size;
  const start = L.read(rec + EDIT_UNDO.pos, 'i32');
  L.write(L.base + EDIT_WINDOW.selStart, 'i32', start);
  const oldNum = L.read(rec + EDIT_UNDO.oldText + 4, 'i32');
  const oldLen = oldNum !== 0 ? oldNum - 1 : 0;
  L.write(L.base + EDIT_WINDOW.insertionPoint, 'i32', start);
  L.write(L.base + EDIT_WINDOW.undoPos, 'i32', pos + 1);
  L.write(L.base + EDIT_WINDOW.selEnd, 'i32', start + oldLen);
  const newNum = L.read(rec + EDIT_UNDO.newText + 4, 'i32');
  const src = newNum !== 0 ? L.read(rec + EDIT_UNDO.newText, 'u32') : emptyWString(L);
  replaceSelection(L, src, 0, 1);
}

// 0x1001e5f0 — copy/cut core (bCut, bKeepUndo): no-op without a selection;
// assigns text[selStart, selEnd) to the process-global clipboard FString;
// when bCut, runs the DeleteChar virtual (vtable +0x128) with (0,
// bKeepUndo).
export function copyOrCut(L, bCut, bKeepUndo) {
  const selEnd = L.read(L.base + EDIT_WINDOW.selEnd, 'i32');
  const selStart = L.read(L.base + EDIT_WINDOW.selStart, 'i32');
  if (selEnd <= selStart) return;
  const clip = L.mem.clipboard;
  if (!Number.isInteger(clip)) {
    throw new EditWindowModelBoundaryError('memory service lacks clipboard');
  }
  const num = L.read(L.base + EDIT_WINDOW.textNum, 'i32');
  const data = num !== 0 ? L.read(L.base + EDIT_WINDOW.text, 'u32') : emptyWString(L);
  assignString(L, clip, data + selStart * 2, selEnd - selStart);
  if (bCut !== 0) deleteCharVirtual(L, 0, bKeepUndo);
}

// 0x1001e6b0 — paste core (bKeepUndo, bExtend): calls the InsertText
// virtual (vtable +0x124) with the clipboard text (clipboard.data when
// num != 0, else the shared L"").
export function pasteEdit(L, bKeepUndo, bExtend) {
  const clip = L.mem.clipboard;
  if (!Number.isInteger(clip)) {
    throw new EditWindowModelBoundaryError('memory service lacks clipboard');
  }
  const num = L.read(clip + 4, 'i32');
  const src = num !== 0 ? L.read(clip, 'u32') : emptyWString(L);
  return insertTextVirtual(L, src, bKeepUndo, bExtend);
}

// 0x1001e260 — SetText virtual body.
export function setTextVirtual(L, textPtr) {
  L.write(L.base + EDIT_WINDOW.selStart, 'i32', 0);
  const len = textLen(L);
  L.write(L.base + EDIT_WINDOW.selEnd, 'i32', len);
  L.write(L.base + EDIT_WINDOW.insertionPoint, 'i32', len);
  insertTextVirtual(L, textPtr, 0, 0);
  setInsertionPointEntry(L, 0, 0);
}
