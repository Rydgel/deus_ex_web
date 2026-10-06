// Original-game visual acceptance (docs/visual-acceptance.md): matched-camera
// frames of the original DeusEx.exe (under Wine or CrossOver) and of Play.
// Both sides take the same console inputs: bCheatsEnabled, `ghost`,
// `ShowHud False`, then per view Location, a zero Velocity and ViewRotation
// (the original types them into its console; Play's view-probe.mjs writes the
// same fields and runs ghost/ShowHud through the original console chain on
// the simulation side, worker mode by default).
//
//   node scripts/visual-acceptance.mjs play [--maps a,b] [--size 1280x720] [--query sim=inline]
//       loads each map in Play, writes the plan (views from the player's start
//       Location) and Play's frames
//   node scripts/visual-acceptance.mjs original [--maps a,b]
//       with DeusEx.exe already running in a 1280x720 window (ad/scripts/original-game.mjs
//       launch; DX_WINE/DX_GAME/WINEPREFIX for plain Wine), takes the original's frames
//   node scripts/visual-acceptance.mjs compare [--maps a,b]
//       per-view metrics and side-by-side/difference images
//
// Frames are raw: the original's Shot bitmaps are its framebuffer before the
// gamma ramp, and Play is captured at Brightness 0.4, whose display ramp
// (pow(x, 1/(2.5*0.4))) is the identity. Output in .work/acceptance/ (local
// captures stay outside Git).
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, '.work/acceptance');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const verb = process.argv[2];
const DEFAULT_MAPS = ['00_Training', '01_NYC_UNATCOIsland', '02_NYC_BatteryPark', '03_NYC_AirfieldHeliBase',
  '04_NYC_Street', '05_NYC_UNATCOMJ12lab', '06_HongKong_WanChai_Market', '08_NYC_Bar', '09_NYC_Ship',
  '10_Paris_Club', '11_Paris_Cathedral', '12_Vandenberg_Cmd', '14_OceanLab_Lab', '15_Area51_Bunker'];
const maps = (option('maps', null)?.split(',') ?? DEFAULT_MAPS);
const [WIDTH, HEIGHT] = option('size', '1280x720').split('x').map(Number);
const planPath = path.join(out, 'plan.json');
const loadPlan = () => existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : {};
mkdirSync(out, {recursive: true});

// Views from a start Location: the four axis yaws level, and one looking
// down the start yaw. Integers, so both consoles get the same floats.
function viewsFrom(location, yaw) {
  const at = location.map(Math.round), snap = ((Math.round(yaw / 16384) * 16384) % 65536 + 65536) % 65536;
  return [0, 1, 2, 3].map(k => ({name: `y${k}`, location: at, rotation: [0, (snap + 16384 * k) % 65536, 0]}))
    .concat([{name: 'down', location: at, rotation: [65536 - 3000, snap, 0]}]);
}

