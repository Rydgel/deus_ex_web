// The page world builds a mover group for every actor whose class descends from Engine.Mover (the class chain, as IsA
// follows it), not for the ones whose class name ends in "Mover": BreakableGlass and BreakableWall extend DeusExMover, the
// simulation tracks them as movers (collision.movers, bIsMover), but world.mjs built groups only for /Mover$/ names, so a
// pane had no mesh and no mirror group on the page (06_HongKong_WanChai_Underworld: the start view looks at a row of
// BreakableGlass panes, rendered as a black hole). Checks, in worker mode, on that map:
// - the page holds a group for every mover the simulation tracks (29, 15 of them BreakableGlass; 14 before);
// - the start view's mirror pass sees the panes' mirror groups (BreakableGlass0, 5 and 17 are in its view) through the
//   same drawn set as any other mover;
// - breaking them (a mover BlowItUp leaves 20000 units up, collider offset (0, 0, 20000), validate-island-blowitup)
//   takes them out of the mirror pass and the frame changes where they were.
//
//   node scripts/validate-page-movers-play.mjs [--url http://...]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-page-movers-play: no installed game data'); process.exit(0); }
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
const map = '06_HongKong_WanChai_Underworld', panes = ['BreakableGlass0', 'BreakableGlass5', 'BreakableGlass17'];
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(debugUrl(`${url}/?hold=1&seed=1`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true, timeDilation: 1}));
  await page.evaluate(() => window.deusExViewer.release());
  await frames(10);
  await page.evaluate(() => window.deusExViewer.viewProbe({ghost: true}));
  await frames(20);
  const probe = args => page.evaluate(a => window.deusExViewer.moverProbe(a), args);
  const state = await probe({});
  const glass = state.movers.filter(m => /^Breakable(Glass|Wall)/.test(m.name));
  const pageMovers = (await page.evaluate(() => window.deusExViewer.status())).movers;
  assert.equal(state.movers.length, 29, 'the simulation tracks 29 movers');
  assert.equal(glass.length, 15, '15 of them are BreakableGlass');
  assert.equal(pageMovers, state.movers.length, `the page holds a group for every tracked mover (page ${pageMovers}, simulation ${state.movers.length})`);
  const mirrors = names => names.filter(group => panes.some(name => group.startsWith(`${name}:`)));
  assert.deepEqual(mirrors(state.moverMirrors ?? []).sort(), panes.map(name => `${name}:1`).sort(),
    `the start view's mirror pass sees the three panes ahead (${JSON.stringify(state.moverMirrors)})`);
  const before = await page.screenshot({clip: {x: 0, y: 0, width: 1280, height: 720}});
  await probe({set: panes.map(name => ({name, offset: [0, 0, 20000]}))});
  await frames(20);
  const after = await probe({});
  assert.deepEqual(mirrors(after.moverMirrors ?? []), [], `broken panes leave the mirror pass (${JSON.stringify(after.moverMirrors)})`);
  const changed = await page.screenshot({clip: {x: 0, y: 0, width: 1280, height: 720}});
  const sameBytes = Buffer.compare(before, changed) === 0;
  assert.ok(!sameBytes, 'the frame changes where the panes were');
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`validate-page-movers-play: ${pageMovers} page movers (${glass.length} glass); the start view's mirror pass sees ${panes.join(', ')}; moving them out takes them out of it and changes the frame`);
} finally { await browser.close(); await server?.close(); }
