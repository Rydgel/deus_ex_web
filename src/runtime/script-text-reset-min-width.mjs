/**
 * Recovered Extension.dll TextWindow.ResetMinWidth translation (native 1563,
 * exec body 0x10047340, method 0x10046450).
 *
 * Exec eats the result byte and calls 0x10046450.  The
 * method writes +0.0f and reconfigures only when the stored minWidth is
 * strictly greater than 0 ordered — zero, negative, and NaN fields skip.
 */
import {
  TEXT_WINDOW_DLL,
  resetMinWidthMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_RESET_MIN_WIDTH_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.ResetMinWidth',
  packageExport: 1094,
  nativeIndex: 1563,
  functionFlags: 0x401,
  serialSize: 26,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10047340,
  execEnd: 0x1004734f,
  execSha256: 'd169d72cc2bea36c337047941cd3de21363b0bd27f9abd368d4a8ab95896072d',
  methodBody: 0x10046450,
  methodEnd: 0x100464ab,
  methodSha256: 'b06f2b587d2efb0920b852b09e6e7209a6ab1d1f0f8208a6b8c25008fb25fece',
});

export class TextWindowResetMinWidthBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowResetMinWidthBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowResetMinWidthBoundaryError(message);
};

export function textWindowResetMinWidth(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.ResetMinWidth requires a canonical window object');
  const L = textMemory(object, services);
  resetMinWidthMethod(L);
}

export const execTextWindowResetMinWidth = textWindowResetMinWidth;
