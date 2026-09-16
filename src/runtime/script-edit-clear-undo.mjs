/**
 * Recovered Extension.dll XEditWindow::ClearUndo translation (exec body
 * 0x100229a0 -> method 0x1001ddf0).  No args.  saved = (undoPos != saved)
 * ? -1 : 0; undoPos = 0; every record's two FStrings go through the
 * per-record destroy sequence and the array is emptied.
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  clearUndo,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_CLEAR_UNDO_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.ClearUndo',
  packageExport: 964,
  nativeIndex: 1912,
  functionFlags: 0x401,
  serialSize: 27,
  ...EDIT_WINDOW_DLL,
  execBody: 0x100229a0,
  execEnd: 0x100229af,
  execSha256: 'e305ab4004156b61b5afc676e4d7dcb5b58a732515e99e2285102665d1a552d1',
  methodBody: 0x1001ddf0,
  methodEnd: 0x1001df18,
  methodSha256: '7a6c5bf30f06c9fb5fa86b48681a1ba1c76fa875eda61c94c83df386e9c349f2',
});

export class EditWindowClearUndoBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowClearUndoBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowClearUndoBoundaryError(message);
};

export function editWindowClearUndo(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.ClearUndo requires a canonical window object');
  }
  const L = editMemory(object, services);
  clearUndo(L);
}

export const execEditWindowClearUndo = editWindowClearUndo;
