/**
 * Recovered Extension.dll XGC::DrawActor (native 1288) and XGC::ClearZ
 * (native 1295) translation. Evidence and the algorithm step by step:
 * docs/gc-draw-actor.md; oracle scripts/native-gc-draw-actor-oracle.py runs
 * the real exec and method bodies.
 *
 *   DrawActor exec 0x1002cd80 -> method 0x1002aa60 (ret 0x1c)
 *   ClearZ    exec 0x1002cee0 -> method 0x1002ae40
 *
 * The method saves the actor's bHidden / bUnlit / DrawScale / Style /
 * ScaleGlow / skins (and, for bConstrain, the scene frame's XB, YB, X, Y),
 * optionally shrinks the frame to the GC's clip box (x87 at the render
 * pass's precision control 24), applies the draw state, optionally clears Z,
 * calls URenderBase::DrawActor(Frame, Actor) through the canvas, then
 * restores everything it changed.
 *
 * Memory it touches is reached through `services`:
 *   mem, objectAddress   the GC and the canvas/viewport/frame images
 *                        (UCanvas +0x78 Viewport, +0x7c Frame, +0x80 Render;
 *                        UViewport +0x64 RenDev; FSceneNode +0xa8 X, +0xac Y,
 *                        +0xb0 XB, +0xb4 YB)
 *   actor.read(actor)    {hidden, unlit, style, drawScale, scaleGlow (raw
 *                        dwords), skins[9]: MultiSkins[0..7] then Skin}
 *   actor.write(actor, {hidden?, unlit?, style?, drawScale?, scaleGlow?, skins?})
 *   render.clearZ(renDev, frame)               RenDev vtable +0x90
 *   render.drawActor(render, frame, actor)     URenderBase vtable +0x74
 *   render.computeRenderSize(frame)            Engine FSceneNode::ComputeRenderSize
 * The float arguments arrive as raw u32 bit patterns, as the other GC draw
 * natives take them.
 */
import {GC, GC_DLL, GC_FLAGS, gcMemory} from './script-gc-state-model.mjs';
import {bitsToF32, f32Bits} from './script-gc-draw-model.mjs';
import {r24prod, r24sum} from './x87-pc24.mjs';

const freeze = Object.freeze;
const f32 = Math.fround;

export const GC_DRAW_ACTOR_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.DrawActor',
  packageExport: 2151,
  nativeIndex: 1288,
  functionFlags: 0x401,
  serialSize: 49,
  ...GC_DLL,
  msvcrtSha256: 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
  execBody: 0x1002cd80,
  execEnd: 0x1002ceba,
  execSha256: '162a2b30d7d7a0e652b6bf197bfff88e4a754801417d7062d3a7443a3dc24ee3',
  methodBody: 0x1002aa60,
  methodEnd: 0x1002ae03,
  methodSha256: '3c67cf8b8505aa91c43101748c4e76d1d0860828e899d79eee71700b5cc715bb',
});

export const GC_CLEAR_Z_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.ClearZ',
  packageExport: 2171,
  nativeIndex: 1295,
  functionFlags: 0x401,
  serialSize: 27,
  ...GC_DLL,
  execBody: 0x1002cee0,
  execEnd: 0x1002ceef,
  execSha256: 'c0e6c4b0a6c176c370d71d594d27ada38b2a23f6febef20cccb10f024bca08b3',
  methodBody: 0x1002ae40,
  methodEnd: 0x1002ae92,
  methodSha256: '7b04cf39bb1203b7ddfaa021c2579c1e6f1c21781fe62ac4f574c270ded0abf9',
});

/** UCanvas / UViewport / FSceneNode offsets the bodies use (SDK layouts). */
export const DRAW_ACTOR_LAYOUT = freeze({
  canvasViewport: 0x78, canvasFrame: 0x7c, canvasRender: 0x80, viewportRenDev: 0x64,
  frameX: 0xa8, frameY: 0xac, frameXB: 0xb0, frameYB: 0xb4,
});

