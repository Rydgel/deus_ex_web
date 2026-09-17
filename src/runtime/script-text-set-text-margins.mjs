/**
 * Recovered Extension.dll TextWindow.SetTextMargins translation (native 1557,
 * exec body 0x100470a0, method 0x10046070).
 *
 * Exec marshals two f32 dwords, eats the result byte,
 * calls 0x10046070.  The method runs x87 fcomp on both margins: the write +
 * reconfigure is skipped iff hMargin equals-or-is-unordered with the h arg
 * AND vMargin equals-or-is-unordered with the v arg — a NaN in either slot
 * makes its compare "equal"; a NaN ARG still stores when the other margin
 * differs.
 */
import {
  TEXT_WINDOW_DLL,
  f32Bits,
  setTextMarginsMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_SET_TEXT_MARGINS_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.SetTextMargins',
  packageExport: 1122,
  nativeIndex: 1557,
  functionFlags: 0x401,
  serialSize: 34,
  ...TEXT_WINDOW_DLL,
  execBody: 0x100470a0,
  execEnd: 0x1004710f,
  execSha256: '77e34c75deba84a484ee009b51ebdea378824d6c142a0017262f999c867fe2b5',
  methodBody: 0x10046070,
  methodEnd: 0x100460e2,
  methodSha256: '8496a3ce40e7c1f0d7edd521d0821139a36d2ca58a3ec7cb0373bacc94b24f53',
});

export class TextWindowSetTextMarginsBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowSetTextMarginsBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowSetTextMarginsBoundaryError(message);
};

export function textWindowSetTextMargins(object, newHMargin, newVMargin, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.SetTextMargins requires a canonical window object');
  if (typeof newHMargin !== 'number')
    fail('TextWindow.SetTextMargins requires a float newHMargin');
  if (typeof newVMargin !== 'number')
    fail('TextWindow.SetTextMargins requires a float newVMargin');
  const L = textMemory(object, services);
  setTextMarginsMethod(L, f32Bits(newHMargin), f32Bits(newVMargin));
}

export const execTextWindowSetTextMargins = textWindowSetTextMargins;
