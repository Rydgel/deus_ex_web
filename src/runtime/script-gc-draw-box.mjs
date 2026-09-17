/**
 * Recovered Extension.dll UGC::DrawBox translation (native 1286,
 * export 2132, flags 0x401, serialSize 52).
 *
 *   exec 0x1002c7e0 -> method 0x10028c50 -> DrawPattern method 0x10028a60
 *     -> draw sink 0x1002a820 -> clip helper 0x1002a4f0
 *     -> canvas vtable slot +0x5c.
 *
 * The method gates on tX != 0, GC+0x48 bit1 (drawing) and boxThickness > 0
 * (fcomp vs 0.0f, `test ah,0x41` — rejected when <=0 or NaN), computes
 * twoT = f32(2*boxThickness), and requires destWidth > twoT AND
 * destHeight > twoT (`test ah,0x41` on each compare — <= or unordered
 * routes to the fallback).  It then emits four pattern tiles — TOP, BOTTOM,
 * LEFT, RIGHT in that order — each an independent DrawPattern call:
 *
 *   pattern(DestX, DestY, destW, T, OrgX, OrgY, tX)
 *   pattern(DestX, f32(DestY+destH-T), destW, T, OrgX, f32(OrgY+destH-T), tX)
 *   pattern(DestX, f32(DestY+T), T, f32(destH-2T), OrgX, f32(OrgY+T), tX)
 *   pattern(f32(DestX+destW-T), f32(DestY+T), T, f32(destH-2T),
 *           f32(OrgX+destW-T), f32(OrgY+T), tX)
 *
 * The native reuses arg slots as locals: the top/bottom OrgY' and DestY'
 * and the shared destH-2T are stored back into [ebp+0x1c]/[ebp+0xc]/
 * [ebp+0x14] between calls — equivalent to the locals above.
 *
 * Fallback (thin box): pattern(DestX, DestY, destW, destH, OrgX, OrgY, tX)
 * — one full-rect pattern tile.
 *
 * All float params arrive as raw u32 bit patterns; `texture` is the object
 * heap pointer.  Returns the ordered emitted DrawTile commands.
 *
 * Evidence: docs/script-gc-draw-model.md; oracle
 * scripts/native-gc-draw-box-oracle.py executes the real bodies.
 */
import {GC, GC_DLL, GC_FLAGS, gcMemory} from './script-gc-state-model.mjs';
import {bitsToF32} from './script-gc-draw-model.mjs';
import {gcDrawPattern} from './script-gc-draw-pattern.mjs';

const freeze = Object.freeze;
const f32 = v => Math.fround(v);

export const GC_DRAW_BOX_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.DrawBox',
  packageExport: 2132,
  nativeIndex: 1286,
  functionFlags: 0x401,
  serialSize: 52,
  ...GC_DLL,
  msvcrtSha256: 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
  execBody: 0x1002c7e0,
  execEnd: 0x1002c950,
  execSha256: 'e4388a6d18dc166bdfb0073c41dd2580f46cff13e8036ba45765ba1401c95563',
  methodBody: 0x10028c50,
  methodEnd: 0x10028df0,
  methodSha256: '2c449a747be4df8d32236c377d7c1d865242f3f667d37dd08ed21a02e23fe3c1',
});

export class GcDrawBoxBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcDrawBoxBoundaryError';
    this.code = `GC_DRAW_BOX_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcDrawBoxBoundaryError(message, details);
};

/**
 * Method 0x10028c50.  `f32bits` marshals the computed edge args back to raw
 * bit patterns for the pattern call, matching the native's fstp-stored
 * locals and the pushes of the unmodified arg dwords.
 */
export function gcDrawBox(object, destX, destY, destWidth, destHeight,
                          orgX, orgY, boxThickness, texture, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.DrawBox requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  const tex = texture >>> 0;
  if (!tex) return null;
  if (!(L.read(L.base + GC.flags, 'u32') & GC_FLAGS.drawing)) return null;
  const t = bitsToF32(boxThickness);
  if (!(t > 0)) return null;                       // T <= 0 or NaN -> ret
  const twoT = f32(t + t);
  const dw = bitsToF32(destWidth), dh = bitsToF32(destHeight);
  const dx = bitsToF32(destX), dy = bitsToF32(destY);
  const ox = bitsToF32(orgX), oy = bitsToF32(orgY);
  const out = [];
  const emit = (...a) => {
    const cmd = gcDrawPattern(object, ...a, tex, services);
    if (cmd) out.push(cmd);
  };
  if (!(dw > twoT) || !(dh > twoT)) {              // destW/dH <= 2T or NaN
    emit(destX, destY, destWidth, destHeight, orgX, orgY);
    return out;
  }
  emit(destX, destY, destWidth, boxThickness, orgX, orgY);                    // TOP
  emit(destX, f32BitsOf(f32(dy + dh - t)), destWidth, boxThickness,
       orgX, f32BitsOf(f32(oy + dh - t)));                                    // BOTTOM
  const h2 = f32(dh - twoT);
  const dyT = f32(dy + t), oyT = f32(oy + t);
  emit(destX, f32BitsOf(dyT), boxThickness, f32BitsOf(h2), orgX, f32BitsOf(oyT)); // LEFT
  emit(f32BitsOf(f32(dx + dw - t)), f32BitsOf(dyT), boxThickness, f32BitsOf(h2),
       f32BitsOf(f32(ox + dw - t)), f32BitsOf(oyT));                          // RIGHT
  return out;
}

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const f32BitsOf = v => { F32[0] = v; return U32[0]; };

export const execGcDrawBox = gcDrawBox;