/** The values GC.DrawActor's exec starts its locals with. */
export const DRAW_ACTOR_DEFAULTS = freeze({bClearZ: 0, bConstrain: 0, bUnlit: 0, drawScale: 0x3f800000, scaleGlow: 0x3f800000, skin: null});

/**
 * MSVCRT _ftol (the shipped body forces truncation, then `fistp qword`; eax
 * is the low dword). NaN and magnitudes of 2^63 and more are the integer
 * indefinite 0x8000000000000000 whose low dword is 0, which `|0` also gives
 * here: every operand has a 24-bit significand, so any magnitude of 2^56 or
 * more is a multiple of 2^32 and NaN converts to 0. The tile sink adds +0.1
 * first (script-gc-draw-model.mjs ftolBiased); this body does not.
 */
export const ftolTruncate = v => Math.trunc(v) | 0;

export class GcDrawActorBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY'} = {}) {
    super(message);
    this.name = 'GcDrawActorBoundaryError';
    this.code = `GC_DRAW_ACTOR_${kind}`;
  }
}

const service = (services, group, name) => {
  const fn = services?.[group]?.[name];
  if (typeof fn !== 'function')
    throw new GcDrawActorBoundaryError(`GC.DrawActor needs the ${group}.${name} service`, {kind: 'SERVICE'});
  return fn;
};

/**
 * Method 0x1002aa60 (and the exec's own gate: actor and drawing). `bClearZ`,
 * `bConstrain` and `bUnlit` are the argument dwords, `drawScale` and
 * `scaleGlow` raw float bits, `skin` an opaque texture reference (null: none).
 */
