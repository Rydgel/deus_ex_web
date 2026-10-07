/**
 * The Extension XViewportWindow family (ViewportWindow.uc): a window that
 * renders the world from an actor or a location into its rectangle. The
 * security computers' camera views, the spy drone and the targeting zoom
 * use it. Recovered from Extension.dll (SHA-256 93c35502…8b916d9c, preferred
 * base 0x10000000); evidence and checks: docs/script-window-viewport.md,
 * scripts/validate-window-viewport-diff.mjs.
 *
 * Storage (SDK ExtViewport.h, registration size 0x1b4):
 *   +0x14c flags: 1 bEnableViewport, 2 bClearZ, 4 bShowActor, 8 bShowWeapons,
 *          0x10 bUseViewRotation, 0x20 bUseEyeHeight, 0x40 bWatchEyeHeight
 *   +0x150 fov, +0x154 defaultTexture, +0x158 defaultColor,
 *   +0x15c originActor, +0x160 watchActor, +0x164 location,
 *   +0x170 relLocation, +0x17c rotation, +0x188 relRotation,
 *   +0x194 bOriginActorDestroyed, +0x198 lastLocation, +0x1a4 lastRotation,
 *   +0x1b0 viewportFrame (the FSceneNode Draw creates, PostDraw finishes)
 *
 * W is the tree-natives world; actors and the renderer are services (`env`):
 *   env.windowInit(win, parent), env.windowCleanUp(win)  XWindow bodies
 *   env.getRootWindow(win), env.getPlayerPawn(win)
 *   env.addActorRef / removeActorRef / isActorValid(win, actor)
 *   env.actor: location, rotation, viewRotation (int[3]), eyeHeight,
 *     isPawn, isPlayerPawn, hidden/setHidden (Actor.bHidden),
 *     behindView/setBehindView (Pawn.bBehindView), fovBits/setFovBits
 *     (Pawn.FovAngle as its raw dword: Draw copies dwords),
 *     addAdditionalView / removeAdditionalView (APlayerPawn, Engine 0x103ba540
 *     / 0x103ba4c0 over PlayerPawn.AdditionalViews[3])
 *   env.render: getRenderer(win), createMasterFrame(renderer, viewport,
 *     location, rotation) -> frame, computeRenderSize(frame),
 *     clearZ(viewport, frame), drawWorld(renderer, frame),
 *     finishMasterFrame(renderer)
 *   env.processScript, env.gc: pushGC, setStyle, setTileColor, drawPattern,
 *     popGC (the XGC bodies) and env.windowDraw / windowPostDraw (XWindow).
 */
import {x87load as X, x87add as A, x87neg as N, x87mul as M, x87int32 as I, x87store as S,
  x87storeDouble as Q, x87sqrt, x87ftol as T, x87div as D} from './script-vm.mjs';
import {vectorToRotator} from './script-decoration-primitives.mjs';
import {coordsDivideRotator} from './script-window-scene-frame.mjs';

export const VIEWPORT = Object.freeze({
  vtable: 0x1005be08, size: 0x1b4,
  flags: 0x14c, fov: 0x150, defaultTexture: 0x154, defaultColor: 0x158, originActor: 0x15c, watchActor: 0x160,
  location: 0x164, relLocation: 0x170, rotation: 0x17c, relRotation: 0x188, privateFlags: 0x194,
  lastLocation: 0x198, lastRotation: 0x1a4, viewportFrame: 0x1b0,
});
const B = Object.freeze({enable: 1, clearZ: 2, showActor: 4, showWeapons: 8, useViewRotation: 0x10, useEyeHeight: 0x20, watchEyeHeight: 0x40});
const V = VIEWPORT;
const sub = (a, b) => A(a, N(b));
const vec = (W, win, off) => [W.f32(win, off), W.f32(win, off + 4), W.f32(win, off + 8)];
const setVec = (W, win, off, v) => { for (let i = 0; i < 3; i++) W.setF32(win, off + 4 * i, v[i]); };
const rot = (W, win, off) => [W.i32(win, off), W.i32(win, off + 4), W.i32(win, off + 8)];
const setRot = (W, win, off, r) => { for (let i = 0; i < 3; i++) W.setI32(win, off + 4 * i, r[i] | 0); };
const setFlag = (W, win, mask, on) => W.setU32(win, V.flags, ((W.u32(win, V.flags) & ~mask) | (on ? mask : 0)) >>> 0);

