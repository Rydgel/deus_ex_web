/**
 * Recovered Extension.dll UGC::DrawStretchedTexture translation
 * (native 1287, export 2141, flags 0x401, serialSize 55).
 *
 *   exec 0x1002cbc0 -> draw sink 0x1002a820 -> clip helper 0x1002a4f0
 *     -> canvas vtable slot +0x5c (Engine UCanvas::DrawTile).
 *
 * There is no separate method body: the exec trampoline evaluates the nine
 * params, gates on tX != 0 and GC+0x48 bit1 (drawing), and calls the draw
 * sink directly with literal-zero pixel-tracking flags:
 *
 *   sink(tX, DestX, DestY, destWidth, destHeight,
 *        srcX, srcY, srcWidth, srcHeight, flagW=0, flagH=0)
 *
 * so the clip helper always takes the proportional-UV path.
 *
 * All float params arrive as raw u32 bit patterns; `texture` is the object
 * heap pointer.  Returns the emitted DrawTile command or null when a gate
 * suppressed it.
 *
 * Evidence: docs/script-gc-draw-model.md; oracle
 * scripts/native-gc-draw-stretched-texture-oracle.py executes the real body.
 */
import {GC, GC_DLL, GC_FLAGS, gcMemory} from './script-gc-state-model.mjs';
import {bitsToF32, gcDrawTileSink} from './script-gc-draw-model.mjs';

const freeze = Object.freeze;

export const GC_DRAW_STRETCHED_TEXTURE_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.DrawStretchedTexture',
  packageExport: 2141,
  nativeIndex: 1287,
  functionFlags: 0x401,
  serialSize: 55,
  ...GC_DLL,
  msvcrtSha256: 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
  execBody: 0x1002cbc0,
  execEnd: 0x1002cd60,
  execSha256: 'df46e259232755da52f5ac167f44aff6ccfb0201ef866410638d18b1185bee1f',
});

export class GcDrawStretchedTextureBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcDrawStretchedTextureBoundaryError';
    this.code = `GC_DRAW_STRETCHED_TEXTURE_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcDrawStretchedTextureBoundaryError(message, details);
};

/**
 * Exec 0x1002cbc0: texture/drawing gates, then the sink with every coord
 * forwarded verbatim and flagW/flagH literal zeros.
 */
export function gcDrawStretchedTexture(object, destX, destY, destWidth, destHeight,
                                       srcX, srcY, srcWidth, srcHeight, texture,
                                       services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.DrawStretchedTexture requires a canonical GC object',
         {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  const tex = texture >>> 0;
  if (!tex) return null;
  if (!(L.read(L.base + GC.flags, 'u32') & GC_FLAGS.drawing)) return null;
  return gcDrawTileSink(L, {
    texture: tex,
    x: bitsToF32(destX), y: bitsToF32(destY),
    w: bitsToF32(destWidth), h: bitsToF32(destHeight),
    u: bitsToF32(srcX), v: bitsToF32(srcY),
    ul: bitsToF32(srcWidth), vl: bitsToF32(srcHeight),
    flagW: 0, flagH: 0,
  });
}

export const execGcDrawStretchedTexture = gcDrawStretchedTexture;
