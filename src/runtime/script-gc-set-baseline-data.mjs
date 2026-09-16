/**
 * Recovered Extension.dll UGC::SetBaselineData translation (native 1262,
 * method body 0x10027680, exec trampoline 0x1002b970).
 *
 * The method stores arg1 (newBaselineOffset) at +0x8c and arg2
 * (newUnderlineHeight) at +0x88 — the memory order is swapped relative to
 * the argument order.  The exec body marshals two float params through
 * GNatives into slots preloaded with the defaults 0x40000000 (2.0f) and
 * 0x3f800000 (1.0f).
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_BASELINE_DATA_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetBaselineData',
  packageExport: 2089,
  nativeIndex: 1262,
  functionFlags: 0x401,
  serialSize: 33,
  execDefaults: {newBaselineOffset: 2.0, newUnderlineHeight: 1.0},
  ...GC_DLL,
  execBody: 0x1002b970,
  execEnd: 0x1002b9df,
  execSha256: '9031bfbadf6f39231a4e60bbc9db6a205e1f436363fd58811782250acc904785',
  methodBody: 0x10027680,
  methodEnd: 0x10027697,
  methodSha256: '7bba0d4f99f6a96a2727d5a531e19c844aa2807446e82f5017ab48e0f803654e',
  // Exec-body slot preloads for the optional params (0x40000000, 0x3f800000).
  defaults: freeze({newBaselineOffset: 2.0, newUnderlineHeight: 1.0}),
});

export class GcSetBaselineDataBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetBaselineDataBoundaryError';
    this.code = `GC_SET_BASELINE_DATA_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetBaselineDataBoundaryError(message, details);
};

export function gcSetBaselineData(object, newBaselineOffset, newUnderlineHeight, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetBaselineData requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newBaselineOffset !== 'number' || typeof newUnderlineHeight !== 'number')
    fail('GC.SetBaselineData requires floats', {kind: 'VALUE'});
  const L = gcMemory(object, services);
  L.write(L.base + GC.baselineOffset, 'f32', newBaselineOffset);
  L.write(L.base + GC.underlineHeight, 'f32', newUnderlineHeight);
}

export const execGcSetBaselineData = gcSetBaselineData;
