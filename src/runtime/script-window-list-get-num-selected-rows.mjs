/**
 * Recovered Extension.dll XListWindow::GetNumSelectedRows translation.
 *
 * The registered native (index 1741) executes inline: it reads the selected
 * row count cached at this+0x1a8 into the int result.  See
 * docs/script-window-list.md.
 */
import {
  LIST_WINDOW,
  LIST_WINDOW_DLL,
  listMemory,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_GETNUMSELECTEDROWS_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.GetNumSelectedRows',
  packageExport: 1595,
  nativeIndex: 1741,
  functionFlags: 0x401,
  serialSize: 28,
  ...LIST_WINDOW_DLL,
  execBody: 0x10034950,
  execEnd: 0x1003496a,
  execSha256: '2f1fe2d2660abab2943c60720f9c67ef157eefe0f8c03646e275d685576abdf6',
});

export class ListWindowGetNumSelectedRowsBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowGetNumSelectedRowsBoundaryError';
    this.code = `LIST_GETNUMSELECTEDROWS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowGetNumSelectedRowsBoundaryError(message, details);
};

export function listWindowGetNumSelectedRows(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.GetNumSelectedRows requires a canonical window object', {kind: 'REFERENCE', value: object});
  const {base, read} = listMemory(object, services);
  return read(base + LIST_WINDOW.numSelected, 'i32');
}

export const execListWindowGetNumSelectedRows = listWindowGetNumSelectedRows;
