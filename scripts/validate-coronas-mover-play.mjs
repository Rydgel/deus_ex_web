// Coronas behind a mover's fragments in Play (docs/coronas.md "Lights behind a
// mover's fragments"; the Node-side comparison with the original's DLL and
// measurements is validate-coronas-tracked.mjs).
//
// 09_NYC_ShipFan at the visual-acceptance view fan2, as its capture sets it:
// the level held (LevelInfo.bPlayersOnly), `ghost`, then Location (236, -238,
// -55) and ViewRotation (-1850, 25298, 0) written through the console's SET
// (viewProbe: the Region stays the start's). The original's helper is offered
// 11 lights there and passes 6; the three lamps over the fan (Light34, Light35,
// Light36), Light60 and one more are blocked, Light34, 35 and 36 by the fan's
// fragments in Level->Model. Play's scan runs in the sim worker by default (`--query sim=inline`
// on the page) and reads the model the brush tracker left.
//
//   node scripts/validate-coronas-mover-play.mjs [--url http://...] [--query sim=inline]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-coronas-mover-play: no installed game data'); process.exit(0); }
const map = '09_NYC_ShipFan', query = option('query', '');
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
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/?hold=1${query ? `&${query}` : ''}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 300000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true}));
  await page.evaluate(() => window.deusExViewer.release());
  await frames(30);
  await page.evaluate(() => window.deusExViewer.viewProbe({ghost: true}));
  await page.evaluate(() => window.deusExViewer.viewProbe({location: [236, -238, -55], rotation: [-1850, 25298, 0]}));
  await frames(60);
  report = await page.evaluate(() => ({stats: window.deusExViewer.coronas(), runtimeError: window.deusExViewer.status().runtimeError?.message ?? null}));
  report.pageErrors = errors;
} finally { await browser.close(); await server?.close(); }
const {stats} = report;
console.log(JSON.stringify({leafLights: stats.leafLights, visible: stats.visible, drawn: stats.drawn, seen: stats.seen,
  hidden: stats.visited.filter(name => !stats.seen.includes(name))}));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.equal(stats.leafLights, 11, 'the helper is offered the original\'s 11 lights');
assert.equal(stats.visible, 6, 'six pass both checks, as in the original');
for (const name of ['Light33', 'Light31', 'Light37', 'Light38', 'Light44']) assert.ok(stats.seen.includes(name), `${name} passes`);
for (const name of ['Light34', 'Light35', 'Light36', 'Light60']) assert.ok(!stats.seen.includes(name), `${name} is hidden behind the fan's fragments or the door`);
console.log(`validate-coronas-mover-play: PASS (${map}${query ? `, ${query}` : ''}: ${stats.leafLights} offered, ${stats.visible} passed, ${stats.drawn} drawn)`);
