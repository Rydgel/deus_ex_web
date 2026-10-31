import { test, expect } from '@playwright/test';
import { BASE } from './browsers.mjs';

// A failed simulation worker (docs/stage-7-exit-criteria.md row 7.9.2, docs/sim-worker.md "A failed worker"). The worker mode is forced
// (`sim=worker`), so Firefox, whose default is the inline mode, runs it too. Measured in Chromium and Firefox on Linux, 2026-10-31: an
// exception the worker catches comes back as a `failure` message and one it does not as the Worker's `error` event, and the worker lives on;
// a worker that closed, was terminated or loops in a frame sends no event at all, which the page tells by the silence of its posted frames.
// (An exhausted ArrayBuffer or Wasm memory is a RangeError, the first case; in Chromium a JavaScript heap out of memory takes the whole
// tab, the page with it, and the browser shows its own crash page.)
test.use({ viewport: { width: 960, height: 640 } });
test.setTimeout(300_000);

const status = page => page.evaluate(() => window.deusExViewer.status());
const grounded = page => page.waitForFunction(() => window.deusExViewer?.status().gameplay?.player.grounded, null, { timeout: 240_000 });
const simWorker = page => {
  const worker = page.workers().find(entry => /sim-worker/.test(entry.url()));
  if (!worker) throw new Error(`no simulation worker among ${page.workers().map(entry => entry.url()).join(', ') || 'none'}`);
  return worker;
};
const silent = page => expect.poll(async () => (await status(page)).simulation?.silent, { timeout: 40_000, intervals: [1000] }).toBe(true);

test('a worker that closes or never returns from a frame: the page says so, and a reload recovers', async ({ page }) => {
  await page.goto(`${BASE}/?debug=1&sim=worker`);
  await grounded(page);
  expect((await status(page)).simulation).toMatchObject({ silent: false });
  await simWorker(page).evaluate(() => { self.close(); });
  await silent(page);
  await expect(page.locator('#toast')).toContainText('The game stopped answering. Reload the page');
  await page.reload();
  await grounded(page);
  // the reloaded page's worker answers, and the next stuck one is told the same way
  await expect.poll(async () => (await status(page)).simulation?.outstanding ?? 99, { timeout: 10_000 }).toBeLessThan(5);
  await simWorker(page).evaluate(() => { setTimeout(() => { for (;;); }); });
  await silent(page);
  await expect(page.locator('#toast')).toContainText('The game stopped answering');
  await page.reload();
  await grounded(page);
  expect((await status(page)).runtimeError).toBeNull();
});

test('an exception in the worker, caught or not: Play pauses with its message, and Player start resets', async ({ page }) => {
  await page.goto(`${BASE}/?debug=1&sim=worker`);
  await grounded(page);
  const reset = async () => {
    await page.locator('#tools-options').click();
    await page.getByRole('button', { name: 'Player start', exact: true }).click();
    await expect.poll(async () => (await status(page)).runtimeError, { timeout: 30_000 }).toBeNull();
    const frame = (await status(page)).frame;
    await page.waitForFunction(frame => window.deusExViewer.status().frame > frame + 10, frame);
    expect((await status(page)).paused).toBe(false);
  };
  // a message the worker cannot handle: its `failure` reply
  await simWorker(page).evaluate(() => self.dispatchEvent(new MessageEvent('message',
    { data: { type: 'call', method: 'probeMissing', args: null, clock: { now: performance.now(), date: Date.now() } } })));
  await expect.poll(async () => (await status(page)).runtimeError?.message ?? null, { timeout: 10_000 }).toBe('Unknown simulation call probeMissing');
  expect((await status(page)).paused).toBe(true);
  await expect(page.locator('#toast')).toContainText('Play paused: Unknown simulation call probeMissing. Choose Player start to reset.');
  await reset();
  // an exception nothing catches: the Worker's error event
  await simWorker(page).evaluate(() => { setTimeout(() => { throw new Error('probe: an uncaught worker exception'); }); });
  await expect.poll(async () => (await status(page)).runtimeError?.message ?? '', { timeout: 10_000 }).toContain('probe: an uncaught worker exception');
  await expect(page.locator('#toast')).toContainText('Play paused:');
  await reset();
});

test('the default start, which has no Player start: the pause names the reload', async ({ page }) => {
  await page.goto(`${BASE}/?sim=worker`);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === 'DX'; }, null, { timeout: 240_000 });
  await simWorker(page).evaluate(() => self.dispatchEvent(new MessageEvent('message',
    { data: { type: 'call', method: 'probeMissing', args: null, clock: { now: performance.now(), date: Date.now() } } })));
  await expect(page.locator('#toast')).toContainText('Play paused: Unknown simulation call probeMissing. Reload the page to continue from a saved game.');
});

test('a worker that dies in the middle of a save writes nothing: the kept slot is the earlier one, whole', async ({ page }) => {
  await page.goto(`${BASE}/?debug=1&sim=worker&saves=on`);
  await grounded(page);
  await page.locator('#scene').click({ position: { x: 480, y: 320 } });
  const slot = async dir => {
    const entry = (await page.evaluate(() => window.deusExViewer.saves.list())).find(entry => entry.dir === dir);
    if (!entry) return null;
    const files = {};
    for (const { name } of entry.files) files[name] = await page.evaluate(([dir, name]) => window.deusExViewer.saves.read(dir, name), [dir, name]);
    return files;
  };
  // a whole Quick Save first (a DataLink that plays after the Training starts refuses one: the key is pressed until the game takes it)
  await expect.poll(async () => { await page.keyboard.press('NumpadAdd'); return (await slot('QuickSave')) !== null; },
    { timeout: 120_000, intervals: [1500] }).toBe(true);
  await page.waitForTimeout(1000);
  const kept = await slot('QuickSave');
  expect(Object.keys(kept)).toContain('SaveInfo.dxs');
  // the next save asks the page for its picture, and the worker is terminated instead of answered: the save was begun and never finished
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.type === 'snapshot') { window.__killedInSave = true; this.terminate(); return; }
      return post.call(this, message, ...rest);
    };
  });
  await expect.poll(async () => { await page.keyboard.press('NumpadAdd'); return page.evaluate(() => window.__killedInSave === true); },
    { timeout: 60_000, intervals: [1500] }).toBe(true);
  await silent(page);
  expect(await slot('QuickSave')).toEqual(kept);
  // the reloaded page reads the same slot
  await page.reload();
  await grounded(page);
  expect(await slot('QuickSave')).toEqual(kept);
});
