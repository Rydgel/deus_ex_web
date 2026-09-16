/**
 * Recovered Extension.dll XEditWindow::IsSingleLineEditingEnabled translation
 * (exec body 0x10021ed0 — inline execInt: bumps the frame code pointer, reads
 * this+0x1d0, shifts right 1, masks bit0, stores through the out pointer).
 * Returns the single-line-editing bit.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_IS_SINGLE_LINE_EDITING_ENABLED_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.IsSingleLineEditingEnabled',
  packageExport: 1163,
  nativeIndex: 1888,
  functionFlags: 0x401,
  serialSize: 28,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021ed0,
  execEnd: 0x10021eef,
  execSha256: '4555db1090b104bb50ac400c94dfffe3ef99833821c19f381d35d6d631aec6b6',
});

export class EditWindowIsSingleLineEditingEnabledBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowIsSingleLineEditingEnabledBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowIsSingleLineEditingEnabledBoundaryError(message);
};

export function editWindowIsSingleLineEditingEnabled(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.IsSingleLineEditingEnabled requires a canonical window object');
  }
  const L = editMemory(object, services);
  return (L.read(L.base + EDIT_WINDOW.flags, 'u32') >>> 1) & 1;
}

export const execEditWindowIsSingleLineEditingEnabled = editWindowIsSingleLineEditingEnabled;
