import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { safeNormal } from '../src/runtime/steps.mjs';
import { findSpot } from '../src/runtime/fitting.mjs';
import { gameDirectory } from './game-directory.mjs';

const f = Math.fround, cases = [], clear = { time: 1, normal: [0, 0, 0] };
function add(changes = {}) {
  cases.push({ position: [-1149.24, 825.84, -80.2].map(f), extent: [20, 20, 43],
    options: [0, 1], points: [0, 0, 1], lines: Array(14).fill(clear), ...changes });
}
for (const options of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
  for (const points of [[1, 1, 1], [0, 1, 1], [0, 0, 1], [0, 0, 0], [2, 2, 2]]) {
    for (const extent of [[0, 0, 0], [20, 20, 43], [20, 20, 16], [f(.1), f(.2), f(.3)], [10, 23, 45]]) add({ options, points, extent });
  }
}
const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, -1], [f(.6), 0, f(.8)], safeNormal([1, 2, 3])];
for (const normal of normals) for (const time of [0, f(.1), f(.3), f(.99999994), 1]) {
  for (const index of [0, 5, 6, 13]) {
    const lines = Array(14).fill(clear); lines[index] = { time, normal };
    add({ lines });
  }
}
let seed = 90157;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const vector = scale => Array.from({ length: 3 }, () => f((random() * 2 - 1) * scale));
for (let i = 0; i < 200; i++) add({ position: vector(3000), extent: vector(80).map(Math.abs),
  options: [i % 2, (i >> 1) % 2], points: [0, 0, i % 3 === 0 ? 0 : 1],
  lines: Array.from({ length: 14 }, () => random() < .5 ? clear : { time: f(random()), normal: safeNormal(vector(1)) }),
});

const directory = path.resolve('reports/movement/native-fitting');
// Original capture: retained Z product falls just below a float32 midpoint.
add({position:[0,0,-111.1500015258789],extent:[20,20,43],options:[0,0],points:[1],
  lines:[{time:0,normal:[0,0,-1]},...Array(5).fill(clear)]});
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-fitting-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
const native = JSON.parse(stdout);
assert.equal(native.results.length, cases.length);
await writeFile(path.join(directory, 'original.json'), JSON.stringify(native, null, 2));
function run(input) {
  const events = []; let pointIndex = 0, lineIndex = 0;
  const queries = {
    pointCheck(position, extent, flags, extra) {
      events.push({ point: { position, extent, flags, extra } });
      assert.ok(pointIndex < input.points.length, 'explicit point response available');
      return input.points[pointIndex++];
    },
    lineCheck(start, end, extent, flags, extra) {
      events.push({ line: { start, end, extent, flags, extra } });
      assert.ok(lineIndex < input.lines.length, 'explicit line response available');
      return input.lines[lineIndex++];
    },
  };
  const position = findSpot(queries, input.position, input.extent, ...input.options);
  return { success: position !== null, position: position ?? input.position, events };
}
let maxError = 0;
function same(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    maxError = Math.max(maxError, Math.abs(actual - expected)); return Object.is(actual, expected);
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const keys = Object.keys(actual);
    return keys.length === Object.keys(expected).length && keys.map(key => same(actual[key], expected[key])).every(Boolean);
  }
  return actual === expected;
}
const mismatches = [];
const comparisons = cases.map((input, index) => {
  const actual = run(input), expected = native.results[index];
  if (!same(actual, expected)) mismatches.push(index);
  return { input, actual, expected };
});
const summary = { cases: cases.length, originalSuccesses: native.results.filter(r => r.success).length,
  binaryHashes: native.hashes, scope: 'original FindSpot / AdjustSpot with controlled point and ray callbacks',
  comparison: 'exact position, success, all query arguments and order, including signed zero', maxError, mismatches };
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 15), mismatchCount: mismatches.length }, null, 2));
assert.equal(mismatches.length, 0, 'placement agrees with original FindSpot / AdjustSpot for all sampled cases');
