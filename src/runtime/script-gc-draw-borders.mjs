/**
 * Recovered Extension.dll UGC::DrawBorders translation (native 1289,
 * export 2159, flags 0x401, serialSize 61).
 *
 *   exec 0x1002c970 -> method 0x10028df0 -> tile gate 0x10028770
 *     -> draw sink 0x1002a820 -> clip helper 0x1002a4f0
 *     -> canvas vtable slot +0x5c.
 *
 * The exec evaluates 8 float params, then the `borders` Texture[9] property
 * (*GPropAddr when set, else the by-value local buffer), then two bools —
 * the method receives 19 stack dwords (4 dest, 4 margin, 9 texture ptrs,
 * 2 stretch flags).
 *
 * Method layout (locals named for their role):
 *   leftW  = max(b0.U, b2.U, b4.U);   if (leftM   > 0) leftW  = leftM
 *   rightW = max(b1.U, b3.U, b5.U);   if (rightM  > 0) rightW = rightM
 *   topH   = max(b0.V, b1.V, b6.V);   if (topM    > 0) topH   = topM
 *   botH   = max(b2.V, b3.V, b7.V);   if (bottomM > 0) botH   = bottomM
 *   (each max is `if (acc < dim) acc = dim` on f32s; margins copy raw bits)
 *   midW = f32(destW - (leftW+rightW));  if (midW < 0 or NaN):
 *     ratio = f32(destW / (leftW+rightW));  midW = 0;
 *     leftW = f32(leftW*ratio);  rightW = f32(rightW*ratio)
 *   midH = f32(destH - (topH+botH));     symmetric rescale on topH/botH
 *   X1 = f32(leftW + DestX);  X2 = f32(X1ext + midW)
 *   Y1 = f32(topH + DestY);   Y2 = f32(Y1ext + midH)
 *   (the native keeps the 80-bit partial sums on the FPU stack; in f64 the
 *    chained adds are exact, so X2 = f32(leftW + DestX + midW))
 *
 * Emission order (each only when its texture is non-null), all through the
 * 9-arg gate — zero UL/VL produce pixel-tracking flags, nonzero produce
 * proportional:
 *   TL b0: gate(DestX, DestY, leftW, topH,  b0.U-leftW, b0.V-topH, leftW, topH)
 *   TR b1: gate(X2,    DestY, rightW, topH, 0,          b1.V-topH, rightW, topH)
 *   BL b2: gate(DestX, Y2,    leftW,  botH, b2.U-leftW, 0,         leftW, botH)
 *   BR b3: gate(X2,    Y2,    rightW, botH, 0,          0,         rightW,botH)
 *   L  b4: gate(DestX, Y1,    leftW,  midH, b4.U-leftW, 0,
 *               leftW, bStretchV ? b4.V : 0)
 *   R  b5: gate(X2,    Y1,    rightW, midH, 0,          0,
 *               rightW, bStretchV ? b5.V : 0)
 *   T  b6: gate(X1,    DestY, midW,   topH, 0,          b6.V-topH,
 *               bStretchH ? b6.U : 0, topH)
 *   B  b7: gate(X1,    Y2,    midW,   botH, 0,          0,
 *               bStretchH ? b7.U : 0, botH)
 *   C  b8: gate(X1,    Y1,    midW,   midH, 0,          0,
 *               bStretchH ? b8.U : 0, bStretchV ? b8.V : 0)
 * where `tex.U`/`tex.V` are the i32 dims at +0x34/+0x38 converted fild->f32
 * and the deltas are f32(dim - width/height).
 *
 * Returns the ordered emitted DrawTile commands.
 *
 * Evidence: docs/script-gc-draw-model.md; oracle
 * scripts/native-gc-draw-borders-oracle.py executes the real bodies.
 */
import {GC, GC_DLL, GC_FLAGS, gcMemory} from './script-gc-state-model.mjs';
import {bitsToF32, gcTileEmitGate} from './script-gc-draw-model.mjs';

const freeze = Object.freeze;
const f32 = v => Math.fround(v);

export const GC_DRAW_BORDERS_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.DrawBorders',
  packageExport: 2159,
  nativeIndex: 1289,
  functionFlags: 0x401,
  serialSize: 61,
  ...GC_DLL,
  msvcrtSha256: 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
  execBody: 0x1002c970,
  execEnd: 0x1002cbc0,
  execSha256: '17994e51a39005a31869882e97b4dabca2fd9ff960150eed885c6865173eff33',
  methodBody: 0x10028df0,
  methodEnd: 0x100292f0,
  methodSha256: '2295d7ac14141f2acc40d17000f1fbc22bca25732ae2bd0d2ce6a9129893b0de',
});

