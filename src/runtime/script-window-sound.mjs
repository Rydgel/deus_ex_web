/** Original Window.PlaySound native 1473; deferred audio call boundary.
 * Extension 0x10053820 -> 0x10050050. See docs/script-window-sound.md. */
import {refValue, x87load as X, x87add as A, x87neg as N, x87mul as M,
  x87div as D, x87store as S, x87ftol as T} from './script-vm.mjs';
import {fcoordsAxes} from './script-pawn-locomotion.mjs';
import {getRootWindow, ROOT, O} from './script-window-tree-natives.mjs';

const sub = (a, b) => A(a, N(b));
const below = (a, b) => {
  const difference = sub(a, b);
  return difference.nan !== undefined || !!(difference.neg && (difference.inf || difference.sig !== 0n));
};
const half = value => S(M(X(value), X(.5)));

/** Full native calculation through audio's PlaySound virtual call arguments.
 * W.deferWindowSound records the request while the audio device is unbound.
 * W.soundPawnFields returns original Location/ViewRotation as arrays.
 */
export function windowPlaySound(W, win, sound, volume = -1, pitch = 1, posX, posY) {
  // The C++ centered overload (0x1004ffb0) evaluates height before width.
  if (posY === undefined) posY = half(W.f32(win, O.height));
  if (posX === undefined) posX = half(W.f32(win, O.width));
  volume = Math.fround(volume); pitch = Math.fround(pitch);
  posX = Math.fround(posX); posY = Math.fround(posY);
  const requestedVolume = volume;
  if (volume === -1 || Number.isNaN(volume)) volume = W.f32(win, 0x114);
  const root = getRootWindow(W, win), pawnRoot = getRootWindow(W, win);
  const pawn = pawnRoot ? W.ptr(pawnRoot, ROOT.parentPawn) : null;
  if (!root || !pawn || !sound) return;
  let invisibleAncestor = win;
  while (invisibleAncestor && (W.u8(invisibleAncestor, O.flags) & 1))
    invisibleAncestor = W.ptr(invisibleAncestor, O.parent);
  let pan = 0;
  if (!invisibleAncestor && (W.u8(root, 0x5c0) & 1)) {
    const x = S(sub(A(X(posX), X(W.f32(win, 0xd4))), X(W.f32(root, 0xd4))));
    let width = X(W.f32(root, O.width));
    if (below(width, X(1))) width = X(1);
    const value = sub(D(A(X(x), X(x)), width), X(1));
    pan = below(value, X(-1)) ? -1 : below(value, X(1)) ? S(value) : 1;
  }
  volume = S(M(D(X(100), sub(X(100), X(1))), X(volume)));
  const fields = W.soundPawnFields(pawn);
  const rotation = fields.viewRotation.map(v => v | 0);
  rotation[0] = 0;
  rotation[1] = (rotation[1] + T(M(X(pan), X(16384)))) | 0;
  const axis = fcoordsAxes(rotation)[1];
  const location = axis.map((v, i) => S(A(X(S(M(X(v), X(1)))), X(fields.location[i]))));
  const request = {window: win, sound, root, pawn, requestedVolume, posX, posY, pan,
    actor: null, id: 0, location, volume, radius: 100, pitch};
  W.deferWindowSound(request);
  return request;
}

export function dispatchWindowSoundNative(W, call) {
  if (call.index !== 1473) return {handled: false};
  const win = call.receiver;
  const arg = (i, fallback) => i < call.argumentCount ? refValue(call.evaluateArgument(i)) ?? fallback : fallback;
  const sound = arg(0, null), volume = arg(1, -1), pitch = arg(2, 1);
  // Each default dimension is read immediately before its own argument.
  const posX = arg(3, half(W.f32(win, O.width)));
  const posY = arg(4, half(W.f32(win, O.height)));
  windowPlaySound(W, win, sound, volume, pitch, posX, posY);
  return {handled: true, value: undefined};
}
