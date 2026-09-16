/**
 * Recovered Extension.dll UGC::SetTextVSpacing translation (native 1250,
 * method body 0x100276a0, exec trampoline 0x1002ba00).
 *
 * The method stores the evaluated argument dword verbatim at +0x90 (the
 * f32 textVSpacing field).  The exec body marshals the float param through
 * GNatives into a dword slot and pushes it.  The JS side receives the
 * decoded number; the f32 heap write roundtrips every case bit pattern
 * (zero, -0.0, denormals, canonical NaN, infinities) exactly.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_TEXT_V_SPACING_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetTextVSpacing',
  packageExport: 2063,
  nativeIndex: 1250,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002ba00,
  execEnd: 0x1002ba46,
  execSha256: 'a8b2db7ed077d624b00f678c9576931e8f8ed4bd4093fe12d30924a38eacf9c4',
  methodBody: 0x100276a0,
  methodEnd: 0x100276ad,
  methodSha256: 'f06ef1fadf30551dc9e6cc8665f4670f4b9df8e9248abd8585bff034eb5b140a',
});

export class GcSetTextVSpacingBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetTextVSpacingBoundaryError';
    this.code = `GC_SET_TEXT_V_SPACING_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetTextVSpacingBoundaryError(message, details);
};

export function gcSetTextVSpacing(object, newVSpacing, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetTextVSpacing requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newVSpacing !== 'number')
    fail('GC.SetTextVSpacing requires a float', {kind: 'VALUE', value: newVSpacing});
  const L = gcMemory(object, services);
  L.write(L.base + GC.textVSpacing, 'f32', newVSpacing);
}

export const execGcSetTextVSpacing = gcSetTextVSpacing;
