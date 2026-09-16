/**
 * Recovered Extension.dll UGC::IsModulationEnabled translation (native 1221,
 * inline exec body 0x1002b410, no method body).
 *
 * The exec body is the whole native: it advances the frame code pointer by
 * one byte, reads the flag word at this+0x48, shifts it right by 4
 * (`shr eax,4`), masks with `and eax,1` and stores the dword through the
 * result pointer.  Returns 0|1.
 */
import {
  GC,
  GC_DLL,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_IS_MODULATION_ENABLED_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.IsModulationEnabled',
  packageExport: 2037,
  nativeIndex: 1221,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002b410,
  execEnd: 0x1002b42d,
  execSha256: 'e98592cfca8bfdf613b3ed37f1767e1f749a880c75e889e96a19835ad1d06478',
  methodBody: null,
});

export class GcIsModulationEnabledBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcIsModulationEnabledBoundaryError';
    this.code = `GC_IS_MODULATION_ENABLED_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcIsModulationEnabledBoundaryError(message, details);
};

export function gcIsModulationEnabled(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.IsModulationEnabled requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return (L.read(L.base + GC.flags, 'u32') >>> 4) & 1;
}

export const execGcIsModulationEnabled = gcIsModulationEnabled;
