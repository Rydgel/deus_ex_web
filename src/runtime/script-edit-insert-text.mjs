/**
 * Recovered Extension.dll XEditWindow::InsertText translation (exec body
 * 0x10022150 -> convertPipes 0x10050710 -> vtable +0x124, InsertText
 * virtual 0x1001e3c0).  The exec marshals the script string into a temp
 * FString, runs convertPipes on it, invokes the virtual with
 * (converted, bUndo, bSelect) — the ints default to 0 — and stores the
 * virtual's EAX into the bool result slot.
 *
 * The JS entry mirrors the marshalling boundary: `textPtr` is the
 * materialized wchar string (the VM-side temp FString lifecycle is not
 * modelled — it is exec-level plumbing, not method behavior).
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  convertPipes,
  insertTextVirtual,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_INSERT_TEXT_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.InsertText',
  packageExport: 935,
  nativeIndex: 1900,
  functionFlags: 0x401,
  serialSize: 37,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10022150,
  execEnd: 0x100222f9,
  execSha256: '7ba70856a2720a420d86323374d0e35dc4d062d70aebe4e09e00e12bd7bdf06b',
  methodBody: 0x1001e3c0,
  methodEnd: 0x1001e552,
  methodSha256: 'bfd4b736e7409bf6e701e767915c79c84f065deeff13b11529cf43cf71142e74',
});

export class EditWindowInsertTextBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowInsertTextBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowInsertTextBoundaryError(message);
};

export function editWindowInsertText(object, textPtr, bUndo, bSelect, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.InsertText requires a canonical window object');
  }
  const L = editMemory(object, services);
  const converted = convertPipes(L, textPtr);
  return insertTextVirtual(L, converted, bUndo | 0, bSelect | 0);
}

export const execEditWindowInsertText = editWindowInsertText;
