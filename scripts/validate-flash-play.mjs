// The viewport flash in the browser (docs/screen-flash.md "Play").
//
// Default worker mode. On 00_Training the player's ConstantGlowScale/ConstantGlowFog (the fields ViewFlash integrates
// into FlashScale/FlashFog every tick, as an augmentation's glow does) are set through the placeProbe seam, the one
// place a script property is written here: the flash itself runs the original ViewFlash bytecode, UGameEngine::Draw's
// derivation (screen-flash.mjs viewportFlash in the snapshot) and the page's EndFlash pass (flash-pass.mjs).
//   1. glow scale 0, fog 0 (FlashScale 1: the neutral plane 0.5) draws nothing: the frame equals the baseline.
//   2. glow scale -0.25, fog (0.3, 0, 0): the plane is scale 0.375, fog 0.3; EndFlash's quad is fog RGB bytes (76, 0, 0)
//      with alpha 0.75: red up, green and blue down against the baseline.
//   3. back to neutral: the baseline again.
//   node scripts/validate-flash-play.mjs [--url http://...] [--query sim=inline] [--shot flash.png]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-flash-play: no installed game data'); process.exit(0); }
let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    const text = (await response.text()).replace('antialias: true })', 'antialias: true, preserveDrawingBuffer: true })');
    await route.fulfill({response, body: text + '\nwindow.__deusFlash={get renderer(){return renderer;}};\n'});
  });
  await page.goto(`${url}/${option('query', '') ? `?${option('query', '')}` : ''}`);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training'; }, {}, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const means = () => page.evaluate(() => {
    const canvas = window.__deusFlash.renderer.domElement, copy = document.createElement('canvas');
    copy.width = canvas.width; copy.height = canvas.height;
    const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0);
    const {data} = context.getImageData(0, 0, copy.width, copy.height);
    const sum = [0, 0, 0]; let n = 0;
    for (let i = 0; i < data.length; i += 4) { sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; n++; }
    return sum.map(v => v / n);
  });
  const glow = (scale, fog) => page.evaluate(([scale, fog]) => window.deusExViewer.placeProbe({set: {actor: '$player',
    fields: {ConstantGlowScale: scale, ConstantGlowFog: fog}}}), [scale, fog]);
  await frames(90);
  await glow(0, [0, 0, 0]); await frames(90);
  const baseline = await means();
  await glow(-0.25, [0.3, 0, 0]); await frames(150);
  const tinted = await means();
  if (option('shot', null)) await page.screenshot({path: option('shot', null)});
  await glow(0, [0, 0, 0]); await frames(150);
  const after = await means();
  const status = await page.evaluate(() => window.deusExViewer.status());
  assert.equal(status.runtimeError, null, 'Play did not pause');
  assert.deepEqual(errors, [], 'no page errors');
  const near = (a, b, tolerance) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
  assert.ok(near(after, baseline, 1.5), `the neutral flash draws nothing: ${baseline.map(v => v.toFixed(2))} then ${after.map(v => v.toFixed(2))}`);
  assert.ok(tinted[0] > baseline[0] + 10, `red rises under the fog: ${baseline[0].toFixed(1)} -> ${tinted[0].toFixed(1)}`);
  assert.ok(tinted[1] < baseline[1] * 0.9 && tinted[2] < baseline[2] * 0.9, `green and blue fall by the scale: ${baseline.map(v => v.toFixed(1))} -> ${tinted.map(v => v.toFixed(1))}`);
  console.log(`PASS validate-flash-play: baseline ${baseline.map(v => v.toFixed(1))}, tinted ${tinted.map(v => v.toFixed(1))}, neutral again ${after.map(v => v.toFixed(1))}`);
} finally {
  await browser.close();
  await server?.close();
}
