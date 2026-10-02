// Wall mirrors in Play (docs/mirror-surfaces.md "All maps"): the player faces
// the translucent bar mirror in 02_NYC_Bar, an opaque unlit bathroom mirror
// in 02_NYC_Hotel and the translucent mirror on 02_NYC_Smug's DeusExMover7. Each plane's reflected child renders, the mirror region
// differs from the same frame drawn without the reflection, and the opaque
// mirror shows the child alone.
//
//   node scripts/validate-mirrors-play.mjs [--url http://...] [--shots DIR]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-mirrors-play: no installed game data'); process.exit(0); }
let server = null, url = option('url', null);
const shots = option('shots', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
// Camera in front of each mirror (Unreal units, yaw toward the plane).
const CASES = [
  {map: '02_NYC_Bar', name: 'translucent wall', location: [-768, -600, 95], yaw: 49152, opaque: false},
  {map: '02_NYC_Hotel', name: 'opaque unlit wall', location: [1880, -1158, 148], yaw: 32768, opaque: true},
  {map: '02_NYC_Smug', name: 'translucent mover', location: [-576, 1530, 250], yaw: 16384, opaque: false},
];
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const results = [];
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: (await response.text()) +
      '\nwindow.__deusMirrors={get world(){return world;},get game(){return game;}};\n'});
  });
  await page.goto(url);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  for (const c of CASES) {
    await page.locator('#map').selectOption(c.map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, c.map, {timeout: 240000});
    await page.evaluate(({location, yaw}) => {
      const game = window.__deusMirrors.game, runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
      runtime.farMoveActor(player, location, 0, 1);
      runtime.writeNamed(player, 'ViewRotation', [0, yaw, 0]);
    }, c);
    await frames(90);
    const read = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(() => {
      const world = window.__deusMirrors.world, s = window.deusExViewer.status();
      resolve({mirrors: s.mirrors, runtimeError: s.runtimeError?.message ?? null,
        notes: [...world.notes].filter(n => /mirror/i.test(n))});
    }, 0))));
    const state = await read();
    if (shots) await page.screenshot({path: `${shots}/mirror-${c.map}.png`});
    const withReflection = await page.screenshot();
    // The same view with every mirror's reflection disabled (render() skipped).
    await page.evaluate(() => { window.__deusMirrors.world.mirrors.enabled = false; });
    await frames(3);
    const without = await page.screenshot();
    if (shots) await page.screenshot({path: `${shots}/mirror-${c.map}-off.png`});
    await page.evaluate(() => { window.__deusMirrors.world.mirrors.enabled = true; });
    const differing = withReflection.length && without.length ? Buffer.compare(withReflection, without) !== 0 : false;
    results.push({...c, ...state, differing});
  }
  results.pageErrors = errors;
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(results, null, 1));
assert.deepEqual(results.pageErrors, []);
for (const r of results) {
  assert.equal(r.runtimeError, null, r.map);
  assert.ok(r.mirrors.renderedPlanes >= 1, `${r.map}: the ${r.name} mirror renders a reflected child`);
  assert.ok(r.mirrors.surfaces >= 1 && (!r.opaque || r.mirrors.opaqueSurfaces >= 1), `${r.map}: mirror surfaces admitted`);
  assert.ok(!r.notes.some(n => /outside static upward-facing/.test(n)), `${r.map}: no static-floor-only note`);
  assert.ok(r.differing, `${r.map}: the reflection changes the frame`);
}
console.log(`validate-mirrors-play: PASS (${results.map(r => `${r.map} ${r.name}: ${r.mirrors.renderedPlanes} plane(s)`).join('; ')})`);
