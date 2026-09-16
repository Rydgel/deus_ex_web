/**
 * Recovered Extension.dll XEditWindow::Paste translation (exec body
 * 0x10022a30 -> method 0x1001e020 -> paste core 0x1001e6b0(1, 0)).  No
 * args.  Calls the InsertText virtual with the process-global clipboard
 * text (clipboard.data when num != 0, else the shared L""), bKeepUndo=1,
 * bExtend=0.  An empty clipboard still reaches the virtual's
 * replaceSelection path per the filterText empty-input rule.
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  pasteEdit,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_PASTE_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.Paste',
  packageExport: 967,
  nativeIndex: 1917,
  functionFlags: 0x401,
  serialSize: 27,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10022a30,
  execEnd: 0x10022a3f,
  execSha256: '5783ca117fa9c386c39deb6578c9be3be5b7a36fdce61a476d50e8f681d17c15',
  methodBody: 0x1001e020,
  methodEnd: 0x1001e092,
  methodSha256: '111e010f586eb3b8a87f5a00e8ffa130c24a0cd2e205e0d4095cb4903e364101',
});

export class EditWindowPasteBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowPasteBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowPasteBoundaryError(message);
};

export function editWindowPaste(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.Paste requires a canonical window object');
  }
  const L = editMemory(object, services);
  pasteEdit(L, 1, 0);
}

export const execEditWindowPaste = editWindowPaste;
