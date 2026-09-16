/**
 * Recovered Extension.dll UGC::GetFontHeight translation (native 1281,
 * method body 0x10027d60, exec trampoline 0x1002c210).
 *
 * The method reads the space glyph (codepoint 0x20) of the GC's fonts through
 * the shared lookup 0x10026880 and keeps the VSize (+0xc i32):
 *
 *   local = 0
 *   if normalFont: if 0 < normalSpaceVSize -> local = normalSpaceVSize
 *   if boldFont:   if local < boldSpaceVSize -> local = boldSpaceVSize
 *   if bIncludeSpace: local += textVSpacing (+0x90 f32)
 *   return local as f32 (x87 fstp by the exec)
 *
 * The compares are x87 fcomp C0 tests (`test ah,1`): the normal-font store
 * fires when 0.0 < height, the bold store when local < height; glyph metrics
 * are i32 so unordered is unreachable.  The vSpacing add is a single 80-bit
 * fadd stored once — Math.fround of the exact f64 sum is bit-identical for
 * every reachable input.
 *
 * `gcGetFontHeightMethod` models the method body; `gcGetFontHeight` is the
 * exec-level behaviour (bIncludeSpace marshalled int → tested nonzero).
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';
import {uFontGlyph} from './script-font-model.mjs';

const freeze = Object.freeze;

export const GC_GET_FONT_HEIGHT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.GetFontHeight',
  packageExport: 2103,
  nativeIndex: 1281,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002c210,
  execEnd: 0x1002c25c,
  execSha256: '46f1e18caec554fde929301383da88025d15f135e7af44562aacc2477e3700f7',
  methodBody: 0x10027d60,
  methodEnd: 0x10027e44,
  methodSha256: 'c3c524a7ef64f34bdcc30fdb6e05a56a3164bbee138e3c7ebb7bdd9280e63567',
});

export class GcGetFontHeightBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcGetFontHeightBoundaryError';
    this.code = `GC_GET_FONT_HEIGHT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcGetFontHeightBoundaryError(message, details);
};

export function gcGetFontHeightMethod(object, bIncludeSpace, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.GetFontHeight requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  let height = 0;
  const normal = L.read(L.base + GC.normalFont, 'u32');
  if (normal !== 0) {
    const spaceH = uFontGlyph(L, normal, 0x20).vSize;
    if (spaceH > 0) height = spaceH;
  }
  const bold = L.read(L.base + GC.boldFont, 'u32');
  if (bold !== 0) {
    const spaceH = uFontGlyph(L, bold, 0x20).vSize;
    if (!(height >= spaceH)) height = spaceH;
  }
  if (bIncludeSpace)
    height = Math.fround(height + L.read(L.base + GC.textVSpacing, 'f32'));
  return Math.fround(height);
}

export function gcGetFontHeight(object, bIncludeSpace, services = {}) {
  return gcGetFontHeightMethod(object, bIncludeSpace, services);
}

export const execGcGetFontHeight = gcGetFontHeight;
