// x87-pc24.mjs: the precision control 24 model (docs/render-pass-precision.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { p24add, p24sub, p24mul, p24div, p24sqrt, r24 } from '../src/runtime/x87-pc24.mjs';
import { x87load, x87double, x87store } from '../src/runtime/script-vm.mjs';

const f = Math.fround;
let seed = 12345;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const value = () => f((random() - 0.5) * 2 ** Math.floor(random() * 40 - 20));

test('float operands: one binary32 rounding of the exact result', () => {
  for (let i = 0; i < 20000; i++) {
    const a = value(), b = value() || 1;
    assert.equal(x87store(p24add(x87load(a), x87load(b))), f(a + b));
    assert.equal(x87store(p24sub(x87load(a), x87load(b))), f(a - b));
    assert.equal(x87store(p24mul(x87load(a), x87load(b))), f(a * b));
    assert.equal(x87store(p24div(x87load(a), x87load(b))), f(a / b));
    assert.equal(x87store(p24sqrt(x87load(Math.abs(a)))), f(Math.sqrt(Math.abs(a))));
  }
});

test('a double operand is rounded once from the exact product', () => {
  // An integer times a double reciprocal (FGetHSV's `fild; fmul qword`
  // shape) against the exact product rounded to 24 bits with BigInts.
  for (let i = 0; i < 20000; i++) {
    const n = Math.floor(random() * 256), d = x87double(1 / (1 + Math.floor(random() * 300)));
    const got = p24mul({ neg: 0, sig: BigInt(n), exp: 0 }, d), sig = BigInt(n) * d.sig;
    if (sig === 0n) continue;
    const sh = BigInt(Math.max(0, sig.toString(2).length - 24));
    let q = sig >> sh;
    const rem = sig - (q << sh), half = sh ? 1n << (sh - 1n) : 0n;
    if (sh && (rem > half || (rem === half && (q & 1n)))) q += 1n;
    assert.equal(Number(got.sig) * 2 ** got.exp, Number(q) * 2 ** (d.exp + Number(sh)));
  }
});

test('the wide exponent: no denormalization before the store', () => {
  // 2^-100 · 2^-100 is a normal register value at PC 24; binary32 would
  // flush it. Scaling back up by 2^100 recovers it exactly.
  const tiny = x87load(2 ** -100), product = p24mul(tiny, tiny);
  assert.equal(x87store(p24mul(product, x87double(2 ** 100))), 2 ** -100);
  assert.equal(r24(2 ** -200 * 3), 2 ** -200 * 3);
  assert.equal(r24(1 + 2 ** -30), 1);
});
