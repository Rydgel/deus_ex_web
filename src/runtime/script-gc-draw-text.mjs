/**
 * Recovered Extension.dll UGC::DrawText translation (native 1282,
 * export 2106, flags 0x401, serialSize 43).
 *
 *   exec 0x1002c280 — evaluates DestX/DestY/destWidth/destHeight/textStr
 *     through GNatives, substitutes the static empty wstring when the
 *     FString num is 0, calls the method, tears the FString down through
 *     FArray::Realloc/Remove.
 *   method 0x10028180 — gates on GC+0x48 bit1 (drawing), canvas (GC+0x28)
 *     and the text pointer, copies the text color (GC+0x6c) into the emit
 *     state, snapshots curFont = normalFont (GC+0x7c), computes
 *     wrapInt = wordWrap ? ftol(destWidth) : 0, then PushGC ->
 *     Intersect(DestX, DestY, destWidth, destHeight) -> optional vAlign
 *     measure -> per-line scan + per-glyph drawGlyph -> PopGC.
 *   scan wrapper 0x10029d80 / scanner 0x10029ae0 / nextChar 0x100294d0 —
 *     the same pipeline GetTextExtent uses (script-gc-get-text-extent.mjs).
 *   drawGlyph 0x10029e40 — glyph lookup (uFontGlyph), texture realize
 *     (0x1002a370), world-space clip, then FRenderInterface::DrawTile at
 *     *(*(canvas+0x7c)+0x64) vtable +0x7c — the SAME boundary the real
 *     UCanvas::DrawTile (Engine.dll 0x10376160) delegates to internally.
 *     A second emit draws the underline when the emit state's '|&' flag
 *     and the GC underline data (tex +0x84, height +0x88) are set.
 *   realize 0x1002a370 — 5-record MRU texture cache (Extension .bss
 *     0x100a2630, head 0x100a2dc8, count 0x100a2dc4); a full cache forces
 *     the tail record out (Unlock old, Lock new), a texture of 0 returns
 *     the static record 0x100aeb20 without locking.
 *
 * The glyph emit's 21-dword arg block: (sceneNode, FTextureInfo record,
 * X, Y, XL, YL, U, V, UL, VL, spanBuffer=0, Z, Color FPlane, Fog FPlane,
 * polyFlags) — the scene-node/record pair replaces DrawTile's texture
 * arg, the fog plane is the constant (0,0,0,0) the FPlane ctor builds
 * from four zero args, and the text polyflags (GC+0x50) are the trailing
 * dword (pushed before the ctor, surviving its arg cleanup).
 *
 * Coordinate marshalling matches the tile sink: X/Y/XL/YL = f32(imul(
 * ftol(v + 0.1), multiplier)), U/V/UL/VL = f32(ftol(v + 0.1)).
 *
 * Float params arrive as raw u32 bit patterns; `text` is the string value
 * (0 models a null FString data pointer — the method gate).  The realize
 * cache needs services.texCache = {records: [5 addrs], static: addr,
 * head: 0, count: 0} — the addresses back the emitted `record` fields and
 * carry the oracle's rec0..4/recStatic labels.
 *
 * Evidence: docs/script-gc-draw-model.md; oracle
 * scripts/native-gc-draw-text-oracle.py executes the real bodies.
 */
import {GC, GC_DLL, GC_FLAGS, GC_TEXT_FLAGS, gcMemory} from './script-gc-state-model.mjs';
import {GC_DRAW, bitsToF32, f32Bits, ftolBiased} from './script-gc-draw-model.mjs';
import {uFontGlyph} from './script-font-model.mjs';
import {copyTextFloats, gcTextExtentUnits, nextChar, scanLine,
        STATE_AMP, STATE_BOLD, STATE_COLOR, STATE_SIZE, stateView,
        textUnits} from './script-gc-get-text-extent.mjs';
import {gcPushGC} from './script-gc-push-gc.mjs';
import {gcIntersect} from './script-gc-intersect.mjs';
import {gcPopGC} from './script-gc-pop-gc.mjs';

