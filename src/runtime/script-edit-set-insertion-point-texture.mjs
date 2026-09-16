/**
 * Recovered Extension.dll XEditWindow::SetInsertionPointTexture translation
 * (method body 0x1001daf0, exec stub 0x10022450).
 *
 * Two raw dword stores: the texture object goes to +0x1ec, the packed
 * colour to +0x1f0, then updateCaret(0) runs (leaf event).  The exec
 * body builds the default colour as three 0xff bytes; its fourth byte is
 * left undefined (the local reuses the incoming Stack argument slot), so
 * the colour reaches the method verbatim as marshalled.  Texture/colour
 * arguments are opaque dwords here.  The export is void.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
  updateCaret,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_INSERTION_POINT_TEXTURE_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetInsertionPointTexture',
  packageExport: 1276,
  nativeIndex: 1905,
  functionFlags: 0x401,
  serialSize: 34,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10022450,
  execEnd: 0x100224cd,
  execSha256: '590e2cb0f2808e853c357881d7731682491f1ab6d8b866380a20aa75cb03f529',
  methodBody: 0x1001daf0,
  methodEnd: 0x1001db74,
  methodSha256: 'b299f5a2a04de0c02f4af60db0a0eef2aa44335e511e7c429ca3ab0198b4ac01',
});

export class EditWindowSetInsertionPointTextureBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetInsertionPointTextureBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetInsertionPointTextureBoundaryError(message);
};

export function editWindowSetInsertionPointTexture(object, newTexture, newColor, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetInsertionPointTexture requires a canonical window object');
  }
  const L = editMemory(object, services);
  L.write(L.base + EDIT_WINDOW.ipTexture, 'u32', newTexture | 0);
  L.write(L.base + EDIT_WINDOW.ipColor, 'u32', newColor | 0);
  updateCaret(L, 0);
}

export const execEditWindowSetInsertionPointTexture = editWindowSetInsertionPointTexture;
