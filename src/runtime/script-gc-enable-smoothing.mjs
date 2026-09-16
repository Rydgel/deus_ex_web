/**
 * Recovered Extension.dll UGC::EnableSmoothing translation (native 1210,
 * method body 0x100270e0, exec trampoline 0x1002b030).
 *
 * The method folds the argument into flag bit0 with the xor-mask-xor idiom
 * (+0x48 -> ((flags ^ arg) & 1) ^ flags), then calls the polyflags-from-flags
 * helper 0x1002af00 which rewrites +0x4c.  The style byte at +0x44 is NOT
 * recomputed.  The exec body marshals the single bool param through
 * GNatives, then calls the method.  The export is void.
 */
import {
  GC,
  GC_DLL,
  gcMemory,
  updatePolyFlagsFromFlags,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_ENABLE_SMOOTHING_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.EnableSmoothing',
  packageExport: 2015,
  nativeIndex: 1210,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002b030,
  execEnd: 0x1002b076,
  execSha256: '688bac2965716496eb0d11e97cf65c2241110c5ffcbf9bde8f012a236963a756',
  methodBody: 0x100270e0,
  methodEnd: 0x10027162,
  methodSha256: '771bfeb5e69f1f5371b02b66a1b406a0ce8f72d0ed8ca6e2bc2fc822b5659118',
});

export class GcEnableSmoothingBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcEnableSmoothingBoundaryError';
    this.code = `GC_ENABLE_SMOOTHING_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcEnableSmoothingBoundaryError(message, details);
};

export function gcEnableSmoothing(object, bNewSmoothing, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.EnableSmoothing requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof bNewSmoothing !== 'number' || !Number.isInteger(bNewSmoothing))
    fail('GC.EnableSmoothing requires an integer flag', {kind: 'VALUE', value: bNewSmoothing});
  const L = gcMemory(object, services);
  const flags = L.read(L.base + GC.flags, 'u32');
  const next = (((flags ^ (bNewSmoothing >>> 0)) & 1) ^ flags) >>> 0;
  L.write(L.base + GC.flags, 'u32', next);
  updatePolyFlagsFromFlags(L, L.base);
}

export const execGcEnableSmoothing = gcEnableSmoothing;
