/**
 * Recovered Extension.dll XListWindow::SetColumnType translation (body
 * 0x10030480).
 *
 * The column index is validated (0x10033240).  The newFmt argument reaches
 * the body as a wide-string pointer: a null pointer selects the default
 * format for the type ("%f" for type 1, "%02h:%02m" for type 2, the shared
 * empty wstring otherwise) while any other pointer — including one to an
 * empty string — is used verbatim.  The low byte of the type is stored, the
 * column format FString is reassigned (the native self-assign guard compares
 * format.data to the format pointer and cannot fire for marshaled strings),
 * and when acquireContext returns a context every row's field at the column
 * is re-copied through the 0x1000-wchar field-copy buffer, re-parsed by
 * setFieldText 0x10031af0, and re-measured by measureField 0x10031e60 before
 * the context is released.  Flag bit1 then runs the auto-expand driver
 * 0x1002fc40.  The export is void.
 */
import {
  LIST_WINDOW,
  LIST_COL,
  LIST_ROW,
  LIST_FIELD,
  LIST_FLAGS,
  LIST_WINDOW_DLL,
  acquireContext,
  autoExpandColumns,
  colIndexValid,
  fieldText,
  fstringAssign,
  listMemory,
  measureField,
  releaseContext,
  setFieldText,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

const LIST_FIELD_COPY_CAP = 0x1000;   // wcsncpy bound on 0x100a380c

export const WINDOW_LIST_SET_COLUMN_TYPE_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.SetColumnType',
  packageExport: 1666,
  nativeIndex: 1775,
  functionFlags: 0x401,
  serialSize: 37,
  ...LIST_WINDOW_DLL,
  execBody: 0x10035790,
  execEnd: 0x10035932,
  execSha256: 'b128adfa30ed2e98f46397ffc74c409bce3ee10e682c3588040e7e5cb5d1e9c2',
  methodBody: 0x10030480,
  methodEnd: 0x100306e6,
  methodSha256: 'db9d2ca2224a86cea924ca5c1751d9c85bf69c0fcab9a8532018e4fc68c17bc3',
});

export class ListWindowSetColumnTypeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowSetColumnTypeBoundaryError';
    this.code = `LIST_SET_COLUMN_TYPE_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowSetColumnTypeBoundaryError(message, details);
};

export function listWindowSetColumnType(object, colIndex, newType, newFmt, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.SetColumnType requires a canonical window object',
      {kind: 'REFERENCE', value: object});
  if (typeof colIndex !== 'number' || !Number.isInteger(colIndex))
    fail('ListWindow.SetColumnType requires an integer column index',
      {kind: 'VALUE', value: colIndex});
  if (typeof newType !== 'number' || !Number.isInteger(newType))
    fail('ListWindow.SetColumnType requires an integer type',
      {kind: 'VALUE', value: newType});
  if (newFmt != null && newFmt !== 0 && typeof newFmt !== 'string')
    fail('ListWindow.SetColumnType requires the marshaled format string or null',
      {kind: 'VALUE', value: newFmt});
  const L = listMemory(object, services);
  const col = colIndex | 0;
  if (!colIndexValid(L, col)) return;
  const type = newType & 0xff;
  // The body receives a pointer: null/0 selects the per-type default, any
  // other pointer (including one to "") is used verbatim.
  let fmt = newFmt;
  if (fmt == null || fmt === 0)
    fmt = type === 1 ? '%f' : type === 2 ? '%02h:%02m' : '';
  const colPtr = L.read(L.base + LIST_WINDOW.colsData, 'u32') + col * LIST_COL.size;
  L.write(colPtr + LIST_COL.type, 'u8', type);
  fstringAssign(L, colPtr + LIST_COL.format, fmt);
  const ctx = acquireContext(L);
  if (ctx) {
    const count = L.read(L.base + LIST_WINDOW.rowsCount, 'i32');
    const rdata = L.read(L.base + LIST_WINDOW.rowsData, 'u32');
    for (let i = 0; i < count; i++) {
      const node = L.read(rdata + 4 * i, 'u32');
      const field = L.read(node + LIST_ROW.fieldsData, 'u32') + col * LIST_FIELD.size;
      // wcsncpy(0x100a380c, text, 0x1000): truncation to the copy bound; a
      // longer field would read past the buffer — outside observed usage.
      const token = fieldText(L, field).slice(0, LIST_FIELD_COPY_CAP);
      setFieldText(L, node, col, token);
      measureField(L, ctx, node, col);
    }
    releaseContext(L, ctx);
  }
  if (L.read(L.base + LIST_WINDOW.flags, 'u32') & LIST_FLAGS.autoExpand)
    autoExpandColumns(L, 1);
}

export const execListWindowSetColumnType = listWindowSetColumnType;
