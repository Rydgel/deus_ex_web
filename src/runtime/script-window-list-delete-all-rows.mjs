/**
 * Recovered Extension.dll XListWindow::DeleteAllRows translation (body
 * 0x1002f020).  Clears numSelected/selected/selected2 first (remembering
 * whether a selection existed), then destroys rows in reverse order: each
 * node's fields are destructed (0x100368e0: FString reset + ~FString), the
 * fields array is emptied (FArray::Empty) and destructed (~FArray), and the
 * node itself is freed through GMalloc->Free.  The rows array is then
 * emptied.  When a selection existed the selection broadcast 0x100331a0 runs
 * before AskParentForReconfigure 0x1004e060; the method's leftover EAX is the
 * broadcast return value, or 0 when no broadcast ran.
 */
import {
  LIST_FIELD,
  LIST_ROW,
  LIST_WINDOW,
  LIST_WINDOW_DLL,
  askParentReconfigure,
  broadcastSelection,
  farrayDtor,
  farrayEmpty,
  fieldDtor,
  fieldRangeDtor,
  listMemory,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_DELETE_ALL_ROWS_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.DeleteAllRows',
  packageExport: 1576,
  nativeIndex: 1733,
  functionFlags: 0x401,
  serialSize: 27,
  ...LIST_WINDOW_DLL,
  execBody: 0x100344a0,
  execEnd: 0x100344af,
  execSha256: '86bbe9854114156218ca05640bfccb6bdd9ca1bd07f5303cc78686c47275cf7d',
  methodBody: 0x1002f020,
  methodEnd: 0x1002f164,
  methodSha256: 'c5f22394b55c79bfa89be16454740cfb31f82b5c7508cfff4fb11dcdc3e8fead',
});

export class ListWindowDeleteAllRowsBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowDeleteAllRowsBoundaryError';
    this.code = `LIST_DELETE_ALL_ROWS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowDeleteAllRowsBoundaryError(message, details);
};

export function listWindowDeleteAllRows(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.DeleteAllRows requires a canonical window object',
      {kind: 'REFERENCE', value: object});
  const L = listMemory(object, services);
  const wasSelected = L.read(L.base + LIST_WINDOW.numSelected, 'i32') > 0 ? 1 : 0;
  L.write(L.base + LIST_WINDOW.numSelected, 'i32', 0);
  L.write(L.base + LIST_WINDOW.selected, 'u32', 0);
  L.write(L.base + LIST_WINDOW.selected2, 'u32', 0);
  const rows = L.base + LIST_WINDOW.rowsData;
  const count = L.read(rows + 4, 'i32');
  for (let i = count - 1; i >= 0; i--) {
    const node = L.read(L.read(rows, 'u32') + 4 * i, 'u32');
    if (!node) continue;
    const fields = node + LIST_ROW.fieldsData;
    const fdata = L.read(fields, 'u32');
    const fcount = L.read(fields + 4, 'i32');
    for (let j = 0; j < fcount; j++) fieldDtor(L, fdata + j * LIST_FIELD.size);
    farrayEmpty(L, fields, LIST_FIELD.size, 0);
    fieldRangeDtor(L, fields, 0, L.read(fields + 4, 'i32'));
    farrayDtor(L, fields);
    L.free(node);
  }
  farrayEmpty(L, rows, 4, 0);
  const result = wasSelected ? broadcastSelection(L) : 0;
  askParentReconfigure(L);
  return result;
}

export const execListWindowDeleteAllRows = listWindowDeleteAllRows;
