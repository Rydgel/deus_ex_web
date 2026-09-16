/**
 * Recovered Extension.dll XListWindow::IndexToRowId translation (body
 * 0x1002ecf0).  Bounds-checks the index against the rows TArray count at
 * this+0x174 and returns the row node pointer rows[index] — the opaque
 * "row id" the script side carries — or 0 when out of range.
 */
import {
  LIST_ROW,
  LIST_WINDOW,
  LIST_WINDOW_DLL,
  listMemory,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_INDEX_TO_ROW_ID_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.IndexToRowId',
  packageExport: 1549,
  nativeIndex: 1720,
  functionFlags: 0x401,
  serialSize: 31,
  ...LIST_WINDOW_DLL,
  execBody: 0x10033f50,
  execEnd: 0x10033f9c,
  execSha256: 'af24276bb876d625328f84e378de5190e4ba238a1449185a7bb16e056d72dda6',
  methodBody: 0x1002ecf0,
  methodEnd: 0x1002ed0c,
  methodSha256: 'f88028f3212465fa711b00e7a7aa90721d6ae2edabbb8bbe54c222a254306922',
});

export class ListWindowIndexToRowIdBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowIndexToRowIdBoundaryError';
    this.code = `LIST_INDEX_TO_ROW_ID_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowIndexToRowIdBoundaryError(message, details);
};

export function listWindowIndexToRowId(object, index, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.IndexToRowId requires a canonical window object', {kind: 'REFERENCE', value: object});
  if (typeof index !== 'number' || !Number.isInteger(index))
    fail('ListWindow.IndexToRowId requires an integer index', {kind: 'VALUE', value: index});
  const {base, read} = listMemory(object, services);
  index |= 0;
  if (index < 0 || index >= read(base + LIST_WINDOW.rowsCount, 'i32')) return 0;
  return read(read(base + LIST_WINDOW.rowsData, 'u32') + 4 * index, 'u32');
}

export const execListWindowIndexToRowId = listWindowIndexToRowId;
