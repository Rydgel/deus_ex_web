/**
 * Recovered Extension.dll XEditWindow::Undo translation (exec body
 * 0x10022940 -> method 0x1001e0a0).  No args.  When undoPos > 0 the
 * method decrements it, restores selection = [rec.pos, rec.pos +
 * rec.newLen) and ip = rec.pos, then replaces that range with the
 * record's old text through replaceSelection(oldText, 0, 1).
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  undoEdit,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_UNDO_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.Undo',
  packageExport: 962,
  nativeIndex: 1910,
  functionFlags: 0x401,
  serialSize: 27,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10022940,
  execEnd: 0x1002294f,
  execSha256: '6a25673fa1a85db641e422b46ae32d0af2ca8ee06ef9191d11eb13ebeb194cf3',
  methodBody: 0x1001e0a0,
  methodEnd: 0x1001e16f,
  methodSha256: '041f7d9676cd6388b9f47cd0a9c9ec2a0229957564227aa432cdbb0bd5daaf2f',
});

export class EditWindowUndoBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowUndoBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowUndoBoundaryError(message);
};

export function editWindowUndo(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.Undo requires a canonical window object');
  }
  const L = editMemory(object, services);
  undoEdit(L);
}

export const execEditWindowUndo = editWindowUndo;
