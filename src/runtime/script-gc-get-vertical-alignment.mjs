/**
 * Recovered Extension.dll UGC::GetVerticalAlignment translation (native
 * 1255, inline getter exec body 0x1002bbd0; there is no method body).
 *
 * The exec body loads the byte at +0x95 and stores it through the result
 * pointer.  The export returns a byte.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_GET_VERTICAL_ALIGNMENT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.GetVerticalAlignment',
  packageExport: 2073,
  nativeIndex: 1255,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002bbd0,
  execEnd: 0x1002bbea,
  execSha256: '71f29c7fb3ad2651094b643a4bed6d1301c35d46b3d225100c6e7c0d63c3ec52',
  methodBody: null,
  methodEnd: null,
  methodSha256: null,
});

export class GcGetVerticalAlignmentBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcGetVerticalAlignmentBoundaryError';
    this.code = `GC_GET_VERTICAL_ALIGNMENT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcGetVerticalAlignmentBoundaryError(message, details);
};

export function gcGetVerticalAlignment(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.GetVerticalAlignment requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return L.read(L.base + GC.vAlign, 'u8');
}

export const execGcGetVerticalAlignment = gcGetVerticalAlignment;
