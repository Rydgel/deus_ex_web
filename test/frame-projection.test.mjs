import test from 'node:test';
import assert from 'node:assert/strict';
import { d3dVertex, depthConstants, floatWord, frameOfFields, frameOfWords, modelVertex, projectView, viewPoint, wordFloat }
  from '../src/runtime/frame-projection.mjs';

// The vertex chain's operations are one binary32 rounding each at the render
// pass's precision control 24. Here they are checked against an independent
// exact-rational implementation (BigInt round-to-nearest-even to 24 bits),
// not against Math.fround composed the same way; the original's own results
// are the oracle's (scripts/validate-frame-projection.mjs).
const bitsOf = value => floatWord(value) >>> 0;
const toRational = x => {            // a finite float as numerator / 2^k
  const word = bitsOf(x), sign = word >>> 31 ? -1n : 1n, e = (word >>> 23) & 255, m = BigInt(word & 0x7fffff);
  if (e === 0) return { n: sign * m, k: 149n };
  return { n: sign * (m | 0x800000n), k: BigInt(150 - e) };
};
const normalize = ({ n, k }) => { while (k > 0n && n % 2n === 0n && n !== 0n) { n /= 2n; k -= 1n; } return { n, k }; };
/** Round the rational p/q (q > 0) to the nearest binary32 (ties to even), as a number. */
function roundRational(p, q) {
  if (p === 0n) return 0;
  const sign = p < 0n ? -1 : 1; p = p < 0n ? -p : p;
  // Find e with 2^23 <= p / (q 2^e) < 2^24.
  let e = BigInt(p.toString(2).length - q.toString(2).length) - 24n;
  const scaled = (pp, qq, ee) => (ee >= 0n ? [pp, qq << ee] : [pp << -ee, qq]);
  for (;;) {
    const [a, b] = scaled(p, q, e);
    if (a < (1n << 23n) * b) e -= 1n; else if (a >= (1n << 24n) * b) e += 1n; else break;
  }
  const [a, b] = scaled(p, q, e);
  let m = a / b; const rem = a % b;
  if (2n * rem > b || (2n * rem === b && (m & 1n))) m += 1n;
  const value = Number(m) * 2 ** Number(e);
  return sign * value;
}
const ratAdd = (x, y, sub = false) => { const a = toRational(x), b = toRational(y), k = a.k > b.k ? a.k : b.k;
  return { n: (a.n << (k - a.k)) + (sub ? -1n : 1n) * (b.n << (k - b.k)), k }; };
const roundRat = ({ n, k }) => roundRational(n, 1n << k);
const add = (x, y) => roundRat(ratAdd(x, y)), sub = (x, y) => roundRat(ratAdd(x, y, true));
const mul = (x, y) => { const a = toRational(x), b = toRational(y); return roundRat({ n: a.n * b.n, k: a.k + b.k }); };
const div = (x, y) => { const a = toRational(x), b = toRational(y);
  const num = a.n << b.k, den = b.n << a.k; return den < 0n ? roundRational(-num, -den) : roundRational(num, den); };

let seed = 12345;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const f32 = Math.fround;
const randomFrame = () => {
  // An orthonormal-ish frame: random axes are enough, the chain does not care.
  const axis = () => [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1].map(f32);
  return { origin: [random() * 8000 - 4000, random() * 8000 - 4000, random() * 600].map(f32), axes: [axis(), axis(), axis()],
    width: 1440, height: 960, fx15: f32((1440 + 1.0001) * 0.5), fy15: f32((960 + 1.0001) * 0.5), projZ: f32(500 + random() * 800),
    rprojZ: f32(1 / 900), xb: Math.floor(random() * 300), yb: Math.floor(random() * 200) };
};

test('the view transform and the projection are one binary32 rounding per operation', () => {
  for (let i = 0; i < 400; i++) {
    const frame = randomFrame(), p = [random() * 9000 - 4500, random() * 9000 - 4500, random() * 1500 - 100].map(f32);
    const d = p.map((v, k) => sub(v, frame.origin[k]));
    const expected = frame.axes.map(a => add(add(mul(d[0], a[0]), mul(d[1], a[1])), mul(d[2], a[2])));
    const got = viewPoint(frame, p);
    assert.deepEqual(got.map(bitsOf), expected.map(bitsOf), 'view point');
    if (!(expected[2] > 1)) continue;
    const rz = div(frame.projZ, expected[2]), screenX = add(mul(expected[0], rz), frame.fx15), screenY = add(mul(expected[1], rz), frame.fy15);
    const projected = projectView(frame, got);
    assert.deepEqual([projected.rz, projected.screenX, projected.screenY].map(bitsOf), [rz, screenX, screenY].map(bitsOf), 'projection');
    const depth = depthConstants(32), rhw = mul(rz, frame.rprojZ);
    const vertex = d3dVertex(frame, depth, projected);
    assert.deepEqual([vertex.sx, vertex.sy, vertex.sz, vertex.rhw].map(bitsOf),
      [sub(add(frame.xb, screenX), 0.5), sub(add(frame.yb, screenY), 0.5), add(mul(rhw, depth.zScale), depth.zBias), rhw].map(bitsOf), 'vertex');
  }
});

test('SetRes depth constants: near 1, far 32767 (8192 at 16 bits), depth 0 at view depth 1 and 1 at the far plane', () => {
  // Measured on the original (D3DDrv 0x1000c40f..0x1000c45b under Unicorn): _33 = 0x3f800100, _43 = -_33.
  const wide = depthConstants(32), narrow = depthConstants(16);
  assert.equal(bitsOf(wide.zBias), 0x3f800100);
  assert.equal(bitsOf(wide.zScale), 0xbf800100);
  assert.equal(narrow.zBias, f32(8192 / 8191));
  for (const [far, c] of [[32767, wide], [8192, narrow]]) {
    const depthAt = z => c.zBias + c.zScale * (1 / z);
    assert.ok(Math.abs(depthAt(1)) < 1e-6 && Math.abs(depthAt(far) - 1) < 1e-4, `far ${far}`);
    assert.ok(depthAt(100) < depthAt(200) && depthAt(200) < depthAt(far));
  }
});

test('frames from the occlusion words and from the ComputeRenderSize fields agree', () => {
  const words = new Array(64).fill(0);
  [10, 20, 30, 0, 1, 0, 0, 0, 1, 1, 0, 0].forEach((v, i) => { words[i] = bitsOf(v); });
  words[12] = 1024; words[13] = 768; words[14] = bitsOf(512.50006); words[15] = bitsOf(384.50006); words[20] = bitsOf(512); words[60] = bitsOf(1 / 512);
  const fields = new Array(57).fill(0);
  [10, 20, 30, 0, 1, 0, 0, 0, 1, 1, 0, 0].forEach((v, i) => { fields[i] = bitsOf(v); });
  fields[14] = words[14]; fields[15] = words[15]; fields[21] = words[20]; fields[24] = words[60];
  const a = frameOfWords(words, { x: 3, y: 4 }), b = frameOfFields(fields, { width: 1024, height: 768, x: 3, y: 4 });
  assert.deepEqual(a, b);
  assert.equal(a.projZ, 512);
  // The centre of the screen: a point straight ahead lands at (XB + FX15 - 0.5, YB + FY15 - 0.5).
  const v = modelVertex(a, depthConstants(32), [110, 20, 30]);
  assert.equal(v.sx, f32(f32(3 + a.fx15) - 0.5));
  assert.equal(v.sy, f32(f32(4 + a.fy15) - 0.5));
  assert.equal(wordFloat(floatWord(v.rhw)), v.rhw);
});
