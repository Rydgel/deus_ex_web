/**
 * Recovered Extension.dll UGC::EnableWordWrap translation (native 1258,
 * method body 0x10027720, exec trampoline 0x1002bd90).
 *
 * The method folds the argument into text-flag bit0 at +0x98 with the
 * xor-mask-xor idiom: ((flags ^ arg) & 1) ^ flags.  No helper runs and no
 * other field is touched.  The exec body marshals the single bool param
 * through GNatives, then calls the method.  The export is void.
 */
import {
  GC,
  GC_DLL,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_ENABLE_WORD_WRAP_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.EnableWordWrap',
  packageExport: 2081,
  nativeIndex: 1258,
  functionFlags: 0x401,
  serialSize: 30,
  ...GC_DLL,
  execBody: 0x1002bd90,
  execEnd: 0x1002bdd6,
  execSha256: 'cbf176a7e84be59c8443b942dbff05bd733f36c72b3386d3ca83acd39629fbe2',
  methodBody: 0x10027720,
  methodEnd: 0x1002773e,
  methodSha256: 'c9b421491337da2dfc68999f1bd508ef42f112bc2efdc8a37a77025a994d2cc6',
});

export class GcEnableWordWrapBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcEnableWordWrapBoundaryError';
    this.code = `GC_ENABLE_WORD_WRAP_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcEnableWordWrapBoundaryError(message, details);
};

export function gcEnableWordWrap(object, bNewWordWrap, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.EnableWordWrap requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof bNewWordWrap !== 'number' || !Number.isInteger(bNewWordWrap))
    fail('GC.EnableWordWrap requires an integer flag', {kind: 'VALUE', value: bNewWordWrap});
  const L = gcMemory(object, services);
  const flags = L.read(L.base + GC.textFlags, 'u32');
  const next = (((flags ^ (bNewWordWrap >>> 0)) & 1) ^ flags) >>> 0;
  L.write(L.base + GC.textFlags, 'u32', next);
}

export const execGcEnableWordWrap = gcEnableWordWrap;
