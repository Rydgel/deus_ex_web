// The live comparison's population step names actors the way FNames compare, without case
// (docs/visual-acceptance.md "Live scenes", the sweep's StartUp group).
//
// The two programs spell some map actors' names differently: the name table keeps the first spelling registered, so the
// original's `mib1` and `Light1` are Play's `MIB1` and `light1` in 05_NYC_UNATCOMJ12lab (and 06_HongKong_MJ12lab, 14_Oceanlab_Silo).
// The population step destroys every actor of Play's level whose name is not in the original's list; compared case-sensitively
// it destroyed MIB1, a live pawn the original ticks (its four draws on the first tick sit between Doberman3's and Terrorist1's
// in the actor order, so every later pawn's Sleep(FRand() + 0.2) read another draw: 33 of the 53 pawns left StartUp on other ticks).
// Checks, in worker mode, with the original's spellings:
// - the population call destroys neither actor and reports neither as missing;
// - a watch by the original's spelling finds Play's actor (the replay's rows are keyed by it);
// - the pawn still takes its place in the level's pawn census afterwards.
//
//   node scripts/validate-live-population-case.mjs [--url http://...]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-live-population-case: no installed game data'); process.exit(0); }
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
const map = '05_NYC_UNATCOMJ12lab';
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(debugUrl(`${url}/?hold=1&seed=1`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
  await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true, timeDilation: 1}));
  await page.evaluate(() => window.deusExViewer.release());
  const {actors} = await page.evaluate(() => window.deusExViewer.liveProbe({actors: 'engine.actor'}));
  const names = actors.map(actor => actor.name);
  assert(names.includes('MIB1') && names.includes('light1'), 'the map holds MIB1 and light1 in Play\'s spelling');
  // the original's list: the same level, those two actors spelled as the original's name table has them
  const original = names.map(name => ({name: name === 'MIB1' ? 'mib1' : name === 'light1' ? 'Light1' : name, odds: 1}));
  const {population} = await page.evaluate(list => window.deusExViewer.liveProbe({population: list}), original);
  assert.deepEqual(population.removed, [], `the population step destroyed ${population.removed.join(', ')}`);
  assert.deepEqual(population.missing, [], `the population step reports ${population.missing.join(', ')} missing`);
  const {offsets} = await page.evaluate(() => window.deusExViewer.liveProbe({offsets: {mib1: ['Health'], Light1: ['LightBrightness']}}));
  assert(offsets.mib1 && offsets.Light1, 'a watch by the original\'s spelling finds Play\'s actor');
  const {census} = await page.evaluate(() => window.deusExViewer.liveProbe({census: true}));
  assert(census.pawns.some(pawn => pawn.name === 'MIB1'), 'MIB1 is still in the level');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`validate-live-population-case: ${map}: mib1/MIB1 and Light1/light1 kept and found by either spelling, 0 removed, 0 missing`);
} finally { await browser.close(); await server?.close(); }
