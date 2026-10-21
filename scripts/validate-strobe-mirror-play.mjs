// The Underworld club's dance floor in the mirror panes: lit in one original frame, dark in the next (docs/visual-acceptance.md "Strobe,
// a host input", "The reflected floor in view d").
//
// Render.dll's Strobe function (0x10b05b30) flips one global flag (0x10b49ea8) whenever Level.TimeSeconds differs from the time it last saw
// (0x10b49ea4), and zeroes the light's brightness while the flag is set. The map's TriggerLight1 (a Strobe light at full brightness
// until its first Tick) lights the dance floor, so a frozen-level capture shows the floor and the dancers lit or dark by the parity of
// the frames the game drew, in both programs, at a mirror's reflection exactly as in a direct view. A first comparison at one view
// read the original's lit frame against Play's dark one as a mirror lighting defect; with the flag held equal on both sides (the original
// through `dx-live-win.exe strobe hold`, Play through the held clock and liveProbe `strobe`) the mirror area and the direct view
// from the reflected camera match in both states.
//
// What this checks in Play (worker mode, ghost, level frozen as in the live acceptance):
// 1. The free-running cadence equals the original's polls (dx-live-win.exe strobe poll, 120 samples 5 ms apart at each camera): at the
//    four views the flag flips at every new TimeSeconds (a: 12 of 12 time steps flipped, b 13 of 13, c 10 of 10, d 31 of 31) and at
//    the three wall views p1, p2, p3 (a mirror request with no child frame, no strobe-lit surface drawn) the original's time stayed
//    put: no flip.
// 2. With the clock held (TimeDilation 0) a written flag stays, and the lit/dark ratio of the frame over the mirror area (view d) and over
//    the opening of the direct view from the reflected camera (view r) is the original's, measured the same way (held flag, raw frames
//    at Brightness 0.4, region means of d_s0/d_s1 and r_s0/r_s1 below), within 10%.
// 3. `viewProbe({playersOnly: false})` clears LevelInfo.bPlayersOnly (it was ignored): the unfrozen level ticks TriggerLight1, whose
//    LightBrightness goes to 0 (the original's live read: 3.8e-29) and the flag stops flipping (40 polls of the original: one value).
//
//   node scripts/validate-strobe-mirror-play.mjs [--url http://...] [--shots DIR]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-strobe-mirror-play: no installed game data'); process.exit(0); }
let server = null, url = option('url', null);
const shots = option('shots', null);
if (shots) mkdirSync(shots, {recursive: true});
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
const map = '06_HongKong_WanChai_Underworld';
// Eyes (Location, ghost: the eye is Location + 40). a to d: the acceptance views; p1 to p3: wall views.
const VIEWS = {a: [[-1024, -1650, -336], 49152], b: [[-1300, -1650, -336], 52000], c: [[-760, -1400, -336], 46000], d: [[-1120, -1900, -336], 55000],
  p1: [[-1300, -2000, -336], 43000], p2: [[-700, -2000, -336], 49152], p3: [[-700, -2000, -336], 55000],
  r: [[-1120, -2208, -336], 10536]};
