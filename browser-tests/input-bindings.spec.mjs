import { test, expect } from '@playwright/test';
import { chromiumChannel } from './browsers.mjs';

// The original's input bindings in the browser page (docs/input-bindings.md): the mouse wheel is WinDrv's WM_MOUSEWHEEL (IK_MouseW's
// axis, then IK_MouseWheelUp/Down pressed and released) and runs User.ini's MouseWheelDown=NextBeltItem / MouseWheelUp=PrevBeltItem;
// a key the original can bind is the game's whether or not it has a binding (preventDefault), and in fullscreen the page asks Keyboard
// Lock for all of them. Chromium's new headless mode (no window on the desktop); the page is the worktree's own vite server:
//   DX_BASE_URL=http://127.0.0.1:5191 npx playwright test -c .work/playwright.dev.config.mjs browser-tests/input-bindings.spec.mjs
// What headless Chromium cannot show: its CDP key events go straight to the page, so the browser's own action for an unprevented key
// (F5 reloading, F3 finding) is not exercised, only that the page prevented it; the browser-reserved chords (Ctrl+W ...) are not tried.
test.use({ ...chromiumChannel, headless: true, viewport: { width: 1280, height: 800 } });
const BASE = process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173';

const ready = (page, map) => page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && !s.runtimeError; }, map, { timeout: 240_000 });
const world = page => page.evaluate(async () => { const w = await window.deusExViewer.windowProbe(); return { belt: w.belt, inHand: w.inHand, top: w.top }; });

