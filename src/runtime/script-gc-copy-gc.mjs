/**
 * Recovered Extension.dll UGC::CopyGC translation (native 1270,
 * method body 0x10027760, exec trampoline 0x1002bef0).
 *
 * The method copies the drawing-state fields of the source object into the
 * destination (ecx = destination, arg = source pointer):
 *   +0x28, +0x2c..+0x40 (six dwords), byte +0x44, bits 0-5 of +0x48 merged
 *   over the destination (six xor/mask/xor folds; destination bits 6+
 *   survive), +0x4c, +0x50, +0x54, +0x58..+0x64, +0x68, +0x6c..+0x78,
 *   +0x7c, +0x80, +0x84, +0x88, +0x8c, +0x90, bytes +0x94/+0x95, bits 0-1
 *   of +0x98 merged (destination bits 2+ survive), +0x9c, +0xa0.
 * Stack fields +0xa4..+0xb4 are never touched.  A null source dereferences
 * a null pointer in the original; the translation raises a boundary error.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_COPY_GC_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.CopyGC',
  packageExport: 2092,
  nativeIndex: 1270,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002bef0,
  execEnd: 0x1002bf36,
  execSha256: '4b6881bc97cae869b7909efb914605c437cbfcd7a9b7e40fff1f8aeadaaee435',
  methodBody: 0x10027760,
  methodEnd: 0x100278c9,
  methodSha256: 'd1cba082642e1542150603ceb60d645ad10e08788d0d785f00b74d170e90b6ec',
});

export class GcCopyGcBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcCopyGcBoundaryError';
    this.code = `GC_COPY_GC_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcCopyGcBoundaryError(message, details);
};

export function gcCopyGC(object, copy, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.CopyGC requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof copy !== 'number' || !Number.isInteger(copy))
    fail('GC.CopyGC requires an integer source address', {kind: 'VALUE', value: copy});
  if (copy === 0)
    fail('GC.CopyGC requires a non-null source object', {kind: 'REFERENCE', value: copy});
  const L = gcMemory(object, services);
  const dst = L.base;
  const src = copy >>> 0;
  L.write(dst + GC.canvas, 'u32', L.read(src + GC.canvas, 'u32'));
  for (let offset = GC.originX; offset <= GC.clipHeight; offset += 4)
    L.write(dst + offset, 'u32', L.read(src + offset, 'u32'));
  L.write(dst + GC.style, 'u8', L.read(src + GC.style, 'u8'));
  const flags = L.read(dst + GC.flags, 'u32');
  L.write(dst + GC.flags, 'u32',
    ((flags & ~0x3f) | (L.read(src + GC.flags, 'u32') & 0x3f)) >>> 0);
  for (const offset of [GC.polyFlags, GC.textPolyFlags, GC.tileColor])
    L.write(dst + offset, 'u32', L.read(src + offset, 'u32'));
  for (let offset = GC.tileFloats; offset <= GC.tileFloats + 0xc; offset += 4)
    L.write(dst + offset, 'u32', L.read(src + offset, 'u32'));
  L.write(dst + GC.textColor, 'u32', L.read(src + GC.textColor, 'u32'));
  for (let offset = GC.textFloats; offset <= GC.textFloats + 0xc; offset += 4)
    L.write(dst + offset, 'u32', L.read(src + offset, 'u32'));
  for (const offset of [GC.normalFont, GC.boldFont, GC.unknown84,
    GC.underlineHeight, GC.baselineOffset, GC.textVSpacing])
    L.write(dst + offset, 'u32', L.read(src + offset, 'u32'));
  L.write(dst + GC.hAlign, 'u8', L.read(src + GC.hAlign, 'u8'));
  L.write(dst + GC.vAlign, 'u8', L.read(src + GC.vAlign, 'u8'));
  const textFlags = L.read(dst + GC.textFlags, 'u32');
  L.write(dst + GC.textFlags, 'u32',
    ((textFlags & ~0x3) | (L.read(src + GC.textFlags, 'u32') & 0x3)) >>> 0);
  for (const offset of [GC.unknown9c, GC.unknownA0])
    L.write(dst + offset, 'u32', L.read(src + offset, 'u32'));
}

export const execGcCopyGC = gcCopyGC;