/** InternalConstructor 0x10018ae0 -> 0x10018af0: UObject, the
 * XExtensionObject vtable, XClipRect, the XViewportWindow vtable. */
export function constructViewportWindow(W, win) {
  W.uobjectConstructor(win); W.setU32(win, 0, 0x10059888);
  for (let o = 0xd4; o <= 0xe8; o += 4) W.setU32(win, o, 0);
  W.setU32(win, 0, V.vtable);
}

/** Init 0x10049f10: XWindow::Init; bDrawRawBackground (+0x38 bit 0) off;
 * flags |= enable, clearZ, useViewRotation, useEyeHeight, watchEyeHeight with
 * showActor/showWeapons off; fov 90; defaultColor (0,0,0) whose alpha byte is
 * the parent argument slot's high byte; every vector/rotator and both actors
 * cleared; then SetViewportActor(GetPlayerPawn(), TRUE, TRUE). */
export function initViewportWindow(W, win, parent, env) {
  env.windowInit(win, parent);
  W.setU32(win, 0x38, (W.u32(win, 0x38) & ~1) >>> 0);
  W.setU32(win, V.flags, ((W.u32(win, V.flags) & ~0xc) | 0x73) >>> 0);
  W.setU32(win, V.defaultColor, (W.addressOf(parent) & 0xff000000) >>> 0);
  for (const off of [V.location, V.relLocation, V.lastLocation]) setVec(W, win, off, [0, 0, 0]);
  for (const off of [V.rotation, V.relRotation, V.lastRotation]) setRot(W, win, off, [0, 0, 0]);
  W.setF32(win, V.fov, 90);
  W.setPtr(win, V.originActor, null); W.setPtr(win, V.watchActor, null);
  W.setU32(win, V.privateFlags, (W.u32(win, V.privateFlags) & ~1) >>> 0);
  W.setU32(win, V.viewportFrame, 0);
  setViewportActor(W, win, env.getPlayerPawn(win), 1, 1, env);
}

/** CleanUp 0x1004a070: SetViewportActor(NULL, TRUE, TRUE), XWindow::CleanUp. */
export function cleanUpViewportWindow(W, win, env) {
  setViewportActor(W, win, null, 1, 1, env);
  env.windowCleanUp(win);
}

/** SetViewportActor 0x1004a170(actor, bEyeLevel, bEnable). */
export function setViewportActor(W, win, actor, eyeLevel, enable, env) {
  W.setU32(win, V.flags, (((W.u32(win, V.flags) & ~0x21) | (enable & 1)) | ((eyeLevel & 1) << 5)) >>> 0);
  setVec(W, win, V.location, [0, 0, 0]);
  setVec(W, win, V.relLocation, [0, 0, 0]);
  const old = W.ptr(win, V.originActor) ?? null;
  actor ??= null;
  if (old !== actor) {
    const player = env.getPlayerPawn(win);
    if (player) {
      env.actor.removeAdditionalView(player, old);                      // vtable +0xb0
      if (player !== actor) env.actor.addAdditionalView(player, actor);  // vtable +0xac
    }
    env.addActorRef(win, actor);
    env.removeActorRef(win, old);
    W.setPtr(win, V.originActor, actor);
  }
  const origin = W.ptr(win, V.originActor);
  setVec(W, win, V.lastLocation, origin ? env.actor.location(origin) : vec(W, win, V.location));
}

/** SetViewportLocation 0x1004a300(location, bEnable). */
export function setViewportLocation(W, win, location, enable, env) {
  setFlag(W, win, B.enable, enable & 1);
  setVec(W, win, V.location, location);
  setVec(W, win, V.relLocation, [0, 0, 0]);
  const origin = W.ptr(win, V.originActor);
  if (origin) { env.removeActorRef(win, origin); W.setPtr(win, V.originActor, null); }
  setVec(W, win, V.lastLocation, vec(W, win, V.location));
}

/** SetWatchActor 0x1004a400(actor, bEyeLevel): the look-at rotation from
 * lastLocation, through Core FVector::Rotation. */
