/**
 * Recovered Extension.dll UGC::EnableTranslucency translation (native 1218,
 * method body 0x10027330, exec trampoline 0x1002b2f0).
 *
 * The method rewrites the flag word at +0x48 as
 * (flags & ~8) | ((arg & 1) << 3) — bit3 is the translucent flag — then calls
 * the style-from-flags helper 0x1002aed0 (rewrites the style byte +0x44) and
 * the polyflags-from-flags helper 0x1002af00 (rewrites +0x4c), in that
 * order.  The exec body marshals the single bool param through GNatives,
 * then calls the method.  The export is void.
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

export const GC_ENABLE_TRANSLUCENCY_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.EnableTranslucency',
  packageExport: 2031,
  nativeIndex: 1218,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002b2f0,
  execEnd: 0x1002b336,
  execSha256: '2c5c6053518166658fbcaa65f5c0434280f96ea35ae57ddab4d5a791b1b3ad35',
  methodBody: 0x10027330,
  methodEnd: 0x100273bf,
  methodSha256: '3827827a0350964c4620ee05ccf5c1f27659ca2b213c4f46e184b044689bc3c9',
});

export class GcEnableTranslucencyBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcEnableTranslucencyBoundaryError';
    this.code = `GC_ENABLE_TRANSLUCENCY_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcEnableTranslucencyBoundaryError(message, details);
};

export function gcEnableTranslucency(object, bNewTranslucency, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.EnableTranslucency requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof bNewTranslucency !== 'number' || !Number.isInteger(bNewTranslucency))
    fail('GC.EnableTranslucency requires an integer flag', {kind: 'VALUE', value: bNewTranslucency});
  const L = gcMemory(object, services);
  const flags = L.read(L.base + GC.flags, 'u32');
  const next = ((flags & ~GC_FLAGS.translucent) | ((bNewTranslucency & 1) << 3)) >>> 0;
  L.write(L.base + GC.flags, 'u32', next);
  updateStyleFromFlags(L, L.base);
  updatePolyFlagsFromFlags(L, L.base);
}

export const execGcEnableTranslucency = gcEnableTranslucency;
