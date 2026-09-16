/**
 * Recovered Extension.dll UGC::GetTextColor translation (native 1241,
 * inline getter exec body 0x1002b590; there is no method body).
 *
 * The exec body clears GPropAddr, evaluates the out struct param, then
 * stores the +0x68 dword through GPropAddr (or the local slot when the
 * eval left GPropAddr null).  The translation returns the stored dword.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_GET_TEXT_COLOR_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.GetTextColor',
  packageExport: 2045,
  nativeIndex: 1241,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002b590,
  execEnd: 0x1002b5e2,
  execSha256: 'f0326c95841abae4489bc04362f8a0c2c9c180c934f9c913447d437b2427e558',
  methodBody: null,
  methodEnd: null,
  methodSha256: null,
});

export class GcGetTextColorBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcGetTextColorBoundaryError';
    this.code = `GC_GET_TEXT_COLOR_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcGetTextColorBoundaryError(message, details);
};

export function gcGetTextColor(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.GetTextColor requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return L.read(L.base + GC.textColor, 'u32');
}

export const execGcGetTextColor = gcGetTextColor;
