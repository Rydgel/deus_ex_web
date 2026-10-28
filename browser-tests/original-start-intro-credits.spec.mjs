import { test, expect } from '@playwright/test';
import { chromiumChannel } from './browsers.mjs';

// The main menu's Play Intro and Credits from the default start, through the original's scripts (docs/travel.md "Play, step 5"): Escape opens MenuMain over the
// logo map, a click on Play Intro travels to 00_Intro, Escape in the intro's conversation ends it (ConWindowActive.AbortCinematicConvo, then
// MissionIntro.Timer -> PostIntro -> SendPlayer "dxonly"), the DXOnly level arrives with the player Paralyzed and nothing open, a click there (Paralyzed.Fire ->
// ShowMainMenu) opens MenuMain with Save Game and Back to Game insensitive, the Credits button opens CreditsWindow over it, and a click ends the credits
// (MouseButtonReleased -> FinishedScrolling -> PopWindow) with the menu again on top. Every click is a real pointer click on the control as the menu draws it
// (settingsProbe `center`). The default start keeps the pointer through the travels (docs/boot.md "The mouse and fullscreen"): the first world click only takes it.
// Chromium's new headless mode grants pointer lock and fullscreen, so no window opens on the desktop.
test.use({ ...chromiumChannel, headless: true, viewport: { width: 1280, height: 800 } });

test('Play Intro, Escape, the DXOnly menu and the Credits end at the main menu', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/favicon/.test(message.location().url)) errors.push(message.text()); });
  const probe = step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
  const top = async () => (await probe({ op: 'state' }))?.top ?? null;
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const map = (name, timeout = 240_000) => page.waitForFunction(name => { const s = window.deusExViewer?.status(); return s?.ready && s.map?.toLowerCase() === name.toLowerCase() && !s.runtimeError; }, name, { timeout });
  const runtimeError = () => page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
  /** A pointer click on a control of the top window: the menu's cursor follows absolute motion once the lock is released (a user's Escape in a window does that). */
  const clickControl = async spec => {
    if (await page.evaluate(() => Boolean(document.pointerLockElement))) { await page.evaluate(() => document.exitPointerLock()); await frames(3); }
    const { result } = await probe({ op: 'center', ...spec });
    const buffer = await page.evaluate(() => { const canvas = document.querySelector('#scene'); return { w: canvas.width, h: canvas.height }; });
    const box = await page.locator('#scene').boundingBox();
    const x = box.x + result.x * box.width / buffer.w, y = box.y + result.y * box.height / buffer.h;
    await page.mouse.move(x - 12, y - 6); await frames(2);
    await page.mouse.move(x, y); await frames(3);
    await page.mouse.down(); await frames(2); await page.mouse.up(); await frames(8);
  };
  /** A click in the world (the left button: Fire for the player, MouseButtonReleased for a window). The first one only takes the pointer lock. */
  const clickScene = async (fx = 0.5, fy = 0.5) => {
    const box = await page.locator('#scene').boundingBox();
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy); await frames(2);
    await page.mouse.down(); await frames(2); await page.mouse.up(); await frames(8);
  };

  await page.goto(`${process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173'}/?antialias=0&saves=off`);
  await map('DX');
  await frames(120);
  await page.keyboard.press('Escape');
  await expect.poll(top).toBe('deusex.menumain');
  await clickControl({ field: 'winButtons', index: 5 });                     // Play Intro
  await map('00_Intro');
  await expect.poll(top, { timeout: 30_000 }).toBe('deusex.conwindowactive');
  await page.waitForTimeout(12_000);                                           // into the conversation
  await page.keyboard.press('Escape');                                         // ConWindowActive: AbortCinematicConvo
  await map('dxonly', 120_000);
  await frames(120);
  expect(await runtimeError()).toBeNull();
  expect(await top()).toBeNull();                                              // DXOnly: nothing open, the logo behind it
  const flags = await page.evaluate(() => window.deusExViewer.liveProbe({ flags: {} }).then(r => r.flags.entries.map(entry => entry.name).sort()));
  expect(flags).toEqual(['Intro_Played', 'PlayerTraveling', 'SKTemp_SkillPointsAvail', 'SKTemp_SkillPointsTotal']);

  // a click in the world is Fire for the Paralyzed player: Paralyzed.Fire -> ShowMainMenu (the pointer the Play Intro click took is still held; a first click
  // that only takes it would be followed by a second)
  await clickScene(); await frames(30);
  if (await top() === null) { await clickScene(); await frames(30); }
  expect(await top()).toBe('deusex.menumain');
  const controls = (await probe({ op: 'controls' })).result;
  const sensitive = index => controls.windows[controls.menu.buttons[index].window].sensitive;
  expect([sensitive(0), sensitive(1), sensitive(5), sensitive(6), sensitive(7)]).toEqual([true, false, true, true, false]);   // New Game, Save Game, Play Intro, Credits, Back to Game

  await clickControl({ field: 'winButtons', index: 6 });                     // Credits
  await frames(60);
  expect(await top()).toBe('deusex.creditswindow');
  await page.waitForTimeout(6_000);
  expect(await top()).toBe('deusex.creditswindow');
  await clickScene(0.5, 0.3); await frames(30);                              // MouseButtonReleased: the credits end
  expect(await top()).toBe('deusex.menumain');
  expect(await runtimeError()).toBeNull();
  expect(errors).toEqual([]);
});
