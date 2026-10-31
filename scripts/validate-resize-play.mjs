// Play through a resize (Stage 7 row 7.6.3, docs/boot.md "A resize"): the window resized during Play, or its device pixel ratio
// changed (a zoom, the window moved to another screen), draws what a fresh load at the final size draws, byte for byte, with no
// runtime error. The scene is 10_Paris_Club's bar mirror (validate-context-loss-play.mjs's): the 4:3 picture letterboxed in the
// window, the HUD, a mirror pass and the dancers' meshes, under a paused Playwright clock and ?hold=1, so that a run and its reference
// simulate the same frames; then Escape and MenuMain over the frame keeper's copy of the last frame.
//
//   - resize: the reference loads at 1280 x 720 (a 960 x 720 picture, root units of 1); the run loads at 1024 x 640, resizes to
//     1280 x 720 after `before` frames and draws `after` more; a second run goes through 1600 x 1000 (root units of 2) on the way;
//   - ratio (Chromium): the reference loads at a device pixel ratio of 2; the run loads at 1 and changes to 2 over CDP
//     (Emulation.setDeviceMetricsOverride). A real change (a zoom, another screen) is told by main.mjs `watchPixelRatio`'s resolution
//     query, which the emulated one does not fire: the run nudges the height by a pixel and back, so this case checks the page at its
//     new ratio, not how it learns of it.
//
// Host measurement of the page against itself.
//
//   node scripts/validate-resize-play.mjs [--browser chromium|firefox] [--sim worker|inline] [--before 20] [--after 20] [--case resize|ratio]
import assert from 'node:assert/strict';
import {chromium, firefox} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {debugUrl} from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-resize-play: no installed game data'); process.exit(0); }
const engine = option('browser', 'chromium'), simMode = option('sim', null), only = option('case', null);
if (engine !== 'chromium' && engine !== 'firefox') throw new Error('--browser must be chromium or firefox');
const before = Number(option('before', 20)), after = Number(option('after', 20));
const PARIS = {map: '10_Paris_Club', location: [78, -1008, 27], rotation: [61736, 0, 0], region: {zone: 'ZoneInfo4', iLeaf: 380, zoneNumber: 7}};
const FINAL = {width: 1280, height: 720}, FIRST = {width: 1024, height: 640}, LARGE = {width: 1600, height: 1000};

const root = fileURLToPath(new URL('..', import.meta.url));
const {default: base} = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
const server = await createServer({...base, configFile: false, root, logLevel: 'error',
  server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const INSTALL = new Date('2001-06-23T12:00:00Z').getTime(), START = INSTALL + 3600 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The page in Play at the bar, at `size` and `scale`, its frame loop held, the clock paused at START and released. */
async function open(browser, size, scale = 1) {
  const context = await browser.newContext({viewport: size, deviceScaleFactor: scale});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch(), text = await response.text(), from = 'antialias: true })';
    if (!text.includes(from)) throw new Error('validate-resize-play: the page\'s renderer construction changed');
    await route.fulfill({response, body: text.replace(from, 'antialias: true, preserveDrawingBuffer: true })')});
  });
  // the page bars hidden, and the original's 4:3 picture (the debugging page keeps the shape it was given)
  await page.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); localStorage.setItem('deusex.screenAspect', '4:3'); } catch { /* none */ } });
  await page.clock.install({time: INSTALL});
  await page.goto(debugUrl(`${url}/?hold=1&seed=1&shaderWarmup=0${simMode ? `&sim=${simMode}` : ''}`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.evaluate(map => { const menu = document.getElementById('map'); menu.value = map; menu.dispatchEvent(new Event('change')); }, PARIS.map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.mode === 'play'; },
    PARIS.map, {timeout: 240000});
  await page.evaluate(async c => {
    await window.deusExViewer.viewProbe({ghost: true});
    await window.deusExViewer.viewProbe({location: c.location, rotation: c.rotation, region: c.region});
  }, PARIS);
  await page.clock.pauseAt(START);
  await page.evaluate(() => window.deusExViewer.release());
  return {context, page, errors};
}
const step = async page => { await page.clock.runFor(16); await page.evaluate(() => window.deusExViewer.settled()); };
const buffer = page => page.evaluate(() => { const c = document.getElementById('scene'); return [c.width, c.height, c.style.width, c.style.height]; });
/** Waits in real time (the page's timers are paused) for the resize observer or the resolution query to give the canvas a new size. */
async function resized(page, previous) {
  for (const end = Date.now() + 20000; ;) {
    const now = await buffer(page);
    if (now.join() !== previous.join()) { await sleep(100); if ((await buffer(page)).join() === now.join()) return now; }
    if (Date.now() > end) throw new Error(`validate-resize-play: the canvas kept ${previous.join(' ')}`);
    await sleep(20);
  }
}
async function frame(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('scene'), gl = canvas.getContext('webgl2');
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight, pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return crypto.subtle.digest('SHA-256', pixels).then(digest => {
      let drawn = 0; for (let i = 3; i < pixels.length; i += 4) drawn += pixels[i] !== 0;
      const status = window.deusExViewer.status();
      return {hex: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''), drawn, size: [width, height],
        style: [canvas.style.width, canvas.style.height], error: status.runtimeError?.message ?? null, mirrors: status.mirrors};
    });
  });
}
/** One run: loads at `first` (`scale`), then each change ({size}, or {viewport, scale}: a CDP pixel ratio change) after `before`
 * frames in all, with `after` frames after the last; its last frame. */
