/**
 * Recovered Extension.dll XEditWindow::IsEditingEnabled translation (exec body
 * 0x10021e20 — the function has no separate method body; the inline exec body
 * bumps the frame code pointer, reads this+0x1d0, masks bit0, and stores it
 * through the out pointer).  Returns the editing-enabled bit.
 */
import {
  EDIT_FLAGS,
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_IS_EDITING_ENABLED_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.IsEditingEnabled',
  packageExport: 1150,
  nativeIndex: 1886,
  functionFlags: 0x401,
  serialSize: 28,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021e20,
  execEnd: 0x10021e3d,
  execSha256: '6655e853882767d584916b6274e1d35e06d91428626f763cbca728ded2666d24',
});

export class EditWindowIsEditingEnabledBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowIsEditingEnabledBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowIsEditingEnabledBoundaryError(message);
};

export function editWindowIsEditingEnabled(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.IsEditingEnabled requires a canonical window object');
  }
  const L = editMemory(object, services);
  return L.read(L.base + EDIT_WINDOW.flags, 'u32') & EDIT_FLAGS.editing;
}

export const execEditWindowIsEditingEnabled = editWindowIsEditingEnabled;
