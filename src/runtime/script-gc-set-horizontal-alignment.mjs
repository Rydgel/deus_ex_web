/**
 * Recovered Extension.dll UGC::SetHorizontalAlignment translation (native
 * 1252, method body 0x100276b0, exec trampoline 0x1002bab0).
 *
 * The method stores the argument low byte (al) at +0x94.  The exec body
 * marshals the byte param through GNatives and applies `and ecx,0xff`
 * before the call (only the slot low byte was preinitialised), so the
 * translation masks & 0xff.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_HORIZONTAL_ALIGNMENT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetHorizontalAlignment',
  packageExport: 2067,
  nativeIndex: 1252,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002bab0,
  execEnd: 0x1002baf9,
  execSha256: '282d811bdd69fe59c8f696ca1517aada8ee8204382db30b75fc5bec75b9643cd',
  methodBody: 0x100276b0,
  methodEnd: 0x100276bd,
  methodSha256: '6fe1cac3e8603bf57a82fd26b68f4c57f0ced58c44378a111d421f98dfabea06',
});

export class GcSetHorizontalAlignmentBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetHorizontalAlignmentBoundaryError';
    this.code = `GC_SET_HORIZONTAL_ALIGNMENT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetHorizontalAlignmentBoundaryError(message, details);
};

export function gcSetHorizontalAlignment(object, newHAlign, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetHorizontalAlignment requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newHAlign !== 'number' || !Number.isInteger(newHAlign))
    fail('GC.SetHorizontalAlignment requires an integer alignment', {kind: 'VALUE', value: newHAlign});
  const L = gcMemory(object, services);
  L.write(L.base + GC.hAlign, 'u8', newHAlign & 0xff);
}

export const execGcSetHorizontalAlignment = gcSetHorizontalAlignment;
