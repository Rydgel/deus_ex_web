/**
 * Recovered Extension.dll XEditWindow::DeleteChar translation (exec body
 * 0x10022320 -> vtable +0x128, DeleteChar virtual 0x1001e560 -> core
 * 0x100201d0).  The exec marshals (bBefore, bUndo) with int defaults 0.
 * The virtual clears undo history and marks the text changed when
 * bUndo == 0 — before the deletion attempt, so a backspace at position 0
 * still clears history.
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  deleteCharVirtual,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_DELETE_CHAR_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.DeleteChar',
  packageExport: 1254,
  nativeIndex: 1901,
  functionFlags: 0x401,
  serialSize: 34,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10022320,
  execEnd: 0x10022392,
  execSha256: '92902ad525f5835f207cac1aaadf1897fe7c50df2c590111b1f13867057738cf',
  methodBody: 0x1001e560,
  methodEnd: 0x1001e5ee,
  methodSha256: 'c736fba7330c0dbed773c0a494b0ffff9279f41427b9cfa6fd61235dc2a2dc93',
});

export class EditWindowDeleteCharBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowDeleteCharBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowDeleteCharBoundaryError(message);
};

export function editWindowDeleteChar(object, bBefore, bUndo, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.DeleteChar requires a canonical window object');
  }
  const L = editMemory(object, services);
  deleteCharVirtual(L, bBefore | 0, bUndo | 0);
}

export const execEditWindowDeleteChar = editWindowDeleteChar;
