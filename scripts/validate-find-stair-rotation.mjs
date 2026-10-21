/** Pawn.FindStairRotation (native 524) against the original (docs/pawn-stair-rotation.md): the exec APawn::execFindStairRotation
 * (Engine.dll 0x103bb880) runs unchanged under Unicorn (scripts/native-find-stair-rotation-oracle.py, NATIVE_PROBE_PYTHON) with
 * Core's FCoords operator, the sine table and the CRT _ftol; only the level's SingleLineCheck is a stub whose answers (Hit.Time
 * per call) come from the case. The same cases run through src/runtime/script-pawn-stair-rotation.mjs. Compared exactly: the int
 * result, the pitch the exec stores back, and the list of SingleLineCheck calls (End, Start, extent and flags as float words).
 * Every float travels as its bit pattern. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {findStairRotation} from '../src/runtime/script-pawn-stair-rotation.mjs';

const f = Math.fround;
const view = new DataView(new ArrayBuffer(4));
const bits = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
const float = word => { view.setUint32(0, word >>> 0, true); return view.getFloat32(0, true); };

// A small deterministic generator (mulberry32).
let seed = 524;
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = list => list[Math.floor(random() * list.length)];
const uniform = (low, high) => low + (high - low) * random();

const DT = [0, 0.001, 1 / 60, 0.0166667, 0.05, 0.1, 0.32, 0.33, f(0.33), 0.3300001, 0.34, 0.5, 1, 100, -0.01, -0, NaN, Infinity];
const PITCH = [0, 1, -1, 100, -100, 999, 1000, 1001, 5400, 5399, 0x1518, -5000, -4999, 0x7fff, 0x8000, 0x8001, 0x9000, 0xffff, 0x10000,
  0x12345, 20000, -20000, 0x7fffffff, -0x80000000, 12345, -12345, 8000, -8000, 2500, -2500];
const EYE = [0, 5, 27, 40.5, 64, f(1.1)], RADIUS = [0, 1, 17, 20, 24.5], HEIGHT = [0, 25, 43, 43.0000008, 50, 60.25];
const TIME = [1, 1, 1, 0, 0.1, 0.2, 0.3, 0.39, 0.4, f(0.4), 0.41, 0.5, 0.75, 0.9, 0.99, 0.999999, f(1 - 2 ** -24)];
const times = () => Array.from({length: 5}, () => random() < 0.3 ? uniform(0, 1) : pick(TIME));

const cases = [];
for (let n = 0; n < 6000; n++) {
  cases.push({
    dt: pick(DT), eye: pick(EYE), radius: pick(RADIUS), height: pick(HEIGHT),
    location: [uniform(-5000, 5000), uniform(-5000, 5000), uniform(-3000, 3000)],
    rotation: [pick(PITCH), random() < 0.2 ? 0 : Math.floor(uniform(-70000, 70000)), random() < 0.5 ? 0 : Math.floor(uniform(-20000, 20000))],
    times: times(),
  });
}
// Each case runs the whole ladder: hand-built times that walk every branch with a standing player (eye 27, height 43: h = 70).
for (const pitch of [0, 3000, -3000, 0x1518, -5000])
  for (const dt of [1 / 60, 0.1, 0.33])
    for (const ladder of [[1, 0.1, 0.5, 1, 1], [1, 0.1, 0.1, 1, 1], [0.7, 0.1, 0.9, 1, 1], [0.7, 0.1, 0.05, 1, 1], [0.7, 0.9, 1, 1, 1], [0.7, 0.5, 1, 1, 0.9],
      [0.7, 0.5, 1, 1, 1], [0.7, 0.5, 1, 1, 0.2], [0.7, 0.5, 1, 0.5, 1], [0.7, 0.99, 0.5, 1, 0.95], [0.3, 1, 1, 1, 1], [0.4, 1, 1, 1, 1], [1, 1, 1, 1, 1]])
      cases.push({dt, eye: 27, radius: 20, height: 43, location: [100.5, -200.25, 30.125], rotation: [pitch, 16384, 0], times: ladder});

// Equality at the last comparison: 3h = 160 exactly (h = float32(160 / 3)), floor = 160 * 0.5 = 80, floor + 10 = 160 * 0.5625.
for (const pitch of [-3000, 0, 3000])
  cases.push({dt: 1 / 60, eye: 0, radius: 20, height: f(160 / 3), location: [10, 20, 30], rotation: [pitch, 0, 0], times: [0.7, 0.5, 1, 0.5625, 1]});
const encode = c => ({dt: bits(c.dt), location: c.location.map(bits), rotation: c.rotation, eye: bits(c.eye), radius: bits(c.radius),
  height: bits(c.height), times: c.times.map(bits)});
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const output = execFileSync(python, ['scripts/native-find-stair-rotation-oracle.py', gameDirectory()],
  {input: JSON.stringify({cases: cases.map(encode)}), encoding: 'utf8', maxBuffer: 1 << 28});
const original = JSON.parse(output).results;

let mismatches = 0;
const histogram = new Map();
cases.forEach((c, index) => {
  const expected = original[index];
  let pitchAfter = c.rotation[0] | 0, answers = 0;
  const calls = [];
  const state = {location: c.location.map(f), viewRotation: [...c.rotation], eyeHeight: f(c.eye), radius: f(c.radius), height: f(c.height)};
  const result = findStairRotation(state, c.dt, {
    setPitch: value => { pitchAfter = value; },
    lineCheck: (start, end, extent, flags, extra) => {
      calls.push({source: true, end: end.map(bits), start: start.map(bits), flags, extent: extent.map(bits), extra});
      return {time: f(c.times[answers++])};
    },
  });
  const actual = {result, pitchAfter, calls};
  try {
    assert.deepEqual(actual, {result: expected.result, pitchAfter: expected.pitchAfter, calls: expected.calls});
    assert.equal(expected.consumed, 6, 'the exec consumed the float operand and the end token');
  } catch (error) {
    if (mismatches++ < 3) console.error(`case ${index} ${JSON.stringify(c)}\n  original ${JSON.stringify(expected)}\n  script   ${JSON.stringify(actual)}`);
  }
  const key = `${calls.length} calls, ${result === 0x1518 ? 'up' : result === -5000 ? 'down' : result === 0 ? 'zero' : 'eased'}${Number.isNaN(c.dt) ? ', NaN dt' : ''}`;
  histogram.set(key, (histogram.get(key) ?? 0) + 1);
});
assert.equal(mismatches, 0, `${mismatches} of ${cases.length} cases differ from the original`);
// A rising floor makes three calls (eye line, down from half way, down from the wall), a falling one four (the thin line, then down).
for (const required of ['0 calls', '1 calls', '2 calls', '3 calls', '4 calls', 'up', 'down', 'eased'])
  assert.ok([...histogram.keys()].some(key => key.includes(required)), `no case reaches ${required}`);
console.log(JSON.stringify({cases: cases.length, mismatches, coverage: Object.fromEntries([...histogram].sort())}));
