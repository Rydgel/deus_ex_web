// Volumetric fog in Play (docs/volumetric-fog.md "Play"): on 02_NYC_Bar,
// Light90's volume (VolumeRadius 128, VolumeBrightness 32, VolumeFog 64)
// fills the bar's fog zones. Each frame the fog pass recomputes the fog maps
// of the visible fog-zone surfaces through the Rust loop and draws them with
// ONE/INVSRCALPHA; the frame changes when the pass is hidden.
//
//   node scripts/validate-volumetric-fog-play.mjs [--url http://...] [--shots DIR]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-volumetric-fog-play: no installed game data'); process.exit(0); }
const map = '02_NYC_Bar', shots = option('shots', null);
let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: (await response.text()) +
      '\nwindow.__deusFog={get world(){return world;},get game(){return game;}};\n'});
  });
  // Reads the runtime through main.mjs: the page's own simulation (?sim=inline).
  await page.goto(`${url.replace(/\/$/, '')}/?sim=inline`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  await page.evaluate(() => {
    const game = window.__deusFog.game, runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
    runtime.farMoveActor(player, [-900, -330, 80], 0, 1);
    runtime.writeNamed(player, 'ViewRotation', [0, 25000, 0]);
  });
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(90);
  report = await page.evaluate(() => {
    const fog = window.__deusFog.world.fog;
    let fogged = 0;
    for (const object of fog.root.children) if (object.visible) fogged++;
    return {stats: {...fog.stats}, visibleMeshes: fogged, runtimeError: window.deusExViewer.status().runtimeError?.message ?? null,
      notes: window.__deusFog.world.notes.filter(n => /fog/i.test(n))};
  });
  const on = await page.screenshot();
  if (shots) await page.screenshot({path: `${shots}/fog-${map}.png`});
  await page.evaluate(() => { window.__deusFog.world.fog.root.visible = false; });
  await frames(3);
  const off = await page.screenshot();
  if (shots) await page.screenshot({path: `${shots}/fog-${map}-off.png`});
  report.differing = Buffer.compare(on, off) !== 0;
  report.pageErrors = errors;
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.ok(report.stats.surfaces > 0 && report.stats.lights === 1, 'fog-zone surfaces and Light90 are collected');
assert.ok(report.stats.kernel, 'the Rust fog loop is in use');
assert.ok(report.stats.drawn > 0 && report.stats.texels > 0, 'visible fog surfaces get fog maps this frame');
assert.ok(report.differing, 'the fog pass changes the frame');
console.log(`validate-volumetric-fog-play: PASS (${map}: ${report.stats.drawn} of ${report.stats.surfaces} fog surfaces, ${report.stats.texels} texels)`);
