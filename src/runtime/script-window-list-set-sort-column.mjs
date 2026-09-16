/**
 * Recovered Extension.dll XListWindow::SetSortColumn translation (body
 * 0x10030860).
 *
 * The column index is validated by 0x10033240 (0 <= col < numCols); an
 * invalid index is a complete no-op.  Every column then has sortPriority
 * reset to 0 and sortFlags bits 0-1 cleared.  The target column gets
 * sortPriority = 1, sortFlags bit0 = bReverse bit0 and bit1 =
 * bCaseSensitive bit1 (other sortFlags bits preserved).  When the window
 * sorting flag (flags bit0) is set the sort driver 0x100329b0 runs
 * immediately.  The export is void.
 */
import {
  LIST_WINDOW,
  LIST_COL,
  LIST_FLAGS,
  LIST_WINDOW_DLL,
  colIndexValid,
  listMemory,
  sortRows,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_SET_SORT_COLUMN_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.SetSortColumn',
  packageExport: 1679,
  nativeIndex: 1780,
  functionFlags: 0x401,
  serialSize: 37,
  ...LIST_WINDOW_DLL,
  execBody: 0x10035ad0,
  execEnd: 0x10035b6c,
  execSha256: 'ff3717e971c48fd903e32b51d13acd9d27f66b82d9be153907b5667c5c47a1e9',
  methodBody: 0x10030860,
  methodEnd: 0x1003097e,
  methodSha256: 'e7a54b31f0243c8b6e9c684f4f1d62011c13e42cee15a0ac24a34d2a3f5677a3',
});

export class ListWindowSetSortColumnBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowSetSortColumnBoundaryError';
    this.code = `LIST_SET_SORT_COLUMN_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowSetSortColumnBoundaryError(message, details);
};

export function listWindowSetSortColumn(object, colIndex, bReverse, bCaseSensitive,
                                        services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.SetSortColumn requires a canonical window object',
      {kind: 'REFERENCE', value: object});
  if (typeof colIndex !== 'number' || !Number.isInteger(colIndex))
    fail('ListWindow.SetSortColumn requires an integer column index',
      {kind: 'VALUE', value: colIndex});
  if (typeof bReverse !== 'number' || !Number.isInteger(bReverse))
    fail('ListWindow.SetSortColumn requires an integer reverse flag',
      {kind: 'VALUE', value: bReverse});
  if (typeof bCaseSensitive !== 'number' || !Number.isInteger(bCaseSensitive))
    fail('ListWindow.SetSortColumn requires an integer case-sensitivity flag',
      {kind: 'VALUE', value: bCaseSensitive});
  const L = listMemory(object, services);
  const col = colIndex | 0;
  if (!colIndexValid(L, col)) return;
  const numCols = L.read(L.base + LIST_WINDOW.numCols, 'i32');
  const cdata = L.read(L.base + LIST_WINDOW.colsData, 'u32');
  for (let i = 0; i < numCols; i++) {
    const colPtr = cdata + i * LIST_COL.size;
    L.write(colPtr + LIST_COL.sortPriority, 'i32', 0);
    L.write(colPtr + LIST_COL.sortFlags, 'u32',
      (L.read(colPtr + LIST_COL.sortFlags, 'u32') & ~3) >>> 0);
  }
  const target = cdata + col * LIST_COL.size;
  L.write(target + LIST_COL.sortPriority, 'i32', 1);
  const flagsAddr = target + LIST_COL.sortFlags;
  const sortFlags = L.read(flagsAddr, 'u32');
  L.write(flagsAddr, 'u32', (((sortFlags ^ bReverse) & 1) ^ sortFlags) >>> 0);
  L.write(flagsAddr, 'u32',
    ((((bCaseSensitive & 1) << 1) | (L.read(flagsAddr, 'u32') & ~2))) >>> 0);
  if (L.read(L.base + LIST_WINDOW.flags, 'u32') & LIST_FLAGS.sorting) sortRows(L);
}

export const execListWindowSetSortColumn = listWindowSetSortColumn;
