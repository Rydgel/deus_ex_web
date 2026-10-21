/** UI Background = Snapshot in the page (docs/root-snapshot.md), headless Chromium on the default start: the original Game options screen sets
 * the choice (MenuScreenOptions > MenuChoice_UIBackground, OK), the game runs in 00_Training, and Escape opens the original main menu.
 * RootWindow.GenerateSnapshot (native 1524) answers the pause: the menu draws over a grey picture of the frame the player saw before
 * it, made by the page from its kept frame, and nothing stops the game. Checked on the left strip of the canvas, which no menu window
 * covers: its block averages after the pause follow the grey of the frame before it (correlation per channel), where the live 3D view
 * would not be a grey picture, and the strip is not flat. A second pause makes another snapshot.
 *
 *   node scripts/validate-root-snapshot-browser.mjs [--shots DIR]
 */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-root-snapshot-browser: no installed game data'); process.exit(0); }
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const shotsDir = option('shots', null);
const dir = fileURLToPath(new URL('..', import.meta.url));
const {default: base} = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({...base, configFile: false, root: dir, logLevel: 'error',
  server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({args: ['--use-angle=gl']});
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${url}/?antialias=0`);
  const ready = map => page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && !s.runtimeError; }, map, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const probe = step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
  const runtimeError = () => page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
  const shot = async name => { const png = await page.locator('#scene').screenshot(); if (shotsDir) await writeFile(`${shotsDir}/${name}.png`, png); return png; };
  /** Block averages (R, G, B) of the canvas's left strip, 2 columns by 20 rows, decoded in the page from a PNG. */
  const strip = png => page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const width = Math.floor(bitmap.width * 0.12), columns = 2, rows = 20, out = [];
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const x = Math.floor(column * width / columns), y = Math.floor(row * bitmap.height / rows), w = Math.floor(width / columns), h = Math.floor(bitmap.height / rows);
      const data = context.getImageData(x, y, w, h).data, sum = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) { sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; }
      out.push(sum.map(value => value / (data.length / 4)));
    }
    return {blocks: out, width: bitmap.width, height: bitmap.height};
  }, png.toString('base64'));
  const correlation = (a, b) => {
    const mean = list => list.reduce((x, y) => x + y, 0) / list.length, ma = mean(a), mb = mean(b);
    let cov = 0, va = 0, vb = 0;
    a.forEach((x, i) => { cov += (x - ma) * (b[i] - mb); va += (x - ma) ** 2; vb += (b[i] - mb) ** 2; });
    return va && vb ? cov / Math.sqrt(va * vb) : 0;
  };
  const state = () => probe({op: 'state'});

  await ready('DX');
  await frames(120);
  await page.keyboard.press('Escape'); await frames(30);
  assert.equal((await state()).top, 'deusex.menumain');
  await probe({op: 'button', index: 4});                       // Training
  await ready('00_Training');
  await frames(200);
  assert.equal(await runtimeError(), null, 'no runtime error on arrival');

  // The original Game options screen: UI Background cycles Render 3D -> Snapshot; OK saves it into the player.
  await probe({op: 'menu'}); await frames(15);
  await probe({op: 'invoke', screen: 'MenuSettings'}); await frames(15);
  await probe({op: 'invoke', screen: 'MenuScreenOptions'}); await frames(15);
  await probe({op: 'press', choice: 'MenuChoice_UIBackground'}); await frames(10);
  await probe({op: 'action', action: 1}); await frames(15);
  for (let guard = 0; (await state()).top && guard < 8; guard++) { await page.keyboard.press('Escape'); await frames(20); }
  assert.equal((await state()).top, null, 'back in the game');
  const requestsBefore = (await state()).display.snapshotRequests.length;
  await frames(90);                                            // frames to keep
  const before = await strip(await shot('snapshot-1-before'));

  await page.keyboard.press('Escape'); await frames(30);
  const paused = await state();
  assert.equal(paused.top, 'deusex.menumain', 'Escape opens the main menu');
  assert.equal(await runtimeError(), null, 'the pause stopped the game');
  assert.ok(paused.display.snapshotRequests.length > requestsBefore, 'the pause asked for a snapshot');
  const request = paused.display.snapshotRequests.at(-1);
  const after = await strip(await shot('snapshot-2-menu'));
  const luminance = list => list.map(([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b);
  const spread = list => Math.max(...list) - Math.min(...list);
  const grey = luminance(before.blocks);
  const channels = [0, 1, 2].map(c => after.blocks.map(block => block[c]));
  console.log(JSON.stringify({request, beforeSpread: Math.round(spread(grey)), afterSpread: channels.map(c => Math.round(spread(c))),
    correlation: channels.map(c => Number(correlation(grey, c).toFixed(3)))}));
  assert.ok(spread(grey) > 10, 'the frame before the pause has structure in the strip');
  for (const [c, values] of channels.entries()) {
    assert.ok(spread(values) > 4, `channel ${c} of the strip is not flat`);
    assert.ok(correlation(grey, values) > 0.9, `channel ${c} follows the grey of the frame before the pause (${correlation(grey, values).toFixed(3)})`);
  }

  // A second pause makes another snapshot.
  await page.keyboard.press('Escape'); await frames(30);
  await page.keyboard.press('Escape'); await frames(30);
  const again = await state();
  assert.equal(again.top, 'deusex.menumain');
  assert.ok(again.display.snapshotRequests.at(-1).serial > request.serial, 'a second snapshot');
  assert.equal(await runtimeError(), null);
  assert.deepEqual(errors, [], 'page errors');
  console.log('PASS validate-root-snapshot-browser: UI Background = Snapshot, Escape in 00_Training draws the menu over the grey frame');
} finally { await browser.close(); await server.close(); }
process.exit(0);