const freeze = Object.freeze;
const f32 = Math.fround;

export const GC_DRAW_TEXT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.DrawText',
  packageExport: 2106,
  nativeIndex: 1282,
  functionFlags: 0x401,
  serialSize: 43,
  ...GC_DLL,
  msvcrtSha256: 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
  execBody: 0x1002c280,
  execEnd: 0x1002c440,
  execSha256: '6ab2fb7c59664e77d6fec2d6104f11ecefb928b4f6db84eb2bfdf568e69c64f7',
  methodBody: 0x10028180,
  methodEnd: 0x10028470,
  methodSha256: 'f2d32a36c4267489a9a2f4aabb35890220bbd04b28aa46ca2d8676d2ccac1f44',
});

/** Helper bodies this module translates (preferred-base ranges + sha256). */
export const GC_DRAW_TEXT_BODIES = freeze({
  drawGlyph: {body: 0x10029e40, end: 0x1002a370,
              sha256: 'b00c46153b187f41fb87b5b137475e012579c929de74d79ab7bb692c82ece2a3'},
  realize:   {body: 0x1002a370, end: 0x1002a4f0,
              sha256: 'f3645a02211a14375f5deef5f8a90a62ca4a1fb2f312f7e29606f2a12436c527'},
  scanWrap:  {body: 0x10029d80, end: 0x10029e40,
              sha256: 'f645209a655d951793a4e5068722fc753fe9cf3825afa8c427c000e40c890936'},
});

/** Canvas/render-graph fields and cache constants the glyph path reads. */
const TEXT_DRAW = freeze({
  canvasViewport: 0x78,   // canvas -> viewport (realize Lock args source)
  canvasSceneNode: 0x7c,  // canvas -> FSceneNode (glyph emit arg0)
  viewportRI: 0x64,       // *sceneNode / viewport -> FRenderInterface
  glyphSlot: 0x7c,        // FRenderInterface vtable slot -> DrawTile
  texLockSlot: 0x54,      // UTexture vtable: Lock(record, b0, b4, -1, RI)
  texUnlockSlot: 0x58,    // UTexture vtable: Unlock(record)
  recordNext: 0x80,       // FTextureInfo record link field
  cacheSize: 5,           // record slots at Extension 0x100a2630
  minLineH: 0x1005aa18,   // f32 1.0 the line-height floor compares against
});

