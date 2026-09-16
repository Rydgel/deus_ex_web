/**
 * Recovered Extension.dll XEditWindow::ClearTextChangedFlag translation
 * (method body 0x1001dd50, exec stub 0x10021f80).
 *
 * The method is an SEH-protected tail call into SetTextChangedFlag(0)
 * (0x1001ddc0), which stores this+0x230 (savedUndoPos) = this+0x228
 * (undoPos).  The export is void.
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  setTextChangedFlag,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_CLEAR_TEXT_CHANGED_FLAG_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.ClearTextChangedFlag',
  packageExport: 1197,
  nativeIndex: 1890,
  functionFlags: 0x401,
  serialSize: 27,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021f80,
  execEnd: 0x10021f8f,
  execSha256: '4a5d1d5e84cbdd618f239695a1a3fa2b33390685ebb4b7e9974ebfb72016598c',
  methodBody: 0x1001dd50,
  methodEnd: 0x1001ddc0,
  methodSha256: '944aec82b7f6960e93937cdeaa7ec01f67c0063d8559fe800f3baaba5d941cb0',
});

export class EditWindowClearTextChangedFlagBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowClearTextChangedFlagBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowClearTextChangedFlagBoundaryError(message);
};

export function editWindowClearTextChangedFlag(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.ClearTextChangedFlag requires a canonical window object');
  }
  const L = editMemory(object, services);
  setTextChangedFlag(L, 0);
}

export const execEditWindowClearTextChangedFlag = editWindowClearTextChangedFlag;
