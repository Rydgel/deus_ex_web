/**
 * Recovered Extension.dll XEditWindow::Redo translation (exec body
 * 0x10022970 -> method 0x1001e170).  No args.  When undoPos <=
 * undoNum - 1 the method selects [rec.pos, rec.pos + rec.oldLen), sets ip
 * = rec.pos, advances undoPos, and replaces that range with the record's
 * new text through replaceSelection(newText, 0, 1).
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  redoEdit,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_REDO_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.Redo',
  packageExport: 963,
  nativeIndex: 1911,
  functionFlags: 0x401,
  serialSize: 27,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10022970,
  execEnd: 0x1002297f,
  execSha256: '387096e9d07fe204a25c065c0a3cf5cff53c6418175ead4c4115bf02de6e1b3e',
  methodBody: 0x1001e170,
  methodEnd: 0x1001e254,
  methodSha256: '85f2a7a40d6da1860314a927e0dd5eea8f1aec2aafc5c71cfa4fdc39c2bcb27f',
});

export class EditWindowRedoBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowRedoBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowRedoBoundaryError(message);
};

export function editWindowRedo(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.Redo requires a canonical window object');
  }
  const L = editMemory(object, services);
  redoEdit(L);
}

export const execEditWindowRedo = editWindowRedo;
