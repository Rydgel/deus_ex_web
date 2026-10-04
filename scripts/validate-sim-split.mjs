// Play's simulation is the same across two builds or modes of the page
// (docs/sim-worker.md): each run loads the map with ?hold=1&seed=1 under a
// paused Playwright clock, releases the frame loop at a fixed fake time and
// steps 16 ms frames one at a time, optionally holding the forward key, and
// compares the state digest (src/runtime/state-digest.mjs) at checkpoints.
// The first pair is the same page twice, which shows the scenario is
// deterministic; the second compares page A with page B. A screenshot after
// the last frame is compared too, when the same page reproduces its own
// pixels (texture decoding is asynchronous). Host measurement of the page,
// not an original-game reference.
//
//   node scripts/validate-sim-split.mjs [--a URL] [--b URL] [--map 01_NYC_UNATCOIsland]
//     [--frames 240] [--every 60] [--walk] [--query a=1&b=2] [--query-a ...] [--query-b ...]
//     [--shots DIR] (writes each run's last frame as DIR/<hash>.png)
//
// Without --a, a Vite server for this tree serves A; without --b, B is A.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-sim-split: no installed game data'); process.exit(0); }
const map = option('map', '01_NYC_UNATCOIsland'), frames = Number(option('frames', 240)), every = Number(option('every', 60));
const walk = process.argv.includes('--walk');
let server = null, a = option('a', null);
if (!a) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  a = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const b = option('b', a);
const target = (base, extra) => {
  const url = new URL(base);
  url.searchParams.set('hold', '1'); url.searchParams.set('seed', '1');
  for (const [key, value] of new URLSearchParams(option('query', ''))) url.searchParams.set(key, value);
  for (const [key, value] of new URLSearchParams(extra ?? '')) url.searchParams.set(key, value);
  return url.href;
};
const INSTALL = new Date('2001-06-23T12:00:00Z').getTime(), START = INSTALL + 3600 * 1000;

async function run(browser, url) {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.clock.install({time: INSTALL});
    await page.goto(url);
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.mode === 'play'; },
      map, {timeout: 240000});
    await page.clock.pauseAt(START);
    await page.evaluate(() => window.deusExViewer.release());
    if (walk) await page.keyboard.down('KeyW');
    const digests = [];
    for (let frame = 1; frame <= frames; frame++) {
      await page.clock.runFor(16);
      if (frame % every === 0 || frame === frames) {
        const state = await page.evaluate(() => ({digest: window.deusExViewer.stateDigest(),
          error: window.deusExViewer.status().runtimeError?.message ?? null}));
        digests.push({frame, ...state});
        if (state.error) break;
      }
    }
    const png = await page.locator('#scene').screenshot(), shot = createHash('sha256').update(png).digest('hex').slice(0, 16);
    if (option('shots', null)) await writeFile(`${option('shots', null)}/${shot}.png`, png);
    return {url, digests, shot, errors};
  } finally { await page.close(); }
}

const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const first = await run(browser, target(a, option('query-a', ''))), again = await run(browser, target(a, option('query-a', '')));
  const other = await run(browser, target(b, option('query-b', '')));
  report = {map, frames, walk, a: first, again, b: other};
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1));
for (const side of [report.a, report.again, report.b]) {
  assert.deepEqual(side.errors, [], `${side.url}: page errors`);
  assert.ok(side.digests.every(d => d.error === null), `${side.url}: runtime error ${side.digests.at(-1)?.error}`);
}
const sequence = side => side.digests.map(d => `${d.frame}:${d.digest}`).join(' ');
assert.equal(sequence(report.again), sequence(report.a), 'the same page twice gives the same digests (deterministic scenario)');
assert.equal(sequence(report.b), sequence(report.a), 'page B gives page A\'s digests');
const pixels = report.again.shot === report.a.shot;
if (pixels) assert.equal(report.b.shot, report.a.shot, 'page B draws page A\'s last frame');
else console.log('validate-sim-split: the same page drew different last frames; pixels not compared');
console.log(`validate-sim-split: PASS (${map}, ${frames} frames${walk ? ' walking' : ''}, ${report.a.digests.length} digests${pixels ? ', same pixels' : ''})`);