export function setWatchActor(W, win, actor, eyeLevel, env) {
  setFlag(W, win, B.watchEyeHeight, eyeLevel & 1);
  setRot(W, win, V.rotation, [0, 0, 0]);
  setRot(W, win, V.relRotation, [0, 0, 0]);
  actor ??= null;
  const old = W.ptr(win, V.watchActor) ?? null;
  if (old !== actor) {
    env.addActorRef(win, actor);
    env.removeActorRef(win, old);
    W.setPtr(win, V.watchActor, actor);
  }
  const watch = W.ptr(win, V.watchActor);
  if (!watch) { setRot(W, win, V.lastRotation, rot(W, win, V.rotation)); return; }
  const at = env.actor.location(watch), last = vec(W, win, V.lastLocation);
  setRot(W, win, V.lastRotation, vectorToRotator(at.map((v, i) => S(sub(X(v), X(last[i]))))));
}

/** SetRotation 0x1004a570(rotation). */
export function setViewportRotation(W, win, rotation, env) {
  setRot(W, win, V.rotation, rotation);
  setRot(W, win, V.relRotation, [0, 0, 0]);
  const watch = W.ptr(win, V.watchActor);
  if (watch) { env.removeActorRef(win, watch); W.setPtr(win, V.watchActor, null); }
  setRot(W, win, V.lastRotation, rot(W, win, V.rotation));
}

/** SetFOVAngle 0x1004a660: above 179.0f is 179.0f; below double 0.1 or NaN
 * (C0) is 0.1f. */
export function setFovAngle(W, win, angle) {
  let a = Math.fround(angle);
  if (a > 179) a = 179;
  W.setF32(win, V.fov, a < 0.1 || Number.isNaN(a) ? Math.fround(0.1) : a);
}

/** CalcView 0x1004b180 (vtable +0x11c): ProcessScript(EXTENSION_CalcView,
 * {origin, watch, out location, out rotation}) and the outs copied back. */
export function calcView(win, origin, watch, frame, env) {
  const args = [origin, watch, [...frame.location], [...frame.rotation]];
  env.processScript(win, 'CalcView', args);
  frame.location = args[2].map(Math.fround);
  frame.rotation = args[3].map(v => v | 0);
}

/** GetRenderer 0x1004b2f0: the player's XLevel->Engine->Render, or none. */
const getRenderer = (win, env) => env.render.getRenderer(win);

