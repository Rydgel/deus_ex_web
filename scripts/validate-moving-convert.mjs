#!/usr/bin/env node
/** The light atlas conversion in the Rust core (native/script-vm/src/moving.rs `convert`) against the reference in light-atlas.mjs
 * `update` (`Math.round(Math.max(0, Math.min(1, sample)) * 255)` stored through a Uint8Array) for every one of the 2^32 float32 bit
 * patterns: all NaNs (stored as 0), both zeros and infinities, the denormals, and every finite value between and beyond 0 and 1.
 * Then the composition's single step, `Math.min(127 / 255, p + amount)` stored through a Float32Array, against the same integer step
 * the atlas byte follows (docs/firefox-60fps-plan.md "Moving lights (2026-11-07)", "What the bytes are"): for every static byte 0..255 and
 * every amount `Math.min(127, (b * step) >> 16) / 255` the colour tables can produce, a chain of up to four contributions ends on the byte
 * `min(127, sum)` the integer merge gives. (The Rust composition itself is compared with the JavaScript body by `?movingCompose=verify`.)
 *
 *   node scripts/validate-moving-convert.mjs [--chunk 22] [--from 0] [--to 4294967296]
 */
import assert from 'node:assert/strict';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createMovingComposeKernel } from '../src/runtime/moving-compose-kernel.mjs';

const argv = process.argv.slice(2), flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : Number(argv[i + 1]); };
const kernel = await loadScriptVmKernel();
assert.ok(kernel.moving, 'the script-VM kernel has no moving-light composition');
const composer = createMovingComposeKernel(kernel.moving);

// 1. The conversion, over every bit pattern.
const chunk = 2 ** flag('chunk', 22), from = flag('from', 0), to = flag('to', 2 ** 32);
const bits = new Uint32Array(chunk), floats = new Float32Array(bits.buffer), expected = new Uint8Array(chunk);
let checked = 0, nan = 0;
for (let base = from; base < to; base += chunk) {
  const n = Math.min(chunk, to - base);
  for (let i = 0; i < n; i++) bits[i] = base + i;
  for (let i = 0; i < n; i++) {
    const sample = floats[i];
    expected[i] = Math.round(Math.max(0, Math.min(1, sample)) * 255);
    if (sample !== sample) nan++;
  }
  const got = composer.convert(n === chunk ? bits : bits.subarray(0, n));
  for (let i = 0; i < n; i++) if (got[i] !== expected[i]) assert.fail(`float32 bits 0x${(base + i).toString(16)} (${floats[i]}): the core gives ${got[i]}, the reference ${expected[i]}`);
  checked += n;
}
console.log(`conversion: ${checked} float32 bit patterns equal (${nan} NaN)`);

// 2. The integer step the atlas byte follows.
const MAX = 127 / 255, f = Math.fround;
const byteOf = p => Math.round(Math.max(0, Math.min(1, p)) * 255);
const amounts = new Set();
for (let step = 0; step < 1 << 23; step += 7) for (const b of [1, 2, 3, 7, 31, 32, 63, 64, 100, 127, 128, 200, 254, 255]) amounts.add(Math.min(127, (b * step) >> 16));
for (let e = 0; e <= 127; e++) amounts.add(e);
const entries = [...amounts].sort((a, b) => a - b);
assert.equal(entries[0], 0); assert.equal(entries.at(-1), 127);
let steps = 0;
const chain = (p, sum, depth) => {
  // `sum` is the integer merge's byte; `p` the float32 texel the reference holds
  assert.equal(byteOf(p), sum, `float ${p} should hold byte ${sum}`);
  if (depth === 4) return;
  for (const e of entries) {
    const next = f(Math.min(MAX, p + e / 255)), integer = Math.min(127, sum + e);
    steps++;
    assert.equal(byteOf(next), integer, `p=${p} (byte ${sum}) + ${e}: the reference byte ${byteOf(next)}, the integer merge ${integer}`);
    // (one representative of each float the step can reach: the first and last of the entries are enough to bound the rounding)
    if (depth < 3 || e === 0 || e === 127) chain(next, integer, depth + 1);
  }
};
for (let k = 0; k <= 255; k++) {
  const p = f(k / 255);
  assert.equal(byteOf(p), k, `static byte ${k}`);
  // A static byte above 127 is only ever raised by a contribution, which holds the texel at 127.
  for (const e of entries) {
    const next = f(Math.min(MAX, p + e / 255)), integer = Math.min(127, k + e);
    steps++;
    assert.equal(byteOf(next), integer, `static ${k} + ${e}`);
    if (k <= 127 && (e === 0 || e === 1 || e === 127 || k < 4)) chain(next, integer, 2);
  }
}
console.log(`integer step: ${steps} steps over ${entries.length} amounts equal`);
console.log('PASS validate-moving-convert');
