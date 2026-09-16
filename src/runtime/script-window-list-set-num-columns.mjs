/**
 * Recovered Extension.dll XListWindow::SetNumColumns translation (body
 * 0x1002fa10).
 *
 * Grow path: FArray::Add expands the column TArray (0x38-byte records) and
 * the grown range is zero-filled, then initColumn 0x100314f0 initializes each
 * new column (index, empty header/format FStrings, cleared sort state,
 * width = f32(2*padX + 20.0), packed dword and default font copied from the
 * window).  Shrink path: every removed column is destructed in place (header
 * and format FStrings reset then destructed, four Realloc events each) and
 * FArray::Remove applies the real shrink policy; a nonpositive target
 * destructs every column and empties the array.  Afterwards every row's
 * field array is resized to the column count (resizeRowFields 0x100320b0),
 * the row height is recomputed from the column fonts (0x10031fd0), and the
 * parent is asked to reconfigure (0x1004e060).  The export is void; leftover
 * register values are unobservable.
 */
import {
  LIST_WINDOW,
  LIST_COL,
  LIST_WINDOW_DLL,
  askParentReconfigure,
  columnDtor,
  farrayEmpty,
  farrayRemove,
  farraySetNum,
  initColumn,
  listMemory,
  recomputeRowHeight,
  resizeRowFields,
  zeroBytes,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_SET_NUM_COLUMNS_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.SetNumColumns',
  packageExport: 1630,
  nativeIndex: 1760,
  functionFlags: 0x401,
  serialSize: 31,
  ...LIST_WINDOW_DLL,
  execBody: 0x10034f80,
  execEnd: 0x10034fc6,
  execSha256: '90100741c3e4249520de8ac8d8be63dcb4507e5b12bd8862e1cd2e4228775bd3',
  methodBody: 0x1002fa10,
  methodEnd: 0x1002fc33,
  methodSha256: '88c25172635ae98a695fcab9d0ba1001e209b5f0b272baeaf329dbe71e1fed86',
});

export class ListWindowSetNumColumnsBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowSetNumColumnsBoundaryError';
    this.code = `LIST_SET_NUM_COLUMNS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowSetNumColumnsBoundaryError(message, details);
};

export function listWindowSetNumColumns(object, newCols, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.SetNumColumns requires a canonical window object',
      {kind: 'REFERENCE', value: object});
  if (typeof newCols !== 'number' || !Number.isInteger(newCols))
    fail('ListWindow.SetNumColumns requires an integer column count',
      {kind: 'VALUE', value: newCols});
  const L = listMemory(object, services);
  const cols = L.base + LIST_WINDOW.colsData;
  const cur = L.read(L.base + LIST_WINDOW.numCols, 'i32');
  const n = newCols | 0;
  if (n > cur) {
    const add = n - cur;
    const old = L.read(cols + 4, 'i32');
    farraySetNum(L, cols, cur + add, LIST_COL.size);
    zeroBytes(L, L.read(cols, 'u32') + old * LIST_COL.size, add * LIST_COL.size);
    const numNow = L.read(L.base + LIST_WINDOW.numCols, 'i32');
    for (let i = old; i < numNow; i++)
      initColumn(L, L.read(cols, 'u32') + i * LIST_COL.size, i);
  } else if (n < cur) {
    const num = L.read(cols + 4, 'i32');
    const data = L.read(cols, 'u32');
    if (n > 0) {
      for (let i = n; i < num; i++) columnDtor(L, data + i * LIST_COL.size);
      farrayRemove(L, cols, n, num - n, LIST_COL.size);
    } else {
      for (let i = 0; i < num; i++) columnDtor(L, data + i * LIST_COL.size);
      farrayEmpty(L, cols, LIST_COL.size, 0);
    }
  }
  const rows = L.base + LIST_WINDOW.rowsData;
  const rdata = L.read(rows, 'u32');
  const count = L.read(rows + 4, 'i32');
  for (let i = 0; i < count; i++)
    resizeRowFields(L, L.read(rdata + 4 * i, 'u32'));
  recomputeRowHeight(L);
  askParentReconfigure(L);
}

export const execListWindowSetNumColumns = listWindowSetNumColumns;
