/**
 * Recovered Extension.dll UGC::GetTileColor translation (native 1231,
 * inline getter exec body 0x1002b4b0; there is no method body).
 *
 * The exec body clears GPropAddr, evaluates the out struct param, then
 * stores the +0x54 dword through GPropAddr (or the local slot when the
 * eval left GPropAddr null).  The translation returns the stored dword.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_GET_TILE_COLOR_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.GetTileColor',
  packageExport: 2041,
  nativeIndex: 1231,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002b4b0,
  execEnd: 0x1002b502,
  execSha256: '4c68985dd2a321b5fdadff056f52bfe381b0ca33442728aa259968fed5e45d23',
  methodBody: null,
  methodEnd: null,
  methodSha256: null,
});

export class GcGetTileColorBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcGetTileColorBoundaryError';
    this.code = `GC_GET_TILE_COLOR_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcGetTileColorBoundaryError(message, details);
};

export function gcGetTileColor(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.GetTileColor requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return L.read(L.base + GC.tileColor, 'u32');
}

export const execGcGetTileColor = gcGetTileColor;
