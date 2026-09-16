/**
 * Recovered Extension.dll UGC::IsWordWrapEnabled translation (native 1259,
 * inline exec body 0x1002be00, no method body).
 *
 * The exec body is the whole native: it advances the frame code pointer by
 * one byte, reads the text flag word at this+0x98, masks it with
 * `and eax,1` (no shift) and stores the dword through the result pointer.
 * Returns 0|1.
 */
import {
  GC,
  GC_DLL,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_IS_WORD_WRAP_ENABLED_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.IsWordWrapEnabled',
  packageExport: 2083,
  nativeIndex: 1259,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002be00,
  execEnd: 0x1002be1d,
  execSha256: 'c0dd2e0fa64f48d6598330ca3a5c5e9dcd2c755f86c72bae1c23261092b617a2',
  methodBody: null,
});

export class GcIsWordWrapEnabledBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcIsWordWrapEnabledBoundaryError';
    this.code = `GC_IS_WORD_WRAP_ENABLED_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcIsWordWrapEnabledBoundaryError(message, details);
};

export function gcIsWordWrapEnabled(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.IsWordWrapEnabled requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return (L.read(L.base + GC.textFlags, 'u32') >>> 0) & 1;
}

export const execGcIsWordWrapEnabled = gcIsWordWrapEnabled;
