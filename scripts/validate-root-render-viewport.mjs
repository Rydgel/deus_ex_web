/** Extension XRootWindow PreRender's render viewport (0x1003a7dd..0x1003a8cb)
 * against script-root-render-viewport.mjs, bit for bit on the four frame
 * ints. The original runs unchanged in Unicorn
 * (scripts/native-root-render-viewport-oracle.py). */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {rootRenderViewport} from '../src/runtime/script-root-render-viewport.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-root-render-viewport: no installed game data'); process.exit(0); }
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';

const io = new DataView(new ArrayBuffer(4));
const bits = value => { io.setFloat32(0, value, true); return io.getUint32(0, true); };
const SPECIAL = [0, 0x80000000, 1, 0x80000001, 0x7f800000, 0xff800000, 0x7fc00000, 0xffc00001, 0x7f7fffff, 0xff7fffff,
  bits(0.5), bits(-0.5), bits(0.999999), bits(52), bits(106), bits(1440), bits(960), bits(-3.75), bits(2 ** 31), bits(-(2 ** 31)),
  bits(2 ** 40), bits(1e-30), bits(719.5), bits(-0.0001)];
const MULTIPLIERS = [[1, 1], [2, 2], [3, 3], [0, 0], [-1, -1], [1, 2], [2 ** 20, 2 ** 20], [2 ** 24 + 1, 2 ** 24 + 1],
  [2 ** 30, -(2 ** 30)], [0x7fffffff, -0x80000000]];
const FRAMES = [[1440, 960, 0, 0], [800, 600, 10, 20], [0, 0, 0, 0], [1440, 960, -50, -7], [0x7fffffff, 960, 5, 0], [1, 1, 0x7fffffff, 0]];

let seed = 0x9e3779b9;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const pick = list => list[random() % list.length];
const cases = [];
// MeetPaul's letterbox at the reference size (bars 52 and 106 of 960; the
// root is 1440 x 960 at multiplier 1 there), then systematic edges.
cases.push({flags: 3, render: [0, 52, 1440, 802].map(bits), multipliers: [1, 1], frame: [1440, 960, 0, 0]});
for (const flags of [0, 1, 2, 3, 0xfffffffc, 0xffffffff, 5])
  for (const frame of FRAMES) cases.push({flags, render: [0, 52, 1440, 802].map(bits), multipliers: [1, 1], frame});
for (const multipliers of MULTIPLIERS)
  for (const value of SPECIAL) cases.push({flags: 3, render: [value, value, value, value], multipliers, frame: [1440, 960, 0, 0]});
for (let i = 0; i < 1500; i++) {
  const render = Array.from({length: 4}, () => random() % 3 ? pick(SPECIAL) : random());
  cases.push({flags: pick([1, 3, 3, 3, 7]), render, multipliers: random() % 4 ? pick(MULTIPLIERS) : [random() | 0, random() | 0],
    frame: random() % 3 ? pick(FRAMES) : [random() % 4096, random() % 4096, (random() % 512) - 256, (random() % 512) - 256]});
}

const reference = JSON.parse(execFileSync(python, ['scripts/native-root-render-viewport-oracle.py', root],
  {input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 26})).results;

const memory = new DataView(new ArrayBuffer(0x800));
const W = {u32: (_, at) => memory.getUint32(at, true), i32: (_, at) => memory.getInt32(at, true), f32: (_, at) => memory.getFloat32(at, true)};
let checked = 0;
for (const [index, sample] of cases.entries()) {
  memory.setUint32(0x5d8, sample.flags >>> 0, true);
  sample.render.forEach((value, i) => memory.setUint32(0x5dc + 4 * i, value >>> 0, true));
  memory.setInt32(0x730, sample.multipliers[0], true); memory.setInt32(0x734, sample.multipliers[1], true);
  const [X, Y, XB, YB] = sample.frame;
  const got = rootRenderViewport(W, null, {x: XB, y: YB, width: X, height: Y});
  assert.deepEqual([got.width, got.height, got.x, got.y], reference[index], `case ${index}: ${JSON.stringify(sample)}`);
  checked++;
}
const letterbox = reference[0];
assert.deepEqual(letterbox, [1440, 802, 0, 52], 'MeetPaul letterbox render rect');
console.log(`PASS validate-root-render-viewport: ${checked} original PreRender frame edits bit-exact (flags, multipliers, specials, clamps); letterbox 1440x802 at (0,52)`);
