/**
 * Recovered Extension.dll UGC::DrawIcon translation (native 1283,
 * export 2112, flags 0x401, serialSize 37).
 *
 *   exec 0x1002c460 -> method 0x100289c0 -> leaf 0x10028850
 *     -> draw sink 0x1002a820 -> clip helper 0x1002a4f0
 *     -> canvas vtable slot +0x5c (Engine UCanvas::DrawTile).
 *
 * The exec trampoline evaluates the three params through GNatives and calls
 * the method with (DestX, DestY, tX).  The method gates on tX != 0 and
 * GC+0x48 bit1 (drawing), converts the texture's i32 USize/VSize (+0x34/+0x38)
 * to f32 for the dest size, and calls the shared leaf 0x10028850 which
 * re-applies the same two gates and calls the draw sink directly —
 * flagW/flagH are literal 0 (proportional clip, never pixel-tracking), with
 * the source rect anchored at (0,0) and sized to the texture.
 *
 * Effective emission:
 *   sink(tX, DestX, DestY, f32(USize), f32(VSize), 0, 0,
 *        f32(USize), f32(VSize), flagW=0, flagH=0)
 *
 * Float params arrive as raw u32 bit patterns; `texture` is the object heap
 * pointer.  Returns the emitted DrawTile command or null when a gate
 * suppressed it.
 *
 * Evidence: docs/script-gc-draw-model.md; oracle
 * scripts/native-gc-draw-icon-oracle.py executes the real bodies.
 */
import {GC, GC_DLL, GC_FLAGS, gcMemory} from './script-gc-state-model.mjs';
import {bitsToF32, gcDrawTileSink} from './script-gc-draw-model.mjs';

const freeze = Object.freeze;

export const GC_DRAW_ICON_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.DrawIcon',
  packageExport: 2112,
  nativeIndex: 1283,
  functionFlags: 0x401,
  serialSize: 37,
  ...GC_DLL,
  msvcrtSha256: 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
  execBody: 0x1002c460,
  execEnd: 0x1002c500,
  execSha256: 'ebe614377b08c423b6db52605cba902661001875a7d86cd43f10ae56889f4c19',
  methodBody: 0x100289c0,
  methodEnd: 0x10028a60,
  methodSha256: 'd0b39441b8ff423eced5c21c73e1aa5a40e3be8979bdd633fe767c3d19a3b79a',
  leafBody: 0x10028850,
  leafEnd: 0x10028900,
  leafSha256: '0aaada47c389152a57048644d0b4cc771385205c01903f2f473928f5bc5c6bfb',
});

export class GcDrawIconBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcDrawIconBoundaryError';
    this.code = `GC_DRAW_ICON_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcDrawIconBoundaryError(message, details);
};

/**
 * Method 0x100289c0 + leaf 0x10028850: texture/drawing gates in both bodies
 * (identical and idempotent — modelled once), then the sink with the dest
 * size equal to the texture's f32(USize)/f32(VSize) and the source rect
 * covering the whole texture.
 */
export function gcDrawIcon(object, destX, destY, texture, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.DrawIcon requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  const tex = texture >>> 0;
  if (!tex) return null;
  if (!(L.read(L.base + GC.flags, 'u32') & GC_FLAGS.drawing)) return null;
  const uSize = L.read(tex + 0x34, 'i32');
  const vSize = L.read(tex + 0x38, 'i32');
  return gcDrawTileSink(L, {
    texture: tex,
    x: bitsToF32(destX), y: bitsToF32(destY),
    w: Math.fround(uSize), h: Math.fround(vSize),
    u: 0, v: 0,
    ul: Math.fround(uSize), vl: Math.fround(vSize),
    flagW: 0, flagH: 0,
  });
}

export const execGcDrawIcon = gcDrawIcon;
