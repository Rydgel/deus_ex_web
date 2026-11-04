import { test, expect } from '@playwright/test';
import { BASE } from './browsers.mjs';

// Sound and music start and resume (docs/stage-7-exit-criteria.md row 7.5.1). Galaxy's output is an AudioWorklet on the page's one
// AudioContext (docs/galaxy-music.md "Phase 5"), which the page creates on the first gesture, as browsers allow:
// - the first click starts the music on the original start's logo map;
// - a hidden page draws and ticks nothing (row 7.6.4), but its sound goes on: the worklet keeps mixing what plays, as the
//   original's Galaxy keeps mixing on its timer thread into a DirectSound buffer made with DSBCAPS_GLOBALFOCUS
//   (docs/audio-output-scope.md §1.1 row 11), which sounds while the window is not the focus; the game's own sound changes (Update's
//   batches) stop with its ticks and come back with them;
// - a context the browser or the system suspends is resumed by the page at once, with no gesture (main.mjs activateInfoLinkAudio).
// Galaxy's Update posts a batch only when the game's sound changes, so the test walks (footsteps: effect voices) before the hide,
// after it and after the suspension, and waits for the worklet to apply each walk's batches.
// The hide is the HTML one modelled, as hidden-tab.spec.mjs does (headless browsers keep a background tab visible); the suspension
// is the page's own AudioContext.suspend() (deusExViewer.audioContextProbe). A real hidden tab, system sleep and an interruption by
// the system are not produced headless.
test.use({ viewport: { width: 960, height: 640 } });
test.setTimeout(300_000);

const music = page => page.evaluate(() => window.deusExViewer.musicStatus());
const worklet = s => s.output?.worklet ?? null;
const waitMusic = (page, predicate, what, timeout = 60_000) => expect.poll(async () => predicate(await music(page)), { message: what, timeout }).toBe(true);

test('the first click starts the music on the logo map', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === 'DX'; }, null, { timeout: 240_000 });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.deusExViewer.audioContextProbe())).toBe('uninitialized');   // no sound before a gesture
  await page.locator('#scene').click({ position: { x: 480, y: 320 } });
  await waitMusic(page, s => s.context === 'running' && worklet(s)?.open === true && s.library?.live === true && s.library.playing === true,
    'the context runs, the worklet opened the library and the song plays');
  const before = worklet(await music(page)).quanta;
  await page.waitForTimeout(1000);
  const after = worklet(await music(page));
  expect(after.quanta - before).toBeGreaterThan(150);   // 344 quanta a second at 44.1 kHz
  expect(after.underruns).toBe(0); expect(after.fault).toBe(0); expect(after.error).toBeNull();
  expect(errors).toEqual([]);
});

test('a hidden page keeps its sound playing and the game\'s sound comes back with its ticks; a suspended context resumes by itself', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let hidden = false; const held = [];
    const frame = window.requestAnimationFrame.bind(window);
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
    window.requestAnimationFrame = callback => frame(time => { if (hidden) held.push(callback); else callback(time); });
    window.hidePageForTest = on => {
      hidden = on; document.dispatchEvent(new Event('visibilitychange'));
      if (!on) for (const callback of held.splice(0)) frame(callback);
    };
  });
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().gameplay?.player.grounded, null, { timeout: 240_000 });
  await page.locator('#scene').click({ position: { x: 480, y: 320 } });
  await waitMusic(page, s => s.context === 'running' && s.library?.live === true && s.library.playing === true, 'Training\'s song plays', 90_000);
  // Galaxy's Update posts a batch only when the game's sound changes: a walk's footsteps (effect voices) make some.
  const walk = async () => {
    const before = (await music(page)).library;
    await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW');
    await waitMusic(page, s => s.library.voiceOps > before.voiceOps && s.library.issued > before.issued, 'footsteps start effect voices');
    const issued = (await music(page)).library.issued;
    await waitMusic(page, s => s.library.acknowledged >= issued, 'the worklet applies their batches', 10_000);
  };
  await walk();

  // Hidden: no tick, so no batch from Update; the worklet keeps playing.
  await page.evaluate(() => window.hidePageForTest(true));
  await page.waitForTimeout(300);                                      // a frame in flight lands
  const hidden = await music(page);
  await page.waitForTimeout(2000);
  const still = await music(page);
  expect(still.context).toBe('running');
  expect(worklet(still).quanta - worklet(hidden).quanta).toBeGreaterThan(300);
  expect(still.library.issued).toBe(hidden.library.issued);
  expect(still.library.playing).toBe(true);
  // Shown again: the game's sound changes flow again and the worklet applies them.
  await page.evaluate(() => window.hidePageForTest(false));
  await walk();

  // Suspended: the page resumes it with no gesture, and the game's sound goes on.
  expect(await page.evaluate(() => window.deusExViewer.audioContextProbe({ op: 'suspend' }))).not.toBe('closed');
  await expect.poll(() => page.evaluate(() => window.deusExViewer.audioContextProbe()), { timeout: 5_000 }).toBe('running');
  const resumed = await music(page);
  await page.waitForTimeout(1000);
  expect(worklet(await music(page)).quanta - worklet(resumed).quanta).toBeGreaterThan(150);
  await walk();
  const end = worklet(await music(page));
  expect(end.underruns).toBe(0); expect(end.fault).toBe(0); expect(end.error).toBeNull();
  expect(errors).toEqual([]);
});
