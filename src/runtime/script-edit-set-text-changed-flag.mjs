/**
 * Recovered Extension.dll XEditWindow::SetTextChangedFlag translation
 * (method body 0x1001ddc0, exec stub 0x10021fb0).
 *
 * A two-way store into +0x230 (savedUndoPos): a nonzero argument stores -1
 * (the "dirty" sentinel, always != undoPos), zero stores the current undoPos
 * (+0x228).  The export is void.
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  setTextChangedFlag,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_TEXT_CHANGED_FLAG_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetTextChangedFlag',
  packageExport: 1195,
  nativeIndex: 1891,
  functionFlags: 0x401,
  serialSize: 31,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021fb0,
  execEnd: 0x10021ff6,
  execSha256: '2abc421502137813d9a066b8ec85524e6815d9532f9b2d60b1d0f27fb992dfe6',
  methodBody: 0x1001ddc0,
  methodEnd: 0x1001dde4,
  methodSha256: '7743a83a5f07a479b0ed5989920a71ed6bc6002a55c7556dbbfb90b9740386f4',
});

export class EditWindowSetTextChangedFlagBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetTextChangedFlagBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetTextChangedFlagBoundaryError(message);
};

export function editWindowSetTextChangedFlag(object, bSet, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetTextChangedFlag requires a canonical window object');
  }
  if (typeof bSet !== 'number' || !Number.isInteger(bSet)) {
    fail('EditWindow.SetTextChangedFlag requires an integer flag');
  }
  const L = editMemory(object, services);
  setTextChangedFlag(L, bSet | 0);
}

export const execEditWindowSetTextChangedFlag = editWindowSetTextChangedFlag;
