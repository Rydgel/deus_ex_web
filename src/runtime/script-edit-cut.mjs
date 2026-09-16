/**
 * Recovered Extension.dll XEditWindow::Cut translation (exec body
 * 0x10022a00 -> method 0x1001dfa0 -> copyOrCut core 0x1001e5f0(1, 1)).
 * No args.  Copies the selection into the process-global clipboard then
 * runs the DeleteChar virtual with (bBackspace=0, bKeepUndo=1).
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  copyOrCut,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_CUT_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.Cut',
  packageExport: 966,
  nativeIndex: 1916,
  functionFlags: 0x401,
  serialSize: 27,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10022a00,
  execEnd: 0x10022a0f,
  execSha256: '0ca6ece5698c536a087054c2a43b9a4c6d8a9f67e97e5b88746e30cdcc58121b',
  methodBody: 0x1001dfa0,
  methodEnd: 0x1001e012,
  methodSha256: '5e9e9a817d2edba29c20c33635ac14b9bf69e24582617896fad84ffddd7f7635',
});

export class EditWindowCutBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowCutBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowCutBoundaryError(message);
};

export function editWindowCut(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.Cut requires a canonical window object');
  }
  const L = editMemory(object, services);
  copyOrCut(L, 1, 1);
}

export const execEditWindowCut = editWindowCut;
