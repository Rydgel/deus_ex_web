/**
 * Recovered Extension.dll XEditWindow::SetMaxSize translation (method body
 * 0x1001d980, exec stub 0x10022070).
 *
 * An unchanged value returns immediately.  Otherwise the new limit is stored
 * at +0x1e8; non-positive limits and texts already within the limit return
 * early.  When the text is longer the body selects the tail (selStart = n,
 * selEnd = insertionPoint = len) and invokes the virtual InsertText(+0x124)
 * with (NULL, 0, 0): filterText accepts the empty input (the binary rule
 * inputLen <= 0 -> 1), InsertText clears the undo stack and marks the text
 * changed, and replaceSelection's len > maxSize branch removes the tail and
 * reconfigures.  The body finishes with SetInsertionPoint(0, 0) via the
 * 0x1001d4a0 entry.  The export is void.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
  insertTextVirtual,
  setInsertionPointEntry,
  textLen,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_MAX_SIZE_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetMaxSize',
  packageExport: 931,
  nativeIndex: 1895,
  functionFlags: 0x401,
  serialSize: 31,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10022070,
  execEnd: 0x100220b6,
  execSha256: '64e4d49d998b5a096cbab4e2dd225b5404dba6489a617818171f41ec750454fb',
  methodBody: 0x1001d980,
  methodEnd: 0x1001da53,
  methodSha256: '25fea65b255ba4c7288d35b80f3dcb938cdd4a0b49efe2fe6f9f0ef8bb2718a0',
});

export class EditWindowSetMaxSizeBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetMaxSizeBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetMaxSizeBoundaryError(message);
};

export function editWindowSetMaxSize(object, newMaxSize, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetMaxSize requires a canonical window object');
  }
  if (typeof newMaxSize !== 'number' || !Number.isInteger(newMaxSize)) {
    fail('EditWindow.SetMaxSize requires an integer size');
  }
  const L = editMemory(object, services);
  const n = newMaxSize | 0;
  if (L.read(L.base + EDIT_WINDOW.maxSize, 'i32') === n) return;
  L.write(L.base + EDIT_WINDOW.maxSize, 'i32', n);
  if (n <= 0) return;
  const len = textLen(L);
  if (len <= n) return;
  L.write(L.base + EDIT_WINDOW.selStart, 'i32', n);
  L.write(L.base + EDIT_WINDOW.selEnd, 'i32', len);
  L.write(L.base + EDIT_WINDOW.insertionPoint, 'i32', len);
  insertTextVirtual(L, 0, 0, 0);
  setInsertionPointEntry(L, 0, 0);
}

export const execEditWindowSetMaxSize = editWindowSetMaxSize;
