/**
 * Recovered AActor::FinishAnim (native 261) and its latent poll (0x181).
 *
 * The caller supplies the existing animationView shape and the actor's
 * state-frame view.  This module deliberately does not advance animation
 * fields: the original native only advances FFrame.Code, examines the
 * already-written animation values, and installs/polls one latent action.
 *
 * Evidence: docs/script-finish-anim.md and the hash-verified Engine.dll body
 * at 0x103dff60 (execFinishAnim) and 0x103e00a0 (execPollFinishAnim).
 */

const freeze = value => Object.freeze(value);

/** Actor flags used by Actor.uc's first boolean word at +0x28. */
export const FINISH_ANIM_FLAGS = freeze({
  AnimFinished: 0x08,
  AnimLoop: 0x10,
  AnimNotify: 0x20,
});

/** The latent action installed by execFinishAnim and polled by the engine. */
export const FINISH_ANIM_LATENT_ACTION = 0x181;

/** Static address/byte contract for the installed GOTY Engine.dll image. */
export const FINISH_ANIM_NATIVE_CONTRACT = freeze({
  package: 'Engine',
  class: 'Actor',
  nativeIndex: 261,
  latentAction: FINISH_ANIM_LATENT_ACTION,
  engineSha256: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  execThunk: 0x103037ba,
  execBody: 0x103dff60,
  execThunkBytes: freeze([0xe9, 0xa1, 0xc7, 0x0d, 0x00]),
  execBodyBytes: freeze([
    0x8b, 0x44, 0x24, 0x04, 0x8b, 0x50, 0x0c, 0x42, 0x89, 0x50, 0x0c,
    0x8b, 0x41, 0x28, 0xa8, 0x10, 0x74, 0x05, 0x24, 0xe7, 0x89, 0x41,
    0x28, 0x8b, 0x41, 0x54, 0x85, 0xc0, 0x74, 0x4d, 0xd9, 0x41, 0x58,
    0xd8, 0x1d, 0x54, 0x6d, 0x42, 0x10, 0xdf, 0xe0, 0xf6, 0xc4, 0x01,
    0x75, 0x13, 0xd9, 0x41, 0x5c, 0xdc, 0x1d, 0x38, 0x98, 0x42, 0x10,
    0xdf, 0xe0, 0xf6, 0xc4, 0x40, 0x74, 0x13, 0xc2, 0x08, 0x00, 0xd9,
    0x41, 0x60, 0xdc, 0x1d, 0x38, 0x98, 0x42, 0x10, 0xdf, 0xe0, 0xf6,
    0xc4, 0x40, 0x75, 0x1a, 0xd9, 0x41, 0x58, 0xd8, 0x99, 0x20, 0x02,
    0x00, 0x00, 0xdf, 0xe0, 0xf6, 0xc4, 0x01, 0x74, 0x0a, 0x8b, 0x41,
    0x0c, 0xc7, 0x40, 0x24, 0x81, 0x01, 0x00, 0x00, 0xc2, 0x08, 0x00,
  ]),
  pollThunk: 0x1030240a,
  pollBody: 0x103e00a0,
  pollThunkBytes: freeze([0xe9, 0x91, 0xdc, 0x0d, 0x00]),
  pollBodyBytes: freeze([
    0xf6, 0x41, 0x28, 0x08, 0x74, 0x0a, 0x8b, 0x41, 0x0c, 0xc7, 0x40,
    0x24, 0x00, 0x00, 0x00, 0x00, 0xc2, 0x08, 0x00,
  ]),
  actorOffsets: freeze({
    stateFrame: 0x0c,
    flags: 0x28,
    animSequence: 0x54,
    animFrame: 0x58,
    animRate: 0x5c,
    tweenRate: 0x60,
    animLast: 0x220,
  }),
  stateFrameLatentOffset: 0x24,
  constants: freeze({
    zeroSingle: freeze({ address: 0x10426d54, bytes: [0x00, 0x00, 0x00, 0x00], value: 0 }),
    zeroDouble: freeze({
      address: 0x10429838,
      bytes: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      value: 0,
    }),
  }),
});

