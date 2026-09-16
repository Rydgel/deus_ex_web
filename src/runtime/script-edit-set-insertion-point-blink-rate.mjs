/**
 * Recovered Extension.dll XEditWindow::SetInsertionPointBlinkRate translation
 * (method body 0x1001d960, exec stub 0x100223c0).
 *
 * Two raw dword stores: the first stack argument goes to +0x23c (blink
 * start), the second to +0x240 (blink period).  Both are float bits as
 * marshalled by the exec body.  The export is void.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_INSERTION_POINT_BLINK_RATE_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetInsertionPointBlinkRate',
  packageExport: 1249,
  nativeIndex: 1902,
  functionFlags: 0x401,
  serialSize: 34,
  ...EDIT_WINDOW_DLL,
  execBody: 0x100223c0,
  execEnd: 0x1002242f,
  execSha256: '27671e7250dd5559ae65c6839131d23f2f280ffe64dca605d1a0ee8ef70afdbc',
  methodBody: 0x1001d960,
  methodEnd: 0x1001d977,
  methodSha256: '57e06896854192f45e5bf6e17a92ee3d9fe77bfa30f8c191bee8183eb34726b5',
});

export class EditWindowSetInsertionPointBlinkRateBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetInsertionPointBlinkRateBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetInsertionPointBlinkRateBoundaryError(message);
};

export function editWindowSetInsertionPointBlinkRate(object, blinkStart, blinkPeriod, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetInsertionPointBlinkRate requires a canonical window object');
  }
  if (typeof blinkStart !== 'number' || typeof blinkPeriod !== 'number') {
    fail('EditWindow.SetInsertionPointBlinkRate requires float arguments');
  }
  const L = editMemory(object, services);
  L.write(L.base + EDIT_WINDOW.blinkOn, 'f32', blinkStart);
  L.write(L.base + EDIT_WINDOW.blinkOff, 'f32', blinkPeriod);
}

export const execEditWindowSetInsertionPointBlinkRate = editWindowSetInsertionPointBlinkRate;
