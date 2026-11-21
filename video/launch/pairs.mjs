// The matched original/browser frame pairs of the visual acceptance work (docs/visual-acceptance.md), measured again for the launch
// clips: every <view>-original.png with a <view>-play.png of the same size in .work/acceptance/<map>/, through the comparison of
// scripts/visual-acceptance.mjs `compare` (its functions are copied here unchanged, because that script runs on import and writes
// into the store: this one only reads it) and judged at the Stage 4 gate's thresholds (scripts/validate-stage4-acceptance.mjs
// THRESHOLDS: edge recall 0.90, edge precision 0.85, no outlier block).
//   node video/launch/pairs.mjs [--maps a,b] [--views y0,y1] [--missing 1 (only pairs not yet in the report)]      -> .work/marketing/out/pairs.json
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const store = path.join(repo, '.work/acceptance'), outDir = path.join(repo, '.work/marketing/out');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
export const THRESHOLDS = {edgeRecall: 0.90, edgePrecision: 0.85, outlierBlocks: 0};

export function readRgb(file) {
  const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', file], {encoding: 'utf8'}).split(' ').map(Number);
  return {w, h, data: execFileSync('magick', [file, '-depth', '8', 'rgb:-'], {maxBuffer: 1 << 28})};
}
const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
function edges(img) {
  const {w, h, data} = img, L = new Float32Array(w * h), G = new Float32Array(w * h), E = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = luma(data, 3 * i);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = (dx, dy) => L[(y + dy) * w + x + dx];
    const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
    const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
    G[y * w + x] = Math.hypot(gx, gy);
  }
  const threshold = Math.max(4, Float32Array.from(G).sort()[Math.floor(0.95 * G.length)]);
  for (let i = 0; i < w * h; i++) E[i] = G[i] >= threshold ? 1 : 0;
  return E;
}
function edgeRecall(a, b, w, h, r = 2) {
  let n = 0, hit = 0;
  for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
    if (!a[y * w + x]) continue;
    n++;
    search: for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (b[(y + dy) * w + x + dx]) { hit++; break search; }
  }
  return n ? hit / n : 1;
}
/** The comparison of one pair, as `compare` reports it (without the images it writes), and the share of pixels equal / within 2 of 255. */
export function comparePair(a, b) {
  const A = readRgb(a), B = readRgb(b);
  if (A.w !== B.w || A.h !== B.h) return {error: `size ${A.w}x${A.h} vs ${B.w}x${B.h}`};
  const {w, h} = A, n = w * h, mean = [[0, 0, 0], [0, 0, 0]];
  let mad = 0, identical = 0, within2 = 0, over10 = 0;
  for (let i = 0; i < n; i++) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const x = A.data[3 * i + c], y = B.data[3 * i + c], d = Math.abs(x - y);
      mean[0][c] += x; mean[1][c] += y; mad += d; if (d > worst) worst = d;
    }
    if (worst === 0) identical++;
    if (worst <= 2) within2++;
    if (worst > 10) over10++;
  }
  const EA = edges(A), EB = edges(B);
  const GX = 16, GY = 9, blocks = [];
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    let la = 0, lb = 0, k = 0;
    for (let y = Math.floor(gy * h / GY); y < Math.floor((gy + 1) * h / GY); y++)
      for (let x = Math.floor(gx * w / GX); x < Math.floor((gx + 1) * w / GX); x++) { la += luma(A.data, 3 * (y * w + x)); lb += luma(B.data, 3 * (y * w + x)); k++; }
    blocks.push(+((lb / k + 1) / (la / k + 1)).toFixed(3));
  }
  const m = mean.map(v => v.map(x => x / n)), sorted = [...blocks].sort((x, y) => x - y), median = sorted[sorted.length >> 1];
  const result = {
    size: [w, h], meanOriginal: +((m[0][0] + m[0][1] + m[0][2]) / 3).toFixed(2), meanPlay: +((m[1][0] + m[1][1] + m[1][2]) / 3).toFixed(2),
    ratio: +((m[1][0] + m[1][1] + m[1][2] + 3) / (m[0][0] + m[0][1] + m[0][2] + 3)).toFixed(3),
    mad: +(mad / (3 * n)).toFixed(3), identical: +(identical / n).toFixed(4), within2: +(within2 / n).toFixed(4), over10,
    edgeRecall: +edgeRecall(EA, EB, w, h).toFixed(3), edgePrecision: +edgeRecall(EB, EA, w, h).toFixed(3),
    outlierBlocks: blocks.filter(r => Math.abs(Math.log(r / median)) > Math.log(1.6)).length,
  };
  result.pass = result.edgeRecall >= THRESHOLDS.edgeRecall && result.edgePrecision >= THRESHOLDS.edgePrecision && result.outlierBlocks <= THRESHOLDS.outlierBlocks;
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const maps = option('maps', null)?.split(',') ?? readdirSync(store, {withFileTypes: true}).filter(d => d.isDirectory()).map(d => d.name).sort();
  const only = option('views', null)?.split(',');
  const file = path.join(outDir, 'pairs.json');
  mkdirSync(outDir, {recursive: true});
  const report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for (const map of maps) {
    const dir = path.join(store, map);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(f => f.endsWith('-original.png')).map(f => f.slice(0, -'-original.png'.length)).sort()) {
      if (only && !only.includes(name)) continue;
      if (/-base$|-crop$|crop/.test(name)) continue;
      // the browser's frame: <view>-play.png, or <view>-gate.png where the Stage 4 gate's own run took it (the interface frames)
      const a = path.join(dir, `${name}-original.png`), b = [`${name}-play.png`, `${name}-gate.png`].map(f => path.join(dir, f)).find(existsSync);
      if (!b || (option('missing', null) && report[map]?.[name])) continue;
      const result = {...comparePair(a, b), browser: path.basename(b)};
      (report[map] ??= {})[name] = result;
      console.log(map, name, JSON.stringify(result));
    }
    writeFileSync(file, JSON.stringify(report, null, 1));
  }
}
