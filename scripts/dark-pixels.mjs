// The darkest pixels against the original (docs/visual-acceptance.md "The darkest pixels", item 2): Play's raw frames against the original's
// framebuffer at the identity ramp, separating the pixels an animated light moves from the steady ones.
//
//   node scripts/dark-pixels.mjs --maps 14_OceanLab_Lab,01_NYC_UNATCOIsland --states r45,r52,t037 [--views y0,y1,y2,y3,down] [--dir .work/acceptance]
//       [--original original] [--edge 8] [--json out.json]
//
// Inputs, per map and view, in <dir>/<map>/: `<view>-<original>.png` (default `-original.png`: the original's Shot at Brightness 2/3, where Shot is the
// framebuffer, `visual-acceptance.mjs original --brightness 0.666667`) and one Play frame per state, `<view>-<state>.png` (`visual-acceptance.mjs play
// --query antialias=0 --settle-frames n --time-offset s`, copied to a name per state). The states must differ in what animated light maps depend on: the
// frame count (the noise tables take 256 fresh draws every frame) and the level time (Pulse, Blink, the wavers). A pixel is *steady* when every state gives
// the same value in all three channels; the original is then compared against that value. The other pixels are lit by animated lights, whose phase the
// two programs do not share, and say nothing about rounding.
//
// Prints, per view and in all: the share of steady channel samples, identical share and mean absolute difference on them, the 0..N joint table of
// original against Play on steady samples, and a split of the steady mismatches into flat pixels and edge pixels (the Play frame's 3x3 neighbourhood
// holds a channel step of at least --edge).
//
// With the three `?lightDebug=` captures of the same views (`--base-tag`, `--light-tag`, `--world-tag`: Play's frames with `lightDebug=base`, `light32`
// and `world`, src/viewer/light-atlas.mjs) it also separates the pixels the light-map shader drew (the `world` frame is white) and, for those, gives each
// steady sample its inputs: the base texel b (the `base` frame) and the light-map sample l in bytes (the `light32` frame over 32, saturated above 8
// bytes and white where a surface has no light map), so the ideal product is x = b * 2 * l / 255. It prints the mismatch rate by x (the level
// floor(x) and the tenth of its fraction) and, for samples whose b and l are constant over the pixel's 3x3 neighbourhood (so neither filter has
// anything to blend), the mismatches by level: any mismatch there would be a rounding rule, not filter arithmetic.
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import path from 'node:path';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const dir = option('dir', '.work/acceptance');
const maps = option('maps', '').split(',').filter(Boolean), views = option('views', 'y0,y1,y2,y3,down').split(','), states = option('states', '').split(',').filter(Boolean);
const originalName = option('original', 'original'), edge = Number(option('edge', 8)), TABLE = Number(option('table', 8));
const baseTag = option('base-tag', null), lightTag = option('light-tag', null), worldTag = option('world-tag', null);
const withInputs = Boolean(baseTag && lightTag && worldTag);
const BINS = 10, LEVELS = 4;
const byX = Array.from({length: LEVELS}, () => Array.from({length: BINS}, () => ({n: 0, mism: 0, up: 0})));
const flatByLevel = Array.from({length: LEVELS}, () => ({n: 0, mism: 0, up: 0})), flatTotal = {n: 0, mism: 0}, litTotal = {n: 0, same: 0, abs: 0};
const litJoint = Array.from({length: TABLE}, () => new Float64Array(TABLE)), litByMap = {};
if (!maps.length || states.length < 1) throw new Error('usage: dark-pixels.mjs --maps a,b --states s1,s2,... (two or more states to find the steady pixels)');
const load = file => execFileSync('magick', [file, '-depth', '8', 'rgb:-'], {maxBuffer: 1 << 28});
const W = 1280, H = 720;

