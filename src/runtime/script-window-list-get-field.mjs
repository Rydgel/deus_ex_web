/**
 * Recovered Extension.dll XListWindow::GetField translation (body
 * 0x1002f250).  Returns the field's FString data pointer — the script-side
 * string payload — or the shared empty wstring (0x10099ea8) when the field
 * text has no allocation.  A null row id or an out-of-range column returns 0;
 * the bounds check compares colIndex against the cols TArray count at
 * this+0x180 via the 0x10033240 helper.  The field itself is read without a
 * field-count check, matching the native.
 */
import {
  LIST_FIELD,
  LIST_ROW,
  LIST_WINDOW_DLL,
  colIndexValid,
  listMemory,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_GET_FIELD_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.GetField',
  packageExport: 1581,
  nativeIndex: 1735,
  functionFlags: 0x401,
  serialSize: 34,
  ...LIST_WINDOW_DLL,
  execBody: 0x10034650,
  execEnd: 0x10034785,
  execSha256: '196afa58a177913c845d29c5cd1b802d206f9dd44e9f394d8b095e2d76cef4b4',
  methodBody: 0x1002f250,
  methodEnd: 0x1002f2e8,
  methodSha256: 'd0b084e0eb6adf3051e341a5f62610f34416e2e95b97306f722c8bf46b81c318',
});

export class ListWindowGetFieldBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowGetFieldBoundaryError';
    this.code = `LIST_GET_FIELD_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowGetFieldBoundaryError(message, details);
};

export function listWindowGetField(object, rowId, colIndex, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.GetField requires a canonical window object', {kind: 'REFERENCE', value: object});
  if (typeof colIndex !== 'number' || !Number.isInteger(colIndex))
    fail('ListWindow.GetField requires an integer column index', {kind: 'VALUE', value: colIndex});
  const L = listMemory(object, services);
  const row = rowId >>> 0;
  if (!row) return 0;
  if (!colIndexValid(L, colIndex | 0)) return 0;
  const field = L.read(row + LIST_ROW.fieldsData, 'u32') + (colIndex | 0) * LIST_FIELD.size;
  if (!L.read(field + LIST_FIELD.textCount, 'u32')) {
    const empty = L.mem.emptyWString;
    if (typeof empty !== 'number' || !empty)
      fail('ListWindow.GetField requires the empty wstring cell on the heap service',
        {kind: 'SERVICE'});
    return empty;
  }
  return L.read(field + LIST_FIELD.text, 'u32');
}

export const execListWindowGetField = listWindowGetField;