async function play() {
  const {chromium} = await import('@playwright/test');
  const {createServer} = await import('vite');
  let server = null, url = option('url', null);
  if (!url) {
    const {default: base} = await import('../vite.config.mjs');
    const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/')));
    server = await createServer({...base, configFile: false, root, logLevel: 'error',
      server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
    await server.listen();
    url = server.resolvedUrls.local[0].replace(/\/$/, '');
  }
  const plan = loadPlan();
  const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
  try {
    for (const map of maps) {
      const page = await browser.newPage({viewport: {width: WIDTH, height: HEIGHT}, deviceScaleFactor: 1});
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      const query = option('query', '');
      await page.goto(`${url}/${query ? `?${query}` : ''}`);
      await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
      if (await page.evaluate(() => window.deusExViewer.status().map) !== map) {
        await page.locator('#map').selectOption(map);
        await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
      }
      await page.addStyleTag({content: `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; }`});
      await page.evaluate(() => { const el = document.getElementById('brightness'); el.value = '0.4'; el.dispatchEvent(new Event('input')); });
      const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
      await frames(30);
      const start = await page.evaluate(() => window.deusExViewer.viewProbe({}));
      const entry = plan[map] ?? (plan[map] = {start: start.location, startRotation: start.viewRotation,
        views: viewsFrom(start.location, start.viewRotation[1])});
      const ghost = await page.evaluate(() => window.deusExViewer.viewProbe({ghost: true}));
      const dir = path.join(out, map); mkdirSync(dir, {recursive: true});
      const box = await page.locator('#scene').boundingBox();
      const shots = [];
      for (const view of entry.views) {
        await page.evaluate(v => window.deusExViewer.viewProbe({location: v.location, rotation: v.rotation}), view);
        await frames(45);
        const state = await page.evaluate(() => {
          const s = window.deusExViewer.status();
          return {position: s.position, rotation: s.rotation, runtimeError: s.runtimeError?.message ?? null};
        });
        const probe = await page.evaluate(() => window.deusExViewer.viewProbe({}));
        await page.screenshot({path: path.join(dir, `${view.name}-play.png`),
          clip: {x: box.x, y: box.y, width: Math.round(box.width), height: Math.round(box.height)}});
        shots.push({view: view.name, camera: state, player: {location: probe.location, state: probe.state, physics: probe.physics}});
      }
      writeFileSync(path.join(dir, 'play.json'), JSON.stringify({map, size: [box.width, box.height], ghost, shots, errors}, null, 1));
      console.log(map, `${shots.length} views`, ghost.state, errors.length ? `errors: ${errors.slice(0, 2).join(' | ')}` : '');
      await page.close();
      writeFileSync(planPath, JSON.stringify(plan, null, 1));
    }
  } finally { await browser.close(); await server?.close(); }
}

async function original() {
  const game = await import('../ad/scripts/original-game.mjs');
  const plan = loadPlan(), scratch = path.join(out, 'steps');
  mkdirSync(scratch, {recursive: true});
  let step = 0;
  const post = (lines, timeout) => {
    const file = path.join(scratch, `step-${String(step++).padStart(3, '0')}.txt`);
    writeFileSync(file, lines.join('\n') + '\n');
    game.run(file, timeout);
  };
  const loadWait = Number(option('load-wait', 25000));
  for (const map of maps) {
    const entry = plan[map];
    if (!entry) { console.log(map, 'not in the plan (run `play` first)'); continue; }
    const dir = path.join(out, map); mkdirSync(dir, {recursive: true});
    post([`cmd open ${map}`, `sleep ${loadWait}`], loadWait + 60000);
    post(['cmd set DeusEx.JCDentonMale bCheatsEnabled True', 'sleep 200', 'cmd ghost', 'sleep 200', 'cmd ShowHud False', 'sleep 300']);
    for (const view of entry.views) {
      const [x, y, z] = view.location, [pitch, yaw, roll] = view.rotation;
      let taken = [];
      for (let attempt = 0; attempt < 2 && !taken.length; attempt++) {
        const before = game.shots();
        post([`cmd set DeusEx.JCDentonMale Location (X=${x},Y=${y},Z=${z})`, 'cmd set DeusEx.JCDentonMale Velocity (X=0,Y=0,Z=0)',
          `cmd set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=${roll})`, 'sleep 1500', 'shot', 'sleep 900']);
        const fresh = game.shots().filter(shot => !before.includes(shot));
        taken = fresh.map(shot => {
          const png = path.join(dir, `${view.name}-original.png`), size = game.bmpToPng(path.join(game.SYSTEM, shot), png);
          renameSync(path.join(game.SYSTEM, shot), path.join(dir, `${view.name}-original.bmp`));
          return size;
        });
      }
      console.log(map, view.name, taken.length ? `${taken[0].width}x${taken[0].height}` : 'NO SHOT');
    }
  }
}

// Raw RGB through ImageMagick (no image library in the tree).
function readRgb(file) {
  const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', file], {encoding: 'utf8'}).split(' ').map(Number);
  return {w, h, data: execFileSync('magick', [file, '-depth', '8', 'rgb:-'], {maxBuffer: 1 << 28})};
}
function writeRgb(file, w, h, data) {
  execFileSync('magick', ['-size', `${w}x${h}`, '-depth', '8', 'rgb:-', file], {input: data});
}
const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
function edges(img) {
  const {w, h, data} = img, L = new Float32Array(w * h), E = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = luma(data, 3 * i);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = (dx, dy) => L[(y + dy) * w + x + dx];
    const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
    const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
    E[y * w + x] = Math.hypot(gx, gy) > 48 ? 1 : 0;
  }
  return E;
}
// Share of `a`'s edge pixels with an edge of `b` within `r` pixels.
function edgeRecall(a, b, w, h, r = 2) {
  let n = 0, hit = 0;
  for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
    if (!a[y * w + x]) continue;
    n++;
    search: for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (b[(y + dy) * w + x + dx]) { hit++; break search; }
  }
  return n ? hit / n : 1;
}
function compareOne(a, b, prefix) {
  const A = readRgb(a), B = readRgb(b);
  if (A.w !== B.w || A.h !== B.h) return {error: `size ${A.w}x${A.h} vs ${B.w}x${B.h}`};
  const {w, h} = A, n = w * h, mean = [[0, 0, 0], [0, 0, 0]];
  let mad = 0;
  const diff = Buffer.alloc(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    const x = A.data[3 * i + c], y = B.data[3 * i + c];
    mean[0][c] += x; mean[1][c] += y; mad += Math.abs(x - y);
  }
  // Difference image: red where Play is brighter, blue where darker (luma), x4.
  for (let i = 0; i < n; i++) {
    const d = luma(B.data, 3 * i) - luma(A.data, 3 * i);
    diff[3 * i] = Math.min(255, Math.max(0, 4 * d)); diff[3 * i + 2] = Math.min(255, Math.max(0, -4 * d));
    diff[3 * i + 1] = Math.min(255, luma(A.data, 3 * i) / 3);
  }
  const EA = edges(A), EB = edges(B);
  // 16x9 blocks: Play/original mean-luma ratio, to localize missing or extra content.
  const GX = 16, GY = 9, blocks = [];
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    let la = 0, lb = 0, k = 0;
    for (let y = Math.floor(gy * h / GY); y < Math.floor((gy + 1) * h / GY); y++)
      for (let x = Math.floor(gx * w / GX); x < Math.floor((gx + 1) * w / GX); x++) { la += luma(A.data, 3 * (y * w + x)); lb += luma(B.data, 3 * (y * w + x)); k++; }
    blocks.push(+((lb / k + 1) / (la / k + 1)).toFixed(3));
  }
  writeRgb(`${prefix}-diff.png`, w, h, diff);
  execFileSync('magick', [a, b, `${prefix}-diff.png`, '+append', '-resize', '50%', `${prefix}-side.png`]);
  const m = mean.map(v => v.map(x => x / n));
  const sorted = [...blocks].sort((x, y) => x - y);
  return {
    meanOriginal: m[0].map(x => +x.toFixed(2)), meanPlay: m[1].map(x => +x.toFixed(2)),
    ratio: +((m[1][0] + m[1][1] + m[1][2] + 3) / (m[0][0] + m[0][1] + m[0][2] + 3)).toFixed(3),
    mad: +(mad / (3 * n)).toFixed(2),
    edgeRecall: +edgeRecall(EA, EB, w, h).toFixed(3), edgePrecision: +edgeRecall(EB, EA, w, h).toFixed(3),
    blockRatio: {min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1]},
    outlierBlocks: blocks.map((r, i) => [i % GX, Math.floor(i / GX), r]).filter(([, , r]) => Math.abs(Math.log(r / sorted[sorted.length >> 1])) > Math.log(1.6)),
  };
}

function compare() {
  const report = {}, plan = loadPlan();
  for (const map of maps) {
    const dir = path.join(out, map);
    for (const view of plan[map]?.views ?? []) {
      const a = path.join(dir, `${view.name}-original.png`), b = path.join(dir, `${view.name}-play.png`);
      if (!existsSync(a) || !existsSync(b)) continue;
      const result = compareOne(a, b, path.join(dir, view.name));
      (report[map] ??= {})[view.name] = result;
      const {outlierBlocks, ...brief} = result;
      console.log(map, view.name, JSON.stringify(brief), `${outlierBlocks?.length ?? 0} outlier blocks`);
    }
  }
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
}

if (verb === 'play') await play();
else if (verb === 'original') await original();
else if (verb === 'compare') compare();
else console.log('usage: visual-acceptance.mjs play|original|compare [--maps a,b]');
