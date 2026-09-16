/**
 * Recovered Extension.dll UGC::IsTranslucencyEnabled translation (native
 * 1219, inline exec body 0x1002b360, no method body).
 *
 * The exec body is the whole native: it advances the frame code pointer by
 * one byte, reads the flag word at this+0x48, shifts it right by 3
 * (`shr eax,3`), masks with `and eax,1` and stores the dword through the
 * result pointer.  Returns 0|1.
 */
import {
  GC,
  GC_DLL,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_IS_TRANSLUCENCY_ENABLED_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.IsTranslucencyEnabled',
  packageExport: 2033,
  nativeIndex: 1219,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002b360,
  execEnd: 0x1002b37d,
  execSha256: '82919fb505c2ed14a20eb379e0d39f2cb68b1e52efa917e21e4b49c62a343da7',
  methodBody: null,
});

export class GcIsTranslucencyEnabledBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcIsTranslucencyEnabledBoundaryError';
    this.code = `GC_IS_TRANSLUCENCY_ENABLED_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcIsTranslucencyEnabledBoundaryError(message, details);
};

export function gcIsTranslucencyEnabled(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.IsTranslucencyEnabled requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return (L.read(L.base + GC.flags, 'u32') >>> 3) & 1;
}

export const execGcIsTranslucencyEnabled = gcIsTranslucencyEnabled;
