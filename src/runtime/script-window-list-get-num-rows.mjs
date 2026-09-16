/**
 * Recovered Extension.dll XListWindow::GetNumRows translation.
 *
 * The registered native (index 1740) executes inline: it reads the rows
 * TArray count at this+0x174 into the int result.  See
 * docs/script-window-list.md.
 */
import {
  LIST_WINDOW,
  LIST_WINDOW_DLL,
  listMemory,
  rejectAsync,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_GETNUMROWS_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.GetNumRows',
  packageExport: 1593,
  nativeIndex: 1740,
  functionFlags: 0x401,
  serialSize: 28,
  ...LIST_WINDOW_DLL,
  execBody: 0x10034910,
  execEnd: 0x1003492a,
  execSha256: 'bb613876938cb74bc6cc3e37b747c742f4c5629d107630f375092e707b75f0d3',
});

export class ListWindowGetNumRowsBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowGetNumRowsBoundaryError';
    this.code = `LIST_GETNUMROWS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowGetNumRowsBoundaryError(message, details);
};

export function listWindowGetNumRows(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.GetNumRows requires a canonical window object', {kind: 'REFERENCE', value: object});
  const {base, read} = listMemory(object, services);
  return read(base + LIST_WINDOW.rowsCount, 'i32');
}

export const execListWindowGetNumRows = listWindowGetNumRows;
