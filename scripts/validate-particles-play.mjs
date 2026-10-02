// ParticleGenerator smoke in the browser (docs/particles.md "Play").
//
//   node scripts/validate-particles-play.mjs [--map 02_NYC_Street] [--url http://...]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-particles-play: no installed game data'); process.exit(0); }
const map = option('map', '02_NYC_Street');
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

// Particles in Play (docs/particles.md): on 02_NYC_Street the player stands
// by ParticleGenerator3's vent; the renderer builds the generator's
// ParticleIterator (RenderInterface), the drawn proxy unfreezes the
// generator, native 3017 moves its particles up, CurrentItem moves the proxy
// through them and each draws as a sprite with the live SmokePuff1 fire.
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: (await response.text()) +
      '\nwindow.__deusParticles={get sprites(){return spriteScene;},get game(){return game;}};\n'});
  });
  await page.goto(url);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  await page.evaluate(() => {
    const game = window.__deusParticles.game, runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
    const g = runtime.levelFor(player).actors.find(a => a?.name === 'ParticleGenerator3'), loc = runtime.readNamed(g, 'Location');
    runtime.farMoveActor(player, [loc[0] - 160, loc[1], loc[2] + 40], 0, 1);
    runtime.writeNamed(player, 'ViewRotation', [65536 - 1200, 0, 0]);
  });
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const sample = () => page.evaluate(() => {
    const game = window.__deusParticles.game, runtime = game.doors.scriptRuntime.runtime, level = runtime.levelFor(game.player.collisionActor);
    const g = level.actors.find(a => a?.name === 'ParticleGenerator3'), it = runtime.readNamed(g, 'RenderInterface');
    const proxy = runtime.readNamed(g, 'proxy'), time = runtime.readNamed(level.actors[0], 'TimeSeconds');
    const particles = it ? runtime.readNamed(it, 'Particles').filter(p => p['deusex.particleiterator.sparticle.bactive'])
      .map(p => ({ z: p['deusex.particleiterator.sparticle.location'][2], life: p['deusex.particleiterator.sparticle.lifespan'] })) : [];
    return { iterator: it ? runtime.instance(it).cls.record.key : null, frozen: runtime.readNamed(g, 'bFrozen'), time,
      proxyLast: runtime.readNamed(proxy, 'LastRenderTime'), particles, sprites: window.__deusParticles.sprites.count(),
      notes: [...window.__deusParticles.sprites.notes], runtimeError: window.deusExViewer.status().runtimeError?.message ?? null };
  });
  await frames(180);
  const first = await sample();
  await frames(30);
  const second = await sample();
  report = { first: { ...first, particles: first.particles.length }, second: { ...second, particles: second.particles.length },
    rising: second.particles.length && Math.max(...second.particles.map(p => p.z)) > Math.min(...second.particles.map(p => p.z)),
    pageErrors: errors };
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.second.runtimeError, null);
assert.equal(report.second.iterator, 'deusex.particleiterator', 'the renderer builds the RenderInterface');
assert.equal(report.second.frozen, false, 'a drawn proxy unfreezes the generator');
assert.ok(report.second.particles > 2, 'particles spawn and live');
assert.ok(report.rising, 'particles rise');
assert.ok(report.second.time - report.second.proxyLast < 0.5, 'drawing the particles writes the proxy LastRenderTime');
assert.ok(report.second.sprites > 2, 'sprites draw');
console.log(`validate-particles-play: PASS (${map}: ${report.second.particles} live particles, ${report.second.sprites} sprites)`);
