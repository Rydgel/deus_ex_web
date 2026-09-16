/**
 * Recovered Extension.dll UGC::IsMaskingEnabled translation (native 1217,
 * inline exec body 0x1002b2b0, no method body).
 *
 * The exec body is the whole native: it advances the frame code pointer by
 * one byte, reads the flag word at this+0x48, shifts it right by 2
 * (`shr eax,2`), masks with `and eax,1` and stores the dword through the
 * result pointer.  Returns 0|1.
 */
import {
  GC,
  GC_DLL,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_IS_MASKING_ENABLED_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.IsMaskingEnabled',
  packageExport: 2029,
  nativeIndex: 1217,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002b2b0,
  execEnd: 0x1002b2cd,
  execSha256: '8429aacdffd6b1f0fe937f308a3276a6fc98f79d0bf8222cf77923ba0ce892db',
  methodBody: null,
});

export class GcIsMaskingEnabledBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcIsMaskingEnabledBoundaryError';
    this.code = `GC_IS_MASKING_ENABLED_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcIsMaskingEnabledBoundaryError(message, details);
};

export function gcIsMaskingEnabled(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.IsMaskingEnabled requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return (L.read(L.base + GC.flags, 'u32') >>> 2) & 1;
}

export const execGcIsMaskingEnabled = gcIsMaskingEnabled;