export class GcDrawTextBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcDrawTextBoundaryError';
    this.code = `GC_DRAW_TEXT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcDrawTextBoundaryError(message, details);
};

/**
 * Virtual call into a faked boundary slot — same shape as the shared
 * gcCallDrawTile: read the object's vtable, pull the slot's function
 * pointer and hand (slot, this, payload) to services.callVirtual.
 */
function callSlot(L, object, slotOffset, payload, label) {
  const vtable = L.read(object, 'u32');
  const slot = L.read(vtable + slotOffset, 'u32');
  const call = L.services.callVirtual;
  if (typeof call !== 'function')
    fail(`no callVirtual service for the ${label} boundary`,
      {kind: 'SERVICE', value: slot});
  const crossed = call(slot, object, payload);
  if (crossed && typeof crossed.then === 'function')
    fail(`${label} boundary suspended`, {kind: 'ASYNC'});
  return crossed;
}

/**
 * Texture realize cache 0x1002a370: MRU list of five FTextureInfo records
 * keyed by the texture pointer at record+0.  A null texture returns the
 * static record untouched; a live lookup unlinks the hit and re-heads it;
 * a miss inserts the next free slot or — when all five are live — forces
 * the tail record out (Unlock on the evicted texture, Lock on the new).
 * The Lock call fills record+0 with the texture (the Lock stub/service
 * performs the write, matching UTexture::Lock's FTextureInfo init).
 */
function gcTextRealize(L, canvas, tex) {
  const st = L.services.texCache;
  if (!st || !Array.isArray(st.records) || st.records.length !== TEXT_DRAW.cacheSize)
    fail('GC.DrawText requires services.texCache (5 record slots + static record)',
      {kind: 'SERVICE'});
  if (!tex) return st.static;
  let rec = st.head | 0;
  let prev = 0;
  for (;;) {
    if (!rec) {
      // Miss at list end: append a fresh record (or overflow to static).
      if (st.count >= TEXT_DRAW.cacheSize) return st.static;
      rec = st.records[st.count];
      st.count++;
      break;
    }
    const next = L.read(rec + TEXT_DRAW.recordNext, 'u32');
    const forceTail = next === 0 && st.count >= TEXT_DRAW.cacheSize;
    if (!forceTail && L.read(rec, 'u32') !== tex) {
      prev = rec;
      rec = next;
      continue;
    }
    // Hit (or forced tail): unlink `rec` from its position.
    if (prev) L.write(prev + TEXT_DRAW.recordNext, 'u32', next);
    else st.head = next;
    break;
  }
  const cur = L.read(rec, 'u32');
  if (cur !== tex) {
    if (cur !== 0)
      callSlot(L, cur, TEXT_DRAW.texUnlockSlot, {record: rec}, 'TextureUnlock');
    const vp = L.read(canvas + TEXT_DRAW.canvasViewport, 'u32');
    callSlot(L, tex, TEXT_DRAW.texLockSlot, {
      record: rec,
      b0: L.read(vp + 0xb0, 'u32'),
      b4: L.read(vp + 0xb4, 'u32'),
      arg3: 0xffffffff,
      ri: L.read(vp + TEXT_DRAW.viewportRI, 'u32'),
    }, 'TextureLock');
  }
  // MRU re-head.
  L.write(rec + TEXT_DRAW.recordNext, 'u32', st.head | 0);
  st.head = rec;
  return rec;
}

/** The 21-dword glyph emit block handed to FRenderInterface::DrawTile —
 *  DrawTile's full layout: the scene-node/FTextureInfo pair leads, the fog
 *  plane is a constant (0,0,0,0) (the FPlane ctor reads the four zero args),
 *  and the text polyflags (GC+0x50) are the trailing arg. */
function glyphCommand(L, canvas, sceneNode, record, wx, wy, w, h, u, v, color) {
  const hMult = L.read(L.base + GC_DRAW.hMultiplier, 'i32');
  const vMult = L.read(L.base + GC_DRAW.vMultiplier, 'i32');
  const polyFlags = L.read(L.base + GC.textPolyFlags, 'u32');
  return freeze({
    op: 'DrawGlyphTile',
    node: sceneNode,
    record,
    x: f32Bits(Math.imul(ftolBiased(wx), hMult)),
    y: f32Bits(Math.imul(ftolBiased(wy), vMult)),
    xl: f32Bits(Math.imul(ftolBiased(w), hMult)),
    yl: f32Bits(Math.imul(ftolBiased(h), vMult)),
    u: f32Bits(ftolBiased(u)),
    v: f32Bits(ftolBiased(v)),
    ul: f32Bits(ftolBiased(w)),
    vl: f32Bits(ftolBiased(h)),
    spanBuffer: 0,
    z: L.read(canvas + GC_DRAW.canvasZ, 'u32'),
    color: freeze([...color]),
    fog: freeze([0, 0, 0, 0]),
    polyFlags,
  });
}

/**
 * drawGlyph 0x10029e40 translated.  `state` is the emit state's 20 bytes
 * (color at STATE_COLOR, underline flag at STATE_AMP); `x`/`y` are the
 * glyph's unclipped dest position; `penX`/`glyphH` model the out pointers
 * ({v} cells — penX advances by the raw f32(uSize), glyphH takes the raw
 * f32(vSize), both written before any clipping).
 */
export function drawGlyph(L, font, ch, state, x, y, penX, glyphH) {
  const base = L.base;
  const canvas = L.read(base + GC.canvas, 'u32');
  const sceneNode = L.read(canvas + TEXT_DRAW.canvasSceneNode, 'u32');
  const glyph = uFontGlyph(L, font, ch);
  const record = gcTextRealize(L, canvas, glyph.texture);
  const originX = L.read(base + GC.originX, 'f32');
  const originY = L.read(base + GC.originY, 'f32');
  let wx = f32(x + originX);
  let wy = f32(y + originY);
  let w = f32(glyph.uSize);
  let h = f32(glyph.vSize);
  let u = f32(glyph.startU);
  let v = f32(glyph.startV);
  if (penX) penX.v = f32(w + penX.v);
  if (glyphH) glyphH.v = h;

  const clipLeft = f32(L.read(base + GC.clipX, 'f32') + originX);
  const clipTop = f32(L.read(base + GC.clipY, 'f32') + originY);
  if (!(wx >= clipLeft)) {              // wx < clipLeft or unordered
    const d = wx - clipLeft;
    u = f32(u - d);
    wx = clipLeft;
    w = f32(w + d);
  }
  if (!(wy >= clipTop)) {
    const d = wy - clipTop;
    v = f32(v - d);
    wy = clipTop;
    h = f32(h + d);
  }
  const clipRight = clipLeft + L.read(base + GC.clipWidth, 'f32');
  if (w + wx > clipRight)               // ordered destRight > clipRight
    w = f32(clipRight - wx);
  const clipBottom = clipTop + L.read(base + GC.clipHeight, 'f32');
  if (h + wy > clipBottom)
    h = f32(clipBottom - wy);
  if (!(w > 0) || !(h > 0)) return;

  const view = stateView(state);
  const color = [0, 1, 2, 3].map(i => view.getUint32(STATE_COLOR + 4 * i, true));
  const ri = L.read(L.read(sceneNode, 'u32') + TEXT_DRAW.viewportRI, 'u32');
  callSlot(L, ri, TEXT_DRAW.glyphSlot,
    glyphCommand(L, canvas, sceneNode, record, wx, wy, w, h, u, v, color),
    'DrawGlyphTile');

  // Underline: the '|&' flag byte, an underline texture (GC+0x84) and a
  // positive underline height (GC+0x88) gate a second emit under the
  // glyph — same clip rules, source (0,0), width uSize-1, height from
  // GC+0x88, worldY = f32(vSize) - baselineOffset + originY + y.
  if (state[STATE_AMP] === 0) return;
  const underlineTex = L.read(base + GC.unknown84, 'u32');
  if (underlineTex === 0) return;
  const ulHeight = L.read(base + GC.underlineHeight, 'f32');
  if (!(ulHeight > 0)) return;
  const record2 = gcTextRealize(L, canvas, underlineTex);
  let u2 = 0, v2 = 0;
  let w2 = f32(glyph.uSize - 1);
  let h2 = ulHeight;
  let wx2 = f32(x + originX);
  let wy2 = f32(glyph.vSize - L.read(base + GC.baselineOffset, 'f32') + originY + y);
  if (!(wx2 >= clipLeft)) {
    const d = wx2 - clipLeft;
    u2 = f32(-d);
    wx2 = clipLeft;
    w2 = f32(w2 + d);
  }
  if (!(wy2 >= clipTop)) {
    const d = wy2 - clipTop;
    v2 = f32(-d);
    wy2 = clipTop;
    h2 = f32(h2 + d);
  }
  if (w2 + wx2 > clipRight)
    w2 = f32(clipRight - wx2);
  if (h2 + wy2 > clipBottom)
    h2 = f32(clipBottom - wy2);
  if (!(w2 > 0) || !(h2 > 0)) return;
  callSlot(L, ri, TEXT_DRAW.glyphSlot,
    glyphCommand(L, canvas, sceneNode, record2, wx2, wy2, w2, h2, u2, v2, color),
    'DrawGlyphTile');
}

/**
 * Method 0x10028180 translated.  `text` is the string value; 0 models the
 * null FString data pointer (the method's early-out gate).  The exec
 * body substitutes the static empty wstring for num == 0, so an empty
 * string still reaches the method here.
 */
export function gcDrawText(object, destX, destY, destWidth, destHeight, text, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.DrawText requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  const base = L.base;
  if (!(L.read(base + GC.flags, 'u32') & GC_FLAGS.drawing)) return;
  if (!L.read(base + GC.canvas, 'u32')) return;
  // The gate is on the FString data pointer, not emptiness: the exec body
  // substitutes a valid empty wstring for num == 0, so '' still runs.
  if (text === 0 || text === null || text === undefined) return;
  const units = typeof text === 'string' ? textUnits(text) : Uint16Array.from(text);

  const dx = bitsToF32(destX);
  const dy = bitsToF32(destY);
  const dw = bitsToF32(destWidth);
  const dh = bitsToF32(destHeight);

  const stateA = new Uint8Array(STATE_SIZE);   // emit state [ebp-0x58]
  copyTextFloats(L, base, stateA);             // color = GC+0x6c
  let curFont = L.read(base + GC.normalFont, 'u32');   // [ebp-0x1c]
  let curBold = 0;                                     // [ebp+0x1b]
  const wrapInt = (L.read(base + GC.textFlags, 'u32') & GC_TEXT_FLAGS.wordWrap)
    ? Math.trunc(dw) | 0 : 0;                          // [ebp-0x20]

  gcPushGC(object, services);
  gcIntersect(object, dx, dy, dw, dh, services);

  let lineY = dy;                              // [ebp+0xc] — current line origin
  const vAlign = L.read(base + GC.vAlign, 'u8');
  if (vAlign !== 0) {
    const m = gcTextExtentUnits(L, f32(wrapInt), units);
    if (vAlign === 1) {
      const half = Math.trunc(Math.trunc(dh - m.yExtent) / 2) | 0;
      lineY = f32(half + lineY);
    } else if (vAlign === 2) {
      lineY = f32(lineY + dh - m.yExtent);
    }
  }

  const stateB = new Uint8Array(STATE_SIZE);   // scan state [ebp-0x6c]
  const cursor = {pos: 0};                     // [ebp-0x2c] — scan cursor
  const end = units.length;
  for (;;) {
    stateB.set(stateA);                        // loop-head copy A -> B
    const line = scanLine(L, base, cursor, end, stateB, units, f32(wrapInt));
    if (!line.progress) break;
    const lineW = line.width;                  // [ebp-0x24]
    const lineEnd = line.start + line.len;     // [ebp-0x38]

    const hAlign = L.read(base + GC.hAlign, 'u8');
    let penX;                                  // [ebp-0x14]
    if (hAlign === 1) {
      const half = Math.trunc(Math.trunc(dw - lineW) / 2) | 0;
      penX = f32(half + dx);
    } else if (hAlign === 2) {
      penX = f32(dx + dw - lineW);
    } else {
      penX = dx;
    }

    const emitCur = {pos: line.start};         // [ebp-0x3c]
    const penCell = {v: penX};                 // [ebp-0x14] in/out
    const hCell = {v: 0};                      // [ebp+0x14] — glyphH out
    let lineMaxH = 0;                          // [ebp-0x18]
    for (;;) {
      const ch = nextChar(L, base, emitCur, lineEnd, stateA, units);
      if (ch === 0) break;
      const cl = stateA[STATE_BOLD];
      if (cl !== curBold) {
        curFont = cl ? L.read(base + GC.boldFont, 'u32')
                     : L.read(base + GC.normalFont, 'u32');
        curBold = cl;
      }
      if (ch === 0x0a || curFont === 0) continue;
      drawGlyph(L, curFont, ch, stateA, penCell.v, lineY, penCell, hCell);
      if (!(lineMaxH >= hCell.v)) lineMaxH = hCell.v;
    }

    if (!(lineMaxH >= 1) && curFont !== 0)
      lineMaxH = f32(uFontGlyph(L, curFont, 0x20).vSize);
    lineY = f32(lineMaxH + L.read(base + GC.textVSpacing, 'f32') + lineY);
    stateA.set(stateB);                        // line end: A <- B
  }

  gcPopGC(object, -1, services);   // the method calls the -1 body 0x100279f0
}

export const execGcDrawText = gcDrawText;
