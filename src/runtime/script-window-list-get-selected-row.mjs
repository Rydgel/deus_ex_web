/**
 * Recovered Extension.dll XListWindow::GetSelectedRow translation (body
 * 0x1002f740).  Returns the cached selection node at this+0x1ac when it is
 * still flagged selected (node+4 bit0); otherwise scans the rows TArray for
 * the first node with the selection flag and returns it, or 0 when none.
 */
import {
  LIST_ROW,
  LIST_WINDOW,
  LIST_WINDOW_DLL,
  listMemory,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_GET_SELECTED_ROW_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.GetSelectedRow',
  packageExport: 1612,
  nativeIndex: 1747,
  functionFlags: 0x401,
  serialSize: 28,
  ...LIST_WINDOW_DLL,
  execBody: 0x10034c60,
  execEnd: 0x10034c75,
  execSha256: '78eb625592b873da22f9694e728aeba9f5e81e48617d2999b47981a2af3ecc9f',
  methodBody: 0x1002f740,
  methodEnd: 0x1002f78e,
  methodSha256: '3814d40feff847dcc1473792f7dbc8f08ecae3965877d0f81aa24bf8d0d51243',
});

export class ListWindowGetSelectedRowBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowGetSelectedRowBoundaryError';
    this.code = `LIST_GET_SELECTED_ROW_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowGetSelectedRowBoundaryError(message, details);
};

export function listWindowGetSelectedRow(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.GetSelectedRow requires a canonical window object', {kind: 'REFERENCE', value: object});
  const {base, read} = listMemory(object, services);
  const cached = read(base + LIST_WINDOW.selected, 'u32');
  if (cached !== 0 && (read(cached + LIST_ROW.flags, 'u8') & 1)) return cached;
  const count = read(base + LIST_WINDOW.rowsCount, 'i32');
  const rdata = read(base + LIST_WINDOW.rowsData, 'u32');
  for (let index = 0; index < count; index++) {
    const node = read(rdata + 4 * index, 'u32');
    if (read(node + LIST_ROW.flags, 'u8') & 1) return node;
  }
  return 0;
}

export const execListWindowGetSelectedRow = listWindowGetSelectedRow;
