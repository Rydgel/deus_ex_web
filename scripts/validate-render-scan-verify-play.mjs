// ?renderScan=verify on 03_NYC_Airfield (docs/lasers.md "The proxy's own sprite"): the render scan's reads (render.rs mesh_reads) are
// checked against the JavaScript reads of every binding as the frame goes. The Airfield's four LaserProxys are moved by the laser
// iterators, which a child frame's SetupDynamics runs again between the reads and the binding's update, and the check stopped on
// "LaserProxy3 word 4 differs in mesh_reads" in the first frames of the authored view until the update took the root frame's copy of
// the proxy (sprite-scan.mjs `proxies`). The scenario is sim-split's (?hold=1&seed=1, a paused clock, 16 ms frames, the simulation in the
// worker): the authored view, then the player looking at each proxy. It passes when no frame stops on a runtime error and the child
// frames did run the iterators again (a scenario without them would not reach the check).
//
//   node scripts/validate-render-scan-verify-play.mjs [--url http://...] [--frames 8] [--query k=v&k=v]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-render-scan-verify-play: no installed game data'); process.exit(0); }
const map = '03_NYC_Airfield', frames = Number(option('frames', 8)), extra = option('query', ''), PROXIES = ['LaserProxy0', 'LaserProxy1', 'LaserProxy2', 'LaserProxy3'];
let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  // The tree may itself sit in .work/ or .claude/worktrees/, which the config denies.
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const INSTALL = new Date('2001-06-23T12:00:00Z').getTime(), START = INSTALL + 3600 * 1000;
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const report = {views: []};
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); } catch { /* storage unavailable */ } });
  await page.clock.install({time: INSTALL});
  await page.goto(debugUrl(`${url}/?hold=1&seed=1&renderScan=verify${extra ? `&${extra}` : ''}`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.evaluate(map => { const menu = document.getElementById('map'); menu.value = map; menu.dispatchEvent(new Event('change')); }, map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.mode === 'play'; }, map, {timeout: 240000});
  await page.clock.pauseAt(START);
  await page.evaluate(() => window.deusExViewer.release());
  await page.evaluate(() => window.deusExViewer.iteratorProbe({reset: true}));
  // The authored view first, then each proxy centred.
  for (const name of [null, ...PROXIES]) {
    if (name) await page.evaluate(name => window.deusExViewer.placeProbe({lookAt: name}), name);
    for (let frame = 0; frame < frames; frame++) {
      await page.clock.runFor(16);
      await page.evaluate(() => window.deusExViewer.settled?.());
    }
    const error = await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
    report.views.push({view: name ?? 'authored', error});
    assert.equal(error, null, `${name ?? 'the authored view'}: ${error}`);
  }
  report.iterators = await page.evaluate(() => window.deusExViewer.iteratorProbe({}));
  assert.deepEqual(errors, [], 'page errors');
} finally { await browser.close(); await server?.close(); }
const {scans, rescans, iterators} = report.iterators;
console.log(JSON.stringify({views: report.views, scans, rescans, iterators}));
assert.ok(iterators >= PROXIES.length, `the Airfield's iterating actors: ${iterators}`);
assert.ok(rescans > 0, 'the child frames ran the iterators again (the scenario reaches the check)');
console.log(`validate-render-scan-verify-play: PASS (${map}, ${report.views.length} views of ${frames} frames, ${scans} scans, ${rescans} rescans)`);
