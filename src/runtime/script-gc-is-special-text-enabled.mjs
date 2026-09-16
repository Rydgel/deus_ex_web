/**
 * Recovered Extension.dll UGC::IsSpecialTextEnabled translation (native
 * 1261, inline exec body 0x1002beb0, no method body).
 *
 * The exec body is the whole native: it advances the frame code pointer by
 * one byte, reads the text flag word at this+0x98, shifts it right by 1
 * (`shr eax,1`), masks with `and eax,1` and stores the dword through the
 * result pointer.  Returns 0|1.
 */
import {
  GC,
  GC_DLL,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_IS_SPECIAL_TEXT_ENABLED_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.IsSpecialTextEnabled',
  packageExport: 2087,
  nativeIndex: 1261,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002beb0,
  execEnd: 0x1002becf,
  execSha256: '89989ea635148724dbab22994687c6bf4b4265b66cbd07f1fc37d8adf60cf812',
  methodBody: null,
});

export class GcIsSpecialTextEnabledBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcIsSpecialTextEnabledBoundaryError';
    this.code = `GC_IS_SPECIAL_TEXT_ENABLED_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcIsSpecialTextEnabledBoundaryError(message, details);
};

export function gcIsSpecialTextEnabled(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.IsSpecialTextEnabled requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return (L.read(L.base + GC.textFlags, 'u32') >>> 1) & 1;
}

export const execGcIsSpecialTextEnabled = gcIsSpecialTextEnabled;
