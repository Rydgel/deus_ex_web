import test from 'node:test';
import assert from 'node:assert/strict';
import {x87mul32, x87div32, x87add32, x87sub32, x87nanOf, X87_INDEFINITE} from '../src/runtime/x87-nan.mjs';

// Rows measured on real x87 silicon (AMD Ryzen 9 8945HS, control word 0x037f)
// with tools/x87-nan-probe.c: FLD m32 a, F<op> m32 b, FSTP m32. The full grid
// is scripts/validate-x87-nan-hardware.mjs; these pin the rule without Wine.
const io = new DataView(new ArrayBuffer(4));
const num = b => (io.setUint32(0, b >>> 0, true), io.getFloat32(0, true));
const bits = v => (io.setFloat32(0, Math.fround(v), true), io.getUint32(0, true));
const OPS = {fmul: x87mul32, fdiv: x87div32, fadd: x87add32, fsub: x87sub32};

test('invalid operations store the real indefinite on every host', () => {
  for (const [op, a, b] of [['fmul', 0x7f800000, 0], ['fmul', 0, 0xff800000], ['fadd', 0x7f800000, 0xff800000],
    ['fsub', 0x7f800000, 0x7f800000], ['fdiv', 0, 0x80000000], ['fdiv', 0xff800000, 0x7f800000]])
    assert.equal(bits(OPS[op](num(a), num(b))), X87_INDEFINITE, `${op} ${a.toString(16)} ${b.toString(16)}`);
});

test('a NaN pair keeps the larger significand, the positive NaN on a tie', () => {
  for (const op of Object.keys(OPS)) {
    for (const [a, b, expected] of [
      [0x7fc00001, 0x7fc00002, 0x7fc00002], [0x7fc00002, 0x7fc00001, 0x7fc00002],
      [0x7fc00001, 0xffc00001, 0x7fc00001], [0xffc00001, 0x7fc00001, 0x7fc00001],
      [0xffc00005, 0x7fc00001, 0xffc00005], [0xffc00000, 0x7fc00000, 0x7fc00000],
      [0xffc00000, 0x3f800000, 0xffc00000], [0x3f800000, 0x7fc00000, 0x7fc00000],
    ]) assert.equal(bits(OPS[op](num(a), num(b))), expected, `${op} ${a.toString(16)} ${b.toString(16)}`);
  }
});

test('non-NaN results are the rounded double result', () => {
  assert.equal(x87mul32(1.5, 2.5), Math.fround(3.75));
  assert.equal(x87div32(1, 3), Math.fround(1 / 3));
  assert.ok(Object.is(x87add32(-0, -0), -0));
  assert.equal(bits(x87sub32(Infinity, 1)), 0x7f800000);
  // JavaScript's undefined computes as the canonical NaN.
  assert.equal(bits(x87nanOf(1, undefined)), 0x7fc00000);
});