export function gcDrawActor(object, actor, bClearZ, bConstrain, bUnlit, drawScale, scaleGlow, skin, services = {}) {
  const L = gcMemory(object, services);
  if (!(L.read(L.base + GC.flags, 'u32') & GC_FLAGS.drawing)) return;
  const canvas = L.read(L.base + GC.canvas, 'u32');
  if (!canvas || !actor) return;
  const D = DRAW_ACTOR_LAYOUT;
  const frame = L.read(canvas + D.canvasFrame, 'u32');
  const readActor = service(services, 'actor', 'read'), writeActor = service(services, 'actor', 'write');
  const render = services.render;
  // 1. Save.
  const saved = readActor(actor);
  const savedFrame = {
    xb: L.read(frame + D.frameXB, 'i32'), yb: L.read(frame + D.frameYB, 'i32'),
    x: L.read(frame + D.frameX, 'i32'), y: L.read(frame + D.frameY, 'i32'),
  };
  // 2. bConstrain: the frame becomes the GC's clip box.
  if (bConstrain) {
    const fXB = f32(savedFrame.xb), fYB = f32(savedFrame.yb), fX = f32(savedFrame.x), fY = f32(savedFrame.y);
    const hm = L.read(L.base + GC.unknown9c, 'i32'), vm = L.read(L.base + GC.unknownA0, 'i32');
    const originX = L.read(L.base + GC.originX, 'f32'), originY = L.read(L.base + GC.originY, 'f32');
    const clipX = L.read(L.base + GC.clipX, 'f32'), clipY = L.read(L.base + GC.clipY, 'f32');
    const clipW = L.read(L.base + GC.clipWidth, 'f32'), clipH = L.read(L.base + GC.clipHeight, 'f32');
    const t0 = f32(r24prod(hm, originX)), t1 = f32(r24prod(vm, originY));
    const t2 = f32(r24prod(hm, clipX)), t3 = f32(r24prod(vm, clipY));
    const t4 = f32(r24prod(hm, clipW)), t5 = f32(r24prod(vm, clipH));
    const left = f32(r24sum(t2, t0)), top = f32(r24sum(t3, t1));
    const frameRight = f32(r24sum(fX, fXB));
    const frameBottom = r24sum(fY, fYB);               // an x87 register value, never stored
    const clipRight = r24sum(left, t4);                // likewise
    const clipBottom = f32(r24sum(top, t5));
    // fcomp: an unordered operand skips the first, third and fourth
    // replacements and takes the second.
    let x0 = fXB, y0 = fYB, right = frameRight, bottom = frameBottom;
    if (left > x0) x0 = left;
    if (!(y0 >= top)) y0 = top;
    if (frameRight > clipRight) right = f32(clipRight);
    if (frameBottom > clipBottom) bottom = clipBottom;
    const dx = f32(r24sum(x0, -fXB)), dy = f32(r24sum(y0, -fYB)), width = f32(r24sum(right, -x0));
    const height = r24sum(bottom, -y0);                // st0, converted without a store
    L.write(frame + D.frameXB, 'i32', ftolTruncate(dx));
    L.write(frame + D.frameYB, 'i32', ftolTruncate(dy));
    L.write(frame + D.frameX, 'i32', ftolTruncate(width));
    L.write(frame + D.frameY, 'i32', ftolTruncate(height));
    service(services, 'render', 'computeRenderSize')(frame);
  }
  // 3. The draw state.
  const apply = {hidden: 0, unlit: bUnlit & 1, style: L.read(L.base + GC.style, 'u8'), scaleGlow: scaleGlow >>> 0,
    drawScale: f32Bits(r24prod(bitsToF32(drawScale), bitsToF32(saved.drawScale)))};
  if (skin) apply.skins = Array(9).fill(skin);
  writeActor(actor, apply);
  // 4. Render.
  if (bClearZ) {
    const viewport = L.read(canvas + D.canvasViewport, 'u32');
    service(services, 'render', 'clearZ')(L.read(viewport + D.viewportRenDev, 'u32'), frame);
  }
  service(services, 'render', 'drawActor')(L.read(canvas + D.canvasRender, 'u32'), frame, actor);
  // 5. Restore.
  const restore = {hidden: saved.hidden, unlit: saved.unlit, drawScale: saved.drawScale, style: saved.style, scaleGlow: saved.scaleGlow};
  if (skin) restore.skins = saved.skins;
  writeActor(actor, restore);
  if (bConstrain) {
    L.write(frame + D.frameXB, 'i32', savedFrame.xb);
    L.write(frame + D.frameYB, 'i32', savedFrame.yb);
    L.write(frame + D.frameX, 'i32', savedFrame.x);
    L.write(frame + D.frameY, 'i32', savedFrame.y);
    service(services, 'render', 'computeRenderSize')(frame);
  }
}

/**
 * Exec 0x1002cd80: the seven argument expressions (an omitted optional one,
 * `undefined`, keeps the exec's default local), then the method when the
 * actor is non-null and the GC's drawing flag is set. The exec advances the
 * frame's Code by 8 (seven tokens and EX_EndFunctionParms); ClearZ's by 1.
 */
export function execGcDrawActor(object, args, services = {}) {
  const [actor, bClearZ, bConstrain, bUnlit, drawScale, scaleGlow, skin] = args;
  const D = DRAW_ACTOR_DEFAULTS;
  gcDrawActor(object, actor ?? null, bClearZ ?? D.bClearZ, bConstrain ?? D.bConstrain, bUnlit ?? D.bUnlit,
    drawScale ?? D.drawScale, scaleGlow ?? D.scaleGlow, skin ?? D.skin, services);
}

/** Method 0x1002ae40: the canvas viewport's render device clears Z for the canvas frame. */
export function gcClearZ(object, services = {}) {
  const L = gcMemory(object, services);
  const canvas = L.read(L.base + GC.canvas, 'u32');
  if (!canvas) return;
  const D = DRAW_ACTOR_LAYOUT;
  const viewport = L.read(canvas + D.canvasViewport, 'u32');
  service(services, 'render', 'clearZ')(L.read(viewport + D.viewportRenDev, 'u32'), L.read(canvas + D.canvasFrame, 'u32'));
}
