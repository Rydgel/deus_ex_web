/**
 * Recovered Extension.dll UGC::DrawTexture translation (native 1284,
 * export 2116, flags 0x401, serialSize 49).
 *
 *   exec 0x1002c520 -> method 0x10028b00 -> tile-emit gate 0x10028770
 *     -> draw sink 0x1002a820 -> clip helper 0x1002a4f0
 *     -> canvas vtable slot +0x5c (Engine UCanvas::DrawTile).
 *
 * The exec trampoline evaluates the seven params through GNatives and calls
 * the method with (DestX, DestY, destWidth, destHeight, srcX, srcY, tX).
 * The method gates on tX != 0 and GC+0x48 bit1 (drawing), then calls the
 * shared gate with the source rect's size equal to the dest rect's
 * (srcW = destWidth, srcH = destHeight) — so DrawTexture's UV extent always
 * tracks the pixel extent 1:1 before the multipliers.
 *
 * Float params arrive as raw u32 bit patterns (the marshalled dwords); the
 * texture arrives as the object heap pointer.  The emitted DrawTile command
 * is pushed through services.callVirtual at the vtable boundary; the return
 * value is the emitted command or null when a gate suppressed it.
 *
 * Evidence: docs/script-gc-draw-model.md; oracle
 * scripts/native-gc-draw-texture-oracle.py executes the real bodies.
 */
import {GC, GC_DLL, GC_FLAGS, gcMemory} from './script-gc-state-model.mjs';
import {bitsToF32, gcTileEmitGate} from './script-gc-draw-model.mjs';

const freeze = Object.freeze;

export const GC_DRAW_TEXTURE_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.DrawTexture',
  packageExport: 2116,
  nativeIndex: 1284,
  functionFlags: 0x401,
  serialSize: 49,
  ...GC_DLL,
  msvcrtSha256: 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
  execBody: 0x1002c520,
  execEnd: 0x1002c660,
  execSha256: 'baf90503177bdd7ed46f54cc367bf0d60b3a9ea85cb74f963bfdbcb6377a7382',
  methodBody: 0x10028b00,
  methodEnd: 0x10028ba0,
  methodSha256: '8e0c6090448e2de50955a714e81f7850e48c9bd9594a4eccf0b55facfbe32df9',
});

export class GcDrawTextureBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcDrawTextureBoundaryError';
    this.code = `GC_DRAW_TEXTURE_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcDrawTextureBoundaryError(message, details);
};

/**
 * Method body 0x10028b00: tX null gate, drawing gate, then the shared
 * tile-emit gate with srcW/srcH mirroring destWidth/destHeight.
 * Float params are raw u32 bit patterns; `texture` is the heap pointer.
 */
export function gcDrawTexture(object, destX, destY, destWidth, destHeight,
                              srcX, srcY, texture, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.DrawTexture requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  const tex = texture >>> 0;
  if (!tex) return null;
  if (!(L.read(L.base + GC.flags, 'u32') & GC_FLAGS.drawing)) return null;
  return gcTileEmitGate(L, {
    texture: tex,
    x: bitsToF32(destX), y: bitsToF32(destY),
    w: bitsToF32(destWidth), h: bitsToF32(destHeight),
    u: bitsToF32(srcX), v: bitsToF32(srcY),
    ul: bitsToF32(destWidth), vl: bitsToF32(destHeight),
  });
}

export const execGcDrawTexture = gcDrawTexture;
