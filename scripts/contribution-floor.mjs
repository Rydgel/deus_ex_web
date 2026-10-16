// An effect's contribution measured against the original's own frame-to-frame floor (docs/visual-acceptance.md "04_NYC_Street's steam vents").
// A FireTexture ticks with every drawn frame (Fire.dll's sparks, docs/fire-texture.md), so at a held tick the pixels of an effect drawn with one
// (the steam's SmokePuff1) differ from frame to frame in the original itself. With several frames of the same held tick on each side
// (`live-acceptance.mjs original|play --extra-shots N`), this compares every frame with every other frame of the same program and of the other:
// the metrics of visual-acceptance.mjs `compare --contribution` (the same formulas), the first frame of each pair the reference.
//
//   node scripts/contribution-floor.mjs --map 04_NYC_Street --shot vents4
//
// Reads .work/acceptance/<map>/<shot>-original.png, <shot>-original-<k>.png, <shot>-base-original.png and <shot>-play.png, <shot>-play-<k>.png,
// <shot>-play-base.png. Prints, for the original against itself, Play against the original (the original's frame the reference, as the gate's
// check) and Play against itself, each metric's minimum, median and maximum over the pairs, one JSON line per group.
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const map = option('map', '04_NYC_Street'), shot = option('shot', 'vents4'), dir = path.join(root, '.work/acceptance', map);
const readRgb = file => {
  const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', file], {encoding: 'utf8'}).split(' ').map(Number);
  return {w, h, data: execFileSync('magick', [file, '-depth', '8', 'rgb:-'], {maxBuffer: 1 << 28})};
};
const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
const frames = side => {
  const first = path.join(dir, `${shot}-${side}.png`), list = existsSync(first) ? [first] : [];
  for (let k = 2; existsSync(path.join(dir, `${shot}-${side}-${k}.png`)); k++) list.push(path.join(dir, `${shot}-${side}-${k}.png`));
  return list;
};
// each frame less its program's frame without the effect: the luma difference and the RGB sum
const difference = (file, base) => {
  const f = readRgb(file), n = f.w * f.h, d = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) d[i] = luma(f.data, 3 * i) - luma(base.data, 3 * i);
  for (let i = 0; i < 3 * n; i++) sum += f.data[i] - base.data[i];
  return {d, sum, name: path.basename(file)};
};
const originals = frames('original'), plays = frames('play');
if (!originals.length || !plays.length) throw new Error(`${map} ${shot}: no frames (${originals.length} original, ${plays.length} Play)`);
const originalBase = readRgb(path.join(dir, `${shot}-base-original.png`)), playBase = readRgb(path.join(dir, `${shot}-play-base.png`));
const O = originals.map(file => difference(file, originalBase)), P = plays.map(file => difference(file, playBase));
// visual-acceptance.mjs contribution(): an effect that brightens (the steam); `ref` is the reference (the "original" of that function)
function metrics(ref, other) {
  const a = ref.d, b = other.d, n = a.length;
  let so = 0, sp = 0, soo = 0, spp = 0, sop = 0, absO = 0;
  for (let i = 0; i < n; i++) { so += a[i]; sp += b[i]; soo += a[i] * a[i]; spp += b[i] * b[i]; sop += a[i] * b[i]; absO += Math.abs(a[i]); }
  const k = soo ? sop / soo : 0, correlation = (sop - so * sp / n) / Math.sqrt(Math.max(1e-9, (soo - so * so / n) * (spp - sp * sp / n)));
  // agreement10: the same share over the pixels the reference raises by at least 10 levels (the plume's body, not its faint fringe)
  let resid = 0, own = 0, agree = 0, own10 = 0, agree10 = 0;
  for (let i = 0; i < n; i++) {
    resid += Math.abs(b[i] - k * a[i]);
    if (a[i] >= 1) { own++; if (b[i] >= 0.25 * k * a[i]) agree++; }
    if (a[i] >= 10) { own10++; if (b[i] >= 0.25 * k * a[i]) agree10++; }
  }
  return {correlation, gap: other.sum / Math.max(1, ref.sum), residual: resid / Math.max(1e-9, absO), agreement: own ? agree / own : null, agreement10: own10 ? agree10 / own10 : null};
}
const pairs = (refs, others, same) => refs.flatMap((ref, i) => others.flatMap((other, j) => same && i === j ? [] : [metrics(ref, other)]));
const summary = (label, list) => {
  const out = {group: label, pairs: list.length};
  for (const key of ['agreement', 'agreement10', 'correlation', 'gap', 'residual']) {
    const v = list.map(m => m[key]).sort((x, y) => x - y);
    out[key] = {min: +v[0].toFixed(4), median: +v[v.length >> 1].toFixed(4), max: +v[v.length - 1].toFixed(4)};
  }
  return out;
};
console.log(`${map} ${shot}: ${originals.length} original frames, ${plays.length} Play frames`);
console.log(JSON.stringify(summary('original against itself', pairs(O, O, true))));
console.log(JSON.stringify(summary('Play against the original', pairs(O, P, false))));
console.log(JSON.stringify(summary('Play against itself', pairs(P, P, true))));
