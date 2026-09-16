/**
 * Recovered Extension.dll XEditWindow::SetMaxUndos translation (method body
 * 0x1001da60, exec stub 0x100220e0).
 *
 * Negative arguments clamp to -1 (unlimited) via `or eax, -1`.  The clamped
 * value is compared against +0x22c — equal returns with no store and no trim.
 * Otherwise the value is stored and trimUndo (0x10020290) runs: while the
 * undo TArray holds more records than the limit it destroys the oldest
 * records (Empty/reset/destructor sequence per record), FArray::Removes them,
 * then shifts undoPos and savedUndoPos down, clamping undoPos at 0 and
 * savedUndoPos at -1.  The export is void.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
  trimUndo,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_MAX_UNDOS_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetMaxUndos',
  packageExport: 933,
  nativeIndex: 1896,
  functionFlags: 0x401,
  serialSize: 31,
  ...EDIT_WINDOW_DLL,
  execBody: 0x100220e0,
  execEnd: 0x10022126,
  execSha256: '022d30912675b0ca70c72b4e399a45b62a84407ccb92b1de6381229c24797571',
  methodBody: 0x1001da60,
  methodEnd: 0x1001dae8,
  methodSha256: '61973b1f5c852b2db58849a2f9e12e01f11a0d0e357134f8444350b5a858d00b',
});

export class EditWindowSetMaxUndosBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetMaxUndosBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetMaxUndosBoundaryError(message);
};

export function editWindowSetMaxUndos(object, newMaxUndos, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetMaxUndos requires a canonical window object');
  }
  if (typeof newMaxUndos !== 'number' || !Number.isInteger(newMaxUndos)) {
    fail('EditWindow.SetMaxUndos requires an integer count');
  }
  const L = editMemory(object, services);
  let n = newMaxUndos | 0;
  if (n < 0) n = -1;
  if (L.read(L.base + EDIT_WINDOW.maxUndos, 'i32') === n) return;
  L.write(L.base + EDIT_WINDOW.maxUndos, 'i32', n);
  trimUndo(L);
}

export const execEditWindowSetMaxUndos = editWindowSetMaxUndos;
