/** The New Game path in Play's page, in the default worker mode (docs/travel.md "Play, step 2"): the default start opens the logo map DX.dx; Escape
 * opens the original MenuMain; real mouse clicks on New Game, on No in the "train first?" box (bAskedToTrain is False on a fresh install), on
 * Medium and on Start Game (their places come from the menu windows' own bounds: settingsProbe `center`) run the original scripts through
 * ShowIntro(True) -> SendPlayer("00_Intro"); the page loads the intro with the exported text, the intro plays; Escape (ShowMainMenu on mission 98)
 * or, with --natural, the intro's own end (its conversation, then MissionIntro.Timer) runs PostIntro -> StartNewGame -> SendPlayer, and the page
 * loads 01_NYC_UNATCOIsland with the text its Login imports.
 *
 * Checks: every window of the path is the top window when the next click is made; the page arrives in 00_Intro and then in the Island with
 * no runtime error; the intro's player is the one the original leaves in it (the CameraPoints' Paralyzed state once its first Timer ran); the
 * Island's player holds the starting inventory (the pistol with its 10mm ammo, the prod with its battery, the medkit, the key ring) with the belt
 * positions the text carried, and its flags are {M01_NYC_UNATCOISLAND_StartupText, M1MissionStart} after Mission01's first Timer (FirstFrame ran
 * because the text carried PlayerTraveling: no host marker).
 *
 *   node scripts/validate-travel-newgame-play.mjs [--natural] [--shots DIR] */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-travel-newgame-play: no installed game data'); process.exit(0); }
const shotsDir = option('shots', null), natural = process.argv.includes('--natural');
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
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${url}/?antialias=0`);
  const ready = (map, timeout = 240000) => page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && !s.runtimeError; }, map, { timeout });
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const probe = step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
  const live = args => page.evaluate(args => window.deusExViewer.liveProbe(args), args);
  const shot = async name => { if (shotsDir) await writeFile(`${shotsDir}/${name}.png`, await page.locator('#scene').screenshot()); };
  /** A real mouse click on a control of the top window (settingsProbe `center`: drawing-buffer pixels -> page pixels). The default
   * start takes the pointer lock after a click (docs/boot.md "The mouse and fullscreen"), under which these absolute moves would be
   * relative motion of the menu's cursor: the lock is released first, as the page releases it (deusExViewer.releasePointer: a user's Escape would reach the menu), and the click takes it again. */
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
  const expectTop = async (label, top) => { const state = await probe({ op: 'state' }); assert.equal(state.top, top, `${label}: the top window is ${state.top} (expected ${top})`); };
  const flagNames = async () => (await live({ flags: {} })).flags.entries.map(entry => entry.name).sort();

  await ready('DX');
  await frames(120);
  await page.keyboard.press('Escape');
  await frames(30);
  await expectTop('Escape', 'deusex.menumain');
  await shot('newgame-1-menu');
  await click({ field: 'winButtons', index: 0 });                  // New Game
  await expectTop('New Game', 'deusex.menuuimessageboxwindow');     // bAskedToTrain is False: the original asks whether to train first
  await shot('newgame-2-train-box');
  await click({ field: 'btnNo' });
  await expectTop('the training box', 'deusex.menuselectdifficulty');
  await shot('newgame-3-difficulty');
  await click({ field: 'winButtons', index: 1 });                  // Medium
  await expectTop('Medium', 'deusex.menuscreennewgame');
  await shot('newgame-4-newgame');
  await click({ actionKey: 'START' });                             // Start Game: ShowIntro(True) -> SendPlayer("00_Intro")
  await ready('00_Intro');
  assert.equal(await page.evaluate(() => window.deusExViewer.status().runtimeError), null, 'no runtime error on the intro');
  await frames(180);
  const introFlags = await flagNames();
  console.log('intro flags', JSON.stringify(introFlags));
  await shot('newgame-5-intro');
  if (natural) {
    // the conversation, then Intro_Played and MissionIntro.Timer's PostIntro (about 135 s of level time)
    await ready('01_NYC_UNATCOIsland', 420000);
  } else {
    await page.keyboard.press('Escape');                            // ShowMainMenu on mission 98: bIgnoreNextShowMenu, PostIntro, StartNewGame
    await ready('01_NYC_UNATCOIsland');
  }
  assert.equal(await page.evaluate(() => window.deusExViewer.status().runtimeError), null, 'no runtime error on arrival at the Island');
  await frames(240);
  const names = await flagNames();
  console.log('Island flags', JSON.stringify(names));
  if (JSON.stringify(names) !== JSON.stringify(['M01_NYC_UNATCOISLAND_StartupText', 'M1MissionStart'])) failures.push(`the Island player's flags are ${JSON.stringify(names)}`);
  const items = {};
  for (const cls of ['deusex.weaponpistol', 'deusex.weaponprod', 'deusex.medkit', 'deusex.ammo10mm', 'deusex.ammobattery', 'deusex.nanokeyring']) {
    const rows = (await live({ actors: cls, actorProps: ['Owner', 'beltPos', 'bInObjectBelt'] })).actors;
    items[cls.split('.')[1]] = rows.filter(row => row.Owner && /^JCDentonMale/.test(String(row.Owner?.name ?? row.Owner))).map(row => `${row.name}@${row.beltPos}`);
  }
  console.log('starting inventory', JSON.stringify(items));
  for (const [cls, belt] of [['weaponpistol', 1], ['weaponprod', 2], ['medkit', 3]]) {
    const own = items[cls];
    if (own.length !== 1 || !own[0].endsWith(`@${belt}`)) failures.push(`the player's ${cls}: ${JSON.stringify(own)} (expected one at belt ${belt})`);
  }
  // two rings are owned by the player: the one Login's ResetPlayerToDefaults made, which the text's KeyRing replaced and which stays in the level
  // unreferenced (the import's property assignment), and the imported one; both at belt 0
  if (!items.nanokeyring.length || !items.nanokeyring.every(entry => entry.endsWith('@0'))) failures.push(`the player's key rings: ${JSON.stringify(items.nanokeyring)}`);
  for (const cls of ['ammo10mm', 'ammobattery']) if (items[cls].length !== 1) failures.push(`the player's ${cls}: ${JSON.stringify(items[cls])}`);
  await shot('newgame-6-island');
  if (errors.length) failures.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally { await browser.close(); await server.close(); }
if (failures.length) { console.log(`FAIL validate-travel-newgame-play:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS validate-travel-newgame-play: the original start -> Esc -> New Game -> the intro -> ${natural ? "its own end" : 'Escape'} -> the Island with the player the travel text carried`);
