/**
 * Recovered Extension.dll UGC::GetAlignments translation (native 1257,
 * method body 0x100276f0, exec trampoline 0x1002bcb0).
 *
 * The method takes two out pointers: each non-null pointer receives the
 * zero-extended dword of +0x94 (arg1) / +0x95 (arg2); a null pointer skips
 * the write.  The exec body evaluates both out params (GPropAddr), runs the
 * method over two stack scratch dwords, and copies each scratch low byte to
 * the captured out property when it is non-null.
 *
 * `gcGetAlignmentsMethod` models the method: its writeH/writeV booleans
 * model non-null out pointers and the returned fields are null where the
 * pointer was null.  `gcGetAlignments` is the exec-level behaviour.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_GET_ALIGNMENTS_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.GetAlignments',
  packageExport: 2078,
  nativeIndex: 1257,
  functionFlags: 0x401,
  serialSize: 34,
  ...GC_DLL,
  execBody: 0x1002bcb0,
  execEnd: 0x1002bd6b,
  execSha256: '5ed550afd15cf49a5808b3a44c1c9dae6befbbfb50975bf47dddbcc79525a899',
  methodBody: 0x100276f0,
  methodEnd: 0x10027717,
  methodSha256: '761a4861417d3d77aa71d654f2b71026cefa563f16c112b6bc756922f736d788',
});

export class GcGetAlignmentsBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcGetAlignmentsBoundaryError';
    this.code = `GC_GET_ALIGNMENTS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcGetAlignmentsBoundaryError(message, details);
};

export function gcGetAlignmentsMethod(object, writeH, writeV, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.GetAlignments requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return {
    hAlign: writeH ? L.read(L.base + GC.hAlign, 'u8') : null,
    vAlign: writeV ? L.read(L.base + GC.vAlign, 'u8') : null,
  };
}

export function gcGetAlignments(object, services = {}) {
  return gcGetAlignmentsMethod(object, true, true, services);
}

export const execGcGetAlignments = gcGetAlignments;