/** Draw 0x1004a770(gc). */
export function viewportDraw(W, win, gc, env) {
  const root = env.getRootWindow(win);
  if (!root) return;
  const A_ = env.actor;
  let origin = W.ptr(win, V.originActor);
  if (origin && !env.isActorValid(win, origin)) {
    // The origin was destroyed: keep its last frame.
    W.setPtr(win, V.originActor, null);
    setVec(W, win, V.location, vec(W, win, V.lastLocation));
    setVec(W, win, V.relLocation, [0, 0, 0]);
    const last = rot(W, win, V.lastRotation), rel = rot(W, win, V.relRotation);
    setRot(W, win, V.rotation, last.map((v, i) => (v - rel[i]) | 0));
    W.setU32(win, V.privateFlags, (W.u32(win, V.privateFlags) | 1) >>> 0);
    origin = null;
  }
  let watch = W.ptr(win, V.watchActor);
  if (watch && !env.isActorValid(win, watch)) {
    W.setPtr(win, V.watchActor, null);
    setRot(W, win, V.rotation, rot(W, win, V.lastRotation));
    setRot(W, win, V.relRotation, [0, 0, 0]);
    watch = null;
  }
  if (W.u32(win, V.privateFlags) & 1) W.setU32(win, V.privateFlags, (W.u32(win, V.privateFlags) & ~1) >>> 0);
  let drawn = false;
  if (W.u32(win, V.flags) & B.enable) {
    const canvas = W.ptr(gc, 0x28), viewport = canvas ? W.u32(canvas, 0x78) : 0;
    const renderer = getRenderer(win, env);
    let pawn = null, playerOrigin = null;
    if (origin && A_.isPawn(origin)) { pawn = origin; if (A_.isPlayerPawn(origin)) playerOrigin = origin; }
    const player = env.getPlayerPawn(win);
    const flags = W.u32(win, V.flags);
    let location, rotation;
    if (origin) {
      location = A_.location(origin);
      if (pawn && (flags & B.useEyeHeight)) location[2] = S(A(X(location[2]), X(A_.eyeHeight(pawn))));
      rotation = playerOrigin && (flags & B.useViewRotation) ? A_.viewRotation(playerOrigin) : A_.rotation(origin);
    } else {
      location = vec(W, win, V.location); rotation = rot(W, win, V.rotation);
    }
    // relLocation: its length along (relLocation.Rotation() + frame rotation).
    const rel = vec(W, win, V.relLocation).map(X);
    const lengthSquared = A(A(M(rel[0], rel[0]), M(rel[1], rel[1])), M(rel[2], rel[2]));
    const length = S(x87sqrt(Q(lengthSquared)));                       // appSqrt, fstp dword
    const relRotation = vectorToRotator(vec(W, win, V.relLocation));
    const turn = relRotation.map((v, i) => (v + rotation[i]) | 0);
    const axis = coordsDivideRotator(turn).xAxis;
    location = [S(A(M(X(axis[0]), X(length)), X(location[0]))),
      S(A(X(location[1]), M(X(axis[1]), X(length)))),
      S(A(M(X(axis[2]), X(length)), X(location[2])))];
    if (watch) {
      const at = A_.location(watch);
      let z = X(at[2]);
      if ((flags & B.watchEyeHeight) && A_.isPawn(watch)) z = A(z, X(A_.eyeHeight(watch)));
      const dir = [S(sub(X(at[0]), X(location[0]))), S(sub(X(at[1]), X(location[1]))), S(sub(z, X(location[2])))];
      const look = vectorToRotator(dir);
      rotation = [look[0], look[1], look[2]];
    }
    const relRot = rot(W, win, V.relRotation);
    rotation = rotation.map((v, i) => (v + relRot[i]) | 0);
    const frameView = {location, rotation};
    calcView(win, origin, watch, frameView, env);                        // vtable +0x11c
    setVec(W, win, V.lastLocation, frameView.location);
    setRot(W, win, V.lastRotation, frameView.rotation);
    if (renderer && viewport) {
      const frame = env.render.createMasterFrame(renderer, viewport, frameView.location, frameView.rotation);
      if (frame) {
        W.setU32(win, V.viewportFrame, typeof frame === 'number' ? frame : W.addressOf(frame));
        const hMul = W.i32(root, 0x730), vMul = W.i32(root, 0x734);
        let xb = T(M(A(X(W.f32(win, 0xdc)), X(W.f32(win, 0xd4))), I(hMul)));
        let yb = T(M(A(X(W.f32(win, 0xe0)), X(W.f32(win, 0xd8))), I(vMul)));
        const width = T(M(X(W.f32(win, 0xe4)), I(hMul))), height = T(M(X(W.f32(win, 0xe8)), I(vMul)));
        W.setI32(frame, 0xb0, xb); W.setI32(frame, 0xb4, yb); W.setI32(frame, 0xa8, width); W.setI32(frame, 0xac, height);
        const canvasFrame = W.u32(canvas, 0x7c);
        if (canvasFrame) {
          W.setI32(frame, 0xb0, (W.i32(frame, 0xb0) + W.heap.mem.read(canvasFrame + 0xb0, 'i32')) | 0);
          W.setI32(frame, 0xb4, (W.i32(frame, 0xb4) + W.heap.mem.read(canvasFrame + 0xb4, 'i32')) | 0);
        }
        let savedBehind = 0, savedFov = 0, savedHidden = 0;
        if (player) { savedBehind = A_.behindView(player) ? 1 : 0; savedFov = A_.fovBits(player); }
        if (origin) savedHidden = A_.hidden(origin) ? 1 : 0;
        if (player) {
          A_.setBehindView(player, !((flags & B.showWeapons) && player === playerOrigin));
          A_.setFovBits(player, W.u32(win, V.fov));
        }
        if (origin) A_.setHidden(origin, !(flags & B.showActor));
        env.render.computeRenderSize(frame);
        if (W.i32(frame, 0xa8) > 0 && W.i32(frame, 0xac) > 0) {
          const saved = {x: W.i32(canvas, 0x60), y: W.i32(canvas, 0x64), clipX: W.u32(canvas, 0x3c), clipY: W.u32(canvas, 0x40), frame: W.u32(canvas, 0x7c)};
          W.setU32(canvas, 0x7c, W.addressOf(frame));
          W.setI32(canvas, 0x60, W.i32(frame, 0xa8)); W.setI32(canvas, 0x64, W.i32(frame, 0xac));
          W.setF32(canvas, 0x3c, W.i32(frame, 0xa8)); W.setF32(canvas, 0x40, W.i32(frame, 0xac));
          if (flags & B.clearZ) env.render.clearZ(viewport, frame);
          if (W.i32(frame, 0xa8) > 0 && W.i32(frame, 0xac) > 0) env.render.drawWorld(renderer, frame, {win, origin});   // RenderFrame 0x1004b260
          W.setU32(canvas, 0x40, saved.clipY); W.setU32(canvas, 0x3c, saved.clipX); W.setU32(canvas, 0x7c, saved.frame);
          W.setI32(canvas, 0x64, saved.y); W.setI32(canvas, 0x60, saved.x);
          drawn = true;
        }
        if (origin) A_.setHidden(origin, savedHidden);
        if (player) { A_.setFovBits(player, savedFov); A_.setBehindView(player, savedBehind); }
      }
    }
  }
  if (!drawn) {
    env.gc.pushGC(gc);
    env.gc.setStyle(gc, 1);
    env.gc.setTileColor(gc, W.u32(win, V.defaultColor));
    env.gc.drawPattern(gc, 0, 0, W.f32(win, 0x80), W.f32(win, 0x84), 0, 0, W.u32(win, V.defaultTexture));
    env.gc.popGC(gc);
  }
  env.windowDraw(win, gc);
}

