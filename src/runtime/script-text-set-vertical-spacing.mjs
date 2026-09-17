/**
 * Recovered Extension.dll LargeTextWindow.SetVerticalSpacing translation (native 1860,
 * exec body 0x1002e7b0, method 0x1002d7e0).
 *
 * Exec prefills the local with 1.0f (0x3f800000 —
 * the default), reads the f32 dword, eats the result byte, calls
 * 0x1002d7e0.  The method normalizes the arg through `fcomp +0.0f`
 * (negative or NaN -> +0.0f), then writes +0x174 + reconfigures iff the
 * stored field is not equal-or-unordered.
 */
import {
  TEXT_WINDOW_DLL,
  f32Bits,
  setVerticalSpacingMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_SET_VERTICAL_SPACING_NATIVE = freeze({
  package: 'Extension',
  function: 'LargeTextWindow.SetVerticalSpacing',
  packageExport: 950,
  nativeIndex: 1860,
  functionFlags: 0x401,
  serialSize: 31,
  ...TEXT_WINDOW_DLL,
  execBody: 0x1002e7b0,
  execEnd: 0x1002e7f6,
  execSha256: '3a6fe3103dbb7606443cb07e64879690a9d327041d0821c857d4c53233c3c0f4',
  methodBody: 0x1002d7e0,
  methodEnd: 0x1002d850,
  methodSha256: '36a4f4c70ebd90701d818721fe863b7fd9e3723a56305da6ae3bc2149c8c9b25',
});

export class LargeTextWindowSetVerticalSpacingBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LargeTextWindowSetVerticalSpacingBoundaryError';
  }
}

const fail = message => {
  throw new LargeTextWindowSetVerticalSpacingBoundaryError(message);
};

export function largeTextWindowSetVerticalSpacing(object, newVSpace, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('LargeTextWindow.SetVerticalSpacing requires a canonical window object');
  if (typeof newVSpace !== 'number')
    fail('LargeTextWindow.SetVerticalSpacing requires a float newVSpace');
  const L = textMemory(object, services);
  setVerticalSpacingMethod(L, f32Bits(newVSpace));
}

export const execLargeTextWindowSetVerticalSpacing = largeTextWindowSetVerticalSpacing;
