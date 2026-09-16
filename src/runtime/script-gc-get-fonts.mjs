/**
 * Recovered Extension.dll UGC::GetFonts translation (native 1246, inline
 * getter exec body 0x1002b8a0; there is no method body).
 *
 * The exec body clears GPropAddr, evaluates the first out object param,
 * captures GPropAddr (or the local slot), clears it again, evaluates the
 * second out param, then stores +0x7c through the first out pointer and
 * +0x80 through the second when each is non-null.  The translation returns
 * both raw pointer dwords.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_GET_FONTS_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.GetFonts',
  packageExport: 2056,
  nativeIndex: 1246,
  functionFlags: 0x401,
  serialSize: 34,
  ...GC_DLL,
  execBody: 0x1002b8a0,
  execEnd: 0x1002b94c,
  execSha256: 'b1a81b2f5132454246ee7223f24c804c211346eaa7a81f59f9d0e5a108ed033a',
  methodBody: null,
  methodEnd: null,
  methodSha256: null,
});

export class GcGetFontsBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcGetFontsBoundaryError';
    this.code = `GC_GET_FONTS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcGetFontsBoundaryError(message, details);
};

export function gcGetFonts(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.GetFonts requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return {
    normalFont: L.read(L.base + GC.normalFont, 'u32'),
    boldFont: L.read(L.base + GC.boldFont, 'u32'),
  };
}

export const execGcGetFonts = gcGetFonts;
