/**
 * Recovered Extension.dll XEditWindow::EnableEditing translation
 * (method body 0x1001d600, exec stub 0x10021db0).
 *
 * The method is a single unconditional store:
 *   flags = (flags ^ ((flags ^ arg) & 1)) — i.e. bit0 of +0x1d0 takes the low
 *   bit of the argument, every other bit preserved.  There is no unchanged
 *   early-out: the store always executes.  The exec body marshals the bool
 *   argument through the params reader (stack slot preset to 1) then calls the
 *   method.  The export is void.
 */
import {
  EDIT_FLAGS,
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_ENABLE_EDITING_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.EnableEditing',
  packageExport: 1141,
  nativeIndex: 1885,
  functionFlags: 0x401,
  serialSize: 31,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021db0,
  execEnd: 0x10021df6,
  execSha256: 'd23b12fe36a89ca77b884e9de04fb32f11806d048ed7f4853c2ef68e4e4d357f',
  methodBody: 0x1001d600,
  methodEnd: 0x1001d61e,
  methodSha256: '85f6fdab310a8e063b4bbba5057917af87eaaf939d87299139bedd9ce03840cc',
});

export class EditWindowEnableEditingBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowEnableEditingBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowEnableEditingBoundaryError(message);
};

export function editWindowEnableEditing(object, bEdit, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.EnableEditing requires a canonical window object');
  }
  if (typeof bEdit !== 'number' || !Number.isInteger(bEdit)) {
    fail('EditWindow.EnableEditing requires an integer flag');
  }
  const L = editMemory(object, services);
  const arg = bEdit | 0;
  const flags = L.read(L.base + EDIT_WINDOW.flags, 'u32');
  const next = (flags ^ ((flags ^ arg) & EDIT_FLAGS.editing)) >>> 0;
  L.write(L.base + EDIT_WINDOW.flags, 'u32', next);
}

export const execEditWindowEnableEditing = editWindowEnableEditing;
