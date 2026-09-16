/**
 * Recovered Extension.dll UGC::SetFonts translation (native 1245, method
 * body 0x10027640, exec trampoline 0x1002b810).
 *
 * The method stores arg1 (newNormalFont) at +0x7c and arg2 (newBoldFont)
 * at +0x80 — the same body SetFont tail-calls with (font, font).  The exec
 * body marshals two object params through GNatives.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_FONTS_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetFonts',
  packageExport: 2053,
  nativeIndex: 1245,
  functionFlags: 0x401,
  serialSize: 33,
  ...GC_DLL,
  execBody: 0x1002b810,
  execEnd: 0x1002b87f,
  execSha256: '1baedee3d5f8dfa66a94d4acb280c6f8cdc2f79520beed95cf2449cb16a65684',
  methodBody: 0x10027640,
  methodEnd: 0x10027654,
  methodSha256: '7ce05c25dd00d30022780c045313059e9faf9037610d53bcb431c3eade92c2de',
});

export class GcSetFontsBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetFontsBoundaryError';
    this.code = `GC_SET_FONTS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetFontsBoundaryError(message, details);
};

export function gcSetFonts(object, newNormalFont, newBoldFont, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetFonts requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newNormalFont !== 'number' || !Number.isInteger(newNormalFont)
      || typeof newBoldFont !== 'number' || !Number.isInteger(newBoldFont))
    fail('GC.SetFonts requires integer font pointers', {kind: 'VALUE'});
  const L = gcMemory(object, services);
  L.write(L.base + GC.normalFont, 'u32', newNormalFont >>> 0);
  L.write(L.base + GC.boldFont, 'u32', newBoldFont >>> 0);
}

export const execGcSetFonts = gcSetFonts;
