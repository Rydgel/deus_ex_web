// The page draws the mirror passes the simulation side planned for the
// snapshot it draws (docs/sim-worker.md "The drawn set and LastRenderTime"),
// in Play's default worker mode. The page posts frame N+1 before it draws
// snapshot N, and a resize lands after the rAF callbacks, so the display
// frame after a resize draws a snapshot planned for the old canvas: before
// 2026-10-15 the page re-planned it at its new size (and, after a Play to
// Inspect switch, as Inspect with its free camera) and drew mirror passes the
// simulation side had not planned ("The page drew a mirror pass the
// simulation side did not plan", seen in validator sweeps under CPU load).
// Facing the 02_NYC_Bar mirror, the window is resized across a collapsed
// canvas (an empty render viewport: no DrawWorld) and back, in Play and in
// Inspect, and Play is switched to Inspect there. Every mirror pass the page
// draws is checked against the simulation side's pass ids (main.mjs
// updateActors): no page error, and the mirror draws at the full sizes.
// Before the fix (7bca031) it fails with 8 page errors: two at each restore
// from the collapsed canvas in Play, two at each switch from a Play view
// turned away from the mirror. No CPU load is needed.
//
//   node scripts/validate-mirror-plan-play.mjs [--url http://...]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-mirror-plan-play: no installed game data'); process.exit(0); }
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
const map = '02_NYC_Bar', mirror = {location: [-768, -600, 95], rotation: [0, 49152, 0]};
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const rows = [];
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}, deviceScaleFactor: 1});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(debugUrl(url));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 240000});
  // Frames the page drew (a display frame without a new snapshot draws nothing).
  const drawn = n => page.evaluate(async n => {
    const draws = () => window.deusExViewer.framePhases(false).draws, until = draws() + n;
    while (draws() < until) await new Promise(r => requestAnimationFrame(r));
  }, n);
  const planes = () => page.evaluate(() => window.deusExViewer.status().mirrors?.renderedPlanes ?? 0);
  const place = async () => { await page.evaluate(v => window.deusExViewer.placeProbe(v), mirror); await drawn(30); };
  // The bars' height: a window this tall leaves the canvas no pixel row, so
  // the root window's render viewport is empty (the sweep's failing frame was
  // posted at a 1×0 canvas and drawn at 1024×531).
  const bars = await page.evaluate(() => innerHeight - document.querySelector('#viewport').getBoundingClientRect().height);
  const sizes = [[1024, Math.ceil(bars)], [1024, 640], [1280, 800], [900, 560], [1024, 640]];
  const resizes = async label => {
    for (const [width, height] of sizes) {
      await page.setViewportSize({width, height});
      await drawn(10);
      rows.push({label, width, height, planes: await planes(), errors: errors.length});
    }
  };
  // Only the player ticks (`set LevelInfo bPlayersOnly True`): no NPC starts a
  // conversation whose camera would turn the view away from the mirror.
  await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true}));
  await drawn(30);
  await place();
  for (let round = 0; round < 2; round++) await resizes('play');
  // Inspect in front of the same mirror (the reference camera form).
  await page.evaluate(({location, rotation}) => {
    document.querySelector('#camera-position').value = location.join(', '); document.querySelector('#camera-rotation').value = rotation.join(', ');
    document.querySelector('#camera-form').requestSubmit();
  }, mirror);
  await drawn(20);
  for (let round = 0; round < 2; round++) await resizes('inspect');
  // Play to Inspect in one task, the free camera on the mirror: the next draws
  // take Play snapshots, the view on the mirror or turned away from it.
  for (const yaw of [49152, 16384, 49152, 16384]) {
    await page.locator('#mode').selectOption('play');
    await drawn(5);
    await page.evaluate(v => window.deusExViewer.placeProbe(v), {...mirror, rotation: [0, yaw, 0]});
    await drawn(30);
    const play = await planes();
    await page.evaluate(() => document.querySelector('#camera-form').requestSubmit());
    await drawn(10);
    rows.push({label: 'play->inspect', yaw, play, planes: await planes(), errors: errors.length});
  }
  rows.errors = [...new Set(errors)];
} finally { await browser.close(); await server?.close(); }
for (const row of rows) console.log(JSON.stringify(row));
assert.deepEqual(rows.errors, [], 'no page errors');
for (const row of rows.filter(r => r.label !== 'play->inspect' && r.height >= 560))
  assert.ok(row.planes >= 1, `${row.label} ${row.width}x${row.height}: the mirror draws its reflected child`);
for (const row of rows.filter(r => r.label === 'play->inspect'))
  assert.ok((row.play >= 1) === (row.yaw === mirror.rotation[1]) && row.planes >= 1,
    `Play to Inspect: the mirror draws in Play facing it, not turned away, and in Inspect (${JSON.stringify(row)})`);
console.log(`validate-mirror-plan-play: PASS (${rows.length} resizes and switches, no pass the simulation side did not plan)`);
