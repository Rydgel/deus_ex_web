// Laser beams in Play (docs/lasers.md): on 01_NYC_UNATCOIsland the player
// stands beside LaserTrigger0-4's stacked beams. The renderer builds each
// LaserEmitter's LaserIterator, the emitter's CalcTrace adds its beam,
// ULaserIterator::CurrentItem walks the proxy along it, and the actor mesh
// scene draws the LaserBeam segments at the item snapshots, with no runtime
// error.
//
//   node scripts/validate-lasers-play.mjs [--url http://...] [--shot FILE]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-lasers-play: no installed game data'); process.exit(0); }
const map = '01_NYC_UNATCOIsland', shot = option('shot', null);
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
      '\nwindow.__deusLasers={get npc(){return npcPreview;},get game(){return game;}};\n'});
  });
  await page.goto(url);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  await page.evaluate(() => {
    const game = window.__deusLasers.game, runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
    runtime.farMoveActor(player, [1920, -1069, -60], 0, 1);
    runtime.writeNamed(player, 'ViewRotation', [65536 - 2500, 16384, 0]);
  });
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(150);
  report = await page.evaluate(() => {
    const game = window.__deusLasers.game, runtime = game.doors.scriptRuntime.runtime, level = runtime.levelFor(game.player.collisionActor);
    const read = (a, n) => runtime.readNamed(a, n);
    const emitters = level.actors.filter(a => { try { return a && runtime.instance(a).cls.record.key === 'deusex.laseremitter'; } catch { return false; } });
    return {
      emitters: emitters.map(e => {
        const it = read(e, 'RenderInterface');
        const beams = it ? read(it, 'Beams').filter(b => b['deusex.laseriterator.sbeam.bactive']) : [];
        return {iterator: it ? runtime.instance(it).cls.record.key : null, on: read(e, 'bIsOn'), frozen: read(e, 'bFrozen'),
          maxItems: it ? read(it, 'MaxItems') : 0, beams: beams.map(b => ({length: b['deusex.laseriterator.sbeam.length'],
            segments: b['deusex.laseriterator.sbeam.numsegments']})), proxy: read(e, 'proxy').name,
          proxyLast: read(read(e, 'proxy'), 'LastRenderTime')};
      }),
      time: read(level.actors[0], 'TimeSeconds'), items: window.__deusLasers.npc.itemStats(),
      runtimeError: window.deusExViewer.status().runtimeError?.message ?? null,
    };
  });
  if (shot) await page.screenshot({path: shot});
  report.pageErrors = errors;
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.equal(report.emitters.length, 5, 'five LaserTriggers spawn their emitters');
assert.ok(report.emitters.every(e => e.iterator === 'deusex.laseriterator'), 'the renderer builds each LaserIterator');
const lit = report.emitters.filter(e => e.beams.length && e.maxItems > 1);
assert.ok(lit.length >= 1, 'CalcTrace adds beams once the RenderInterface exists');
assert.ok(lit.every(e => e.maxItems === e.beams.reduce((n, b) => n + b.segments, 0) + 1), 'Init counts the segments plus the last one');
const drawn = report.items.reduce((n, s) => n + s.drawn, 0);
assert.ok(drawn >= lit[0].maxItems, 'the segment previews draw');
// Only items in view are drawn (and so write LastRenderTime), as in SetupSprite.
const drawnProxies = new Set(report.items.filter(s => s.drawn).map(s => s.actor));
assert.ok(drawnProxies.size >= 1 && lit.filter(e => drawnProxies.has(e.proxy)).every(e => report.time - e.proxyLast < 0.5),
  'drawing writes the proxy LastRenderTime');
console.log(`validate-lasers-play: PASS (${lit.length} beams, ${drawn} segments drawn)`);
