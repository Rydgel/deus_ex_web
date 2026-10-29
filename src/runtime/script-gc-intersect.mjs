/**
 * Recovered Extension.dll UGC::Intersect translation (native 1200,
 * method body 0x10027000, exec trampoline 0x1002af40).
 *
 * The method intersects the stored clip rect (+0x34/+0x38 origin-relative,
 * +0x3c/+0x40 size) with the argument rect (x, y, w, h as f32 dwords) on
 * the x87 with FPCW 0x037f (extended intermediates):
 *   A = f(x+ox)  B = f(y+oy)  C = f(cx+ox)  D = f(cy+oy)
 *   E = f(C+sx)  F = D+sy    (F stays in st(0), not rounded)
 *   G = A+w      (stays in st(0), not rounded)   H = f(B+h)
 *   C' = A if C < A or unordered else C   (fcomp, test ah,1 -> C0)
 *   D' = B if D < B or unordered else D
 *   R  = f(G) if E > G else E             (fcomp, test ah,0x41: equal and
 *                                          unordered both keep E)
 *   Bt = H if F > H else F
 *   +0x34 = f(C'-ox)  +0x38 = f(D'-oy)  +0x3c = f(R-C')  +0x40 = f(Bt-D')
 * `Math.fround` is placed only where the body rounds to f32 (the fstp
 * stores and the f(G) re-round); F and G stay unrounded JS doubles, the
 * repo convention for extended intermediates (see rolling.mjs).
 * The exec body evaluates the four float params through GNatives and
 * forwards their dwords.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_INTERSECT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.Intersect',
  packageExport: 2010,
  nativeIndex: 1200,
  functionFlags: 0x401,
  serialSize: 40,
  ...GC_DLL,
  execBody: 0x1002af40,
  execEnd: 0x1002b005,
  execSha256: '0962bb9e71c500e97625863624eea464e0c0111cfa914bf54d11579b1c915445',
  methodBody: 0x10027000,
  methodEnd: 0x100270db,
  methodSha256: 'ffdb7cd55b3f7ebc0dc9f98cd37b2998c2121f3c2d6d4bd29b477676fb3037f8',
});

export class GcIntersectBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcIntersectBoundaryError';
    this.code = `GC_INTERSECT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcIntersectBoundaryError(message, details);
};

export function gcIntersect(object, clipX, clipY, clipWidth, clipHeight, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.Intersect requires a canonical GC object', {kind: 'REFERENCE', value: object});
  // (no array literal per call: the HUD runs this for every DrawText)
  if (typeof clipX !== 'number') fail('GC.Intersect requires a numeric ClipX', {kind: 'VALUE', value: clipX});
  if (typeof clipY !== 'number') fail('GC.Intersect requires a numeric ClipY', {kind: 'VALUE', value: clipY});
  if (typeof clipWidth !== 'number') fail('GC.Intersect requires a numeric clipWidth', {kind: 'VALUE', value: clipWidth});
  if (typeof clipHeight !== 'number') fail('GC.Intersect requires a numeric clipHeight', {kind: 'VALUE', value: clipHeight});
  const L = gcMemory(object, services);
  const base = L.base;
  const ox = L.read(base + GC.originX, 'f32');
  const oy = L.read(base + GC.originY, 'f32');
  const sx = L.read(base + GC.clipWidth, 'f32');
  const sy = L.read(base + GC.clipHeight, 'f32');
  const A = Math.fround(clipX + ox);
  const B = Math.fround(clipY + oy);
  const C = Math.fround(L.read(base + GC.clipX, 'f32') + ox);
  const D = Math.fround(L.read(base + GC.clipY, 'f32') + oy);
  const E = Math.fround(C + sx);
  const F = D + sy;
  const G = A + clipWidth;
  const H = Math.fround(B + clipHeight);
  const Cp = !(C >= A) ? A : C;
  const Dp = !(D >= B) ? B : D;
  const R = E > G ? Math.fround(G) : E;
  const Bt = F > H ? H : F;
  L.write(base + GC.clipX, 'f32', Cp - ox);
  L.write(base + GC.clipY, 'f32', Dp - oy);
  L.write(base + GC.clipWidth, 'f32', R - Cp);
  L.write(base + GC.clipHeight, 'f32', Bt - Dp);
}

export const execGcIntersect = gcIntersect;
