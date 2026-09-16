/**
 * Recovered Extension.dll XEditWindow::SetEditCursor translation
 * (method body 0x1001dc40, exec stub 0x100226d0).
 *
 * Three raw dword stores: cursor object to +0x200, cursor-shadow object
 * to +0x204, packed colour to +0x208.  The exec body's default colour is
 * three 0xff bytes; its fourth byte is left undefined (the local reuses
 * the incoming Stack argument slot).  Cursor/colour arguments are opaque
 * dwords here.  The export is void.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_EDIT_CURSOR_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetEditCursor',
  packageExport: 1321,
  nativeIndex: 1909,
  functionFlags: 0x401,
  serialSize: 37,
  ...EDIT_WINDOW_DLL,
  execBody: 0x100226d0,
  execEnd: 0x1002277a,
  execSha256: '93c363f0226c28f78b5f91f7f08e7d7b7cf99177778911d519953c3f24c2f64f',
  methodBody: 0x1001dc40,
  methodEnd: 0x1001dc61,
  methodSha256: 'f8179b73678ea88bca7e2c6422bb3c044f3a194ab77c8251dffd99957732e2ba',
});

export class EditWindowSetEditCursorBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetEditCursorBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetEditCursorBoundaryError(message);
};

export function editWindowSetEditCursor(object, newCursor, newCursorShadow, newColor, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetEditCursor requires a canonical window object');
  }
  const L = editMemory(object, services);
  L.write(L.base + EDIT_WINDOW.cursor0, 'u32', newCursor | 0);
  L.write(L.base + EDIT_WINDOW.cursor1, 'u32', newCursorShadow | 0);
  L.write(L.base + EDIT_WINDOW.cursor2, 'u32', newColor | 0);
}

export const execEditWindowSetEditCursor = editWindowSetEditCursor;
