/**
 * Recovered Extension.dll TextWindow.SetMinWidth translation (native 1562,
 * exec body 0x100472d0, method 0x100463b0).
 *
 * Exec reads one f32 dword; method 0x100463b0 normalizes
 * the arg through `fcomp +0.0f` — below-zero OR unordered (NaN) becomes
 * +0.0f — then writes +0x164 + reconfigures iff the stored field is not
 * equal-or-unordered to the normalized arg (a stored NaN permanently
 * suppresses writes).
 */
import {
  TEXT_WINDOW_DLL,
  f32Bits,
  setMinWidthMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_SET_MIN_WIDTH_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.SetMinWidth',
  packageExport: 1061,
  nativeIndex: 1562,
  functionFlags: 0x401,
  serialSize: 30,
  ...TEXT_WINDOW_DLL,
  execBody: 0x100472d0,
  execEnd: 0x10047316,
  execSha256: '123fa6f64b875df1cf5fc1754b5fc38782834a9803266bd78950529f6b6223f5',
  methodBody: 0x100463b0,
  methodEnd: 0x10046420,
  methodSha256: '421b9f809b18155a0df0716b6b16356e03e246c9bc4fef182a311a94627eb763',
});

export class TextWindowSetMinWidthBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowSetMinWidthBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowSetMinWidthBoundaryError(message);
};

export function textWindowSetMinWidth(object, newMinWidth, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.SetMinWidth requires a canonical window object');
  if (typeof newMinWidth !== 'number')
    fail('TextWindow.SetMinWidth requires a float newMinWidth');
  const L = textMemory(object, services);
  setMinWidthMethod(L, f32Bits(newMinWidth));
}

export const execTextWindowSetMinWidth = textWindowSetMinWidth;
