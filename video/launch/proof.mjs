// The side-by-side proof clip of the launch: DeusEx.exe above, the browser below, one picture, a seam that moves between the two.
//   node video/launch/proof.mjs [--only 1,54,108] [--fps 60]     -> .work/marketing/out/proof-1080p.mp4, proof-square.mp4
// It shows stored frame pairs of the visual acceptance work (docs/visual-acceptance.md; .work/acceptance/<map>/<view>-original.png
// is the original under Wine, -play.png or -gate.png the browser from the same camera at the same held level time or tick). Nothing
// is captured here. A pair goes in only if
//   - it passes the comparison at the Stage 4 gate's thresholds, measured again by pairs.mjs just before the render, and
//   - both frames hold the raw framebuffer (the original shot at Brightness 2/3, the browser at its identity ramp): the stores shot at
//     the installed ramp carry Wine's uniform 1.13 to 1.45 brightness gap, which a seam would show as a step (mean ratio 0.99 to 1.02).
// Both sides then go through one display ramp, the game's default Brightness 0.6 (exponent 2/3, docs/lighting.md "Display ramp"), and
// one Lanczos resize: nothing is done to one side that is not done to the other.
// The frames are drawn in headless Chromium (no sound anywhere) and encoded by ffmpeg; the clip has no audio track.
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {comparePair} from './pairs.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const store = path.join(repo, '.work/acceptance'), out = path.join(repo, '.work/marketing/out'), work = path.join(out, 'proof');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const FPS = Number(option('fps', 60)), HOLD = 1.8;                    // seconds a pair is shown: one pass of the seam

// [map, view, the browser's frame, what the caption says, the left edge of the square version's 960-wide window in the 1280-wide frame]
const PAIRS = [
  ['00_Intro', 'in2-in1', 'play', 'The intro', 160],
  ['00_Intro', 'in2-in3', 'play', 'The intro', 160],
  ['01_NYC_UNATCOIsland', 'cvA4', 'play', 'Liberty Island', 0],
  ['01_NYC_UNATCOHQ', 'mm3', 'play', 'UNATCO headquarters', 0],
  ['00_Training', 'trainB', 'play', 'Training', 160],
  ['00_Training', 'ui-health', 'gate', 'The health screen', 160],
  ['06_HongKong_WanChai_Garage', 'garage2', 'play', 'Hong Kong, Wan Chai', 160],
  ['06_HongKong_WanChai_Underworld', 'uw_s0', 'play', 'Hong Kong, the Lucky Money', 80],
  ['00_Training', 'ui-menu', 'gate', 'The main menu', 160],
  ['DX', 'dxend2', 'play', 'The logo', 160],
];

// ---------------------------------------------------------------------------------------- the pairs: measured, then graded
rmSync(work, {recursive: true, force: true});
mkdirSync(path.join(work, 'img'), {recursive: true});
const report = [];
for (const [map, view, side, caption, x0] of PAIRS) {
  const a = path.join(store, map, `${view}-original.png`), b = path.join(store, map, `${view}-${side}.png`);
  const m = comparePair(a, b);
  if (!m.pass || m.ratio < 0.99 || m.ratio > 1.02) throw new Error(`${map} ${view} does not qualify: ${JSON.stringify(m)}`);
  report.push({map, view, caption, original: path.relative(repo, a), browser: path.relative(repo, b), ...m});
  for (const [file, tag] of [[a, 'o'], [b, 'b']]) {
    const grade = ['-gamma', '1.5', '-filter', 'Lanczos'];
    execFileSync('magick', [file, ...grade, '-resize', '1920x1080!', path.join(work, 'img', `${map}__${view}-${tag}-wide.png`)]);
    execFileSync('magick', [file, ...grade, '-crop', `960x720+${x0}+0`, '+repage', '-resize', '1080x810!', path.join(work, 'img', `${map}__${view}-${tag}-square.png`)]);
  }
  console.log(`${map} ${view}: identical ${(m.identical * 100).toFixed(1)}%, within 2/255 ${(m.within2 * 100).toFixed(2)}%, edges ${m.edgeRecall}/${m.edgePrecision}, ratio ${m.ratio}`);
}
writeFileSync(path.join(out, 'proof-pairs.json'), JSON.stringify(report, null, 1));

