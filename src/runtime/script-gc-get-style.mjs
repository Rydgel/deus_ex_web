/**
 * Recovered Extension.dll UGC::GetStyle translation (native 1213,
 * inline getter exec body 0x1002b150; there is no method body).
 *
 * The exec body loads the style byte at +0x44 and stores it as a byte
 * through the result pointer.  The export returns a byte.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_GET_STYLE_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.GetStyle',
  packageExport: 2021,
  nativeIndex: 1213,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002b150,
  execEnd: 0x1002b167,
  execSha256: '2df513064d8e96ec79c75e726ca3e74c56f6ce632943146e9f13c219429f0d51',
  methodBody: null,
  methodEnd: null,
  methodSha256: null,
});

export class GcGetStyleBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcGetStyleBoundaryError';
    this.code = `GC_GET_STYLE_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcGetStyleBoundaryError(message, details);
};

export function gcGetStyle(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.GetStyle requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return L.read(L.base + GC.style, 'u8');
}

export const execGcGetStyle = gcGetStyle;
