/**
 * Recovered Extension.dll XListWindow::Sort translation (body 0x10030c10).
 *
 * The export body is a thin call to the sort driver 0x100329b0: rebuild the
 * sort-column list, run the real MSVCRT qsort over the rows pointer array
 * when count > 1, then renumber row ids.  The export is void; EAX leftovers
 * are unobservable through UnrealScript.
 */
import {
  LIST_WINDOW_DLL,
  listMemory,
  sortRows,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_SORT_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.Sort',
  packageExport: 1691,
  nativeIndex: 1784,
  functionFlags: 0x401,
  serialSize: 27,
  ...LIST_WINDOW_DLL,
  execBody: 0x10035d30,
  execEnd: 0x10035d3f,
  execSha256: '0ba5d3b423de56ffce1c9e232edb8cd4c662405b55208b819b2bfb3b79431d88',
  methodBody: 0x10030c10,
  methodEnd: 0x10030c7e,
  methodSha256: '842e6012882fcd3c8608841f18276083740cfc011ff0a2e3c960fb312d0cae7b',
});

export class ListWindowSortBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowSortBoundaryError';
    this.code = `LIST_SORT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowSortBoundaryError(message, details);
};

export function listWindowSort(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.Sort requires a canonical window object',
      {kind: 'REFERENCE', value: object});
  sortRows(listMemory(object, services));
}

export const execListWindowSort = listWindowSort;
