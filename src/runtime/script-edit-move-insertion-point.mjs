/**
 * Recovered Extension.dll XEditWindow::MoveInsertionPoint translation (exec
 * body 0x10021af0 -> method 0x1001d250, 12-entry jump table at
 * 0x1001d464).  The exec masks moveInsert to a byte (`and edx,0xff`).
 *
 * When the line table is empty (count <= 0) the body skips posToLineCol
 * and the page-size computation, leaving line = 0 / pageSize = 1; every
 * line-dependent case then re-checks count and returns.  Cases 2/3/10/11
 * have no count guard.
 *
 * Page size (0x1001d29a-0x1001d2b6): x87 `fld lineHeight; fadd spacing;
 * fdivr height; __ftol` then clamped to >= 1.  The f32->f64 loads and the
 * fadd are exact in doubles; the fdivr quotient can differ from JS `a/b`
 * in the final ulp for extreme inputs — only observable when the quotient
 * sits within an ulp of an integer, which the truncation would split.
 * Unverified caveat, labelled per the contract.
 */
import {
  EDIT_LINE,
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
  moveToLine,
  nextWord,
  posToLineCol,
  prevWord,
  setInsertionPointCore,
  textLen,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_MOVE_INSERTION_POINT_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.MoveInsertionPoint',
  packageExport: 955,
  nativeIndex: 1880,
  functionFlags: 0x401,
  serialSize: 34,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021af0,
  execEnd: 0x10021b62,
  execSha256: 'c970c35bee15c5cf957ff14798eee4242d6013853bc69c334e6d3fcfd6762758',
  methodBody: 0x1001d250,
  methodEnd: 0x1001d461,
  methodSha256: '41ce1b6fd0f887e8e974b9e861697e0f532aa2326d602720a5a7024be6e4b982',
});

export class EditWindowMoveInsertionPointBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowMoveInsertionPointBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowMoveInsertionPointBoundaryError(message);
};

export function editWindowMoveInsertionPoint(object, moveInsert, bDrag, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.MoveInsertionPoint requires a canonical window object');
  }
  const L = editMemory(object, services);
  const type = moveInsert & 0xff;
  const extend = bDrag | 0;
  const count = L.read(L.base + EDIT_WINDOW.linesCount, 'i32');
  let line = 0;
  let pageSize = 1;
  if (count > 0) {
    line = posToLineCol(L, L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32')).line;
    const spacing = L.read(L.base + EDIT_WINDOW.lineSpacing, 'f32');
    const lineHeight = L.read(L.base + EDIT_WINDOW.lineHeight, 'f32');
    const height = L.read(L.base + EDIT_WINDOW.height, 'f32');
    pageSize = Math.trunc(height / (lineHeight + spacing));
    if (pageSize < 1) pageSize = 1;
  }
  switch (type) {
    case 0: // up
      if (count <= 0) return;
      moveToLine(L, line - 1, extend);
      return;
    case 1: // down
      if (count <= 0) return;
      moveToLine(L, line + 1, extend);
      return;
    case 2: // left
      setInsertionPointCore(L, L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32') - 1, extend);
      return;
    case 3: // right
      setInsertionPointCore(L, L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32') + 1, extend);
      return;
    case 4: // word left
      if (count <= 0) return;
      setInsertionPointCore(L, prevWord(L, L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32')), extend);
      return;
    case 5: // word right
      if (count <= 0) return;
      setInsertionPointCore(L, nextWord(L, L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32')), extend);
      return;
    case 6: { // line start
      if (count <= 0) return;
      const rec = L.read(L.base + EDIT_WINDOW.linesData, 'u32') + line * EDIT_LINE.size;
      setInsertionPointCore(L, L.read(rec + EDIT_LINE.start, 'i32'), extend);
      return;
    }
    case 7: { // line end: start + fullLen - 1
      if (count <= 0) return;
      const rec = L.read(L.base + EDIT_WINDOW.linesData, 'u32') + line * EDIT_LINE.size;
      setInsertionPointCore(L,
        L.read(rec + EDIT_LINE.fullLen, 'i32') + L.read(rec + EDIT_LINE.start, 'i32') - 1,
        extend);
      return;
    }
    case 8: // page up
      if (count <= 0) return;
      moveToLine(L, line - pageSize, extend);
      return;
    case 9: // page down
      if (count <= 0) return;
      moveToLine(L, line + pageSize, extend);
      return;
    case 10: // text start
      setInsertionPointCore(L, 0, extend);
      return;
    case 11: // text end
      setInsertionPointCore(L, textLen(L), extend);
      return;
    default: // moveType > 11 (masked byte) is a no-op
      return;
  }
}

export const execEditWindowMoveInsertionPoint = editWindowMoveInsertionPoint;
