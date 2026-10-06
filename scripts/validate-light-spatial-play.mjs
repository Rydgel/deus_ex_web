// Time-varying spatial lights in Play (docs/static-lighting.md "Spatially
// dynamic effects"): on 10_Paris_Club the dance floor's LE_Disco light
// (Light3) is a class 1 light whose light maps spatial.rs recomputes for
// every Level.TimeSeconds inside the light.rs merge. Headless Chromium runs
// Play in the default mode (the simulation in the worker; decal-probe.mjs
// placeProbe moves the player, the light maps are the page's world;
// `--query sim=inline` runs the simulation on the page), puts the player
// beside the light and checks that its
// light maps are admitted, merged when drawn, change from frame to frame and
// reach the light atlas, with no "not translated" note; it reports the
// light-animation phase's cost per frame.
//
//   node scripts/validate-light-spatial-play.mjs [--url http://...] [--query sim=inline] [--frames 240] [--shots DIR]
//        [--map NAME --light x,y,z]
//
// --map/--light measure another map from stands around another light (for
// instance 06_HongKong_Helibase's Searchlight TriggerLight2 at
// -256,-400,684); the checks stay the same.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-light-spatial-play: no installed game data'); process.exit(0); }
const map = option('map', '10_Paris_Club'), frames = Number(option('frames', 240)), shots = option('shots', null);
// Light3 (LE_Disco, LightRadius 34) and places beside it to look from.
const light = option('light', '-175.8588409423828,-321.5807189941406,169.49195861816406').split(',').map(Number);
// [dx, dy, dz, yaw] from the light; `start` stays at the player start,
// turning to the yaws listed.
const stands = [[0, 300, -60, 49152], [300, 0, -60, 32768], [0, -300, -60, 16384], [-300, 0, -60, 0], [0, 0, -100, 0],
  ...[0, 16384, 32768, 49152].map(yaw => ['start', 0, 0, yaw])];
let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { default: base } = await import('../vite.config.mjs');
  // A checkout inside .work/ or .claude/worktrees/ serves itself.
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({ ...base, configFile: false, root, logLevel: 'error',
    server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
let report;
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) +
      '\nwindow.__deusSpatial={get world(){return world;}};\n' });
  });
  const query = option('query', '');
  await page.goto(`${url}/${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 240000 });
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, { timeout: 240000 });
  const frame = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  // The first stand whose view merges the Disco light maps.
  let stand = null;
  const start = (await page.evaluate(() => window.deusExViewer.placeProbe({}))).location;
  for (const [dx, dy, dz, yaw] of stands) {
    await page.evaluate(({ at, yaw }) => window.deusExViewer.placeProbe({ location: at, rotation: [62000, yaw, 0] }),
      { at: dx === 'start' ? start : [light[0] + dx, light[1] + dy, light[2] + dz], yaw });
    await frame(30);
    const seen = await page.evaluate(async () => {
      let changed = 0;
      for (let k = 0; k < 20; k++) { await new Promise(r => requestAnimationFrame(r)); changed += window.__deusSpatial.world.lightAnimation().changedSpatial ?? 0; }
      return changed;
    });
    if (seen) { stand = [dx, dy, dz, yaw]; break; }
  }
  report = await page.evaluate(async frames => {
    const world = window.__deusSpatial.world, samples = [];
    const hash = () => world.lightAtlasPages().map(page => { let h = 0; for (let i = 0; i < page.length; i += 7) h = (Math.imul(h, 31) + page[i]) | 0; return h; });
    const first = hash();
    for (let k = 0; k < frames; k++) {
      await new Promise(r => requestAnimationFrame(r));
      const a = world.lightAnimation();
      samples.push({ ms: a.ms, mergeMs: a.mergeMs, changed: a.changed, changedSpatial: a.changedSpatial, merged: a.merged, time: a.time });
    }
    const median = list => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const last = world.lightAnimation();
    return { records: last.records, spatialRecords: last.spatialRecords,
      framesWithSpatialChanges: samples.filter(s => s.changedSpatial > 0).length, frames,
      medianMs: median(samples.map(s => s.ms)), medianMergeMs: median(samples.map(s => s.mergeMs)),
      maxMs: Math.max(...samples.map(s => s.ms)), medianMerged: median(samples.map(s => s.merged)),
      medianChangedSpatial: median(samples.map(s => s.changedSpatial)),
      timeAdvanced: samples.at(-1).time > samples[0].time, atlasChanged: hash().some((h, i) => h !== first[i]),
      notes: world.notes.filter(note => /Disco|not translated|spatial/i.test(note)),
      runtimeError: window.deusExViewer.status().runtimeError?.message ?? null };
  }, frames);
  report.stand = stand; report.pageErrors = errors;
  if (shots) await page.screenshot({ path: `${shots}/light-spatial-${map}.png` });
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.ok(report.stand, 'a stand beside the light draws its light maps');
assert.ok(report.spatialRecords > 0, 'light maps carry a spatially dynamic light');
assert.ok(!report.notes.some(note => /not translated/.test(note) && /Searchlight|SlowWave|FastWave|Shock|Disco|Interference|Rotor|Shell/.test(note)),
  'no "Light effect ... is not translated" note for these effects');
assert.ok(report.timeAdvanced, 'Level.TimeSeconds advances');
assert.ok(report.framesWithSpatialChanges > report.frames / 2, 'the spatially dynamic light maps change on most frames');
assert.ok(report.atlasChanged, 'the changes reach the light atlas');
console.log(`validate-light-spatial-play: PASS (${map}: ${report.spatialRecords} spatially dynamic light maps, ${report.medianChangedSpatial} changed ` +
  `per frame (median), light animation ${report.medianMs.toFixed(2)} ms/frame median)`);
