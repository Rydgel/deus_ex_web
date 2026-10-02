// Light coronas in Play (docs/coronas.md "Play"): at 02_NYC_BatteryPark's
// player start, Light410 (bCorona) hangs overhead. Looking up at it, the
// corona pass finds it in the player's leaf, both line checks pass, its
// entry fades in, and its tile draws; the frame changes with the pass.
//
//   node scripts/validate-coronas-play.mjs [--map M --light L] [--url http://...] [--shots DIR]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-coronas-play: no installed game data'); process.exit(0); }
const map = option('map', '02_NYC_BatteryPark'), lightName = option('light', 'Light410'), shots = option('shots', null);
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
      '\nwindow.__deusCorona={get corona(){return coronaPass;},get game(){return game;}};\n'});
  });
  await page.goto(url);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(30);
  await page.evaluate(lightName => {
    const game = window.__deusCorona.game, runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
    const light = runtime.levelFor(player).actors.find(a => a?.name === lightName), at = runtime.readNamed(light, 'Location');
    const eye = game.view().location, d = at.map((v, i) => v - eye[i]);
    const units = r => Math.round(r * 32768 / Math.PI);
    runtime.writeNamed(player, 'ViewRotation', [(units(Math.atan2(d[2], Math.hypot(d[0], d[1]))) + 65536) % 65536, (units(Math.atan2(d[1], d[0])) + 65536) % 65536, 0]);
  }, lightName);
  await frames(60);
  report = await page.evaluate(() => ({stats: {...window.__deusCorona.corona.stats},
    runtimeError: window.deusExViewer.status().runtimeError?.message ?? null}));
  const on = await page.screenshot();
  if (shots) await page.screenshot({path: `${shots}/corona-${map}.png`});
  await page.evaluate(() => { const c = window.__deusCorona.corona; c.__render = c.render; c.render = () => {}; });
  await frames(3);
  const off = await page.screenshot();
  if (shots) await page.screenshot({path: `${shots}/corona-${map}-off.png`});
  report.differing = Buffer.compare(on, off) !== 0;
  report.pageErrors = errors;
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.ok(report.stats.leafLights > 0, 'the player leaf permeating list names lights');
assert.ok(report.stats.visible >= 1 && report.stats.drawn >= 1, `${lightName} passes the line checks and its corona draws`);
assert.ok(report.differing, 'the corona changes the frame');
console.log(`validate-coronas-play: PASS (${map}: ${report.stats.leafLights} leaf lights, ${report.stats.visible} visible, ${report.stats.drawn} drawn)`);
