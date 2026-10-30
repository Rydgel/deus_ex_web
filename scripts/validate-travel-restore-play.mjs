/** Visited-map restoration in Play's page, in the default worker mode (docs/travel.md "Play, step 3"): the page's default start -> Escape -> a
 * start button -> a level, then `LocalTravel` to the other map of the same mission and back. Leaving a map files the level in `Save\Current` (the
 * worker's save directory); the way back loads the filed `.dxs` on the simulation side (sim-worker.mjs `loaded` with `travel.arrival.restore`) while
 * the page loads the same map's geometry.
 *
 * Scenario T: Training button -> 00_Training -> 00_TrainingCombat -> 00_Training. Scenario I (`--island`): New Game -> the intro -> Escape ->
 * 01_NYC_UNATCOIsland -> 01_NYC_UNATCOHQ -> 01_NYC_UNATCOIsland. Before leaving, the first map is marked: its UNATCOTroops are destroyed
 * (`KillAll`), a Candybar is summoned; back, the troops stay destroyed, the Candybar is there, the level has one player pawn and no runtime error
 * is raised, the items stand under the same names, the engine log holds no begin-play line, and the page draws the restored scene (a screenshot
 * with --shots).
 *
 *   node scripts/validate-travel-restore-play.mjs [--island] [--shots DIR] */
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-travel-restore-play: no installed game data'); process.exit(0); }
const shotsDir = option('shots', null), island = process.argv.includes('--island');
const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
const failures = [];
const check = (condition, message) => { if (!condition) { failures.push(message); console.log(`  FAIL ${message}`); } };
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${url}/?antialias=0`);
  const status = () => page.evaluate(() => { const s = window.deusExViewer.status(); return { ready: s.ready, map: s.map, revision: s.revision, runtimeError: s.runtimeError?.message ?? null }; });
  /** The next load: a map with a revision above `after` that is ready (a revision is one load). */
  const arrive = async (map, after, timeout = 300000) => {
    await page.waitForFunction(({ map, after }) => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.revision > after; }, { map, after }, { timeout });
    const s = await status();
    check(s.runtimeError === null, `${map}: runtime error ${s.runtimeError}`);
    return s.revision;
  };
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const probe = step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
  const live = args => page.evaluate(args => window.deusExViewer.liveProbe(args), args);
  const exec = commands => page.evaluate(exec => window.deusExViewer.viewProbe({ exec }), commands);
  const count = async cls => (await live({ actors: cls })).actors.length;
  const rows = async cls => (await live({ actors: cls, actorProps: ['Owner'] })).actors.map(row => `${row.name}${row.Owner ? `@${JSON.stringify(row.Owner)}` : ''}`).join(' ');
  const shot = async name => { if (shotsDir) await writeFile(`${shotsDir}/${name}.png`, await page.locator('#scene').screenshot()); };
  // the drawn scene is not blank: a one-colour canvas compresses to a few kilobytes of PNG, a scene to hundreds
  const lit = async () => (await page.locator('#scene').screenshot()).length;
  const click = async spec => {
    if (await page.evaluate(() => Boolean(document.pointerLockElement))) { await page.evaluate(() => window.deusExViewer.releasePointer()); await frames(3); }
    const { result } = await probe({ op: 'center', ...spec });
    const buffer = await page.evaluate(() => { const canvas = document.querySelector('#scene'); return { w: canvas.width, h: canvas.height }; });
    const box = await page.locator('#scene').boundingBox();
    const x = box.x + result.x * box.width / buffer.w, y = box.y + result.y * box.height / buffer.h;
    await page.mouse.move(x - 12, y - 6); await frames(2);
    await page.mouse.move(x, y); await frames(3);
    await page.mouse.down(); await frames(2); await page.mouse.up(); await frames(8);
  };

  await page.waitForFunction(() => window.deusExViewer?.status().ready && window.deusExViewer.status().map === 'DX', null, { timeout: 240000 });
  let revision = (await status()).revision;
  await frames(120);
  await page.keyboard.press('Escape');
  await frames(30);
  let first, second, other;
  if (island) {
    first = '01_NYC_UNATCOIsland'; second = '01_NYC_UNATCOHQ';
    await click({ field: 'winButtons', index: 0 });                  // New Game
    await click({ field: 'btnNo' });                                 // "train first?": no
    await click({ field: 'winButtons', index: 1 });                  // Medium
    await click({ actionKey: 'START' });                             // ShowIntro -> 00_Intro
    revision = await arrive('00_Intro', revision);
    await frames(180);
    await page.keyboard.press('Escape');                             // ShowMainMenu on mission 98: PostIntro, StartNewGame
    revision = await arrive(first, revision);
  } else {
    first = '00_Training'; second = '00_TrainingCombat';
    await probe({ op: 'button', index: 4 });                         // Training: StartTrainingMission -> SendPlayer
    revision = await arrive(first, revision);
  }
  await frames(240);
  const pawns = async () => await count('deusex.jcdentonmale');
  const troopsBefore = await count('deusex.unatcotroop'), candyBefore = await count('deusex.candybar');
  await exec(['KillAll UNATCOTroop', 'summon DeusEx.Candybar']);
  await frames(20);
  const troops = await count('deusex.unatcotroop'), candy = await count('deusex.candybar');
  console.log(`${first}: ${troopsBefore} troops -> ${troops}, candybars ${candyBefore} -> ${candy}`);
  check(troopsBefore > 0 && troops === 0 && candy === candyBefore + 1, `${first}: the markers did not take`);
  const itemsBefore = await rows('deusex.candybar');
  // the tracked movers' transformed vertices (the world the page draws): the restored level must show them where the saved level had them
  const moverPoints = async () => Object.fromEntries((await page.evaluate(() => window.deusExViewer.moverProbe({ points: true }))).movers.map(m => [m.name, JSON.stringify(m.points)]));
  // one mover is placed 64 units up before the save (moverProbe `set`, a test placement through the collision model) so the comparison is not of movers at rest
  const doorName = (await live({ actors: 'deusex.deusexmover' })).actors[0].name, atRest = (await moverPoints())[doorName];
  await page.evaluate(name => window.deusExViewer.moverProbe({ set: [{ name, offset: [0, 0, 64] }] }), doorName);
  await frames(10);
  const moversBefore = await moverPoints();
  check(moversBefore[doorName] !== atRest, `${first}: placing ${doorName} did not move its tracked vertices`);
  await shot('restore-1-first');

  await exec([`LocalTravel ${second}`]);
  revision = await arrive(second, revision);
  await frames(120);
  const secondLit = await lit();
  console.log(`${second}: arrived (fresh level), ${secondLit} bytes of screenshot`);
  check(secondLit > 50000, `${second}: the scene looks blank (${secondLit} bytes)`);
  await shot('restore-2-second');

  await exec([`LocalTravel ${first}`]);
  revision = await arrive(first, revision);
  await frames(240);
  const troopsBack = await count('deusex.unatcotroop'), candyBack = await count('deusex.candybar'), playersBack = await pawns();
  console.log(`${first} restored: ${troopsBack} troops, ${candyBack} candybars, ${playersBack} player pawn(s)`);
  // the level is the one that was filed, not a reload of it: the same items under the same names (a carcass's inventory is spawned by its begin
  // play), and none of the lines of a begin-play pass in the log (the page must not run a Player start over a restored level)
  check(await rows('deusex.candybar') === itemsBefore, `${first}: the candybars changed across the restore: ${itemsBefore} -> ${await rows('deusex.candybar')}`);
  const log = (await live({ engineLog: -1 })).engineLog;
  const moversAfter = await moverPoints(), moved = Object.keys(moversBefore).filter(name => moversAfter[name] !== moversBefore[name]);
  console.log(`  ${Object.keys(moversBefore).length} tracked movers (${doorName} placed up), ${moved.length} not where they were saved${moved.length ? `: ${moved.slice(0, 5)}` : ''}`);
  check(Object.keys(moversBefore).length > 0 && moved.length === 0, `${first}: movers not where they were saved: ${moved.slice(0, 8)}`);
  check(!log.some(line => /^(Log: (Game class is|Bringing Level)|ScriptLog: (InitGame|Base Mutator))/.test(line)), `${first}: the restored level ran a begin-play pass:\n${log.join('\n')}`);
  check(troopsBack === 0, `${first}: ${troopsBack} troops in the restored level (destroyed actors stay destroyed)`);
  check(candyBack === candy, `${first}: ${candyBack} candybars (saved ${candy})`);
  check(playersBack === 1, `${first}: ${playersBack} player pawns`);
  const backLit = await lit();
  check(backLit > 50000, `${first}: the restored scene looks blank (${backLit} bytes)`);
  await shot('restore-3-back');

  // and the other one again: restored from the file the second leave made
  await exec([`LocalTravel ${second}`]);
  revision = await arrive(second, revision);
  await frames(120);
  console.log(`${second}: restored on the way back`);
  await shot('restore-4-second-again');
  if (errors.length) failures.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally { await browser.close(); await server.close(); }
if (failures.length) { console.log(`FAIL validate-travel-restore-play:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS validate-travel-restore-play: ${island ? 'Island <-> HQ' : 'Training <-> Training Combat'} through the page: the filed level comes back with its markers`);