// The original's free-running polls: whether the flag flipped at every new TimeSeconds.
const CADENCE = {a: true, b: true, c: true, d: true, p1: false, p2: false, p3: false};
// Original region means (R, G, B of the raw 1280x720 frame) with the flag held at 0 (lit) and 1 (dark), TimeSeconds 52.3 (d) and 53.1 (r).
const REGIONS = {
  d: {box: [340, 170, 490, 520], lit: [26.68, 21.22, 13.52], dark: [14.90, 7.93, 6.87]},
  r: {box: [430, 200, 360, 500], lit: [36.05, 30.42, 24.57], dark: [25.16, 18.03, 18.13]},
};
const TOLERANCE = 0.10;
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // The page's frame loop keeps each frame's light state (time, flag) in window.__lights, so a sample sees every frame.
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    let body = await response.text();
    const hook = 'if (frame.light) world.beginLightFrame(frame.light);';
    if (!body.includes(hook)) throw new Error(`the frame-log patch no longer matches main.mjs: ${hook}`);
    body = body.replace(hook, `${hook} if (frame.light) (window.__lights ??= []).push([frame.light.timeSeconds, frame.light.strobe?.flag ?? null]);`);
    await route.fulfill({response, body});
  });
  await page.goto(debugUrl(`${url}/?hold=1&seed=1`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
  await page.addStyleTag({content: `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; } #viewport { position: fixed !important; inset: 0 !important; width: 1280px; height: 720px; }
#scene { position: fixed !important; left: 0 !important; top: 0 !important; margin: 0 !important; border: 0 !important; transform: none !important; width: 1280px !important; height: 720px !important; }`});
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  // Brightness 0.4: the display ramp is the identity, so the frame is the raw framebuffer (the acceptance's capture).
  await page.evaluate(() => { const el = document.getElementById('brightness'); el.value = '0.4'; el.dispatchEvent(new Event('input')); });
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const probe = args => page.evaluate(a => window.deusExViewer.viewProbe(a), args);
  const live = args => page.evaluate(a => window.deusExViewer.liveProbe(a), args);
  const strobe = async () => (await live({strobe: {}})).strobe;
  const look = async name => { const [at, yaw] = VIEWS[name]; await probe({location: at, rotation: [0, yaw, 0]}); await frames(8); };
  await probe({playersOnly: true, timeDilation: 1});
  await page.evaluate(() => window.deusExViewer.release());
  await frames(10);
  await probe({ghost: true});
  await frames(20);

  // 1. The free-running cadence.
  const cadence = {};
  for (const name of Object.keys(CADENCE)) {
    await look(name);
    await page.evaluate(() => { window.__lights = []; });
    await frames(24);
    const log = await page.evaluate(() => window.__lights);
    let steps = 0, flips = 0;
    for (let i = 1; i < log.length; i++) {
      if (log[i][0] === log[i - 1][0]) continue;
      steps++;
      if (log[i][1] !== log[i - 1][1]) flips++;
    }
    cadence[name] = {steps, flips};
    assert.ok(steps >= 15, `${name}: the level advanced in ${steps} frames`);
    if (CADENCE[name]) assert.equal(flips, steps, `${name}: the flag flips at every new TimeSeconds (the original's polls), ${flips} of ${steps}`);
    else assert.equal(flips, 0, `${name}: no strobe-lit surface is drawn, no flip (the original's time stayed put), ${flips} of ${steps}`);
  }

  // 2. Held clock, held flag: the lit/dark ratio over the mirror area and over the direct view from the reflected camera.
  await probe({timeDilation: 0});
  await frames(5);
  const mean = async (png, [x, y, w, h]) => page.evaluate(async ([data, x, y, w, h]) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height), g = canvas.getContext('2d');
    g.drawImage(image, 0, 0);
    const p = g.getImageData(x, y, w, h).data, sum = [0, 0, 0];
    for (let i = 0; i < p.length; i += 4) { sum[0] += p[i]; sum[1] += p[i + 1]; sum[2] += p[i + 2]; }
    return sum.map(v => v / (p.length / 4));
  }, [png.toString('base64'), x, y, w, h]);
  const held = {};
  for (const name of ['d', 'r']) {
    await look(name);
    for (const flag of [0, 1]) {
      const seen = await strobe();
      await live({strobe: {flag, time: seen.time}});
      await frames(4);
      const after = await strobe();
      assert.deepEqual(after, {flag, time: Math.fround(seen.time)}, `${name}: the held clock keeps the written flag ${flag} (no new TimeSeconds, no flip)`);
      const png = await page.screenshot({clip: {x: 0, y: 0, width: 1280, height: 720}});
      if (shots) await page.screenshot({path: `${shots}/strobe-${name}-flag${flag}.png`, clip: {x: 0, y: 0, width: 1280, height: 720}});
      (held[name] ??= {})[flag] = await mean(png, REGIONS[name].box);
    }
    const ratio = held[name][0].map((lit, i) => lit / held[name][1][i]), original = REGIONS[name].lit.map((lit, i) => lit / REGIONS[name].dark[i]);
    held[name].ratio = ratio.map(v => Number(v.toFixed(3)));
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(ratio[c] / original[c] - 1) <= TOLERANCE,
        `${name}: lit/dark ratio of channel ${'RGB'[c]} is ${ratio[c].toFixed(3)}, the original's ${original[c].toFixed(3)} (within ${TOLERANCE * 100}%)`);
  }

  // 3. The unfrozen level: TriggerLight1 ticks to 0 and the flag stops flipping.
  const lights = async () => (await live({lights: {type: 5}})).lights.find(l => l.name === 'TriggerLight1');
  assert.equal((await lights()).LightBrightness, 200, 'frozen: TriggerLight1 still at the map brightness');
  await look('d');
  await probe({timeDilation: 0.001, playersOnly: false});
  assert.equal((await probe({})).playersOnly, false, 'viewProbe({playersOnly: false}) clears bPlayersOnly');
  await frames(30);
  assert.equal((await lights()).LightBrightness, 0, 'unfrozen: TriggerLight1.Tick set LightBrightness to 0');
  const before = await strobe();
  await frames(20);
  assert.deepEqual(await strobe(), before, 'unfrozen: no strobe light is live, the flag and its time stop');
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`validate-strobe-mirror-play: cadence ${JSON.stringify(cadence)}; held lit/dark ratios (RGB) d ${held.d.ratio.join('/')} r ${held.r.ratio.join('/')} against the original's `
    + `${REGIONS.d.lit.map((v, i) => (v / REGIONS.d.dark[i]).toFixed(3)).join('/')} and ${REGIONS.r.lit.map((v, i) => (v / REGIONS.r.dark[i]).toFixed(3)).join('/')}; unfrozen TriggerLight1 at 0, flag still`);
} finally { await browser.close(); await server?.close(); }
