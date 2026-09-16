/**
 * Recovered Extension.dll XEditWindow::SetSelectedAreaTextColor
 * translation (method body 0x1001dc30, exec stub 0x10022650).
 *
 * One raw dword store: the packed colour goes to +0x1fc.  The exec
 * body's default colour is three zeroed bytes; its fourth byte is left
 * undefined (the local reuses the saved-this stack slot), so the colour
 * reaches the method verbatim as marshalled.  The export is void.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_SELECTED_AREA_TEXT_COLOR_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetSelectedAreaTextColor',
  packageExport: 1308,
  nativeIndex: 1908,
  functionFlags: 0x401,
  serialSize: 31,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10022650,
  execEnd: 0x100226a4,
  execSha256: '93cb81a45c539cc6f50b46156e8e560af4a1f8625e7aedb7d0fbc5938316cafa',
  methodBody: 0x1001dc30,
  methodEnd: 0x1001dc3d,
  methodSha256: '72ddd121e9c6cee13dc37071e58004ad170e7c7d89326cb7c445d38ceaa7e1fa',
});

export class EditWindowSetSelectedAreaTextColorBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetSelectedAreaTextColorBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetSelectedAreaTextColorBoundaryError(message);
};

export function editWindowSetSelectedAreaTextColor(object, newColor, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetSelectedAreaTextColor requires a canonical window object');
  }
  const L = editMemory(object, services);
  L.write(L.base + EDIT_WINDOW.selTextColor, 'u32', newColor | 0);
}

export const execEditWindowSetSelectedAreaTextColor = editWindowSetSelectedAreaTextColor;
