/**
 * Shared recovered model for the Extension.dll UGC tile-drawing boundary —
 * the command-capture layer every GC draw native funnels through.
 *
 * Chain (all Extension.dll bodies at image base 0x10000000):
 *   gate 0x10028770  — tX != 0, GC+0x48 bit1 (drawing), computes the two
 *                      zero-source-size flags, forwards 11 args to the sink.
 *   sink 0x1002a820  — drawing + canvas (GC+0x28) non-null gates, calls the
 *                      clip helper, post-checks clipped destW/destH/UL/VL > 0,
 *                      then calls the canvas vtable slot +0x5c (DrawTile).
 *   clip 0x1002a4f0  — origin add (GC+0x2c/+0x30), clip rect (GC+0x34..+0x40),
 *                      per-axis pixel-tracking or proportional-UV clipping and
 *                      texture-edge clamps that read tex+0x34/+0x38 (i32
 *                      USize/VSize).
 *
 * The boundary call is Engine UCanvas::DrawTile (vtable slot +0x5c, the
 * UCanvas vtable at Engine.dll 0x10428eec holds 0x103019fb there):
 *   DrawTile(UTexture*, FLOAT X, FLOAT Y, FLOAT XL, FLOAT YL,
 *            FLOAT U, FLOAT V, FLOAT UL, FLOAT VL,
 *            FSpanBuffer*, FLOAT Z, FPlane Color, FPlane Fog, DWORD PolyFlags)
 * thiscall, callee cleans 0x50 bytes.
 *
 * Marshalling recovered from the sink body:
 *   X  = f32(ftol(clippedX + 0.1) * hMultiplier)   GC+0x9c i32
 *   Y  = f32(ftol(clippedY + 0.1) * vMultiplier)   GC+0xa0 i32
 *   XL = f32(ftol(clippedW + 0.1) * hMultiplier)
 *   YL = f32(ftol(clippedH + 0.1) * vMultiplier)
 *   U/V/UL/VL = f32(ftol(clipped + 0.1))           (no multiplier)
 *   span = 0, Z = canvas+0x4c (f32 bits forwarded raw),
 *   Color = FPlane copy of GC+0x58 (tilePlane), Fog = FPlane(0,0,0,0),
 *   PolyFlags = GC+0x4c.
 * ftol is MSVCRT _ftol (0x78004dc1 in the shipped MSVCRT.dll): it sets the
 * FPU RC field to truncate (or ah,0x0c) then fistp — i.e. C-style (int)cast
 * of (value + 0.1), NOT round-to-nearest.
 *
 * The GC draws from PaintWindows (XRootWindow::PostRender, reached from
 * PostRenderFlash), inside the render pass: x87 precision control 24
 * (docs/render-pass-precision.md). Every FADD, FSUB, FMUL and FDIV of the clip
 * helper and the `+ 0.1` before each _ftol round to 24 bits with the
 * register's wide exponent (x87-pc24.mjs).
 *
 * Evidence: disassembly of the bodies above (scripts/native-gc-draw-probe.py
 * runs them unmodified under Unicorn); docs/script-gc-draw-model.md.
 */
import {GC, GC_DLL, GC_FLAGS, gcMemory} from './script-gc-state-model.mjs';
import {r24, r24sum} from './x87-pc24.mjs';

const freeze = Object.freeze;

/** Boundary + clip constants recovered from the native bodies. */
export const GC_DRAW = freeze({
  canvas: GC.canvas,          // 0x28 — GC field holding the UCanvas object
  drawTileSlot: 0x5c,         // UCanvas vtable slot for DrawTile
  canvasZ: 0x4c,              // f32 canvas field pushed as the DrawTile Z arg
  tilePlane: GC.tileFloats,   // 0x58 — Color FPlane source (4 f32)
  tilePolyFlags: GC.polyFlags,// 0x4c — DrawTile PolyFlags arg source
  hMultiplier: 0x9c,          // i32 integer multiplier applied AFTER ftol
  vMultiplier: 0xa0,          // i32 (Extension.u: GC.hMultiplier/vMultiplier)
  textureUSize: 0x34,         // i32 UBitmap field the tex-edge clamp reads
  textureVSize: 0x38,
  zeroF32: 0x10059884,        // f32 0.0 constant every fcomp compares against
  ftolBias: 0x1005e470,       // f64 0.1 constant added before each _ftol
  clipHelper: 0x1002a4f0,
  tileSink: 0x1002a820,
  tileGate: 0x10028770,
  canvasVtable: 0x10428eec,   // Engine.dll UCanvas vtable (DrawTile slot owner)
  drawTileImpl: 0x103019fb,   // Engine.dll UCanvas::DrawTile thunk target
});

