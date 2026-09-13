import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeRng} from '../src/runtime/rng.mjs';
import {execVRand, VRAND_NATIVE} from '../src/runtime/script-vrand.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';

const cases = [
  [0, [-0.037319645285606384, -0.6002209186553955, 0.7989631295204163]],
  [1, [0.9622223377227783, 0.264940470457077, -0.06272778660058975]],
  [42, [0.96846604347229, -0.02128535881638527, -0.24823471903800964]],
  [32767, [-0.6237718462944031, -0.49732884764671326, -0.6029699444770813]],
  [4294967295, [-0.2988285720348358, 0.00774200726300478, 0.9542754292488098]],
];

test('native 252 uses the shared stream and returns original float32 unit vectors', () => {
  assert.equal(VRAND_NATIVE.index, 252);
  for (const [seed, expected] of cases) {
    const rng = createNativeRng(seed);
    assert.deepEqual(execVRand(rng), expected, `seed ${seed}`);
  }
});

test('native 252 consumes three random values per rejected or accepted sample', () => {
  const rng = createNativeRng(0);
  const before = rng.state;
  execVRand(rng);
  assert.equal(rng.state, 3870123402);
  assert.notEqual(rng.state, before);
});

test('ScriptRuntime dispatches native 252 without evaluating arguments', () => {
  const rng = createNativeRng(1);
  const runtime = new ScriptRuntime({}, {rng});
  let evaluations = 0;
  const result = runtime.invokeNative({
    index: 252,
    receiver: {},
    argumentCount: 0,
    evaluateArgument: () => { evaluations++; return undefined; },
  });
  assert.equal(evaluations, 0);
  assert.deepEqual(result, cases[1][1]);
});

test('native 252 requires a shared original RNG and no arguments', () => {
  assert.throws(() => execVRand({}), /shared original RNG stream/);
  const runtime = new ScriptRuntime({}, {rng: createNativeRng(1)});
  assert.throws(() => runtime.invokeNative({
    index: 252, receiver: {}, argumentCount: 1, evaluateArgument: () => 0,
  }), /accepts no arguments/);
});