test('the wheel selects the belt items through NextBeltItem and PrevBeltItem; the F keys and Tab never reach the browser', async ({ page, browserName }) => {
  test.setTimeout(600_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${BASE}/?debug=1`);
  await ready(page, '00_Training');
  // What the page left of each event once its own handlers ran (a listener on window runs after the game's, on document).
  await page.evaluate(() => {
    window.__events = [];
    for (const type of ['wheel', 'keydown', 'keyup']) window.addEventListener(type, e => window.__events.push({ type, code: e.code ?? null, dy: e.deltaY ?? null, mode: e.deltaMode ?? null,
      repeat: e.repeat ?? null, prevented: e.defaultPrevented }), { passive: true });
  });
  const events = (type, since) => page.evaluate(([type, since]) => window.__events.filter(e => e.type === type).slice(since), [type, since]);

  // Two items for the belt, besides the key ring: summoned in front of the player (the console cheat), the view turned down to each and
  // picked up through the original's ParseRightClick.
  await page.evaluate(() => window.deusExViewer.placeProbe({ location: [1166, 375, -39] }));
  for (const [cls, name] of [['Multitool', 'Multitool3'], ['MedKit', 'MedKit0']]) {
    await page.evaluate(cls => window.deusExViewer.viewProbe({ exec: ['summon DeusEx.' + cls] }), cls);
    await page.waitForTimeout(1500);
    await page.evaluate(name => window.deusExViewer.placeProbe({ lookAt: name }), name);
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.deusExViewer.viewProbe({ exec: ['ParseRightClick'] }));
    await expect.poll(async () => (await world(page)).belt.includes(name), { timeout: 15_000 }).toBe(true);
  }
  const { belt } = await world(page);
  const items = belt.filter(Boolean);
  expect(items.length).toBe(3);                                  // the key ring (slot 0) and the two picked up
  const inHand = async () => (await world(page)).inHand;
  const settle = async expected => { await expect.poll(inHand, { timeout: 10_000 }).toBe(expected); };

  // Digit0 is ActivateBelt 0: the key ring in hand. Then the wheel, with the pointer over the view.
  await page.keyboard.press('Digit0');
  await settle(items[0]);
  const box = await page.locator('#scene').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // One notch of Playwright's synthetic wheel: Chromium's 100 pixels are one 120-unit notch. Playwright's WebKit makes a pixel wheel's
  // ticks from WebKit's 40-pixel line (browser_patches/webkit WebPageInspectorInputAgent::dispatchWheelEvent: wheelTicks = delta /
  // Scrollbar::pixelsPerLineStep()), and WebKit's wheelDeltaY is the ticks times 120 (WheelEvent.cpp TickMultiplier): 100 pixels
  // there are 2.5 notches, two belt steps (the Mac, 2026-11-09), so a notch is 40 pixels.
  const NOTCH = browserName === 'webkit' ? 40 : 100;
  const notch = async (dy, expected) => { await page.mouse.wheel(0, dy); await settle(expected); };
  await notch(NOTCH, items[1]);        // MouseWheelDown = NextBeltItem
  await notch(NOTCH, items[2]);
  await notch(NOTCH, items[0]);        // past the last item it wraps to the first
  await notch(-NOTCH, items[2]);       // MouseWheelUp = PrevBeltItem
  await notch(-NOTCH, items[1]);
  const real = await events('wheel', 0);
  expect(real.length).toBe(5);
  expect(real.every(e => e.prevented && e.mode === 0)).toBe(true);   // the page took them (no scrolling, no Ctrl+wheel zoom)

  // Another delta mode, and several notches in one browser event (Chromium coalesces a frame's notches): one message per notch.
  // 6 lines are two notches (three lines to a notch); a page is one.
  const synthetic = (deltaMode, deltaY) => page.evaluate(([deltaMode, deltaY]) => document.getElementById('scene')
    .dispatchEvent(new WheelEvent('wheel', { deltaMode, deltaY, bubbles: true, cancelable: true })), [deltaMode, deltaY]);
  await synthetic(1, 6);  await settle(items[0]);   // items[1] -> [2] -> [0]
  await synthetic(2, -1); await settle(items[2]);   // one page up: PrevBeltItem once
  // A touchpad's small deltas wait for a whole notch: a line is 40 units, so three events make one.
  await synthetic(1, 1); await synthetic(1, 1); await page.waitForTimeout(250);
  expect(await inHand()).toBe(items[2]);
  await synthetic(1, 1); await settle(items[0]);
  // A sideways scroll is no wheel notch.
  await page.evaluate(() => document.getElementById('scene').dispatchEvent(new WheelEvent('wheel', { deltaX: 300, bubbles: true, cancelable: true })));
  await page.waitForTimeout(500);
  expect(await inHand()).toBe(items[0]);

  // The F keys and Tab: the browser's help, find, reload, caret browsing, devtools and focus move are not run, bound or not.
  // (F1 and F2 open the inventory and goals screens, which hold the keyboard, so they come last.)
  const seen = (await events('keydown', 0)).length;
  // Slash, Backslash, Minus, Equal, Home and PageUp have no binding in User.ini (the page's answer to the second press is "not handled"):
  // Firefox's quick find starts on /, the original's window takes them all the same.
  const keys = ['F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'Tab', 'Pause', 'CapsLock'];
  const unbound = ['Slash', 'Backslash', 'Minus', 'Equal', 'Home', 'PageUp'];
  for (const key of keys) await page.keyboard.press(key);
  // (The page learns a key's answer a frame or more late, from the simulation worker's snapshot: the first press is always taken, a
  // later one only if the rule holds for a key the original did not handle.)
  for (const key of unbound) for (let press = 0; press < 3; press++) { await page.keyboard.press(key); await page.waitForTimeout(400); }
  await page.keyboard.down('F5'); await page.keyboard.down('F5'); await page.keyboard.up('F5');   // an auto-repeat press
  const down = await events('keydown', seen);
  expect(down.length).toBe(keys.length + 3 * unbound.length + 2);
  for (const e of down) expect(e.prevented, `${e.code} keydown`).toBe(true);
  expect((await events('keydown', seen)).filter(e => e.repeat).length).toBe(1);
  for (const e of (await events('keyup', 0)).filter(e => keys.includes(e.code) || unbound.includes(e.code))) expect(e.prevented, `${e.code} keyup`).toBe(true);
  await page.keyboard.press('CapsLock');   // the toggle back (Pause is a toggle too)
  await page.keyboard.press('Pause');
  expect(await page.evaluate(() => document.activeElement.tagName)).toBe('BODY');   // Tab moved no focus
  await page.keyboard.press('F1');
  await expect.poll(async () => (await world(page)).top, { timeout: 10_000 }).toBeTruthy();
  expect((await world(page)).top).toMatch(/inventory/i);
  expect((await events('keydown', 0)).at(-1)).toMatchObject({ code: 'F1', prevented: true });
  expect(errors).toEqual([]);
});

// Keyboard Lock is Chromium's (navigator.keyboard); Firefox and Safari have none: there the fullscreen comes without it, and F11 and the
// reserved chords stay the browser's (docs/input-bindings.md "Browser-reserved keys").
test('the original start asks Keyboard Lock for every key the original can bind when it takes fullscreen, where the browser has it', async ({ page }) => {
  test.setTimeout(400_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__locks = [];
    const keyboard = navigator.keyboard, lock = keyboard?.lock;
    if (lock) keyboard.lock = function (codes) { window.__locks.push(codes ? [...codes] : null); return lock.call(this, codes); };
  });
  await page.goto(`${BASE}/`);
  await ready(page, 'DX');
  const box = await page.locator('#scene').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);   // takes the pointer, not fullscreen
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__locks.length)).toBe(0);         // nothing locks outside fullscreen
  await page.keyboard.down('AltLeft'); await page.keyboard.press('Enter'); await page.keyboard.up('AltLeft');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('app');
  if (await page.evaluate(() => typeof navigator.keyboard?.lock === 'function')) {
    await expect.poll(() => page.evaluate(() => window.__locks.length)).toBeGreaterThan(0);
    const locked = await page.evaluate(() => window.__locks.at(-1));
    for (const code of ['Escape', 'Tab', 'F1', 'F3', 'F5', 'F6', 'F7', 'F11', 'F12', 'KeyW', 'KeyT', 'KeyN', 'Digit0', 'Pause', 'CapsLock', 'NumpadPeriod'].map(c => c === 'NumpadPeriod' ? 'NumpadDecimal' : c))
      expect(locked, code).toContain(code);
    expect(locked).not.toContain('MetaLeft');   // the system's own key stays the system's
  } else {
    // no Keyboard Lock: the fullscreen and the pointer lock without it, and nothing the page tried to call
    expect(await page.evaluate(() => window.__locks.length)).toBe(0);
    await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id ?? null)).toBe('scene');
  }
  // Alt+Enter leaves fullscreen and releases the lock; the keys are the browser's again.
  await page.keyboard.down('AltLeft'); await page.keyboard.press('Enter'); await page.keyboard.up('AltLeft');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe(null);
  expect(errors).toEqual([]);
});