/** Shared body ranges + sha-256 (preferred-base bytes) this model translates. */
export const GC_DRAW_BODIES = freeze({
  tileGate:   {body: 0x10028770, end: 0x10028830,
               sha256: '930bddf65c0cdd7635922b70ca6fa73dcc1c9b86e11418c961892685a30c1a3f'},
  tileSink:   {body: 0x1002a820, end: 0x1002aa40,
               sha256: '8ac3b4038577918be928c24ad7b40225b57ab909fb9c097cca8c02b14d47b93a'},
  clipHelper: {body: 0x1002a4f0, end: 0x1002a818,
               sha256: '5253a2976eb52492299cb266fd4dde1b1c4d2de75aefd17c08e3fc534f30365f'},
});

/** f64 0.1 — the qword constant at 0x1005e470 (bits 0x3fb999999999999a). */
export const GC_DRAW_FTOL_BIAS = (() => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, 0x3fb999999999999an, true);
  return view.getFloat64(0, true);
})();

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const f32 = v => Math.fround(v);
/** f32 bit pattern of an f32-valued number. */
export const f32Bits = v => { F32[0] = f32(v); return U32[0]; };
/** f32 value from a raw u32 bit pattern. */
export const bitsToF32 = b => { U32[0] = b >>> 0; return F32[0]; };

/**
 * MSVCRT _ftol applied to the x87 value st0 after the caller's f64 +0.1 bias:
 * the real body switches RC to truncate and fistp's, so the result is the
 * toward-zero integer of (v + 0.1), the sum rounded once to 24 bits (FADD
 * m64 at precision control 24).  `|0` keeps the low eax dword, matching the
 * i64 -> eax truncation for out-of-range inputs.
 */
export const ftolBiased = v => Math.trunc(r24sum(v, GC_DRAW_FTOL_BIAS)) | 0;

// The clip helper's x87 operations at precision control 24 on 24-bit
// register values (x87-pc24.mjs r24: the f64 result rounded once more is
// the PC 24 result). The texture-edge stage's FILD'd USize/VSize, an int
// that can exceed 24 bits, goes through r24sum instead.
const add = (a, b) => r24(a + b), sub = (a, b) => r24(a - b);
const mul = (a, b) => r24(a * b), div = (a, b) => r24(a / b);

