#!/usr/bin/env node
/**
 * The Rust x87 operator kernel (native/script-vm, docs/rust-core.md R2b)
 * against the JavaScript VM's BigInt bodies (script-vm.mjs x87Operators),
 * which are validated against the original Core.dll bodies by the native
 * operator validators. Every operator must return bit-identical float32 words
 * (NaN payloads and signed zeros included) or identical int32 words on edge
 * operands (zeros, denormals, normal boundaries, infinities, quiet and
 * signalling NaNs of both signs and several payloads, int32 extremes, the
 * SafeNormal 1e-08 threshold) and on seeded random operands: raw bit patterns
 * and log-uniform finite magnitudes.
 *
 * The words are compared before they become numbers in an Array: V8 may store
 * a NaN number into an Array canonically, depending on the literal's feedback
 * state rather than on the operands, so the BigInt result literal once held
 * 0x7fc00000 where its body (and Core.dll) stored 0xffc00000. The number
 * forms both sides hand to the VM are then checked against the words with
 * any NaN matching any NaN.
 */
import assert from 'node:assert/strict';
import {x87Operators, x87OperatorWords} from '../src/runtime/script-vm.mjs';
import {loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';

const kernel = await loadScriptVmKernel();
const f32io = new DataView(new ArrayBuffer(4));
const bits = v => (f32io.setFloat32(0, Math.fround(v), true), f32io.getUint32(0, true));
const num = b => (f32io.setUint32(0, b >>> 0, true), f32io.getFloat32(0, true));

let seed = 0x2545f491;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const EDGE_BITS = [
  0x00000000, 0x80000000, 0x00000001, 0x80000001, 0x007fffff, 0x807fffff, 0x00800000, 0x80800000,
  0x3f800000, 0xbf800000, 0x3f7fffff, 0x3f800001, 0x40000000, 0x40400000, 0x7f7fffff, 0xff7fffff,
  0x7f800000, 0xff800000, 0x7fc00000, 0xffc00000, 0x7f800001, 0xff800001, 0x7fbfffff, 0x7fc00001,
  0xffffffff, 0x7fffffff, 0x7fa00000, 0x32abcc77, 0x322bcc77, 0x322bcc78, 0x5f000000, 0xdf000000,
  0x4f000000, 0xcf000000, 0x4effffff, 0x3e800000, 0x1f800000, 0x0c000000, 0x60000000, 0x20000000,
];
const EDGE_INTS = [0, 1, -1, 2, 0x4000, -0x4000, 0x7fff, 0x8000, 0x10000, 0x7fffffff, -0x80000000, -0x7fffffff, 65535, 12345, -54321];
const randomFloatBits = () => {
  const r = random() % 4;
  if (r === 0) return random();
  if (r === 1) return EDGE_BITS[random() % EDGE_BITS.length];
  // A finite magnitude spread over the exponents that script math meets.
  const exponent = 127 + (random() % 80) - 40;
  return ((random() & 0x80000000) | (exponent << 23) | (random() & 0x7fffff)) >>> 0;
};
const randomInt = () => (random() % 3 === 0 ? EDGE_INTS[random() % EDGE_INTS.length] : random() | 0);
const float = () => num(randomFloatBits());
const vector = () => [float(), float(), float()];
const rotator = () => [randomInt(), randomInt(), randomInt()];

const show = v => Array.isArray(v) ? `[${v.map(show).join(',')}]` : `0x${bits(v).toString(16)}(${v})`;
const showWords = v => Array.isArray(v) ? `[${v.map(showWords).join(',')}]` : `0x${(v >>> 0).toString(16)}`;
// Operators whose results are int32s; the others store float32 words.
const INTEGER = new Set(['divideEqualIntFloat', 'multiplyRotatorFloat']);
const sameWords = (a, b) => Array.isArray(a)
  ? Array.isArray(b) && a.length === b.length && a.every((v, i) => sameWords(v, b[i]))
  : Number.isInteger(a) && Number.isInteger(b) && a >>> 0 === b >>> 0;
const nanWord = w => (w & 0x7fffffff) >>> 0 > 0x7f800000;
// A number form against the reference words: bit-equal, a NaN word matching
// any NaN.
const numberMatches = (value, word) => Array.isArray(word)
  ? Array.isArray(value) && value.length === word.length && value.every((v, i) => numberMatches(v, word[i]))
  : typeof value === 'number' && (nanWord(word) ? value !== value : bits(value) === word >>> 0);

const OPERATORS = {
  divideEqualIntFloat: () => [randomInt(), float()],
  percent: () => [float(), float()],
  sqrt: () => [float()],
  square: () => [float()],
  dot: () => [vector(), vector()],
  multiplyEqualVectorFloat: () => [vector(), float()],
  divideEqualVectorFloat: () => [vector(), float()],
  subtractEqualVectorVector: () => [vector(), vector()],
  normal: () => [vector()],
  smerp: () => [float(), float(), float()],
  rotate: () => [vector(), rotator()],
  multiplyRotatorFloat: () => [rotator(), float()],
  multiplyVectorVector: () => [vector(), vector()],
  multiplyEqualVectorVector: () => [vector(), vector()],
  mirrorVectorByNormal: () => [vector(), vector()],
};
const CASES = Number(process.env.X87_CASES ?? 20000);
let total = 0;
for (const [name, operands] of Object.entries(OPERATORS)) {
  assert.equal(typeof kernel[name], 'function', `kernel exports ${name}`);
  for (let i = 0; i < CASES; i++) {
    const args = operands();
    let expected;
    try { expected = x87OperatorWords[name](...args); }
    catch (error) {
      // The reference refuses nothing here; an error is a harness fault.
      throw new Error(`${name}(${args.map(show).join(', ')}) reference threw: ${error.message}`);
    }
    const actual = kernel[name](...args);
    // A scalar float result is returned, not stored in an Array, so its
    // number keeps the kernel's word; a vector's words are read from the
    // kernel's result slot.
    const words = INTEGER.has(name) ? actual : Array.isArray(expected) ? kernel.resultWords() : bits(actual);
    assert.ok(sameWords(words, expected),
      `${name}(${args.map(show).join(', ')}): kernel ${showWords(words)}, BigInt ${showWords(expected)}`);
    if (!INTEGER.has(name)) {
      assert.ok(numberMatches(actual, expected), `${name}(${args.map(show).join(', ')}): kernel number form ${show(actual)}`);
      const numbers = x87Operators[name](...args);
      assert.ok(numberMatches(numbers, expected), `${name}(${args.map(show).join(', ')}): BigInt number form ${show(numbers)}`);
    } else assert.ok(sameWords(x87Operators[name](...args), expected), `${name}: BigInt int form`);
    total++;
  }
}
console.log(`validate-script-vm-x87: ${Object.keys(OPERATORS).length} operators, ${total} operand sets bit-identical to the BigInt x87 bodies`);
