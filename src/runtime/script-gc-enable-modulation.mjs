/**
 * Recovered Extension.dll UGC::EnableModulation translation (native 1220,
 * method body 0x100273c0, exec trampoline 0x1002b3a0).
 *
 * The method rewrites the flag word at +0x48 as
 * (flags & ~0x10) | ((arg & 1) << 4) — bit4 is the modulated flag — then
 * calls the style-from-flags helper 0x1002aed0 (rewrites the style byte
 * +0x44) and the polyflags-from-flags helper 0x1002af00 (rewrites +0x4c),
 * in that order.  The exec body marshals the single bool param through
 * GNatives, then calls the method.  The export is void.
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

export const GC_ENABLE_MODULATION_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.EnableModulation',
  packageExport: 2035,
  nativeIndex: 1220,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002b3a0,
  execEnd: 0x1002b3e6,
  execSha256: 'ca6f06bb83be71bf67b48a547c0809fb50d94dccaf0ac620632bc5859b80abc2',
  methodBody: 0x100273c0,
  methodEnd: 0x1002744f,
  methodSha256: 'd1af31d53b1edd1c39973bcb3d65bea95a5e87a0c3b294c1d052387ef88b5250',
});

export class GcEnableModulationBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcEnableModulationBoundaryError';
    this.code = `GC_ENABLE_MODULATION_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcEnableModulationBoundaryError(message, details);
};

export function gcEnableModulation(object, bNewModulation, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.EnableModulation requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof bNewModulation !== 'number' || !Number.isInteger(bNewModulation))
    fail('GC.EnableModulation requires an integer flag', {kind: 'VALUE', value: bNewModulation});
  const L = gcMemory(object, services);
  const flags = L.read(L.base + GC.flags, 'u32');
  const next = ((flags & ~GC_FLAGS.modulated) | ((bNewModulation & 1) << 4)) >>> 0;
  L.write(L.base + GC.flags, 'u32', next);
  updateStyleFromFlags(L, L.base);
  updatePolyFlagsFromFlags(L, L.base);
}

export const execGcEnableModulation = gcEnableModulation;
