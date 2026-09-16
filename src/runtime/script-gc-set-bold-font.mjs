/**
 * Recovered Extension.dll UGC::SetBoldFont translation (native 1244,
 * method body 0x10027670, exec trampoline 0x1002b7a0).
 *
 * The method stores the font pointer dword at +0x80 (boldFont).  The
 * exec body marshals the object param through GNatives.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_BOLD_FONT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetBoldFont',
  packageExport: 2051,
  nativeIndex: 1244,
  functionFlags: 0x401,
  serialSize: 30,
  ...GC_DLL,
  execBody: 0x1002b7a0,
  execEnd: 0x1002b7e6,
  execSha256: '110b5b74fcf29ed0c3bdd5c4a2ddeaa1594939debbbf5d2354e5d31f8b507597',
  methodBody: 0x10027670,
  methodEnd: 0x1002767d,
  methodSha256: 'fe59297b4c5ab98695333ed43c909cc10cb5d3430e3e6a2ebee9aa41f4b418ab',
});

export class GcSetBoldFontBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetBoldFontBoundaryError';
    this.code = `GC_SET_BOLD_FONT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetBoldFontBoundaryError(message, details);
};

export function gcSetBoldFont(object, newBoldFont, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetBoldFont requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newBoldFont !== 'number' || !Number.isInteger(newBoldFont))
    fail('GC.SetBoldFont requires an integer font pointer', {kind: 'VALUE', value: newBoldFont});
  const L = gcMemory(object, services);
  L.write(L.base + GC.boldFont, 'u32', newBoldFont >>> 0);
}

export const execGcSetBoldFont = gcSetBoldFont;