async function run(browser, first, changes = [], scale = 1) {
  const {context, page, errors} = await open(browser, first, scale);
  try {
    // every run simulates `before` + `after` frames: the frames between two changes come out of the first stretch
    const between = 5 * Math.max(0, changes.length - 1);
    for (let n = 0; n < before - between; n++) await step(page);
    let total = before - between;
    for (const [index, change] of changes.entries()) {
      const previous = await buffer(page);
      if (change.size) { await page.setViewportSize(change.size); await resized(page, previous); }
      else {
        // Headless Chromium's emulated ratio reaches devicePixelRatio but fires no resolution query change (nor a device-pixel resize
        // observer entry; measured 2026-10-31): a one-pixel nudge of the height has the page's resize take the new ratio.
        const cdp = await context.newCDPSession(page), {width, height} = change.viewport;
        await cdp.send('Emulation.setDeviceMetricsOverride', {width, height: height + 1, deviceScaleFactor: change.scale, mobile: false});
        const nudged = await resized(page, previous);
        await cdp.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: change.scale, mobile: false});
        await sleep(500);   // (at 2 the snapped buffer is the nudged one: nothing to wait for but the observer)
        assert.deepEqual(await buffer(page), nudged, 'ratio: the height back gives the same buffer');
      }
      const frames = index === changes.length - 1 ? after : 5;   // (5: `between`)
      for (let n = 0; n < frames; n++) await step(page);
      total += frames;
    }
    for (; total < before + after; total++) await step(page);
    const plain = await frame(page);
    // MenuMain over the kept frame (frame-keeper.mjs keeps it while a window holds the mouse): the keeper's copy at the final size
    await page.locator('#scene').focus();
    await page.keyboard.press('Escape');
    for (let n = 0; n < 10; n++) await step(page);
    const menu = await frame(page);
    menu.top = (await page.evaluate(() => window.deusExViewer.settingsProbe({op: 'state'})))?.top ?? null;
    return {...plain, menu, errors};
  } finally { await context.close(); }
}
const same = (label, got, reference) => {
  assert.deepEqual(got.errors, [], `${label}: page errors`); assert.equal(got.error, null, `${label}: runtime error`);
  assert.deepEqual(got.size, reference.size, `${label}: the drawing buffer`); assert.deepEqual(got.style, reference.style, `${label}: the canvas box`);
  assert.equal(got.hex, reference.hex, `${label}: the last frame equals a fresh load at the final size`);
  assert.equal(got.menu.top, 'deusex.menumain', `${label}: Escape opened MenuMain`);
  assert.equal(got.menu.hex, reference.menu.hex, `${label}: MenuMain over the kept frame equals a fresh load's`);
};

const browser = engine === 'firefox' ? await firefox.launch()
  : await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const summary = [];
try {
  if (!only || only === 'resize') {
    const reference = await run(browser, FINAL);
    assert.equal(reference.error, null, 'reference: runtime error'); assert.ok(reference.drawn > 0, 'reference: drawn');
    assert.ok(reference.mirrors?.planes > 0, 'reference: the bar mirror is in the scene');
    assert.equal(reference.menu.top, 'deusex.menumain', 'reference: Escape opened MenuMain');
    assert.notEqual(reference.menu.hex, reference.hex, 'reference: the menu is drawn');
    same('resize', await run(browser, FIRST, [{size: FINAL}]), reference);
    same('resize twice', await run(browser, FIRST, [{size: LARGE}, {size: FINAL}]), reference);
    summary.push(`resize: 1024x640 -> 1280x720 and through 1600x1000 equal a fresh 1280x720 (buffer ${reference.size.join('x')})`);
  }
  if ((!only || only === 'ratio') && engine === 'chromium') {
    const reference = await run(browser, FINAL, [], 2);
    assert.equal(reference.error, null, 'ratio reference: runtime error');
    same('ratio', await run(browser, FINAL, [{viewport: FINAL, scale: 2}]), reference);
    summary.push(`ratio: 1 -> 2 equals a fresh load at 2 (buffer ${reference.size.join('x')})`);
  }
} finally { await browser.close(); await server.close(); }
console.log(`validate-resize-play: PASS (${engine}; ${summary.join('; ')})`);
