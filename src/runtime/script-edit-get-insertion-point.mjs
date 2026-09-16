/**
 * Recovered Extension.dll XEditWindow::GetInsertionPoint translation (exec
 * body 0x10021c20 — the function has no separate method body; the inline
 * exec body bumps the frame code pointer, reads this+0x1d4, and stores it
 * through the out pointer).  Returns the insertion-point index.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_GET_INSERTION_POINT_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.GetInsertionPoint',
  packageExport: 1097,
  nativeIndex: 1882,
  functionFlags: 0x401,
  serialSize: 28,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021c20,
  execEnd: 0x10021c3a,
  execSha256: 'b72f8614381d0f5c2a99dc6144f01d8ee080b15c5b219b2f7a52ce6f7c7e7ae3',
});

export class EditWindowGetInsertionPointBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowGetInsertionPointBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowGetInsertionPointBoundaryError(message);
};

export function editWindowGetInsertionPoint(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.GetInsertionPoint requires a canonical window object');
  }
  const L = editMemory(object, services);
  return L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32');
}

export const execEditWindowGetInsertionPoint = editWindowGetInsertionPoint;
