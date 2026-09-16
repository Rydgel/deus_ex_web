/**
 * Recovered Extension.dll UGC::IsDrawingEnabled translation (native 1215,
 * inline exec body 0x1002b200, no method body).
 *
 * The exec body is the whole native: it advances the frame code pointer by
 * one byte, reads the flag word at this+0x48, shifts it right by 1
 * (`shr eax,1`), masks with `and eax,1` and stores the dword through the
 * result pointer.  Returns 0|1.
 */
import {
  GC,
  GC_DLL,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_IS_DRAWING_ENABLED_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.IsDrawingEnabled',
  packageExport: 2025,
  nativeIndex: 1215,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002b200,
  execEnd: 0x1002b21c,
  execSha256: '2302b3e3a1ce4d54c29511c4a5a7c0c86d4c23669336b8aaa4d400bbf16efa25',
  methodBody: null,
});

export class GcIsDrawingEnabledBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcIsDrawingEnabledBoundaryError';
    this.code = `GC_IS_DRAWING_ENABLED_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcIsDrawingEnabledBoundaryError(message, details);
};

export function gcIsDrawingEnabled(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.IsDrawingEnabled requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return (L.read(L.base + GC.flags, 'u32') >>> 1) & 1;
}

export const execGcIsDrawingEnabled = gcIsDrawingEnabled;
