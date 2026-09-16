/**
 * Recovered Extension.dll UGC::SetStyle translation (native 1212,
 * method body 0x10027170, exec trampoline 0x1002b0e0).
 *
 * The method stores the argument low byte (dl) at +0x44, then:
 *   s == 0:  flags &= ~2 (and al,0xfd) and returns WITHOUT calling the
 *            polyflags-from-flags helper;
 *   s != 0:  flags |= 2 (or al,2, stored), then
 *            s == 2 -> (flags & ~0x18) | 4   (and al,0xe7; or al,4)
 *            s == 3 -> (flags & ~0x14) | 8   (and al,0xeb; or al,8)
 *            s == 4 -> (flags & ~0x0c) | 0x10 (and al,0xf3; or al,0x10)
 *            other  -> flags & ~0x1c         (and al,0xe3)
 *            and calls helper 0x1002af00 to recompute +0x4c.
 * Every mask touches only the low byte; flag bits 6+ are preserved.  The
 * exec body marshals the byte param through GNatives and pushes the whole
 * evaluated dword; only dl is consumed, so the translation masks & 0xff.
 */
import {
  GC,
  GC_DLL,
  GC_FLAGS,
  gcMemory,
  updatePolyFlagsFromFlags,
} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_STYLE_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetStyle',
  packageExport: 2019,
  nativeIndex: 1212,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002b0e0,
  execEnd: 0x1002b123,
  execSha256: '08a8cd8d391a5da308204f1e9a96a6028b4f36bebbe14053274dda17fa5a0f56',
  methodBody: 0x10027170,
  methodEnd: 0x1002727b,
  methodSha256: 'f849e8966abb705426b3d24bfc23d3a2f963a52533470233130a7c99cd4c893d',
});

export class GcSetStyleBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetStyleBoundaryError';
    this.code = `GC_SET_STYLE_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetStyleBoundaryError(message, details);
};

export function gcSetStyle(object, newStyle, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetStyle requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newStyle !== 'number' || !Number.isInteger(newStyle))
    fail('GC.SetStyle requires an integer style', {kind: 'VALUE', value: newStyle});
  const L = gcMemory(object, services);
  const style = newStyle & 0xff;
  L.write(L.base + GC.style, 'u8', style);
  const flags = L.read(L.base + GC.flags, 'u32');
  if (style === 0) {
    L.write(L.base + GC.flags, 'u32', (flags & ~GC_FLAGS.drawing) >>> 0);
    return;
  }
  let next = (flags | GC_FLAGS.drawing) >>> 0;
  if (style === 2) next = ((next & ~0x18) | GC_FLAGS.masked) >>> 0;
  else if (style === 3) next = ((next & ~0x14) | GC_FLAGS.translucent) >>> 0;
  else if (style === 4) next = ((next & ~0x0c) | GC_FLAGS.modulated) >>> 0;
  else next = (next & ~0x1c) >>> 0;
  L.write(L.base + GC.flags, 'u32', next);
  updatePolyFlagsFromFlags(L, L.base);
}

export const execGcSetStyle = gcSetStyle;
