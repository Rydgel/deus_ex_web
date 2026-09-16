/**
 * Recovered Extension.dll UGC::EnableSpecialText translation (native 1260,
 * method body 0x10027740, exec trampoline 0x1002be40).
 *
 * The method rewrites the text flag word at +0x98 as
 * (flags & ~2) | ((arg & 1) << 1) — bit1 is the specialText flag.  No
 * helper runs and no other field is touched.  The exec body marshals the
 * single bool param through GNatives, then calls the method.  The export is
 * void.
 */
import {
  GC,
  GC_DLL,
  GC_TEXT_FLAGS,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_ENABLE_SPECIAL_TEXT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.EnableSpecialText',
  packageExport: 2085,
  nativeIndex: 1260,
  functionFlags: 0x401,
  serialSize: 30,
  ...GC_DLL,
  execBody: 0x1002be40,
  execEnd: 0x1002be86,
  execSha256: 'ea95cd12f671d47804314518cf39e0ff1010d61f2fff0c31b6fedcf8fad49b77',
  methodBody: 0x10027740,
  methodEnd: 0x1002775d,
  methodSha256: '3e1fa0a403a778976a41cb5dbcfa9de6d76d2f1506f807d5d1b038e986e8169e',
});

export class GcEnableSpecialTextBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcEnableSpecialTextBoundaryError';
    this.code = `GC_ENABLE_SPECIAL_TEXT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcEnableSpecialTextBoundaryError(message, details);
};

export function gcEnableSpecialText(object, bNewSpecialText, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.EnableSpecialText requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof bNewSpecialText !== 'number' || !Number.isInteger(bNewSpecialText))
    fail('GC.EnableSpecialText requires an integer flag', {kind: 'VALUE', value: bNewSpecialText});
  const L = gcMemory(object, services);
  const flags = L.read(L.base + GC.textFlags, 'u32');
  const next = ((flags & ~GC_TEXT_FLAGS.specialText) | ((bNewSpecialText & 1) << 1)) >>> 0;
  L.write(L.base + GC.textFlags, 'u32', next);
}

export const execGcEnableSpecialText = gcEnableSpecialText;
