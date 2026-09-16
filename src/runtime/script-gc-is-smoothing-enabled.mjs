/**
 * Recovered Extension.dll UGC::IsSmoothingEnabled translation (native 1211,
 * inline exec body 0x1002b0a0, no method body).
 *
 * The exec body is the whole native: it advances the frame code pointer by
 * one byte, reads the flag word at this+0x48, masks it with `and eax,1` (no
 * shift) and stores the dword through the result pointer.  Returns 0|1.
 */
import {
  GC,
  GC_DLL,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_IS_SMOOTHING_ENABLED_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.IsSmoothingEnabled',
  packageExport: 2017,
  nativeIndex: 1211,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002b0a0,
  execEnd: 0x1002b0ba,
  execSha256: 'b97626a9dd938f0676e0bcbd1aa3d57b756bf490650eeb4eeb62c84260b1ff18',
  methodBody: null,
});

export class GcIsSmoothingEnabledBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcIsSmoothingEnabledBoundaryError';
    this.code = `GC_IS_SMOOTHING_ENABLED_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcIsSmoothingEnabledBoundaryError(message, details);
};

export function gcIsSmoothingEnabled(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.IsSmoothingEnabled requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return (L.read(L.base + GC.flags, 'u32') >>> 0) & 1;
}

export const execGcIsSmoothingEnabled = gcIsSmoothingEnabled;
