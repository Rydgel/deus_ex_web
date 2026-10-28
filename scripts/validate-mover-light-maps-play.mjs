/** SetupForSurf's static cache header for movers in Play's default worker mode (docs/static-lighting.md "Mover surfaces in
 * SetupForSurf"): the simulation sends each drawn mover polygon with the facet the brush tracker holds for it
 * (sim-session.mjs moverItems), and world.relightMovers builds its light map again when its mover's leaf, Location or
 * Rotation differ from the header it was built for (lighting.mjs relightPolygon). On 00_TrainingCombat's DeusExMover26,
 * a door without bDynamicLightMover, with the player in front of it (mover-probe.mjs moverDecalProbe place):
 *   1. after the settle every drawn polygon's light map is built on its tracker facet, under the authored header;
 *   2. slid by KeyPos[1] (moverProbe set, as MoveActor leaves it), those light maps are built again on facets moved by
 *      (0, -56, 0), under the new header, at least one light map's texels change, and the frames after build nothing;
 *   3. back at the authored Location, every texel is the settled one again.
 * Then on 09_NYC_ShipFan, the fan DeusExMover1 spins on its own (RotationRate, bFixedRotationDir): its light maps' header
 * Rotation changes and its drawn polygons are built again as it turns; the rebuild's time per frame is reported
 * (world.moverLighting). No runtime or page error.
 *
 *   node scripts/validate-mover-light-maps-play.mjs [--url http://...] [--query sim=inline] [--frames N]
 */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const NAME = 'validate-mover-light-maps-play';
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
const query = option('query', ''), turns = Number(option('frames', 60));
let server = null, url = option('url', null);
if (!url) {
  const tree = fileURLToPath(new URL('..', import.meta.url));
  const { default: base } = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && tree.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && tree.includes('/.claude/worktrees/')));
  server = await createServer({ ...base, configFile: false, root: tree, logLevel: 'error',
    server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\nwindow.__deusMovers={get world(){return world;}};\n' });
  });
  await page.goto(debugUrl(`${url}/${query ? `?${query}` : ''}`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 240000 });
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const open = async map => {
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, { timeout: 240000 });
  };
  // The mover's light maps as the page holds them: header, whether built on a tracker facet, the facet origin, texels.
  const records = name => page.evaluate(name => {
    const { world } = window.__deusMovers, lighting = world.lightMaps;
    return lighting.ownedRecords().filter(r => r.owner === name).map(r => ({ surface: r.surfaceIndex, header: r.header ? [...r.header] : null,
      facet: Boolean(r.pose?.facet), origin: [...lighting.geometryFor(r).facet.origin], texels: Array.from(r.baseTexels) }));
  }, name);
  const counters = () => page.evaluate(() => ({ ...window.__deusMovers.world.moverLighting }));
  const status = () => page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);

  // 1-3. The door.
  await open('00_TrainingCombat');
  const door = 'DeusExMover26', placed = await page.evaluate(name => window.deusExViewer.moverDecalProbe({ place: true, name, distance: 120 }), door);
  await frames(90);
  const settled = await records(door), drawn = settled.filter(r => r.facet), authored = placed.moverLocation;
  assert.ok(drawn.length > 0, `${door}: no light map built on a tracker facet after the settle`);
  for (const r of drawn) assert.deepEqual(r.header.slice(1, 4), authored.map(Math.fround), `${door} surface ${r.surface}: header Location`);
  const key = [0, -56, 0];
  await page.evaluate(([name, offset]) => window.deusExViewer.moverProbe({ set: [{ name, offset }] }), [door, key]);
  await frames(30);
  const before = await counters();
  const slid = await records(door);
  await frames(30);
  const after = await counters();
  let changed = 0, rebuilt = 0;
  for (const r of slid) {
    const was = settled.find(s => s.surface === r.surface);
    if (!was.facet) continue;
    assert.ok(r.facet, `${door} surface ${r.surface}: not on a tracker facet after the slide`);
    assert.deepEqual(r.header.slice(1, 4), authored.map((v, i) => Math.fround(v + key[i])), `${door} surface ${r.surface}: header Location after the slide`);
    const moved = r.origin.map((v, i) => v - was.origin[i]);
    assert.ok(moved.every((v, i) => Math.abs(v - key[i]) < 0.01), `${door} surface ${r.surface}: facet moved by ${moved}`);
    rebuilt++;
    if (r.texels.some((v, i) => v !== was.texels[i])) changed++;
  }
  assert.ok(changed > 0, `${door}: no drawn light map changed when it slid`);
  assert.equal(after.totalRebuilt, before.totalRebuilt, `${door}: ${after.totalRebuilt - before.totalRebuilt} light maps built again with nothing moving`);
  await page.evaluate(([name, offset]) => window.deusExViewer.moverProbe({ set: [{ name, offset }] }), [door, key.map(v => -v)]);
  await frames(30);
  for (const r of await records(door)) {
    const was = settled.find(s => s.surface === r.surface);
    if (was.facet) assert.deepEqual(r.texels, was.texels, `${door} surface ${r.surface}: texels back at the authored Location`);
  }
  console.log(`${door}: ${drawn.length} of ${settled.length} light maps on tracker facets; slid by ${key}: ${rebuilt} built again, ${changed} changed; back: equal`);
  assert.equal(await status(), null, 'runtime error on 00_TrainingCombat');

  // 4. The fan, spinning on its own (RotationRate, bFixedRotationDir): sampled every frame.
  await open('09_NYC_ShipFan');
  const fan = 'DeusExMover1';
  await page.evaluate(name => window.deusExViewer.moverDecalProbe({ place: true, name, distance: 200 }), fan);
  await frames(90);
  const start = await counters(), first = await records(fan), samples = [];
  for (let k = 0; k < turns; k++) {
    await frames(1);
    const c = await counters();
    samples.push({ rebuilt: c.rebuilt, ms: c.ms });
  }
  const end = await counters(), last = await records(fan), onFacets = last.filter(r => r.facet).length;
  const turned = last.some(r => first.find(f => f.surface === r.surface)?.header?.slice(4).some((v, i) => v !== r.header?.[4 + i]));
  const perCall = (end.totalMs - start.totalMs) / Math.max(1, end.calls - start.calls), sorted = samples.map(s => s.ms).sort((a, b) => a - b);
  assert.ok(turned, `${fan}: its light maps' header Rotation did not change over ${turns} frames`);
  assert.ok(end.totalRebuilt > start.totalRebuilt, `${fan}: turning built nothing again`);
  console.log(`${fan}: ${onFacets} light maps on tracker facets; ${end.totalRebuilt - start.totalRebuilt} built again over ${end.calls - start.calls} frames `
    + `(${Math.max(...samples.map(s => s.rebuilt))} at most in one); relightMovers ${perCall.toFixed(3)} ms mean, median ${sorted[sorted.length >> 1].toFixed(3)}, max ${sorted.at(-1).toFixed(3)}`);
  assert.equal(await status(), null, 'runtime error on 09_NYC_ShipFan');
  assert.deepEqual(errors, [], 'page errors');
  console.log(`PASS ${NAME}`);
} finally {
  await browser.close();
  await server?.close();
}
