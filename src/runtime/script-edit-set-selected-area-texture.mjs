/**
 * Recovered Extension.dll XEditWindow::SetSelectedAreaTexture translation
 * (method body 0x1001dc10, exec stub 0x100225b0).
 *
 * Two raw dword stores — texture object to +0x1f4, packed colour to
 * +0x1f8 — with no caret update.  The exec body's default colour is
 * three 0xc0 bytes; its fourth byte is left undefined (the local reuses
 * the incoming Stack argument slot).  Texture/colour arguments are
 * opaque dwords here.  The export is void.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_SELECTED_AREA_TEXTURE_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetSelectedAreaTexture',
  packageExport: 953,
  nativeIndex: 1907,
  functionFlags: 0x401,
  serialSize: 34,
  ...EDIT_WINDOW_DLL,
  execBody: 0x100225b0,
  execEnd: 0x1002262d,
  execSha256: '22c8f131676f6043f717a2251f15d824ba58fbd26279a659f11ea8eb51c125eb',
  methodBody: 0x1001dc10,
  methodEnd: 0x1001dc27,
  methodSha256: 'adef155d0fd25ebd74c18f04284370c753623365780069ff5ad414c82b0abc56',
});

export class EditWindowSetSelectedAreaTextureBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetSelectedAreaTextureBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetSelectedAreaTextureBoundaryError(message);
};

export function editWindowSetSelectedAreaTexture(object, newTexture, newColor, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetSelectedAreaTexture requires a canonical window object');
  }
  const L = editMemory(object, services);
  L.write(L.base + EDIT_WINDOW.selTexture, 'u32', newTexture | 0);
  L.write(L.base + EDIT_WINDOW.selColor, 'u32', newColor | 0);
}

export const execEditWindowSetSelectedAreaTexture = editWindowSetSelectedAreaTexture;
