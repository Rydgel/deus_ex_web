// How many pixels the 3D view's projection from the pass frame changes
// (play-camera.mjs setFrameProjection against the FOV and the constant
// half-pixel centre it replaced), in Play's default worker mode: at seeded
// views of the Island, the Paris club and Training, the page draws the same
// frozen frame (the window blurred: no simulation step, Level time still)
// three times, with the frame projection, with the FOV's, and with the frame
// projection again. The last against the first is the noise floor (anything
// that is not the projection); the middle against the first is the change.
// Pixels are compared in a second page from the PNG screenshots of the
// viewport, any channel of RGBA.
//
//   node scripts/census-frame-projection.mjs [views per map] [--fov 90] [--dpr 2] [--maps A,B]
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const views = Number(process.argv.slice(2).find(arg => /^\d+$/.test(arg)) ?? 6), fov = Number(option('fov', 75)), dpr = Number(option('dpr', 1));
const maps = option('maps', '01_NYC_UNATCOIsland,10_Paris_Club,00_Training').split(',');
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System'])
  for (const name of await readdir(path.join(root, directory))) files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files);
const dir = fileURLToPath(new URL('..', import.meta.url));
const {default: base} = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({...base, configFile: false, root: dir, logLevel: 'error',
  server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
try {
  const compare = await browser.newPage();
  const different = (a, b) => compare.evaluate(async ([x, y]) => {
    const load = async base64 => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [p, q] = [await load(x), await load(y)];
    let count = 0, max = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      const d = Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]), Math.abs(p.data[i + 3] - q.data[i + 3]));
      if (d) { count++; max = Math.max(max, d); }
    }
    return {count, max, pixels: p.width * p.height, same: p.width === q.width && p.height === q.height};
  }, [a.toString('base64'), b.toString('base64')]);
  for (const map of maps) {
    const asset = await assets.get(map), model = decodeMap(asset.bytes);
    let state = 0x9e3779b9 ^ map.length;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const spots = model.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint/.test(a.className)).map(a => a.values.Location);
    const page = await browser.newPage({viewport: {width: 1024, height: 640}, deviceScaleFactor: dpr});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
    const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
    const shot = () => page.locator('#scene').screenshot();
    await frames(30);
    if (fov !== 75) await page.evaluate(fov => window.deusExViewer.placeProbe({set: {actor: '$player', fields: {FOVAngle: fov, DesiredFOV: fov}}}), fov);
    await frames(10);
    const played = await page.evaluate(() => window.deusExViewer.visibility()?.master?.fov);
    if (played !== fov) console.log(`${map}: the frame's FOV is ${played}, not the requested ${fov}`);
    let changed = 0, noisy = 0, total = 0, unsettled = 0, differing = 0, pixels = 0, maxChange = 0, size = null;
    const per = [];
    for (let v = 0; v < views; v++) {
      const at = spots[Math.floor(random() * spots.length)];
      await page.evaluate(args => window.deusExViewer.placeProbe(args), {location: at.map((c, k) => c + (k === 2 ? 10 : 0)),
        rotation: [Math.floor(random() * 3000) - 1500 & 0xffff, Math.floor(random() * 65536), 0]});
      await frames(40);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));   // freeze: no simulation step
      await frames(6);
      await page.evaluate(() => window.deusExViewer.frameProjection(true)); await frames(3);
      // Wait for the frozen frame to settle (textures, light maps and meshes still arriving).
      let a = await shot(), settled = false;
      for (let attempt = 0; attempt < 10 && !settled; attempt++) {
        await frames(8);
        const again = await shot();
        settled = (await different(a, again)).count === 0;
        a = again;
      }
      if (!settled) { unsettled++; per.push('unsettled'); continue; }
      await page.evaluate(() => window.deusExViewer.frameProjection(false)); await frames(3);
      const b = await shot();
      await page.evaluate(() => window.deusExViewer.frameProjection(true)); await frames(3);
      const c = await shot();
      const [noise, change] = [await different(a, c), await different(a, b)];
      per.push(`${change.count}/${noise.count}`);
      total++; pixels += change.pixels; size = size ?? change.pixels;
      noisy += noise.count; changed += change.count; maxChange = Math.max(maxChange, change.max);
      if (change.count) differing++;
      await page.keyboard.press('Escape').catch(() => {});
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    }
    console.log(`${map} (FOV ${played}, ${dpr} px per CSS px, ${size} pixels a view): ${total} settled views` +
      `${unsettled ? ` (${unsettled} more never settled: animated textures keep changing a frozen frame)` : ''}: the FOV's projection differs from the ` +
      `frame projection's in ${changed} pixels (${(100 * changed / Math.max(1, pixels)).toFixed(5)}%) in ${differing} views, largest channel difference ${maxChange}; ` +
      `per view ${per.join(' ')}; the same frame projection drawn twice differs in ${noisy}${errors.length ? `; page errors ${errors}` : ''}`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
