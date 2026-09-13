import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';

const pkg = { imports: [], exports: [{ name: 'Value' }, { name: 'Amount' }] };

function compile(bytes, size) {
  return compileFunction({ pkg, entry: { path: 'Fixture.FloatApprox' }, bytes: Uint8Array.from(bytes), size });
}

function floatNative(index, a, b) {
  // Field references allow nonfinite host values. The native expression's
  // operand evaluator still stores each value as a float32 before comparison.
  const bytes = [0x04, 0x60, index, 0x01, 0x01, 0x01, 0x02, 0x16];
  return compile(bytes, 14).run({ Value: a, Amount: b });
}

test('native 210 uses float32 operands and strict 0.0001 comparison', () => {
  assert.ok(primitiveNativeIndices.includes(210));

  // The second input rounds to the first input's float32 representation.
  assert.equal(floatNative(210, 1, 1 + 2 ** -25), true);

  // The nearest float32 above 0.0001 is outside the native strict band.
  const above = Math.fround(0.000100000004);
  assert.equal(above, 0.00010000000474974513);
  assert.equal(floatNative(210, above, 0), false);

  // The nearest float32 representation of the decimal literal itself is
  // below the embedded double threshold and therefore remains accepted.
  assert.equal(Math.fround(0.0001), 0.00009999999747378752);
  assert.equal(floatNative(210, 0.0001, 0), true);

  // Equal signed zeros compare as an absolute zero difference.
  assert.equal(floatNative(210, -0, +0), true);
  assert.equal(floatNative(210, +0, -0), true);
});

test('native 210 preserves original unordered and infinite outcomes', () => {
  // Core's fcom C0 test treats unordered as below the threshold.
  assert.equal(floatNative(210, Number.NaN, 3), true);
  assert.equal(floatNative(210, 3, Number.NaN), true);
  assert.equal(floatNative(210, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), true);
  assert.equal(floatNative(210, Number.POSITIVE_INFINITY, 1), false);
  assert.equal(floatNative(210, Number.NEGATIVE_INFINITY, 1), false);
});
