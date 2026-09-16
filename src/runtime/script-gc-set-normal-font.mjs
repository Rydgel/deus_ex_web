/**
 * Recovered Extension.dll UGC::SetNormalFont translation (native 1243,
 * method body 0x10027660, exec trampoline 0x1002b730).
 *
 * The method stores the font pointer dword at +0x7c (normalFont).  The
 * exec body marshals the object param through GNatives.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_NORMAL_FONT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetNormalFont',
  packageExport: 2049,
  nativeIndex: 1243,
  functionFlags: 0x401,
  serialSize: 30,
  ...GC_DLL,
  execBody: 0x1002b730,
  execEnd: 0x1002b776,
  execSha256: 'e6294099604e479b0672de2690ff4d5f74b8b488fcf0129a033dd0dd661f93a2',
  methodBody: 0x10027660,
  methodEnd: 0x1002766a,
  methodSha256: 'b27d1bfb53e7b26c3cf2b46195a6161888624e5b0a5cc3eb89c0bc4c64635aa8',
});

export class GcSetNormalFontBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetNormalFontBoundaryError';
    this.code = `GC_SET_NORMAL_FONT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetNormalFontBoundaryError(message, details);
};

export function gcSetNormalFont(object, newNormalFont, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetNormalFont requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newNormalFont !== 'number' || !Number.isInteger(newNormalFont))
    fail('GC.SetNormalFont requires an integer font pointer', {kind: 'VALUE', value: newNormalFont});
  const L = gcMemory(object, services);
  L.write(L.base + GC.normalFont, 'u32', newNormalFont >>> 0);
}

export const execGcSetNormalFont = gcSetNormalFont;