/** PostDraw 0x1004af20: XWindow::PostDraw, then FinishMasterFrame. */
export function viewportPostDraw(W, win, gc, env) {
  env.windowPostDraw(win, gc);
  if (W.u32(win, V.viewportFrame)) {
    env.render.finishMasterFrame(getRenderer(win, env));
    W.setU32(win, V.viewportFrame, 0);
  }
}

/** ConvertVectorToCoordinates 0x1004afc0 (vtable): the frame's Coords and
 * projection, without the root's multipliers; needs a frame (assert 0x2cf). */
export function viewportVectorToCoordinates(W, win, vector) {
  const frame = W.u32(win, V.viewportFrame);
  if (!frame) throw new Error('XViewportWindow::ConvertVectorToCoordinates assertion (line 0x2cf): no viewportFrame');
  const mem = W.heap.mem, f = off => mem.read(frame + off, 'f32');
  const rel = [0, 1, 2].map(i => sub(X(vector[i]), X(f(0x34 + 4 * i))));
  const t = [0, 1, 2].map(axis => S(A(A(M(rel[0], X(f(0x40 + 12 * axis))), M(rel[1], X(f(0x44 + 12 * axis)))), M(rel[2], X(f(0x48 + 12 * axis))))));
  if (t[2] > 1) {
    const scale = S(D(X(f(0xdc)), X(t[2])));
    const x = S(I(T(A(M(X(t[0]), X(scale)), X(f(0xc8))))));
    const y = S(I(T(A(M(X(t[1]), X(scale)), X(f(0xcc))))));
    return {visible: true, x, y};
  }
  return {visible: false, x: S(I(T(X(f(0xc8))))), y: S(I(T(X(f(0xcc)))))};
}

/** Engine APlayerPawn::AddAdditionalView 0x103ba540 over AdditionalViews[3]
 * (+0x6a8): a null actor succeeds; otherwise the first empty slot takes it.
 * Returns whether it was stored. */
export function addAdditionalView(views, actor) {
  if (!actor) return true;
  for (let i = 0; i < 3; i++) if (!views[i]) { views[i] = actor; return true; }
  return false;
}

/** Engine APlayerPawn::RemoveAdditionalView 0x103ba4c0: the first slot holding
 * the actor is cleared and the later slots move down one; the last slot keeps
 * its value (it is not cleared after the move). */
export function removeAdditionalView(views, actor) {
  if (!actor) return;
  for (let i = 0; i < 3; i++) {
    if (views[i] !== actor) continue;
    views[i] = null;
    for (let k = i; k < 2; k++) views[k] = views[k + 1];
    return;
  }
}
