/** The host services the original menus ask for (docs/host-services.md), on the default start in headless Chromium, worker mode, with the real
 * mouse: Customize Keys' auto-repeat scroll arrows, the Display screen's Toggle Full-Screen Mode (UWindowsViewport::Exec ToggleFullscreen)
 * and the Render Device prompt's RELAUNCH -changevideo (USystem::Exec).
 *
 *   node scripts/validate-host-services-play.mjs
 *
 * 1. Holding the scroll-down arrow (an XButtonWindow with auto-repeat: its tick reads the pointer and activates the button again every
 *    repeat) scrolls the key list by several steps over 2 seconds, where a quick click scrolls it by one.
 * 2. The Full-Screen choice takes the page into fullscreen (the default start is windowed: its first click takes only the pointer) and the
 *    next press out again, as Alt+Enter does; the pointer lock follows.
 * 3. The Render Device choice raises its prompt; its Yes sends RELAUNCH -changevideo, which the page announces as a cancelable
 *    'deusex-relaunch' event (the first time the check cancels it); left alone, the event is followed by a reload of the page.
 * 4. In the reloaded page, MenuMain's Exit raises its box and the box's Yes sends EXIT (USystem::Exec): the page announces a cancelable
 *    'deusex-exit' event and, left alone, ends the game: the view is hidden and the page says the game has exited (docs/host-services.md "Exit").
 * No runtime error may occur. Needs the installed game and Chromium (Playwright). */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-host-services-play: no installed game data'); process.exit(0); }
