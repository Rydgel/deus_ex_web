// Original UTexture::Get/Update/Tick/ConstantTimeTick against
// src/runtime/texture-animation.mjs. The oracle runs the hash-pinned
// Engine.dll bodies on fabricated texture chains
// (scripts/native-texture-animation-oracle.py); every Get's returned frame and
// the AnimCur, PrimeCurrent, Accumulator (bits) and LastUpdateTime state
// after it must match.
//
//   node scripts/validate-native-texture-animation.mjs
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {get} from '../src/runtime/texture-animation.mjs';

const io = new DataView(new ArrayBuffer(8));
const bits = value => { io.setFloat32(0, value, true); return io.getUint32(0, true); };
const float = word => { io.setUint32(0, word >>> 0, true); return io.getFloat32(0, true); };
const doubleBits = value => { io.setFloat64(0, value, true); return io.getBigUint64(0, true).toString(16).padStart(16, '0'); };
let seed = 0x7e57a11;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const pick = list => list[random() % list.length];
const RATES = [0, 0x80000000, 0x7fc00000, 0xffc00000, 0x7f800000, 0xff800000, 1, bits(0.01), bits(0.009), bits(0.0100001),
  bits(100), bits(100.5), bits(99.99), bits(1), bits(2), bits(8), bits(10), bits(15), bits(20), bits(24), bits(30), bits(60), bits(-5)];
const rate = () => random() % 3 ? pick(RATES) : bits((random() % 20000) / 100);

const cases = [];
// A plain four-frame chain at one tick per Update, with a repeated time.
cases.push({frames: 4, links: [1, 2, 3, null], primeCount: 0, minFrameRate: 0, maxFrameRate: 0,
  times: [123456.5, 123456.5, 123456.6, 123456.7, 123456.8, 123456.9, 123457]});
// Frame-rate windows: MaxFrameRate 30, MinFrameRate 10 at 60 fps, 20 fps, 5 fps.
for (const step of [1 / 60, 1 / 20, 1 / 5])
  cases.push({frames: 3, links: [1, 2, 0], primeCount: 0, minFrameRate: bits(10), maxFrameRate: bits(30),
    times: Array.from({length: 40}, (_, i) => 5000 + i * step)});
// Priming, a head without AnimNext, a self link, a cycle back into the chain.
cases.push({frames: 3, links: [1, 2, null], primeCount: 5, minFrameRate: bits(4), maxFrameRate: bits(8), times: [10, 10.05, 10.5, 11]});
cases.push({frames: 1, links: [null], primeCount: 2, minFrameRate: 0, maxFrameRate: 0, times: [1, 2, 3]});
cases.push({frames: 2, links: [0, 1], primeCount: 0, minFrameRate: 0, maxFrameRate: 0, times: [1, 2, 3, 4]});
cases.push({frames: 4, links: [1, 2, 3, 1], primeCount: 0, minFrameRate: bits(1), maxFrameRate: bits(2), times: [0.25, 0.5, 1.6, 9, 9.1]});
// The first Update after construction: LastUpdateTime 0 and appSeconds-sized times.
cases.push({frames: 5, links: [1, 2, 3, 4, null], primeCount: 0, minFrameRate: bits(2), maxFrameRate: bits(12),
  times: [16777216.123, 16777216.2, 16777216.3, 16777215, 16777216.31]});
// Random chains, rates, state and time sequences (backwards steps, NaN).
for (let i = 0; i < 300; i++) {
  const frames = 1 + random() % 5;
  const links = Array.from({length: frames}, () => random() % 4 === 0 ? null : random() % frames);
  let time = random() % 2 ? (random() % 100000) / 7 : 16777216 + (random() % 100000) / 13;
  const times = [];
  for (let k = 0, n = 1 + random() % 25; k < n; k++) {
    const r = random() % 10;
    time += r === 0 ? 0 : r === 1 ? -((random() % 1000) / 997) : r === 2 ? (random() % 100) : (random() % 1000) / 9973;
    times.push(random() % 97 === 0 ? 'nan' : time);
  }
  cases.push({frames, links, primeCount: random() % 4 === 0 ? random() % 6 : 0, primeCurrent: random() % 8 === 0 ? random() % 3 : 0,
    animCur: random() % 4 === 0 ? random() % frames : null, accumulator: random() % 3 === 0 ? bits((random() % 3000) / 1000) : 0,
    lastUpdateTime: random() % 4 === 0 ? time - 1 : 0, minFrameRate: rate(), maxFrameRate: rate(), times});
}

const dir = path.resolve('reports/rendering');
await mkdir(dir, {recursive: true});
const casesPath = path.join(dir, 'texture-animation-cases.json');
await writeFile(casesPath, JSON.stringify(cases));
const {stdout} = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  ['scripts/native-texture-animation-oracle.py', gameDirectory(), casesPath], {maxBuffer: 64 * 1024 * 1024});
const native = JSON.parse(stdout);
assert.equal(native.results.length, cases.length);

const mismatches = [];
let steps = 0, advanced = 0;
for (let i = 0; i < cases.length; i++) {
  const c = cases[i], expected = native.results[i].steps;
  const frames = Array.from({length: c.frames}, () => ({}));
  frames.forEach((frame, k) => { frame.animNext = c.links[k] === null ? null : frames[c.links[k]]; });
  const head = Object.assign(frames[0], {primeCount: c.primeCount, primeCurrent: c.primeCurrent ?? 0,
    minFrameRate: float(c.minFrameRate), maxFrameRate: float(c.maxFrameRate), accumulator: float(c.accumulator ?? 0),
    animCur: c.animCur === null || c.animCur === undefined ? null : frames[c.animCur], lastUpdateTime: c.lastUpdateTime ?? 0});
  const indexOf = frame => frame ? frames.indexOf(frame) : null;
  try {
    c.times.forEach((time, k) => {
      const before = head.animCur;
      const result = get(head, time === 'nan' ? NaN : time);
      const actual = {result: indexOf(result), animCur: indexOf(head.animCur), primeCurrent: head.primeCurrent & 255,
        accumulator: bits(head.accumulator), lastUpdateTime: doubleBits(head.lastUpdateTime), flags: expected[k].flags};
      assert.deepEqual(actual, expected[k], `step ${k}`);
      steps++; if (head.animCur !== before) advanced++;
    });
  } catch (error) {
    mismatches.push({i, case: c, expected, message: error.message.slice(0, 600)});
  }
}
await writeFile(path.join(dir, 'texture-animation-comparison.json'),
  JSON.stringify({cases: cases.length, steps, advanced, hashes: native.hashes, mismatches: mismatches.slice(0, 10)}, null, 1));
console.log(JSON.stringify({cases: cases.length, steps, advanced, mismatches: mismatches.length, first: mismatches[0]?.message}));
assert.equal(mismatches.length, 0);