const joint = Array.from({length: TABLE}, () => new Float64Array(TABLE));
const total = {samples: 0, steady: 0, same: 0, abs: 0, flat: 0, edge: 0, movingSame: 0, movingAbs: 0};
const rows = [];
for (const map of maps) for (const view of views) {
  const original = load(path.join(dir, map, `${view}-${originalName}.png`));
  const runs = states.map(state => load(path.join(dir, map, `${view}-${state}.png`)));
  const steady = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    let same = 1;
    for (let r = 1; r < runs.length && same; r++) for (let c = 0; c < 3; c++) if (runs[r][3 * p + c] !== runs[0][3 * p + c]) { same = 0; break; }
    steady[p] = same;
  }
  const play = runs[0];
  const inputs = withInputs ? ['base', 'light', 'world'].map(k => load(path.join(dir, map, `${view}-${{base: baseTag, light: lightTag, world: worldTag}[k]}.png`))) : null;
  const row = {map, view, samples: 3 * W * H, steady: 0, same: 0, abs: 0, flat: 0, edge: 0, movingSame: 0, movingAbs: 0, dark: {}};
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++) {
      const a = original[3 * p + c], b = play[3 * p + c], d = Math.abs(a - b);
      if (!steady[p]) { row.movingSame += a === b; row.movingAbs += d; continue; }
      if (inputs) {
        const [baseF, lightF, worldF] = inputs, i = 3 * p + c;
        if (worldF[3 * p] === 255 && worldF[3 * p + 1] === 255 && worldF[3 * p + 2] === 255) {
          litTotal.n++; litTotal.same += a === b; litTotal.abs += d;
          const lm = litByMap[map] ??= {n: 0, same: 0}; lm.n++; lm.same += a === b;
          if (a < TABLE && b < TABLE) litJoint[a][b]++;
          if (lightF[i] < 250) {
            const x = baseF[i] * 2 * (lightF[i] / 32) / 255, level = Math.floor(x);
            if (level < LEVELS) {
              const cell = byX[level][Math.min(BINS - 1, Math.floor((x - level) * BINS))];
              cell.n++; if (a !== b) { cell.mism++; if (a > b) cell.up++; }
              const px = p % W, py = (p / W) | 0;
              let flatInputs = px > 0 && py > 0 && px < W - 1 && py < H - 1;
              for (let dy = -1; dy <= 1 && flatInputs; dy++) for (let dx = -1; dx <= 1; dx++) {
                const j = 3 * (p + dy * W + dx) + c;
                if (baseF[j] !== baseF[i] || lightF[j] !== lightF[i]) { flatInputs = false; break; }
              }
              if (flatInputs) { flatTotal.n++; flatTotal.mism += a !== b; flatByLevel[level].n++; if (a !== b) { flatByLevel[level].mism++; if (a > b) flatByLevel[level].up++; } }
            }
          }
        }
      }
      row.steady++; row.same += a === b; row.abs += d;
      if (a < TABLE && b < TABLE) joint[a][b]++;
      if (a !== b) {
        // an edge pixel: a channel step of at least `edge` against a neighbour in the Play frame
        const x = p % W, y = (p / W) | 0;
        let step = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          step = Math.max(step, Math.abs(play[3 * (yy * W + xx) + c] - b));
        }
        if (step >= edge) row.edge++; else row.flat++;
        if (a < 4 && b < 4) { const key = `${a}>${b} ${step >= edge ? 'edge' : 'flat'}`; row.dark[key] = (row.dark[key] ?? 0) + 1; }
      }
    }
  }
  for (const key of ['samples', 'steady', 'same', 'abs', 'flat', 'edge', 'movingSame', 'movingAbs']) total[key] += row[key];
  rows.push(row);
}
const pct = (a, b) => b ? (100 * a / b).toFixed(3) : '-';
console.log('| map | view | steady share | steady identical | steady MAD | mismatches: flat / edge | moving identical | moving MAD |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  const moving = r.samples - r.steady;
  console.log(`| ${r.map} | ${r.view} | ${pct(r.steady, r.samples)}% | ${pct(r.same, r.steady)}% | ${r.steady ? (r.abs / r.steady).toFixed(5) : '-'} | ${r.flat} / ${r.edge} | ${pct(r.movingSame, moving)}% | ${moving ? (r.movingAbs / moving).toFixed(3) : '-'} |`);
}
const moving = total.samples - total.steady;
console.log(`| all | | ${pct(total.steady, total.samples)}% | ${pct(total.same, total.steady)}% | ${(total.abs / total.steady).toFixed(5)} | ${total.flat} / ${total.edge} | ${pct(total.movingSame, moving)}% | ${(total.movingAbs / moving).toFixed(3)} |`);
console.log(`\nsteady channel samples: original value (rows 0..${TABLE - 1}) against Play value (columns)`);
for (let i = 0; i < TABLE; i++) console.log(String(i).padStart(2), Array.from(joint[i]).map(x => String(x).padStart(10)).join(' '));
const dark = {};
for (const r of rows) for (const [k, v] of Object.entries(r.dark)) dark[k] = (dark[k] ?? 0) + v;
console.log('\nsteady mismatches with both values below 4 (original>Play, flat or edge pixel: count):', Object.entries(dark).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none');
if (withInputs) {
  console.log(`\nsamples the light-map shader drew (steady): ${litTotal.n}, identical ${pct(litTotal.same, litTotal.n)}%, MAD ${(litTotal.abs / litTotal.n).toFixed(5)}; original (rows) against Play (columns):`);
  for (let i = 0; i < TABLE; i++) console.log(String(i).padStart(2), Array.from(litJoint[i]).map(x => String(x).padStart(10)).join(' '));
  console.log('  by map:', Object.entries(litByMap).map(([m, v]) => `${m} ${v.n - v.same} of ${v.n} (${pct(v.n - v.same, v.n)}%)`).join('; '));
  console.log('\nmismatch rate by the ideal product x = b * 2 * l / 255: rows floor(x), columns the tenth of its fraction (samples in brackets; the share with the original brighter)');
  for (let l = 0; l < LEVELS; l++) console.log(`x in [${l}, ${l + 1}):`, byX[l].map(c => `${pct(c.mism, c.n)}% (${c.n}, ${pct(c.up, c.mism)}% up)`).join('  '));
  const lmTotal = byX.flat().reduce((a, c) => ({n: a.n + c.n, mism: a.mism + c.mism}), {n: 0, mism: 0});
  console.log(`all of those (a light map under 8 bytes, ideal product below 4): ${lmTotal.mism} mismatches of ${lmTotal.n} samples (${pct(lmTotal.mism, lmTotal.n)}%)`);
  console.log(`\nsamples with constant inputs over their 3x3 neighbourhood: ${flatTotal.mism} mismatches of ${flatTotal.n}`);
  for (let l = 0; l < LEVELS; l++) console.log(`  x in [${l}, ${l + 1}): ${flatByLevel[l].mism} of ${flatByLevel[l].n} (original brighter in ${flatByLevel[l].up})`);
}
if (option('json', null)) writeFileSync(option('json', null), JSON.stringify({rows, total, joint: joint.map(r => Array.from(r))}, null, 1));
