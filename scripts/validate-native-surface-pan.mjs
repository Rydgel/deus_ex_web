// Original Render.dll BSP surface auto-pan against surfacePan
// (texture-animation.mjs): the straight-line range 0x10b1a59a-0x10b1a72a runs
// on fabricated surfaces, zones and levels (native-surface-pan-oracle.py);
// the float PanU/PanV it leaves must match as bits.
//
//   node scripts/validate-native-surface-pan.mjs
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {surfacePan} from '../src/runtime/texture-animation.mjs';

const io = new DataView(new ArrayBuffer(4));
const bits = value => { io.setFloat32(0, value, true); return io.getUint32(0, true); };
const float = word => { io.setUint32(0, word >>> 0, true); return io.getFloat32(0, true); };
let seed = 0x9a71;
// The top bits: an LCG's low bits cycle (bit k with period 2^(k+1)).
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
const SPECIAL = [0, 0x80000000, 0x7fc00000, 0xffc00000, 0x7f800000, 0xff800000, 1, bits(1), bits(-1), bits(0.5), bits(2),
  bits(1e9), bits(-1e9), bits(3.4e38), bits(1 / 35), bits(1 / 8960), bits(29.257143)];
const word = () => random() % 4 === 0 ? SPECIAL[random() % SPECIAL.length] : bits(((random() % 2000000) - 1000000) / 1000);
const time = () => random() % 5 === 0 ? SPECIAL[random() % SPECIAL.length] : bits((random() % 10000000) / 997);
const cases = [];
for (const flags of [0, 0x200, 0x400, 0x600, 0x2600])
  for (let i = 0; i < 80; i++)
    cases.push({flags, panU: ((random() % 65536) - 32768) | 0, panV: ((random() % 65536) - 32768) | 0,
      speedU: word(), speedV: word(), time: time()});

const dir = path.resolve('reports/rendering');
await mkdir(dir, {recursive: true});
const casesPath = path.join(dir, 'surface-pan-cases.json');
await writeFile(casesPath, JSON.stringify(cases));
const {stdout} = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  ['scripts/native-surface-pan-oracle.py', gameDirectory(), casesPath], {maxBuffer: 16 * 1024 * 1024});
const native = JSON.parse(stdout);
const mismatches = [];
cases.forEach((c, i) => {
  const pan = surfacePan({panU: c.panU, panV: c.panV, flags: c.flags, speedU: float(c.speedU), speedV: float(c.speedV),
    timeSeconds: float(c.time)});
  const actual = {u: bits(pan.u), v: bits(pan.v)};
  if (actual.u !== native.results[i].u || actual.v !== native.results[i].v) mismatches.push({i, case: c, actual, expected: native.results[i]});
});
await writeFile(path.join(dir, 'surface-pan-comparison.json'), JSON.stringify({cases: cases.length, mismatches: mismatches.slice(0, 10)}, null, 1));
console.log(JSON.stringify({cases: cases.length, mismatches: mismatches.length, first: mismatches[0]}));
assert.equal(mismatches.length, 0);
