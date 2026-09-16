/**
 * Recovered Extension.dll XEditWindow::GetSelectedArea translation (exec
 * body 0x10021cf0 -> method 0x1001d5c0).  The exec marshals two out-int
 * parameters through GPropAddr with a local scratch fallback; the method
 * writes start = max(selStart, 0) and size = max(selEnd - selStart, 0)
 * (size is computed from the RAW selStart before clamping), each through
 * a NULL-guarded out pointer.
 *
 * The JS entry has no out-pointer concept: it returns {start, length}
 * directly, matching what the script caller observes.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_GET_SELECTED_AREA_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.GetSelectedArea',
  packageExport: 1035,
  nativeIndex: 1884,
  functionFlags: 0x401,
  serialSize: 34,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021cf0,
  execEnd: 0x10021d90,
  execSha256: '982a8d6501985dd8a49105b5c8bac05099f04e3c5f5b10e850226219edf889c8',
  methodBody: 0x1001d5c0,
  methodEnd: 0x1001d5f1,
  methodSha256: '9757e9cf0ef0c475af8c655b93974ca1a17187215fd67128fc44ccd7d11e3d9f',
});

export class EditWindowGetSelectedAreaBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowGetSelectedAreaBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowGetSelectedAreaBoundaryError(message);
};

export function editWindowGetSelectedArea(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.GetSelectedArea requires a canonical window object');
  }
  const L = editMemory(object, services);
  // 0x1001d5c0: edx = selStart; eax = selEnd - selStart (raw); clamps.
  const selStart = L.read(L.base + EDIT_WINDOW.selStart, 'i32');
  const selEnd = L.read(L.base + EDIT_WINDOW.selEnd, 'i32');
  let start = selStart;
  let size = (selEnd - selStart) | 0;
  if (start < 0) start = 0;
  if (size < 0) size = 0;
  return {start, length: size};
}

export const execEditWindowGetSelectedArea = editWindowGetSelectedArea;
