/**
 * Recovered Extension.dll XEditWindow::SetInsertionPoint translation (exec
 * body 0x10021b90 -> method 0x1001d4a0 -> setInsertionPoint core
 * 0x1001f140).  The exec body extracts (newPos, bDrag) and calls the
 * method; the method clamps the position to [0, textLen], moves the
 * insertion point (anchor follows when not extending), recomputes the
 * selection, resets the blink counter, and repaints the caret.
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  setInsertionPointEntry,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_INSERTION_POINT_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetInsertionPoint',
  packageExport: 1071,
  nativeIndex: 1881,
  functionFlags: 0x401,
  serialSize: 34,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021b90,
  execEnd: 0x10021bff,
  execSha256: 'f24bcd7978c2d7f8306d2578a78505cb0c71f92e2a2f7dc4e6b1f4f7bfda34a8',
  methodBody: 0x1001d4a0,
  methodEnd: 0x1001d518,
  methodSha256: 'fb8a59a48e19726b6575c39f29e1a230d9f6d4cb8cd53414d7d70b635d51a548',
});

export class EditWindowSetInsertionPointBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetInsertionPointBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetInsertionPointBoundaryError(message);
};

export function editWindowSetInsertionPoint(object, newPos, bDrag, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetInsertionPoint requires a canonical window object');
  }
  const L = editMemory(object, services);
  setInsertionPointEntry(L, newPos | 0, bDrag | 0);
}

export const execEditWindowSetInsertionPoint = editWindowSetInsertionPoint;
