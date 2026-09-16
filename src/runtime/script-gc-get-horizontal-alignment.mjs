/**
 * Recovered Extension.dll UGC::GetHorizontalAlignment translation (native
 * 1253, inline getter exec body 0x1002bb20; there is no method body).
 *
 * The exec body loads the byte at +0x94 and stores it through the result
 * pointer.  The export returns a byte.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_GET_HORIZONTAL_ALIGNMENT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.GetHorizontalAlignment',
  packageExport: 2069,
  nativeIndex: 1253,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002bb20,
  execEnd: 0x1002bb3a,
  execSha256: '2cf2053a718a00f48ddc4027eab7eaf4e4846015105156a42fc5db4f11f20fa7',
  methodBody: null,
  methodEnd: null,
  methodSha256: null,
});

export class GcGetHorizontalAlignmentBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcGetHorizontalAlignmentBoundaryError';
    this.code = `GC_GET_HORIZONTAL_ALIGNMENT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcGetHorizontalAlignmentBoundaryError(message, details);
};

export function gcGetHorizontalAlignment(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.GetHorizontalAlignment requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return L.read(L.base + GC.hAlign, 'u8');
}

export const execGcGetHorizontalAlignment = gcGetHorizontalAlignment;
