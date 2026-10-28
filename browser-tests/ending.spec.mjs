import { test, expect } from '@playwright/test';
import { chromiumChannel } from './browsers.mjs';

// An ending in the page, from an Area 51 arrival (docs/travel.md "Play, step 5"): `15_Area51_Final` opened from the map list (the debugging page: the default
// start has no way to Area 51 until saves load), then `LocalTravel 99_Endgame1` typed as the original's console line (the Final level's MapExit0 is the
// same SendPlayer with ClearWindowStack first). MissionEndgame plays the Endgame1 conversation (its flags Endgame1_Played and EndgameExplosions), prints the
// quote, and FinishCinematic opens CreditsWindow with bLoadIntro True; a click ends the credits (CreditsWindow.DestroyWindow -> SendPlayer "dxonly"), the DXOnly
// level arrives with the endgame's flags and its Paralyzed player, and a click there opens MenuMain. The Escape variant (ConWindowActive.AbortCinematicConvo ->
// FinishCinematic at once) skips the rest of the conversation.
test.use({ ...chromiumChannel, headless: true, viewport: { width: 1280, height: 800 } });

test('Endgame1 from 15_Area51_Final runs to the credits, DXOnly and the main menu', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/favicon/.test(message.location().url)) errors.push(message.text()); });
  const probe = step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
  const top = async () => (await probe({ op: 'state' }))?.top ?? null;
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const map = (name, timeout = 240_000) => page.waitForFunction(name => { const s = window.deusExViewer?.status(); return s?.ready && s.map?.toLowerCase() === name.toLowerCase() && !s.runtimeError; }, name, { timeout });
  const flagNames = () => page.evaluate(() => window.deusExViewer.liveProbe({ flags: {} }).then(r => r.flags.entries.map(entry => entry.name).sort()));
  const clickScene = async (fx = 0.5, fy = 0.3) => {
    const box = await page.locator('#scene').boundingBox();
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy); await frames(2);
    await page.mouse.down(); await frames(2); await page.mouse.up(); await frames(8);
  };

  await page.goto(`${process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173'}/?debug=1&antialias=0&saves=off`);
  await map('00_Training');
  await page.getByRole('combobox', { name: 'Map', exact: true }).selectOption('15_Area51_Final');
  await map('15_Area51_Final');
  await frames(60);
  await page.evaluate(line => window.deusExViewer.viewProbe({ exec: [line] }), 'LocalTravel 99_Endgame1');
  await map('99_Endgame1', 120_000);
  await expect.poll(top, { timeout: 60_000 }).toBe('deusex.conwindowactive');   // the Endgame1 conversation, first person
  await expect.poll(flagNames, { timeout: 120_000 }).toContain('Endgame1_Played');
  await expect.poll(top, { timeout: 120_000 }).toBe('deusex.creditswindow');   // after the quote: FinishCinematic -> ShowCredits(True)
  await page.waitForTimeout(3_000);
  await clickScene();                                                         // the credits end: SendPlayer "dxonly"
  await map('dxonly', 120_000);
  await frames(120);
  expect(await flagNames()).toEqual(['Endgame1_Played', 'EndgameExplosions', 'PlayerTraveling', 'SKTemp_SkillPointsAvail', 'SKTemp_SkillPointsTotal']);
  await clickScene(); await frames(30);                                       // Paralyzed.Fire -> ShowMainMenu
  expect(await top()).toBe('deusex.menumain');
  expect(await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null)).toBeNull();
  expect(errors).toEqual([]);
});

test('Escape in the Endgame1 conversation opens the credits at once', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/favicon/.test(message.location().url)) errors.push(message.text()); });
  const probe = step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
  const top = async () => (await probe({ op: 'state' }))?.top ?? null;
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const map = (name, timeout = 240_000) => page.waitForFunction(name => { const s = window.deusExViewer?.status(); return s?.ready && s.map?.toLowerCase() === name.toLowerCase() && !s.runtimeError; }, name, { timeout });
  const flagNames = () => page.evaluate(() => window.deusExViewer.liveProbe({ flags: {} }).then(r => r.flags.entries.map(entry => entry.name).sort()));

  await page.goto(`${process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173'}/?debug=1&antialias=0&saves=off`);
  await map('00_Training');
  await page.getByRole('combobox', { name: 'Map', exact: true }).selectOption('15_Area51_Final');
  await map('15_Area51_Final');
  await frames(60);
  await page.evaluate(line => window.deusExViewer.viewProbe({ exec: [line] }), 'LocalTravel 99_Endgame1');
  await map('99_Endgame1', 120_000);
  await expect.poll(top, { timeout: 60_000 }).toBe('deusex.conwindowactive');
  await page.waitForTimeout(8_000);
  await page.keyboard.press('Escape');
  await expect.poll(top, { timeout: 30_000 }).toBe('deusex.creditswindow');
  expect(await flagNames()).toEqual(['Endgame1_Played', 'EndgameExplosions']);
  expect(errors).toEqual([]);
});
