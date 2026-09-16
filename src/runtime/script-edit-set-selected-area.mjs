/**
 * Recovered Extension.dll XEditWindow::SetSelectedArea translation (exec
 * body 0x10021c60 -> method 0x1001d520).  The method clears the
 * word-select state bit (+0x244 &= ~4), moves the insertion point to
 * startPos without extending, then extends it to startPos + Count.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
  setInsertionPointCore,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_SELECTED_AREA_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetSelectedArea',
  packageExport: 1024,
  nativeIndex: 1883,
  functionFlags: 0x401,
  serialSize: 34,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021c60,
  execEnd: 0x10021ccf,
  execSha256: 'ba5cb744c4ee6e161402e70280c4360b2b1aa614e79689e32d5a93536065dc44',
  methodBody: 0x1001d520,
  methodEnd: 0x1001d5b6,
  methodSha256: '87d300f9f39163e50d45bb93012ec756d506d14ba38024c079f867fd66027f2b',
});

export class EditWindowSetSelectedAreaBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetSelectedAreaBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetSelectedAreaBoundaryError(message);
};

export function editWindowSetSelectedArea(object, startPos, count, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetSelectedArea requires a canonical window object');
  }
  const L = editMemory(object, services);
  // 0x1001d546-0x1001d559: stateFlags &= ~EDIT_STATE.wordSelect.
  L.write(L.base + EDIT_WINDOW.stateFlags, 'i32',
    L.read(L.base + EDIT_WINDOW.stateFlags, 'i32') & ~4);
  // 0x1001d54c-0x1001d55f: setInsertionPointCore(start, 0).
  setInsertionPointCore(L, startPos | 0, 0);
  // 0x1001d564-0x1001d56e: setInsertionPointCore(start + Count, 1).
  setInsertionPointCore(L, (startPos | 0) + (count | 0), 1);
}

export const execEditWindowSetSelectedArea = editWindowSetSelectedArea;
