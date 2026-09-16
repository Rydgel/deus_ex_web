/**
 * Recovered Extension.dll UGC::SetTileColor translation (native 1230,
 * method body 0x100274f0, exec trampoline 0x1002b450).
 *
 * The method stores the Color dword at +0x54, then per channel
 * fild(byteN) * fmul(qword [0x1005e3c0]) (the 1/255 f64 constant) stored by
 * fstp f32: +0x58 = f32(byte0*K), +0x5c = f32(byte1*K), +0x60 =
 * f32(byte2*K), +0x64 = 0.  The x87 product is exact in the 64-bit
 * extended mantissa; Math.fround(byte * GC_COLOR_SCALE) reproduces it for
 * all 256 byte values (verified exhaustively), so no extended-precision
 * emulation is needed.  The exec body marshals the struct param as one
 * dword.
 */
import {GC, GC_DLL, gcColorChannel, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_TILE_COLOR_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetTileColor',
  packageExport: 2039,
  nativeIndex: 1230,
  functionFlags: 0x401,
  serialSize: 30,
  ...GC_DLL,
  execBody: 0x1002b450,
  execEnd: 0x1002b48c,
  execSha256: '8dd00d67b2c38bcfded31bf9564465720cda54d5e3c0a299ac362a960f00c102',
  methodBody: 0x100274f0,
  methodEnd: 0x10027574,
  methodSha256: '1c13dd8c6d93be627a7f1fca6476c998c534000d81b500425076d4d59919c8c6',
});

export class GcSetTileColorBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetTileColorBoundaryError';
    this.code = `GC_SET_TILE_COLOR_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetTileColorBoundaryError(message, details);
};

export function gcSetTileColor(object, newTileColor, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetTileColor requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newTileColor !== 'number' || !Number.isInteger(newTileColor))
    fail('GC.SetTileColor requires an integer color', {kind: 'VALUE', value: newTileColor});
  const L = gcMemory(object, services);
  const color = newTileColor >>> 0;
  L.write(L.base + GC.tileColor, 'u32', color);
  L.write(L.base + GC.tileFloats + 0, 'f32', gcColorChannel(color));
  L.write(L.base + GC.tileFloats + 4, 'f32', gcColorChannel(color >>> 8));
  L.write(L.base + GC.tileFloats + 8, 'f32', gcColorChannel(color >>> 16));
  L.write(L.base + GC.tileFloats + 12, 'u32', 0);
}

export const execGcSetTileColor = gcSetTileColor;
