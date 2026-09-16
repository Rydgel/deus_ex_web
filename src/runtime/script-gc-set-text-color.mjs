/**
 * Recovered Extension.dll UGC::SetTextColor translation (native 1240,
 * method body 0x10027580, exec trampoline 0x1002b530).
 *
 * Same shape as SetTileColor on the text fields: +0x68 = Color dword,
 * +0x6c = f32(byte0*K), +0x70 = f32(byte1*K), +0x74 = f32(byte2*K),
 * +0x78 = 0, where K is the f64 at 0x1005e3c0 (1/255).  The exec body
 * marshals the struct param as one dword.
 */
import {GC, GC_DLL, gcColorChannel, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_TEXT_COLOR_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetTextColor',
  packageExport: 2043,
  nativeIndex: 1240,
  functionFlags: 0x401,
  serialSize: 30,
  ...GC_DLL,
  execBody: 0x1002b530,
  execEnd: 0x1002b56c,
  execSha256: '4b4d882105e96ccc10ac5067b3248de075d36f763b2c9b801321439acc709f7f',
  methodBody: 0x10027580,
  methodEnd: 0x10027604,
  methodSha256: '701d17cb1c23d8dd728e607816b3c535ebc646d44e022b7f4a1d77c9b3d807a0',
});

export class GcSetTextColorBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetTextColorBoundaryError';
    this.code = `GC_SET_TEXT_COLOR_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetTextColorBoundaryError(message, details);
};

export function gcSetTextColor(object, newTextColor, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetTextColor requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newTextColor !== 'number' || !Number.isInteger(newTextColor))
    fail('GC.SetTextColor requires an integer color', {kind: 'VALUE', value: newTextColor});
  const L = gcMemory(object, services);
  const color = newTextColor >>> 0;
  L.write(L.base + GC.textColor, 'u32', color);
  L.write(L.base + GC.textFloats + 0, 'f32', gcColorChannel(color));
  L.write(L.base + GC.textFloats + 4, 'f32', gcColorChannel(color >>> 8));
  L.write(L.base + GC.textFloats + 8, 'f32', gcColorChannel(color >>> 16));
  L.write(L.base + GC.textFloats + 12, 'u32', 0);
}

export const execGcSetTextColor = gcSetTextColor;
