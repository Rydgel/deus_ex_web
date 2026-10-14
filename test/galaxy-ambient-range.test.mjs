import test from 'node:test';
import assert from 'node:assert/strict';
import { ambientInRange, ambientInRangeExact } from '../src/runtime/galaxy-audio.mjs';

// The double-precision decision must equal the extended-precision compare for every input: random, and built
// to land the squared distance within a few parts per million of the squared radius, where the exact path decides.
let seed = 12345;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const f32 = Math.fround;

test('ambient range decision equals the extended-precision compare', () => {
  let exactCalls = 0, cases = 0;
  const check = (location, listener, radiusByte) => {
    cases++;
    assert.equal(ambientInRange(location, listener, radiusByte), ambientInRangeExact(location, listener, radiusByte),
      `${location} ${listener} ${radiusByte}`);
  };
  for (let i = 0; i < 40000; i++) {
    const scale = [1, 100, 5000, 40000][i & 3];
    const listener = [0, 1, 2].map(() => f32((random() - 0.5) * 2 * scale));
    const location = [0, 1, 2].map(() => f32((random() - 0.5) * 2 * scale));
    check(location, listener, Math.floor(random() * 256));
  }
  for (let i = 0; i < 60000; i++) {
    const radiusByte = Math.floor(random() * 256), reach = (radiusByte + 1) * 25;
    const listener = [0, 1, 2].map(() => f32((random() - 0.5) * 20000));
    const direction = [0, 1, 2].map(() => random() - 0.5), length = Math.hypot(...direction) || 1;
    const jitter = 1 + (random() - 0.5) * [1e-3, 1e-6, 1e-9, 1e-12][i & 3];
    const location = direction.map((d, k) => f32(listener[k] + d / length * reach * jitter));
    check(location, listener, radiusByte);
  }
  // Exactly on the boundary: axis-aligned, radius in units of 25.
  for (let radiusByte = 0; radiusByte < 256; radiusByte++) {
    const reach = (radiusByte + 1) * 25;
    for (const delta of [-1, 0, 1]) check([f32(reach + delta * 0.001), 0, 0], [0, 0, 0], radiusByte);
    check([f32(reach), 0, 0], [0, 0, 0], radiusByte);
  }
  assert.ok(cases > 100000);
});

test('non-finite coordinates take the exact path', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(ambientInRange([bad, 0, 0], [0, 0, 0], 10), ambientInRangeExact([bad, 0, 0], [0, 0, 0], 10));
  }
});