// ------------------------------------------------------------------------------------------------------ the drawing
const page = () => {
  const C = {bg: '#0c1017', text: '#e8e4dc', dim: '#9aa3b2', orange: '#D97757'};
  const SANS = '"Noto Sans", "Liberation Sans", system-ui, sans-serif';
  let cfg, cv, g;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
  const tag = (label, x, y, {size = 34, align = 'left', alpha = 1} = {}) => {
    g.save(); g.globalAlpha = alpha;
    g.font = `600 ${size}px ${SANS}`; g.textBaseline = 'middle';
    const w = g.measureText(label).width + size * 1.1, h = size * 1.75, left = align === 'right' ? x - w : x;
    g.fillStyle = 'rgba(8,11,16,0.82)'; g.beginPath(); g.roundRect(left, y, w, h, 8); g.fill();
    g.fillStyle = C.orange; g.fillRect(left, y + 8, 4, h - 16);
    g.fillStyle = C.text; g.fillText(label, left + size * 0.55, y + h / 2 + 1);
    g.restore();
    return h;
  };
  window.setup = async c => {
    cfg = c;
    cv = document.getElementById('c'); cv.width = c.W; cv.height = c.H; g = cv.getContext('2d');
    await document.fonts.ready;
    cfg.images = await Promise.all(c.pairs.map(async p => { const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
      return {o: await load(p.o), b: await load(p.b), caption: p.caption}; }));
    return {font: document.fonts.check(`600 34px "Liberation Sans"`)};
  };
  // frame f (0-based): which pair, and where the seam is in the picture (a share of its height, from the top)
  window.at = f => {
    const n = cfg.hold, k = Math.min(cfg.images.length - 1, Math.floor(f / n)), t = (f - k * n) / (n - 1);
    const e = smooth((t - 0.1) / 0.8), s = k % 2 === 0 ? 0.25 + 0.5 * e : 0.75 - 0.5 * e;
    return {k, s, t};
  };
  window.draw = f => {
    const {W, H, box} = cfg, {k, s} = window.at(f), im = cfg.images[k], square = cfg.layout === 'square';
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    const [x, y, w, h] = box, seam = Math.round(y + h * s);
    // the original above the seam, the browser below it: each drawn one to one, nothing blended
    g.save(); g.beginPath(); g.rect(x, y, w, seam - y); g.clip(); g.drawImage(im.o, x, y); g.restore();
    g.save(); g.beginPath(); g.rect(x, seam, w, y + h - seam); g.clip(); g.drawImage(im.b, x, y); g.restore();
    // the seam: a thin light line with a dark edge, and a grip in the middle
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x, seam - 3, w, 6);
    g.fillStyle = '#f4efe6'; g.fillRect(x, seam - 1, w, 2);
    const cx = Math.round(x + w * 0.86);                              // off the middle, where the faces are
    g.fillStyle = 'rgba(8,11,16,0.9)'; g.beginPath(); g.roundRect(cx - 34, seam - 20, 68, 40, 20); g.fill();
    g.strokeStyle = '#f4efe6'; g.lineWidth = 2; g.beginPath(); g.roundRect(cx - 34, seam - 20, 68, 40, 20); g.stroke();
    g.fillStyle = '#f4efe6';
    g.beginPath(); g.moveTo(cx - 9, seam - 5); g.lineTo(cx, seam - 14); g.lineTo(cx + 9, seam - 5); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(cx - 9, seam + 5); g.lineTo(cx, seam + 14); g.lineTo(cx + 9, seam + 5); g.closePath(); g.fill();
    // the labels: the program each half comes from, and what is in the picture
    const small = (str, px, py, align = 'right', size = 24, color = C.dim) => { g.save(); g.font = `${size}px ${SANS}`; g.textAlign = align; g.textBaseline = 'alphabetic';
      if (!square) { g.shadowColor = 'rgba(0,0,0,0.95)'; g.shadowBlur = 8; g.shadowOffsetY = 1; }
      g.fillStyle = color; g.fillText(str, px, py); g.restore(); };
    if (square) {
      tag('DeusEx.exe', 36, 38);
      tag('Browser', 36, y + h + 38);
      small('same camera, same level time', W - 36, 78, 'right', 26);
      small(im.caption, W - 36, y + h + 78, 'right', 30, C.text);
    } else {
      tag('DeusEx.exe', 44, 40, {size: 38});
      tag('Browser', 44, H - 40 - 38 * 1.75, {size: 38});
      small(im.caption, W - 44, H - 76, 'right', 34, C.text);
      small('same camera, same level time', W - 44, H - 40, 'right', 26, '#c9cfda');
    }
    return cv.toDataURL('image/png').slice(22);
  };
};

const b64 = file => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
const LAYOUTS = {wide: {W: 1920, H: 1080, box: [0, 0, 1920, 1080], file: 'proof-1080p.mp4'}, square: {W: 1080, H: 1080, box: [0, 135, 1080, 810], file: 'proof-square.mp4'}};
const hold = Math.round(HOLD * FPS), frames = hold * PAIRS.length, only = option('only', null)?.split(',').map(Number);
const browser = await chromium.launch({args: ['--mute-audio']});
for (const [layout, L] of Object.entries(LAYOUTS)) {
  const tab = await browser.newPage({viewport: {width: L.W, height: L.H}, deviceScaleFactor: 1});
  await tab.setContent('<!doctype html><meta charset="utf-8"><style>html, body { margin: 0; background: #0c1017; } canvas { display: block; }</style><canvas id="c"></canvas>');
  await tab.addScriptTag({content: `(${page.toString()})()`});
  const pairs = PAIRS.map(([map, view, , caption]) => ({caption, o: b64(path.join(work, 'img', `${map}__${view}-o-${layout}.png`)), b: b64(path.join(work, 'img', `${map}__${view}-b-${layout}.png`))}));
  const state = await tab.evaluate(cfg => window.setup(cfg), {layout, W: L.W, H: L.H, box: L.box, hold, pairs});
  if (!state.font) console.warn('Liberation Sans did not load: the labels fall back to a default font');
  const dir = path.join(work, layout);
  mkdirSync(dir, {recursive: true});
  const list = only ?? Array.from({length: frames}, (_, i) => i);
  for (const f of list) writeFileSync(path.join(dir, `f${String(f + 1).padStart(5, '0')}.png`), Buffer.from(await tab.evaluate(n => window.draw(n), f), 'base64'));
  await tab.close();
  console.log(`${layout}: ${list.length} of ${frames} frames ${L.W}x${L.H}`);
  if (only) continue;
  const enc = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%05d.png'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-movflags', '+faststart', '-an',
    path.join(out, L.file)], {stdio: 'inherit'});
  if (enc.status !== 0) throw new Error(`ffmpeg failed for ${layout}`);
  console.log(`-> ${path.relative(repo, path.join(out, L.file))}`);
}
await browser.close();
