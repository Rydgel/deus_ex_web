/**
 * Recovered Extension.dll UGC::SetAlignments translation (native 1256,
 * method body 0x100276d0, exec trampoline 0x1002bc10).
 *
 * The method stores arg1 low byte (al) at +0x94 and arg2 low byte (dl) at
 * +0x95.  The exec body marshals both byte params through GNatives and
 * applies `and ecx,0xff` / `and edx,0xff` before the call, so the
 * translation masks both arguments & 0xff.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_ALIGNMENTS_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetAlignments',
  packageExport: 2075,
  nativeIndex: 1256,
  functionFlags: 0x401,
  serialSize: 34,
  ...GC_DLL,
  execBody: 0x1002bc10,
  execEnd: 0x1002bc85,
  execSha256: '3bb614a554bdfcbcc817f5892a25a46dc53731e1430e1a4f3dd6175035214cd7',
  methodBody: 0x100276d0,
  methodEnd: 0x100276e7,
  methodSha256: '3d0ef3cfab5e6e7571a7030d52aad5d2674c5efb6a1d17346348611bd594e675',
});

export class GcSetAlignmentsBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetAlignmentsBoundaryError';
    this.code = `GC_SET_ALIGNMENTS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetAlignmentsBoundaryError(message, details);
};

export function gcSetAlignments(object, newHAlign, newVAlign, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetAlignments requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newHAlign !== 'number' || !Number.isInteger(newHAlign)
      || typeof newVAlign !== 'number' || !Number.isInteger(newVAlign))
    fail('GC.SetAlignments requires integer alignments', {kind: 'VALUE'});
  const L = gcMemory(object, services);
  L.write(L.base + GC.hAlign, 'u8', newHAlign & 0xff);
  L.write(L.base + GC.vAlign, 'u8', newVAlign & 0xff);
}

export const execGcSetAlignments = gcSetAlignments;
