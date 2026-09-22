import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeRng} from '../src/runtime/rng.mjs';
import {execRotRand, ROTRAND_NATIVE} from '../src/runtime/script-rot-rand.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';

// Captured from the unchanged Core body by scripts/validate-native-rotrand.mjs.
const cases = [
  [0, [15438, 76, 0], 505908858, [15438, 76, 42476], 3539360597],
  [1, [36934, 82, 0], 3357800067, [36934, 82, 12668], 415139642],
  [42, [800, 350, 0], 26255348, [800, 350, 35738], 1171099367],
];
const call = (argumentCount, value) => ({argumentCount, evaluateArgument: () => value});

test('native 320 draws Yaw then Pitch, and Roll only for bRoll', () => {
  assert.equal(ROTRAND_NATIVE.index, 320);
  for (const [seed, rotator, state, rolled, rolledState] of cases) {
    for (const [argumentCount, value] of [[0], [1, undefined], [1, false]]) {
      const rng = createNativeRng(seed);
      assert.deepEqual(execRotRand(call(argumentCount, value), {rng}), rotator, `seed ${seed}`);
      assert.equal(rng.state, state);
    }
    const rng = createNativeRng(seed);
    assert.deepEqual(execRotRand(call(1, true), {rng}), rolled, `seed ${seed} bRoll`);
    assert.equal(rng.state, rolledState);
  }
});

test('ScriptRuntime dispatches native 320 on the shared stream', () => {
  const rng = createNativeRng(0);
  const runtime = new ScriptRuntime({}, {rng});
  assert.deepEqual(runtime.invokeNative({index: 320, receiver: {}, argumentCount: 0, evaluateArgument: () => undefined}), cases[0][1]);
  assert.equal(rng.state, cases[0][2]);
});

test('native 320 requires the shared RNG and at most one bool argument', () => {
  assert.throws(() => execRotRand(call(0), {}), /shared original RNG stream/);
  assert.throws(() => execRotRand(call(2, true), {rng: createNativeRng(1)}), /at most one/);
  assert.throws(() => execRotRand(call(1, 'yes'), {rng: createNativeRng(1)}), /bool/);
});
