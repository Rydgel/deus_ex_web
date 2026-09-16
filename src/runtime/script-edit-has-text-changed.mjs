/**
 * Recovered Extension.dll XEditWindow::HasTextChanged translation (exec body
 * 0x10022020 — inline execInt: bumps the frame code pointer, compares
 * this+0x228 (undoPos) against this+0x230 (savedUndoPos), and stores the
 * setne result through the out pointer).  Note the body's EAX at `ret` is
 * the out pointer itself, not the boolean — the oracle keeps it as evidence.
 * Returns 1 when the undo position differs from the saved marker.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_HAS_TEXT_CHANGED_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.HasTextChanged',
  packageExport: 1199,
  nativeIndex: 1892,
  functionFlags: 0x401,
  serialSize: 28,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10022020,
  execEnd: 0x10022049,
  execSha256: '38403e19ab6e8eef2f3044a000c2b742b68908e4098c3bc7ac28e56c2974428a',
});

export class EditWindowHasTextChangedBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowHasTextChangedBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowHasTextChangedBoundaryError(message);
};

export function editWindowHasTextChanged(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.HasTextChanged requires a canonical window object');
  }
  const L = editMemory(object, services);
  return L.read(L.base + EDIT_WINDOW.undoPos, 'i32')
    !== L.read(L.base + EDIT_WINDOW.savedUndoPos, 'i32') ? 1 : 0;
}

export const execEditWindowHasTextChanged = editWindowHasTextChanged;