export class GcDrawBordersBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcDrawBordersBoundaryError';
    this.code = `GC_DRAW_BORDERS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcDrawBordersBoundaryError(message, details);
};

const texU = (L, tex) => L.read(tex + 0x34, 'i32');
const texV = (L, tex) => L.read(tex + 0x38, 'i32');

/** `if (acc < dim) acc = dim` — the native's fild/fcomp max fold. */
const foldMax = (acc, dim) => (acc < dim ? dim : acc);

/**
 * Method 0x10028df0.  `borders` is the array of nine texture heap pointers
 * (index 0..8 = TL, TR, BL, BR, L, R, T, B, C).  All float args arrive as
 * raw u32 bit patterns.
 */
export function gcDrawBorders(object, destX, destY, destWidth, destHeight,
                              leftMargin, rightMargin, topMargin, bottomMargin,
                              borders, bStretchH, bStretchV, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.DrawBorders requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  if (!(L.read(L.base + GC.flags, 'u32') & GC_FLAGS.drawing)) return null;
  const dw = bitsToF32(destWidth), dh = bitsToF32(destHeight);
  if (!(dw > 0) || !(dh > 0)) return null;
  const b = borders;

  let leftW = 0, rightW = 0, topH = 0, botH = 0;
  if (b[0]) { leftW = foldMax(leftW, f32(texU(L, b[0]))); topH = foldMax(topH, f32(texV(L, b[0]))); }
  if (b[1]) { rightW = foldMax(rightW, f32(texU(L, b[1]))); topH = foldMax(topH, f32(texV(L, b[1]))); }
  if (b[2]) { leftW = foldMax(leftW, f32(texU(L, b[2]))); botH = foldMax(botH, f32(texV(L, b[2]))); }
  if (b[3]) { rightW = foldMax(rightW, f32(texU(L, b[3]))); botH = foldMax(botH, f32(texV(L, b[3]))); }
  if (b[4]) leftW = foldMax(leftW, f32(texU(L, b[4])));
  if (b[5]) rightW = foldMax(rightW, f32(texU(L, b[5])));
  if (b[6]) topH = foldMax(topH, f32(texV(L, b[6])));
  if (b[7]) botH = foldMax(botH, f32(texV(L, b[7])));

  const lm = bitsToF32(leftMargin), rm = bitsToF32(rightMargin);
  const tm = bitsToF32(topMargin), bm = bitsToF32(bottomMargin);
  if (lm > 0) leftW = lm;
  if (rm > 0) rightW = rm;
  if (tm > 0) topH = tm;
  if (bm > 0) botH = bm;

  const sumW = leftW + rightW;              // 80-bit partial, exact in f64
  let midW = f32(dw - sumW);
  const sumH = topH + botH;
  let midH = f32(dh - sumH);
  if (!(midW >= 0)) {                       // midW < 0 or NaN
    const ratio = f32(dw / sumW);
    midW = 0;
    leftW = f32(leftW * ratio);
    rightW = f32(rightW * ratio);
  }
  if (!(midH >= 0)) {                       // midH < 0 or NaN
    const ratio = f32(dh / sumH);
    midH = 0;
    topH = f32(topH * ratio);
    botH = f32(botH * ratio);
  }

  const dx = bitsToF32(destX), dy = bitsToF32(destY);
  const x1 = f32(leftW + dx);
  const x2 = f32(leftW + dx + midW);        // fst keeps the extended partial
  const y1 = f32(topH + dy);
  const y2 = f32(topH + dy + midH);

  const out = [];
  const emit = (texture, x, y, w, h, u, v, ul, vl) => {
    const cmd = gcTileEmitGate(L, {texture, x, y, w, h, u, v, ul, vl});
    if (cmd) out.push(cmd);
  };
  if (b[0]) emit(b[0] >>> 0, dx, dy, leftW, topH,
                 f32(texU(L, b[0]) - leftW), f32(texV(L, b[0]) - topH),
                 leftW, topH);
  if (b[1]) emit(b[1] >>> 0, x2, dy, rightW, topH,
                 0, f32(texV(L, b[1]) - topH), rightW, topH);
  if (b[2]) emit(b[2] >>> 0, dx, y2, leftW, botH,
                 f32(texU(L, b[2]) - leftW), 0, leftW, botH);
  if (b[3]) emit(b[3] >>> 0, x2, y2, rightW, botH, 0, 0, rightW, botH);
  if (b[4]) emit(b[4] >>> 0, dx, y1, leftW, midH,
                 f32(texU(L, b[4]) - leftW), 0,
                 leftW, f32(bStretchV ? texV(L, b[4]) : 0));
  if (b[5]) emit(b[5] >>> 0, x2, y1, rightW, midH, 0, 0,
                 rightW, f32(bStretchV ? texV(L, b[5]) : 0));
  if (b[6]) emit(b[6] >>> 0, x1, dy, midW, topH,
                 0, f32(texV(L, b[6]) - topH),
                 f32(bStretchH ? texU(L, b[6]) : 0), topH);
  if (b[7]) emit(b[7] >>> 0, x1, y2, midW, botH, 0, 0,
                 f32(bStretchH ? texU(L, b[7]) : 0), botH);
  if (b[8]) emit(b[8] >>> 0, x1, y1, midW, midH, 0, 0,
                 f32(bStretchH ? texU(L, b[8]) : 0),
                 f32(bStretchV ? texV(L, b[8]) : 0));
  return out;
}

export const execGcDrawBorders = gcDrawBorders;
