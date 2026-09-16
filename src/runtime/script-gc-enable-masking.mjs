/**
 * Recovered Extension.dll UGC::EnableMasking translation (native 1216,
 * method body 0x100272a0, exec trampoline 0x1002b240).
 *
 * The method rewrites the flag word at +0x48 as
 * (flags & ~4) | ((arg & 1) << 2) — bit2 is the masked flag — then calls the
 * style-from-flags helper 0x1002aed0 (rewrites the style byte +0x44) and the
 * polyflags-from-flags helper 0x1002af00 (rewrites +0x4c), in that order.
 * The exec body marshals the single bool param through GNatives, then calls
 * the method.  The export is void.
 */
import {
  GC,
  GC_DLL,
  GC_FLAGS,
  gcMemory,
  updatePolyFlagsFromFlags,
  updateStyleFromFlags,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_ENABLE_MASKING_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.EnableMasking',
  packageExport: 2027,
  nativeIndex: 1216,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002b240,
  execEnd: 0x1002b286,
  execSha256: '40c7230bd5cbefc6465061f50eba901734d8243cc71daf062f050e03c250c911',
  methodBody: 0x100272a0,
  methodEnd: 0x1002732f,
  methodSha256: '38de30aae13c62a48f96261503af2dd02fa08a338b8e851961b425bbf2f438fc',
});

export class GcEnableMaskingBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcEnableMaskingBoundaryError';
    this.code = `GC_ENABLE_MASKING_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcEnableMaskingBoundaryError(message, details);
};

export function gcEnableMasking(object, bNewMasking, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.EnableMasking requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof bNewMasking !== 'number' || !Number.isInteger(bNewMasking))
    fail('GC.EnableMasking requires an integer flag', {kind: 'VALUE', value: bNewMasking});
  const L = gcMemory(object, services);
  const flags = L.read(L.base + GC.flags, 'u32');
  const next = ((flags & ~GC_FLAGS.masked) | ((bNewMasking & 1) << 2)) >>> 0;
  L.write(L.base + GC.flags, 'u32', next);
  updateStyleFromFlags(L, L.base);
  updatePolyFlagsFromFlags(L, L.base);
}

export const execGcEnableMasking = gcEnableMasking;