const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: ['--use-angle=gl'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
await page.addInitScript(() => {
  window.__relaunches = []; window.__exits = 0;
  window.addEventListener('deusex-exit', () => { window.__exits++; });
  window.addEventListener('deusex-relaunch', event => {
    window.__relaunches.push(event.detail.arguments);
    if (window.__cancelRelaunch !== false) event.preventDefault();
  });
});
const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
const probe = step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
const controls = async () => (await probe({ op: 'controls' })).result;
const runtimeError = () => page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
const state = () => page.evaluate(() => ({ fullscreen: document.fullscreenElement?.id ?? null, lock: document.pointerLockElement?.id ?? null }));
const center = w => [w.x + w.w / 2, w.y + w.h / 2];
const toScreen = async (bx, by) => {
  const buffer = await page.evaluate(() => { const canvas = document.querySelector('#scene'); return { w: canvas.width, h: canvas.height }; });
  const box = await page.locator('#scene').boundingBox();
  return [box.x + bx * box.width / buffer.w, box.y + by * box.height / buffer.h];
};
/** Move to a point in drawing-buffer pixels, with the pointer lock released first as the page releases it (no Escape reaches the game). */
async function moveTo(bx, by) {
  if (await page.evaluate(() => Boolean(document.pointerLockElement))) { await page.evaluate(() => window.deusExViewer.releasePointer()); await frames(3); }
  const [x, y] = await toScreen(bx, by);
  await page.mouse.move(x - 12, y - 6); await frames(1);
  await page.mouse.move(x, y); await frames(2);
}
async function click(bx, by) { await moveTo(bx, by); await page.mouse.down(); await frames(1); await page.mouse.up(); await frames(12); }
/** The button of the top menu that invokes `screen`, clicked. */
async function openScreen(screen) {
  const c = await controls();
  const entry = c.menu.buttons.find(button => button.invoke === `deusex.${screen.toLowerCase()}`);
  assert.ok(entry && entry.window != null, `${c.windows[0].class} has no button invoking ${screen}`);
  await click(...center(c.windows[entry.window]));
  const top = (await controls()).windows[0].class;
  assert.equal(top, `deusex.${screen.toLowerCase()}`, `the click opened ${top}`);
}
const noError = async label => { assert.equal(await runtimeError(), null, `${label}: runtime error`); assert.deepEqual(pageErrors, [], `${label}: page errors`); };

try {
  await page.goto(`${url}/?antialias=0`);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === 'DX' && !s.runtimeError; }, null, { timeout: 240000 });
  await frames(120);
  await page.keyboard.press('Escape'); await frames(30);
  assert.equal((await controls()).windows[0].class, 'deusex.menumain');

  // ---- Customize Keys: the auto-repeat scroll arrows ---------------------------------------------------------------
  await openScreen('MenuSettings');
  await openScreen('MenuScreenCustomizeKeys');
  const listY = async () => (await controls()).windows.find(w => w.class === 'deusex.menuuilistwindow').y;
  const arrowDown = async () => {
    const arrows = (await controls()).windows.filter(w => w.class === 'extension.buttonwindow' && w.w === 15 && w.h === 15);
    assert.equal(arrows.length, 2, 'the two scroll-bar arrows');
    return arrows.sort((a, b) => a.y - b.y)[1];
  };
  const top0 = await listY();
  await click(...center(await arrowDown()));
  const afterClick = await listY();
  assert.ok(afterClick < top0, `a click on the down arrow scrolls one step (${top0} -> ${afterClick})`);
  const stepSize = top0 - afterClick;
  await moveTo(...center(await arrowDown()));
  await page.mouse.down(); await frames(5);
  const early = await listY();
  await frames(120);
  const held = await listY();
  await page.mouse.up(); await frames(10);
  await noError('hold the down arrow');
  const released = await listY();
  assert.ok(early >= afterClick - stepSize * 1.01, `the first 5 frames of the hold scroll at most one more step (${afterClick} -> ${early})`);
  assert.ok(afterClick - held >= 3 * stepSize, `holding scrolls several steps (${afterClick} -> ${held}, step ${stepSize})`);
  const settled = await listY();
  await frames(60);
  assert.equal(await listY(), settled, 'releasing stops the repeat');
  console.log(`auto-repeat: step ${stepSize}px, click ${top0} -> ${afterClick}, hold ${afterClick} -> ${held} -> released ${released}`);

  // ---- Display: Toggle Full-Screen Mode and Render Device ---------------------------------------------------------------
  for (let tries = 0; tries < 4 && (await controls())?.windows[0].class !== 'deusex.menumain'; tries++) { await page.keyboard.press('Escape'); await frames(20); }
  await openScreen('MenuSettings');
  await openScreen('MenuScreenDisplay');
  const choice = async name => {
    const c = await controls();
    const win = c.windows.find(w => w.class === `deusex.menuchoice_${name}`);
    assert.ok(win, `Display has no ${name} choice`);
    return win;
  };
  const before = await state();
  assert.equal(before.fullscreen, null, 'the default start is windowed: its first click took only the pointer');
  await click(...center(await choice('fullscreen')));
  await page.waitForFunction(() => document.fullscreenElement?.id === 'app', null, { timeout: 5000 });
  await frames(10);
  assert.equal((await state()).fullscreen, 'app', 'Toggle Full-Screen Mode takes fullscreen');
  await click(...center(await choice('fullscreen')));
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
  await frames(10);
  assert.deepEqual(await state(), { fullscreen: null, lock: null }, 'and the next press leaves it and gives the pointer back');
  await noError('toggle fullscreen');

  assert.deepEqual(await page.evaluate(() => window.__relaunches), [], 'no relaunch yet');
  await click(...center(await choice('renderdevice')));
  let c = await controls();
  assert.equal(c.windows[0].class, 'deusex.menuuimessageboxwindow', 'the Render Device prompt');
  assert.deepEqual(await page.evaluate(() => window.__relaunches), [], 'the prompt alone relaunches nothing');
  await click(...center(c.windows[c.roles.btnYes]));
  assert.deepEqual(await page.evaluate(() => window.__relaunches), ['-changevideo'], 'Yes sends RELAUNCH -changevideo');
  await noError('render device prompt');
  // Not cancelled, the request restarts the game: the page reloads.
  await page.evaluate(() => { window.__cancelRelaunch = false; window.__marker = 'before the relaunch'; });
  await click(...center(await choice('renderdevice')));
  c = await controls();
  assert.equal(c.windows[0].class, 'deusex.menuuimessageboxwindow', 'the Render Device prompt again');
  await moveTo(...center(c.windows[c.roles.btnYes]));
  const navigation = page.waitForEvent('framenavigated', { timeout: 15000 });
  await page.mouse.down(); await page.mouse.up();
  await navigation;
  await page.waitForFunction(() => window.deusExViewer?.status().ready, null, { timeout: 240000 });
  assert.equal(await page.evaluate(() => window.__marker ?? null), null, 'the page restarted');

  // ---- Exit: MenuMain's last button (MA_Quit), its box, Yes ---------------------------------------------------------------
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === 'DX' && !s.runtimeError; }, null, { timeout: 240000 });
  await frames(120);
  await page.keyboard.press('Escape'); await frames(30);
  c = await controls();
  assert.equal(c.windows[0].class, 'deusex.menumain', 'Escape opens MenuMain after the restart');
  const exitButton = c.menu.buttons.find(button => button.action === 6);
  assert.ok(exitButton?.window != null, 'MenuMain has its Exit button');
  await click(...center(c.windows[exitButton.window]));
  c = await controls();
  assert.equal(c.windows[0].class, 'deusex.menuuimessageboxwindow', 'Exit raises its box');
  assert.equal(await page.evaluate(() => window.__exits), 0, 'the box alone exits nothing');
  await click(...center(c.windows[c.roles.btnYes]));
  await frames(10);
  assert.equal(await page.evaluate(() => window.__exits), 1, 'Yes sends EXIT once');
  const ended = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, view: getComputedStyle(document.querySelector('#scene')).visibility }));
  assert.match(ended.toast, /exited/, 'the page says the game has exited');
  assert.equal(ended.view, 'hidden', 'the view is hidden');
  assert.deepEqual(pageErrors, [], 'exit: page errors');
  console.log(JSON.stringify({ fullscreenToggles: 2, relaunches: ['-changevideo'], autoRepeat: true, exits: 1 }));
  console.log('host services passed');
} finally {
  await browser.close(); await server.close();
}
process.exit(0);
