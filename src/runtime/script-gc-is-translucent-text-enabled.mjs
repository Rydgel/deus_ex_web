/**
 * Recovered Extension.dll UGC::IsTranslucentTextEnabled translation (native
 * 1248, inline exec body 0x1002b680, no method body).
 *
 * The exec body is the whole native: it advances the frame code pointer by
 * one byte, reads the flag word at this+0x48, shifts it right by 5
 * (`shr eax,5`), masks with `and eax,1` and stores the dword through the
 * result pointer.  Returns 0|1.
 */
import {
  GC,
  GC_DLL,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_IS_TRANSLUCENT_TEXT_ENABLED_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.IsTranslucentTextEnabled',
  packageExport: 2061,
  nativeIndex: 1248,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002b680,
  execEnd: 0x1002b69d,
  execSha256: '28783b9e97eea8cabed0ddfee34bac661de47c53bc867f4be7f7ef9f8a43865f',
  methodBody: null,
});

export class GcIsTranslucentTextEnabledBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcIsTranslucentTextEnabledBoundaryError';
    this.code = `GC_IS_TRANSLUCENT_TEXT_ENABLED_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcIsTranslucentTextEnabledBoundaryError(message, details);
};

export function gcIsTranslucentTextEnabled(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.IsTranslucentTextEnabled requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return (L.read(L.base + GC.flags, 'u32') >>> 5) & 1;
}

export const execGcIsTranslucentTextEnabled = gcIsTranslucentTextEnabled;