function requireObject(value, name) {
  if (value === null || typeof value !== 'object') throw new TypeError(`${name} requires an object`);
  return value;
}

function float32(value, name) {
  if (value === undefined) throw new Error(`FinishAnim reached an uninitialized ${name}`);
  return Math.fround(Number(value));
}

function hasAnimationSequence(value) {
  if (value === null || value === undefined || value === 0 || value === false) return false;
  return !(typeof value === 'string' && value.toLowerCase() === 'none');
}

function orderedNonZero(value) {
  // x87 FCOM/FCOML sets C3 for equality and unordered.  The native continues
  // only for an ordered, nonzero AnimRate or TweenRate.
  return !Number.isNaN(value) && value !== 0;
}

function advanceFrameCode(frame) {
  requireObject(frame, 'FinishAnim FFrame');
  if (!Number.isInteger(frame.code)) throw new Error('FinishAnim requires FFrame.Code as an integer');
  // INC is a 32-bit operation in the native body, so retain wraparound.
  frame.code = ((frame.code >>> 0) + 1) >>> 0;
}

/**
 * Execute the recovered `AActor::execFinishAnim` body.
 *
 * `animation` is the existing animationView object; `state` is the state
 * frame's logical `{latent}` object; `frame.code` represents FFrame+0x0c.
 * The native returns void.  A pre-existing latent value is preserved on every
 * path which does not reach the final install store.
 */
export function execFinishAnim({ animation, frame, state } = {}) {
  requireObject(animation, 'FinishAnim animation view');
  advanceFrameCode(frame);

  return finishAnimBody(animation, state);
}

/**
 * Execute the same body after the decoded ScriptVM has already advanced its
 * bytecode cursor.  The VM cursor is the semantic equivalent of native
 * FFrame.Code+1, so this entry intentionally has no synthetic `frame.code`
 * increment.  Native/oracle callers should use execFinishAnim instead.
 */
export function dispatchFinishAnim({ animation, state } = {}) {
  requireObject(animation, 'FinishAnim animation view');
  return finishAnimBody(animation, state);
}

function finishAnimBody(animation, state) {

  // `andb $0xe7, Actor+0x28` clears only bAnimFinished (0x08) and bAnimLoop
  // (0x10) when bAnimLoop was set.  The low bit and all high flag bits survive.
  const flags = (Number(animation.animFlags ?? 0) >>> 0);
  if (flags & FINISH_ANIM_FLAGS.AnimLoop)
    animation.animFlags = (flags & ~0x18) >>> 0;

  if (!hasAnimationSequence(animation.AnimSequence)) return;

  const animFrame = float32(animation.AnimFrame, 'AnimFrame');
  const rateGate = animFrame < 0 || Number.isNaN(animFrame)
    ? float32(animation.TweenRate, 'TweenRate')
    : float32(animation.AnimRate, 'AnimRate');
  if (!orderedNonZero(rateGate)) return;

  const animLast = float32(animation.AnimLast, 'AnimLast');
  // FCOMS sets C0 for less-than *or unordered*.  Consequently a NaN frame or
  // AnimLast reaches the native latent store after the ordered rate gate.
  if (!(animFrame < animLast || Number.isNaN(animFrame) || Number.isNaN(animLast))) return;
  requireObject(state, 'FinishAnim state frame');
  state.latent = FINISH_ANIM_LATENT_ACTION;
}

/** Execute the recovered `AActor::execPollFinishAnim` latent poll. */
export function pollFinishAnim({ animation, state } = {}) {
  requireObject(animation, 'PollFinishAnim animation view');
  const flags = Number(animation.animFlags ?? 0) >>> 0;
  if (flags & FINISH_ANIM_FLAGS.AnimFinished) {
    requireObject(state, 'PollFinishAnim state frame');
    state.latent = 0;
  }
}
