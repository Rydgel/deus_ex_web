import { test, expect } from '@playwright/test';

// The original's start (no ?debug=1) takes the mouse as the original does ([WinDrv.WindowsClient] CaptureMouse=True; Alt+Enter is
// WinDrv's ToggleFullscreen, 0x1110a280) but starts windowed (the user's choice, 2026-10-22, over StartupFullscreen=True): the first
// click takes the pointer, not the screen; Escape opens MenuMain and keeps the pointer; the menu's own cursor follows relative motion
// to a button; a travel keeps the pointer; Alt+Enter takes fullscreen, Escape (held by the Keyboard Lock) and the pointer, and gives
// them back (src/viewer/main.mjs).
// Chromium's new headless mode grants pointer lock and fullscreen, so no window opens on the desktop. Escape here is a synthetic
// key: the browser's own Escape rule (a window releases the lock, a held Escape leaves fullscreen) is not exercised.
test.use({ channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 } });

test('the original start takes the pointer (not fullscreen), keeps it through Escape, the menu and a travel; Alt+Enter toggles fullscreen', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = () => page.evaluate(async () => ({ menu: (await window.deusExViewer.settingsProbe({ op: 'state' }))?.top ?? null,
    lock: document.pointerLockElement?.id ?? null, fullscreen: document.fullscreenElement?.id ?? null, map: window.deusExViewer.status().map }));
  const map = name => page.waitForFunction(name => { const s = window.deusExViewer?.status(); return s?.ready && s.map === name && !s.runtimeError; }, name, { timeout: 240_000 });
  await page.goto(`${process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173'}/`);
  await map('DX');
  let box = await page.locator('#scene').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(state).toMatchObject({ lock: 'scene', fullscreen: null });
  await page.waitForTimeout(500);
  expect((await state()).menu).toBeNull();   // the click that grabs reaches no binding (no Fire, so no menu)
  expect((await state()).fullscreen).toBeNull();   // nor takes fullscreen
  await page.keyboard.press('Escape');
  await expect.poll(state).toMatchObject({ menu: 'deusex.menumain', lock: 'scene', fullscreen: null });
  // The menu's cursor by relative motion: up-left until the root clamps it at its corner, then to the Training button.
  box = await page.locator('#scene').boundingBox();
  let at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const go = async (x, y, steps = 20) => { await page.mouse.move(x, y, { steps }); at = { x, y }; await page.waitForTimeout(150); };
  for (let k = 0; k < 4; k++) { await go(at.x - box.width / 2, at.y - box.height / 2); await go(at.x + 0.001, at.y + 0.001, 1); }
  await go(at.x + box.width * 0.5, at.y + box.height * (299 / 641));   // MenuMain's fifth button, Training (validate-travel-play)
  await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
  await map('00_Training');
  expect(await state()).toMatchObject({ lock: 'scene', fullscreen: null });
  await page.keyboard.down('AltLeft'); await page.keyboard.press('Enter'); await page.keyboard.up('AltLeft');
  await expect.poll(state).toMatchObject({ lock: 'scene', fullscreen: 'app' });
  await page.keyboard.down('AltLeft'); await page.keyboard.press('Enter'); await page.keyboard.up('AltLeft');
  await expect.poll(state).toMatchObject({ lock: null, fullscreen: null });
  await page.keyboard.down('AltLeft'); await page.keyboard.press('Enter'); await page.keyboard.up('AltLeft');
  await expect.poll(state).toMatchObject({ lock: 'scene', fullscreen: 'app' });
  expect(errors).toEqual([]);
});
