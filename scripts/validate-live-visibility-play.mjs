// Play's render feedback in a live level against what the original's renderer stamps
// (docs/visual-acceptance.md "Live scenes", the 06_HongKong_WanChai_Underworld pilot).
//
// The map's start view looks over a mirrored dance floor. The original (Wine, a view sweep of ViewRotation through the
// full circle in 15 degree steps, 8 pawns, 192 readings of LastRenderTime against the level time) stamps Businessman1
// at the start view although the main frame culls him: Render.dll's DrawFrame draws OccludeBsp's mirror child frame
// (recursion 1, Mirror -1), and DrawActorSprite (0x10b25150) stamps its Frame->Sprite. Play's Rust OccludeBsp makes
// that child frame (its `main` set lists the pawn) but the page had no mirror group to draw it with (the panes are
// BreakableGlass movers, which world.mjs did not build until validate-page-movers-play), so no pass stamped it; the
// stamping of a child frame the page cannot draw stays as a fallback. And Model.Zones[i].LastRenderTime, which OccludeBsp writes in every frame
// and AActor::InStasis reads, was never copied to the actors' level (a pawn in a rendered zone within 1200 units of the
// player was frozen by stasis where the original kept ticking it). Checks, in worker mode:
// - at the start view Businessman1 (56 degrees left of the view axis, 526 units) is stamped within half a second,
//   and at 105 degrees further left (the original: not rendered) it is not;
// - Female1, 1,122 units away in a zone the start view shows, reads a zone render time within 5 s of the level time.
//
//   node scripts/validate-live-visibility-play.mjs [--url http://...]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-live-visibility-play: no installed game data'); process.exit(0); }
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
const map = '06_HongKong_WanChai_Underworld';
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/?hold=1&seed=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  // The frozen start of the live acceptance: bPlayersOnly from the first tick, then the ghost.
  await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true, timeDilation: 1}));
  await page.evaluate(() => window.deusExViewer.release());
  await frames(10);
  const start = await page.evaluate(() => window.deusExViewer.viewProbe({ghost: true}));
  // The level clock past InStasis's 5 s (a zone time of zero reads as stale only then).
  await page.evaluate(() => window.deusExViewer.viewProbe({timeDilation: 30}));
  for (let k = 0; k < 400; k++) {
    await frames(5);
    if ((await page.evaluate(() => window.deusExViewer.viewProbe({}))).timeSeconds > 9) break;
  }
  await page.evaluate(() => window.deusExViewer.viewProbe({timeDilation: 1}));
  const census = async yaw => {
    await page.evaluate(r => window.deusExViewer.viewProbe({rotation: r}), [0, yaw, 0]);
    const {census: t0} = await page.evaluate(() => window.deusExViewer.liveProbe({census: true}));
    let now;
    do { await frames(15); now = (await page.evaluate(() => window.deusExViewer.liveProbe({census: true}))).census; } while (now.time - t0.time < 1.5);
    return now;
  };
  const base = start.viewRotation[1] >>> 0 & 0xffff;
  const pawn = (c, name) => { const p = c.pawns.find(q => q.name === name); assert.ok(p, `${name} is in the level`); return p; };
  const view0 = await census(base);
  assert.ok(view0.time - pawn(view0, 'Businessman1').lrt < 0.5,
    `Businessman1 is stamped at the start view (stale ${view0.time - pawn(view0, 'Businessman1').lrt})`);
  assert.ok(view0.time - pawn(view0, 'Female3').lrt < 0.5, 'Female3 (in the main frame) is stamped at the start view');
  const zone = pawn(view0, 'Female1');
  assert.ok(typeof zone.zoneLrt === 'number' && view0.time - zone.zoneLrt < 5,
    `Female1's zone was rendered within 5 s (zone render time ${zone.zoneLrt}, level time ${view0.time})`);
  const away = await census((base + Math.round(105 / 360 * 65536)) & 0xffff);
  assert.ok(away.time - pawn(away, 'Businessman1').lrt > 0.5, 'Businessman1 is not stamped 105 degrees to the left');
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`validate-live-visibility-play: Businessman1 stamped at the start view (stale ${(view0.time - pawn(view0, 'Businessman1').lrt).toFixed(3)} s) and not at +105 degrees; Female1's zone render time ${zone.zoneLrt.toFixed(2)} at level time ${view0.time.toFixed(2)}`);
} finally { await browser.close(); await server?.close(); }
