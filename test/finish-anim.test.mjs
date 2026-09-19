import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FINISH_ANIM_FLAGS,
  FINISH_ANIM_LATENT_ACTION,
  dispatchFinishAnim,
  execFinishAnim,
  pollFinishAnim,
} from '../src/runtime/finish-anim.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';

function animation(overrides = {}) {
  return {
    AnimSequence: 'Walk',
    AnimFrame: 0,
    AnimRate: 1,
    TweenRate: 1,
    AnimLast: 1,
    animFlags: 0,
    ...overrides,
  };
}

function run(overrides = {}, state = {latent: 0x55}, frame = {code: 0x100}) {
  const view = animation(overrides);
  execFinishAnim({animation: view, frame, state});
  return {view, frame, state};
}

test('FinishAnim advances FFrame.Code and clears finished/loop flags conditionally', () => {
  const {view, frame, state} = run({animFlags: 0x8000001f, AnimSequence: 'None'}, {latent: 0x55}, {code: 0xffffffff});
  assert.equal(frame.code, 0, 'native INC wraps the 32-bit Code word');
  assert.equal(view.animFlags, 0x80000007, 'and 0xe7 clears only bAnimFinished and bAnimLoop');
  assert.equal(state.latent, 0x55, 'a missing sequence returns before the latent store');

  const noLoop = run({animFlags: 0x80000009, AnimFrame: 0, AnimRate: 0, AnimLast: 1});
  assert.equal(noLoop.view.animFlags, 0x80000009, 'flags are untouched when bAnimLoop is clear');
  assert.equal(noLoop.state.latent, 0x55);
});

test('decoded VM dispatch reuses the body without a second Code increment', () => {
  const view = animation({AnimFrame: 0, AnimRate: 1, AnimLast: 1});
  const frame = {code: 0x200};
  const state = {latent: 0};
  dispatchFinishAnim({animation: view, state});
  assert.equal(frame.code, 0x200, 'the decoded VM has already advanced its cursor');
  assert.equal(state.latent, FINISH_ANIM_LATENT_ACTION);
});

test('FinishAnim uses AnimRate for nonnegative frames and TweenRate for negative frames', () => {
  const positive = run({AnimFrame: 0, AnimRate: 2, TweenRate: 0, AnimLast: 1});
  assert.equal(positive.state.latent, FINISH_ANIM_LATENT_ACTION);

  const rateDisabled = run({AnimFrame: 0, AnimRate: 0, TweenRate: 2, AnimLast: 1});
  assert.equal(rateDisabled.state.latent, 0x55, 'TweenRate is ignored for a nonnegative frame');

  const negative = run({AnimFrame: -0.5, AnimRate: 0, TweenRate: 2, AnimLast: 0});
  assert.equal(negative.state.latent, FINISH_ANIM_LATENT_ACTION);

  const tweenDisabled = run({AnimFrame: -0.5, AnimRate: 2, TweenRate: 0, AnimLast: 0});
  assert.equal(tweenDisabled.state.latent, 0x55, 'AnimRate is ignored for a negative frame');
});

test('FinishAnim installs only when the final ordered frame comparison is below AnimLast', () => {
  assert.equal(run({AnimFrame: 1, AnimRate: 1, AnimLast: 1}).state.latent, 0x55);
  assert.equal(run({AnimFrame: 2, AnimRate: 1, AnimLast: 1}).state.latent, 0x55);
  assert.equal(run({AnimFrame: 0.5, AnimRate: 1, AnimLast: 1}).state.latent, FINISH_ANIM_LATENT_ACTION);
});

test('FinishAnim preserves x87 unordered behavior at each comparison', () => {
  // FCOMS sets C0 on an unordered comparison.  A NaN frame therefore selects
  // the TweenRate gate and, with a valid tween, reaches the final latent store.
  assert.equal(run({AnimFrame: NaN, AnimRate: 0, TweenRate: 1, AnimLast: 0}).state.latent,
    FINISH_ANIM_LATENT_ACTION);
  // FCOML sets C3 on an unordered rate comparison, taking the native return.
  assert.equal(run({AnimFrame: 0, AnimRate: NaN, TweenRate: 1, AnimLast: 1}).state.latent, 0x55);
  assert.equal(run({AnimFrame: -1, AnimRate: 1, TweenRate: NaN, AnimLast: 0}).state.latent, 0x55);
  // The final FCOMS also treats unordered as C0, so a NaN AnimLast installs.
  assert.equal(run({AnimFrame: 0, AnimRate: 1, AnimLast: NaN}).state.latent, FINISH_ANIM_LATENT_ACTION);
});

test('PollFinishAnim clears only the latent action when bAnimFinished is set', () => {
  const done = animation({animFlags: FINISH_ANIM_FLAGS.AnimFinished});
  const state = {latent: FINISH_ANIM_LATENT_ACTION};
  pollFinishAnim({animation: done, state});
  assert.equal(state.latent, 0);

  const pending = {latent: FINISH_ANIM_LATENT_ACTION};
  pollFinishAnim({animation: animation({animFlags: FINISH_ANIM_FLAGS.AnimLoop}), state: pending});
  assert.equal(pending.latent, FINISH_ANIM_LATENT_ACTION);
});

test('ScriptRuntime dispatches native 261 and its 0x181 poll through one actor state frame', () => {
  const actor = {};
  const state = {latent: 0};
  const values = new Map([
    ['AnimSequence', 'Walk'], ['AnimFrame', 0], ['AnimRate', 1],
    ['TweenRate', 0], ['AnimLast', 1],
  ]);
  const runtime = new ScriptRuntime({});
  runtime.instance = receiver => {
    assert.equal(receiver, actor);
    return {state};
  };
  runtime.namedReference = (receiver, name) => {
    assert.equal(receiver, actor);
    return {get: () => values.get(name), set: value => values.set(name, value)};
  };

  assert.equal(runtime.invokeNative({
    index: 261, receiver: actor, argumentCount: 0,
    evaluateArgument: () => { throw new Error('FinishAnim evaluated an argument'); },
  }), undefined);
  assert.equal(state.latent, FINISH_ANIM_LATENT_ACTION);

  values.set('bAnimFinished', true);
  runtime.services.pollLatent({index: FINISH_ANIM_LATENT_ACTION, receiver: actor, state, seconds: 0});
  assert.equal(state.latent, 0);
});
