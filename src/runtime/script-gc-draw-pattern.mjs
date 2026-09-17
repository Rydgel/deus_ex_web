/**
 * Recovered Extension.dll UGC::DrawPattern translation (native 1285,
 * export 2124, flags 0x401, serialSize 49).
 *
 *   exec 0x1002c680 -> method 0x10028a60 -> draw sink 0x1002a820
 *     -> clip helper 0x1002a4f0 -> canvas vtable slot +0x5c.
 *
 * The method gates on tX != 0 and GC+0x48 bit1 (drawing), then calls the
 * draw sink with the source extent pinned to a single texel and BOTH
 * pixel-tracking flags set:
 *
 *   sink(tX, DestX, DestY, destWidth, destHeight,
 *        OrgX, OrgY, 0, 0, flagW=1, flagH=1)
 *
 * flagW=flagH=1 puts the clip helper on its pixel-tracking path: the source
 * rect tracks the clipped dest pixels 1:1 (s.ul = s.w, s.vl = s.h) and the
 * OrgX/OrgY source offset shifts by the clip delta — the original "pattern"
 * fill semantics where the dest rect samples the texture anchored at the
 * Org point.
 *
 * All float params arrive as raw u32 bit patterns; `texture` is the object
 * heap pointer.  Returns the emitted DrawTile command or null when a gate
 * suppressed it.
 *
 * Evidence: docs/script-gc-draw-model.md; oracle
 * scripts/native-gc-draw-pattern-oracle.py executes the real bodies.
 */
import {GC, GC_DLL, GC_FLAGS, gcMemory} from './script-gc-state-model.mjs';
import {bitsToF32, gcDrawTileSink} from './script-gc-draw-model.mjs';

const freeze = Object.freeze;

export const GC_DRAW_PATTERN_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.DrawPattern',
  packageExport: 2124,
  nativeIndex: 1285,
  functionFlags: 0x401,
  serialSize: 49,
  ...GC_DLL,
  msvcrtSha256: 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
  execBody: 0x1002c680,
  execEnd: 0x1002c7c0,
  execSha256: 'ca7bc8e9abea39d716d909d3a9553fcd39080a8e61a0a81098048a829555dab7',
  methodBody: 0x10028a60,
  methodEnd: 0x10028b00,
  methodSha256: '216aebcb5e1cdfa899b4f2fb1d1983b168c29e3168490482560c8ef754df2fa5',
});

export class GcDrawPatternBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcDrawPatternBoundaryError';
    this.code = `GC_DRAW_PATTERN_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcDrawPatternBoundaryError(message, details);
};

/**
 * Method 0x10028a60: texture/drawing gates, then the sink with zero source
 * extents and both pixel-tracking flags — the helper's per-axis
 * `s.ul = s.w / s.vl = s.h` assignments make the clipped pixel count the
 * emitted UV extent.
 */
export function gcDrawPattern(object, destX, destY, destWidth, destHeight,
                              orgX, orgY, texture, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.DrawPattern requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  const tex = texture >>> 0;
  if (!tex) return null;
  if (!(L.read(L.base + GC.flags, 'u32') & GC_FLAGS.drawing)) return null;
  return gcDrawTileSink(L, {
    texture: tex,
    x: bitsToF32(destX), y: bitsToF32(destY),
    w: bitsToF32(destWidth), h: bitsToF32(destHeight),
    u: bitsToF32(orgX), v: bitsToF32(orgY),
    ul: 0, vl: 0,
    flagW: 1, flagH: 1,
  });
}

export const execGcDrawPattern = gcDrawPattern;
