/**
 * Recovered Extension.dll XEditWindow::SetInsertionPointType translation
 * (method body 0x1001db80, exec stub 0x100224f0).
 *
 * The exec body masks the newType argument with 0xff (`and eax,0xff`);
 * the method then stores it as a byte at +0x1dc, the two float arguments
 * as raw f32 dwords at +0x258/+0x25c, and runs updateCaret(0) (leaf
 * event).  The export is void.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
  updateCaret,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_INSERTION_POINT_TYPE_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetInsertionPointType',
  packageExport: 1257,
  nativeIndex: 1906,
  functionFlags: 0x401,
  serialSize: 37,
  ...EDIT_WINDOW_DLL,
  execBody: 0x100224f0,
  execEnd: 0x1002258e,
  execSha256: 'fd8bca29f60b8d79ad90f1fa6d190cbc13d6e59dba96a64c4f40869f24fb2793',
  methodBody: 0x1001db80,
  methodEnd: 0x1001dc0d,
  methodSha256: '257ae7d098a7a176d4b14ab6075499205608d92b8d6625d93fdb32a09e21ce2b',
});

export class EditWindowSetInsertionPointTypeBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetInsertionPointTypeBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetInsertionPointTypeBoundaryError(message);
};

export function editWindowSetInsertionPointType(object, newType, prefWidth, prefHeight, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetInsertionPointType requires a canonical window object');
  }
  const L = editMemory(object, services);
  L.write(L.base + EDIT_WINDOW.ipType, 'u8', newType & 0xff);
  L.write(L.base + EDIT_WINDOW.prefWidth, 'f32', prefWidth);
  L.write(L.base + EDIT_WINDOW.prefHeight, 'f32', prefHeight);
  updateCaret(L, 0);
}

export const execEditWindowSetInsertionPointType = editWindowSetInsertionPointType;