export class GcDrawBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcDrawBoundaryError';
    this.code = `GC_DRAW_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const drawFail = (message, details) => {
  throw new GcDrawBoundaryError(message, details);
};

/**
 * The DrawTile command record handed across the canvas boundary.  All float
 * fields carry raw u32 bit patterns (f32 bits), matching the dwords the
 * native sink pushes; `texture`/`canvas` are heap pointers canonicalised by
 * the capture service.
 */
export function drawTileCommand({texture, x, y, xl, yl, u, v, ul, vl, z, color, fog, polyFlags}) {
  return freeze({
    op: 'DrawTile',
    texture, x, y, xl, yl, u, v, ul, vl,
    spanBuffer: 0,
    z,
    color: freeze([...color]),
    fog: freeze([...fog]),
    polyFlags: polyFlags >>> 0,
  });
}

/**
 * The canvas boundary call — the native `call dword ptr [vtable+0x5c]`.
 * Reads GC+0x28 (canvas), *canvas (vtable), *(vtable+0x5c) (slot) from the
 * heap, then hands the marshalled command to services.callVirtual — the
 * command-capture sink the app/validator supplies.  Anything missing or
 * unreadable is a boundary error, never silently dropped.
 */
export function gcCallDrawTile(L, command) {
  const canvas = L.read(L.base + GC_DRAW.canvas, 'u32');
  const vtable = L.read(canvas, 'u32');
  const slot = L.read(vtable + GC_DRAW.drawTileSlot, 'u32');
  const call = L.services.callVirtual;
  if (typeof call !== 'function')
    drawFail('no callVirtual service for the canvas DrawTile boundary',
      {kind: 'SERVICE', value: slot});
  const crossed = call(slot, canvas, command);
  if (crossed && typeof crossed.then === 'function')
    drawFail('canvas DrawTile boundary suspended', {kind: 'ASYNC'});
  return crossed;
}

/**
 * Clip helper 0x1002a4f0 translated.  `s` is a mutable record of f32-valued
 * numbers {x, y, w, h, u, v, ul, vl} — the sink's stack slots the body
 * rewrites in place.  flagW/flagH are the gate's (srcSize == 0.0) ints.
 * `tex` is the texture heap pointer; its i32 +0x34/+0x38 fields are read only
 * on the proportional path, exactly where the body reads them.
 *
 * Every store into `s` is f32-rounded (the body's fstp dword); the values the
 * body keeps on the stack (the clip deltas, the right/bottom edges, the
 * texture-edge end) are 24-bit register values, one rounding per FADD, FSUB,
 * FMUL and FDIV in the body's order (0x1002a4f0-0x1002a814).
 */
export function gcClipTile(L, s, flagW, flagH, tex) {
  const base = L.base;
  const readF = off => L.read(base + off, 'f32');

  // *x += orgX; *y += orgY; clipLeft = clipX + orgX; clipTop = clipY + orgY.
  s.x = f32(add(readF(GC.originX), s.x));
  s.y = f32(add(readF(GC.originY), s.y));
  const clipLeft = f32(add(readF(GC.clipX), readF(GC.originX)));
  const clipTop = f32(add(readF(GC.clipY), readF(GC.originY)));

  if (flagW) {
    // Pixel-tracking mode (srcW == 0): UVs follow the clipped pixels 1:1.
    if (!(s.x >= clipLeft)) {                       // *x < clipLeft or unordered
      const d = sub(s.x, clipLeft);
      s.u = f32(sub(s.u, d));
      s.w = f32(add(d, s.w));
      s.x = clipLeft;
    }
    const clipRight = add(clipLeft, readF(GC.clipWidth));
    if (add(s.x, s.w) > clipRight)                  // ordered destRight > clipRight
      s.w = f32(sub(clipRight, s.x));
    s.ul = s.w;
  } else {
    // Proportional UV mode (srcW != 0).
    if (s.w > 0 && !(s.x >= clipLeft)) {
      const d = sub(s.x, clipLeft);
      const t = div(mul(d, s.ul), s.w);
      s.ul = f32(add(t, s.ul));
      s.u = f32(sub(s.u, t));
      s.w = f32(add(d, s.w));
      s.x = clipLeft;
    }
    if (s.w > 0) {
      const destRight = add(s.x, s.w);
      const clipRight = add(clipLeft, readF(GC.clipWidth));
      if (destRight > clipRight) {
        s.ul = f32(add(div(mul(sub(clipRight, destRight), s.ul), s.w), s.ul));
        s.w = f32(sub(add(clipLeft, readF(GC.clipWidth)), s.x));
      }
    }
    if (s.ul > 0) {
      if (!(s.u >= 0)) {                            // *u < 0 or unordered
        const d = div(mul(s.u, s.w), s.ul);
        s.w = f32(add(d, s.w));
        s.x = f32(sub(s.x, d));
        s.ul = f32(add(s.u, s.ul));
        s.u = 0;
      }
      const texW = L.read(tex + GC_DRAW.textureUSize, 'i32');
      const uEnd = add(s.u, s.ul);
      if (uEnd > texW) {
        s.w = f32(add(div(mul(r24sum(texW, -uEnd), s.w), s.ul), s.w));
        s.ul = f32(r24sum(texW, -s.u));
      }
    }
  }

  if (flagH) {
    if (!(s.y >= clipTop)) {
      const d = sub(s.y, clipTop);
      s.v = f32(sub(s.v, d));
      s.h = f32(add(d, s.h));
      s.y = clipTop;
    }
    const clipBottom = add(clipTop, readF(GC.clipHeight));
    if (add(s.y, s.h) > clipBottom)
      s.h = f32(sub(clipBottom, s.y));
    s.vl = s.h;
  } else {
    if (s.h > 0 && !(s.y >= clipTop)) {
      const d = sub(s.y, clipTop);
      const t = div(mul(d, s.vl), s.h);
      s.vl = f32(add(t, s.vl));
      s.v = f32(sub(s.v, t));
      s.h = f32(add(d, s.h));
      s.y = clipTop;
    }
    if (s.h > 0) {
      const destBottom = add(s.y, s.h);
      const clipBottom = add(clipTop, readF(GC.clipHeight));
      if (destBottom > clipBottom) {
        s.vl = f32(add(div(mul(sub(clipBottom, destBottom), s.vl), s.h), s.vl));
        s.h = f32(sub(add(clipTop, readF(GC.clipHeight)), s.y));
      }
    }
    if (s.vl > 0) {
      if (!(s.v >= 0)) {
        const d = div(mul(s.v, s.h), s.vl);
        s.h = f32(add(d, s.h));
        s.y = f32(sub(s.y, d));
        s.vl = f32(add(s.v, s.vl));
        s.v = 0;
      }
      const texH = L.read(tex + GC_DRAW.textureVSize, 'i32');
      const vEnd = add(s.v, s.vl);
      if (vEnd > texH) {
        s.h = f32(add(div(mul(r24sum(texH, -vEnd), s.h), s.vl), s.h));
        s.vl = f32(r24sum(texH, -s.v));
      }
    }
  }
}

/**
 * Draw sink 0x1002a820 translated.  `args` mirrors the callee stack:
 * {texture, x, y, w, h, u, v, ul, vl, flagW, flagH} — texture is a heap
 * pointer, the coord/UV slots are f32-valued numbers, flags are ints.
 * Returns the emitted DrawTile command, or null when a gate suppresses it.
 */
export function gcDrawTileSink(L, args) {
  if (!(L.read(L.base + GC.flags, 'u32') & GC_FLAGS.drawing)) return null;
  if (!L.read(L.base + GC_DRAW.canvas, 'u32')) return null;

  const s = {x: args.x, y: args.y, w: args.w, h: args.h,
             u: args.u, v: args.v, ul: args.ul, vl: args.vl};
  gcClipTile(L, s, args.flagW, args.flagH, args.texture);

  // Post-clip suppression, in the body's check order (fcomp vs 0.0f).
  if (!(s.w > 0) || !(s.h > 0) || !(s.ul > 0) || !(s.vl > 0)) return null;
  if (!args.texture) return null;

  const canvas = L.read(L.base + GC_DRAW.canvas, 'u32');
  const hMult = L.read(L.base + GC_DRAW.hMultiplier, 'i32');
  const vMult = L.read(L.base + GC_DRAW.vMultiplier, 'i32');
  const color = [0, 1, 2, 3].map(i => L.read(L.base + GC_DRAW.tilePlane + 4 * i, 'u32'));
  const command = drawTileCommand({
    texture: args.texture,
    x: f32Bits(Math.imul(ftolBiased(s.x), hMult)),
    y: f32Bits(Math.imul(ftolBiased(s.y), vMult)),
    xl: f32Bits(Math.imul(ftolBiased(s.w), hMult)),
    yl: f32Bits(Math.imul(ftolBiased(s.h), vMult)),
    u: f32Bits(ftolBiased(s.u)),
    v: f32Bits(ftolBiased(s.v)),
    ul: f32Bits(ftolBiased(s.ul)),
    vl: f32Bits(ftolBiased(s.vl)),
    z: L.read(canvas + GC_DRAW.canvasZ, 'u32'),
    color,
    fog: [0, 0, 0, 0],
    polyFlags: L.read(L.base + GC_DRAW.tilePolyFlags, 'u32'),
  });
  gcCallDrawTile(L, command);
  return command;
}

/**
 * Tile-emit gate 0x10028770 translated: texture/drawing gates, the two
 * (srcSize == 0.0f or unordered) flags, then the sink.  Shared by every
 * single-tile draw native — DrawTexture passes srcW/srcH equal to destW/destH.
 */
export function gcTileEmitGate(L, {texture, x, y, w, h, u, v, ul, vl}) {
  if (!texture) return null;
  if (!(L.read(L.base + GC.flags, 'u32') & GC_FLAGS.drawing)) return null;
  const zeroOrUnordered = a => !(a > 0) && !(a < 0);
  return gcDrawTileSink(L, {
    texture, x, y, w, h, u, v, ul, vl,
    flagW: zeroOrUnordered(ul) ? 1 : 0,
    flagH: zeroOrUnordered(vl) ? 1 : 0,
  });
}
