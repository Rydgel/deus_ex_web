/**
 * Recovered Extension.dll UGC::EnableTranslucentText translation (native
 * 1247, method body 0x10027610, exec trampoline 0x1002b610).
 *
 * The method rewrites the flag word at +0x48 as
 * (flags & ~0x20) | ((arg & 1) << 5) — bit5 is the translucentText flag —
 * then tests bit5 of the NEW low byte (`test al,0x20`) and stores the text
 * polyflags word at +0x50: 0x804 when set, 0x802 when clear.  No other
 * helper runs.  The exec body marshals the single bool param through
 * GNatives, then calls the method.  The export is void.
 */
import {
  GC,
  GC_DLL,
  GC_FLAGS,
  GC_POLY,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_ENABLE_TRANSLUCENT_TEXT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.EnableTranslucentText',
  packageExport: 2059,
  nativeIndex: 1247,
  functionFlags: 0x401,
  serialSize: 30,
  ...GC_DLL,
  execBody: 0x1002b610,
  execEnd: 0x1002b656,
  execSha256: 'ca6024e47a376e15e2a51eb7b07a0a1f7733d4511640456a4d77588ca04d45c8',
  methodBody: 0x10027610,
  methodEnd: 0x1002763d,
  methodSha256: '5757e733b78dfc6a3c58a1071697e1ef5b23e61361c31db6371c254365703254',
});

export class GcEnableTranslucentTextBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcEnableTranslucentTextBoundaryError';
    this.code = `GC_ENABLE_TRANSLUCENT_TEXT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcEnableTranslucentTextBoundaryError(message, details);
};

export function gcEnableTranslucentText(object, bNewTranslucency, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.EnableTranslucentText requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof bNewTranslucency !== 'number' || !Number.isInteger(bNewTranslucency))
    fail('GC.EnableTranslucentText requires an integer flag', {kind: 'VALUE', value: bNewTranslucency});
  const L = gcMemory(object, services);
  const flags = L.read(L.base + GC.flags, 'u32');
  const next = ((flags & ~GC_FLAGS.translucentText) | ((bNewTranslucency & 1) << 5)) >>> 0;
  L.write(L.base + GC.flags, 'u32', next);
  L.write(L.base + GC.textPolyFlags, 'u32',
    (next & GC_FLAGS.translucentText) ? GC_POLY.textTranslucent : GC_POLY.textOpaque);
}

export const execGcEnableTranslucentText = gcEnableTranslucentText;
