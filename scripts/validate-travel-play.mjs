/** Map travel in Play's page, in the default worker mode (docs/travel.md "Proposed implementation order", step 1): the page's default start (no `debug=1`) starts the
 * logo map DX.dx; Escape opens the original MenuMain; the Training button (winButtons[4]) runs DeusExPlayer.StartTrainingMission ->
 * SendPlayer -> ClientTravel; the simulation side's travel step exports the player, browses and hands the page the next level, which
 * the page loads with the travel text its Login imports.
 *
 * Checks: the page arrives in 00_Training with no runtime error; the player's flags are {M00_TRAINING_StartupText, M0MissionStart} once
 * Mission00's first Timer has run (it ran FirstFrame, which needs the PlayerTraveling the travel text carried: no host marker); the
 * knocked-out test subject, UNATCOTroop2, has become a carcass; and the HUD is the arrived player's (Play does not stop).
 *
 *   node scripts/validate-travel-play.mjs [--shots DIR] */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-travel-play: no installed game data'); process.exit(0); }
const shotsDir = option('shots', null);
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
  const ready = map => page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && !s.runtimeError; }, map, { timeout: 240000 });
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const probe = step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
  const shot = async name => { if (shotsDir) await writeFile(`${shotsDir}/${name}.png`, await page.locator('#scene').screenshot()); };

  await ready('DX');
  await frames(120);
  await shot('travel-1-logo');
  // Escape (the page's key path: User.ini's Escape=ShowMainMenu): the original main menu over the playing logo map
  await page.keyboard.press('Escape');
  await frames(30);
  const menu = await probe({ op: 'state' });
  assert.equal(menu.top, 'deusex.menumain', `Escape opens the original main menu (top window: ${menu.top})`);
  await shot('travel-2-menu');
  // the Training button: StartTrainingMission -> SendPlayer -> ClientTravel; the travel step browses after the next tick. A click on the
  // button as the menu draws it (the pointer reaches the root window while the modal menu owns the mouse grab) or, with --probe, the
  // button activated through the menu driver.
  if (process.argv.includes('--probe')) await probe({ op: 'button', index: 4 });
  else {
    const box = await page.locator('#scene').boundingBox();
    const x = box.x + box.width * 0.5, y = box.y + box.height * (299 / 641);   // MenuMain's fifth button, "Training" (travel-2-menu.png)
    await page.mouse.move(x - 20, y - 10); await frames(2);
    await page.mouse.move(x, y); await frames(3);
    await page.mouse.down(); await frames(2); await page.mouse.up();
  }
  await ready('00_Training');
  assert.equal(await page.evaluate(() => window.deusExViewer.status().runtimeError), null, 'no runtime error on arrival');
  // Mission00's first Timer (1 s) runs FirstFrame because the travel text carried PlayerTraveling
  const flagsOf = () => page.evaluate(() => window.deusExViewer.liveProbe({ flags: {} }).then(r => r.flags));
  await frames(240);
  const flags = await flagsOf();
  const names = flags.entries.map(entry => entry.name).sort();
  console.log('flags', JSON.stringify(names), 'defaultExpiration', flags.defaultExpiration);
  if (JSON.stringify(names) !== JSON.stringify(['M00_TRAINING_StartupText', 'M0MissionStart'])) failures.push(`the arrived player's flags are ${JSON.stringify(names)}`);
  const carcasses = (await page.evaluate(() => window.deusExViewer.liveProbe({ actors: 'deusex.unatcotroopcarcass' }).then(r => r.actors))).map(row => row.name);
  console.log('carcasses', JSON.stringify(carcasses));
  if (!carcasses.length) failures.push('FirstFrame did not knock the cadet out into a carcass (no UNATCOTroopCarcass)');
  await shot('travel-3-training');
  if (errors.length) failures.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally { await browser.close(); await server.close(); }
if (failures.length) { console.log(`FAIL validate-travel-play:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-travel-play: the original start -> Escape -> Training button arrives in 00_Training with the player the travel text carried');
