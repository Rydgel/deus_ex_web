/**
 * Recovered Extension.dll UGC::EnableDrawing translation (native 1214,
 * method body 0x10027280, exec trampoline 0x1002b190).
 *
 * The method rewrites the flag word at +0x48 as
 * (flags & ~2) | ((arg & 1) << 1) — bit1 is the drawing flag.  No helper
 * runs: the style byte +0x44 and polyflags +0x4c are left untouched.  The
 * exec body marshals the single bool param through GNatives, then calls the
 * method.  The export is void.
 */
import {
  GC,
  GC_DLL,
  GC_FLAGS,
  gcMemory,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_ENABLE_DRAWING_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.EnableDrawing',
  packageExport: 2023,
  nativeIndex: 1214,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002b190,
  execEnd: 0x1002b1d6,
  execSha256: '9df7b506fa17f69253a95afbfe44b7229b1db3354e7ca1f0d21cd97e1579a23f',
  methodBody: 0x10027280,
  methodEnd: 0x10027297,
  methodSha256: '5a68b91c48fa1c5df8541280675f5d6840094029d9269201a5cf350f09829645',
});

export class GcEnableDrawingBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcEnableDrawingBoundaryError';
    this.code = `GC_ENABLE_DRAWING_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcEnableDrawingBoundaryError(message, details);
};

export function gcEnableDrawing(object, bDrawEnabled, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.EnableDrawing requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof bDrawEnabled !== 'number' || !Number.isInteger(bDrawEnabled))
    fail('GC.EnableDrawing requires an integer flag', {kind: 'VALUE', value: bDrawEnabled});
  const L = gcMemory(object, services);
  const flags = L.read(L.base + GC.flags, 'u32');
  const next = ((flags & ~GC_FLAGS.drawing) | ((bDrawEnabled & 1) << 1)) >>> 0;
  L.write(L.base + GC.flags, 'u32', next);
}

export const execGcEnableDrawing = gcEnableDrawing;
