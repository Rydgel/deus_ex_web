// Play through a lost WebGL context (docs/context-loss.md): the canvas's context is lost and restored with
// WEBGL_lose_context under a paused Playwright clock, as D3DDrv's Lock waits for a lost device and rebuilds it.
//
//   - loss: 10_Paris_Club's bar mirror (dancers tweening on the GPU mesh path). The context is lost with a frame in
//     flight (worker mode: its snapshot arrives while the context is lost) and restored without advancing the clock.
//     The last frame's pixels must equal a run of the same frames without a loss, byte for byte, and every mesh binding
//     must have left the GPU path (Chromium);
//   - race (worker mode): the same, but the frame in flight's snapshot is held on the page until the context is back (a
//     restore faster than a worker frame; Chromium's restore makes a new context, which is slower), so the restore applies it;
//     the last frame's pixels are again the run's without a loss;
//   - freeze: 00_Training with the shader warm-up on. While the context is lost the clock runs two seconds and nothing is
//     simulated (state digest and Level.TimeSeconds unchanged); the first tick after the restore advances
//     Level.TimeSeconds by the whole time since the last one, as the original's next tick does after D3DDrv's wait.
//   - never: 00_Training, a context the browser never gives back. Ten seconds of the page clock pass with nothing simulated and the
//     toast saying so (the original waits with no limit); a reload of the page makes a new context, and Play runs again (Stage 7
//     row 7.9.3).
//
// The pixel runs turn the shader warm-up off (?shaderWarmup=0) on both sides: the restore's warm-up waits on timers the
// paused clock would have to advance, which would add that time to the next frame. Host measurement of the page against
// itself; the original's side is the D3DDrv code in docs/context-loss.md.
//
//   node scripts/validate-context-loss-play.mjs [--browser chromium|firefox] [--sim worker|inline] [--before 30] [--after 30]
//     [--case loss|race|freeze|never]   (--sim: default the browser's own mode, Chromium's worker and Firefox's inline)
import assert from 'node:assert/strict';
import {chromium, firefox} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {debugUrl} from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-context-loss-play: no installed game data'); process.exit(0); }
const engine = option('browser', 'chromium'), simMode = option('sim', null), only = option('case', null);
if (engine !== 'chromium' && engine !== 'firefox') throw new Error('--browser must be chromium or firefox');
const worker = simMode ? simMode === 'worker' : engine === 'chromium';
const before = Number(option('before', 30)), after = Number(option('after', 30));
// The bar mirror with the player's reflection (validate-mesh-path-frames.mjs's first case).
const PARIS = {map: '10_Paris_Club', location: [78, -1008, 27], rotation: [61736, 0, 0], region: {zone: 'ZoneInfo4', iLeaf: 380, zoneNumber: 7}};

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

/** The page at `map` in Play, its frame loop held, the clock paused at START and released. */
async function open(browser, map, query, place = null) {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  const errors = [], glErrors = [];
  page.on('pageerror', error => errors.push(error.message));
  // GL errors after a restore would mean an object of the lost context was used (CONTEXT_LOST_WEBGL lines are the loss's own).
  // A delete of one is not: three.js's dispose listeners from before the loss still hold the old context's objects, and an
  // object disposed after the restore deletes them, which WebGL ignores with a warning (counted in `staleDeletes`).
  let staleDeletes = 0;
  page.on('console', message => {
    const text = message.text();
    if (/INVALID_OPERATION: delete\w*: object does not belong to this context/.test(text)) staleDeletes++;
    else if (/INVALID_|GL_OUT_OF|GL ERROR/.test(text) && !/CONTEXT_LOST/.test(text)) glErrors.push(text);
  });
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch(), text = await response.text(), from = 'antialias: true })';
    if (!text.includes(from)) throw new Error('validate-context-loss-play: the page\'s renderer construction changed');
    await route.fulfill({response, body: text.replace(from, 'antialias: true, preserveDrawingBuffer: true })')});
  });
  await page.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); } catch { /* storage unavailable */ } });
  // The race: the simulation worker's frame messages can be held on the page side (holdFramesForTest) and delivered later
  // (releaseFramesForTest), so a snapshot simulated before the loss arrives after the restore.
  await page.addInitScript(() => {
    const held = [];
    window.Worker = class extends window.Worker {
      set onmessage(handler) {
        super.onmessage = event => {
          if (window.holdFramesForTest && event.data?.type === 'frame') held.push(() => handler.call(this, event)); else handler.call(this, event);
        };
      }
      get onmessage() { return super.onmessage; }
    };
    window.releaseFramesForTest = () => { window.holdFramesForTest = false; for (const deliver of held.splice(0)) deliver(); };
  });
  await page.clock.install({time: INSTALL});
  await page.goto(debugUrl(`${url}/?hold=1&seed=1${simMode ? `&sim=${simMode}` : ''}${query}`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.evaluate(map => { const menu = document.getElementById('map'); menu.value = map; menu.dispatchEvent(new Event('change')); }, map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.mode === 'play'; },
    map, {timeout: 240000});
  if (place) await page.evaluate(async c => {
    await window.deusExViewer.viewProbe({ghost: true});
    await window.deusExViewer.viewProbe({location: c.location, rotation: c.rotation, region: c.region});
  }, place);
  // The extension is taken while the context is live (a lost context returns none).
  await page.evaluate(() => { window.loseContextForTest = document.getElementById('scene').getContext('webgl2').getExtension('WEBGL_lose_context'); });
  await page.clock.pauseAt(START);
  await page.evaluate(() => window.deusExViewer.release());
  return {page, errors, glErrors, staleDeletes: () => staleDeletes};
}
const step = async page => { await page.clock.runFor(16); await page.evaluate(() => window.deusExViewer.settled()); };
/** Polls the page in real time (the page's own timers are paused). */
async function until(page, test, what, ms = 60000) {
  for (const end = Date.now() + ms; !(await page.evaluate(test));) {
    if (Date.now() > end) throw new Error(`validate-context-loss-play: timed out waiting for ${what}`);
    await sleep(10);
  }
}
const lose = page => page.evaluate(() => window.loseContextForTest.loseContext());
const restore = page => page.evaluate(() => window.loseContextForTest.restoreContext());
const lost = () => window.deusExViewer.status().graphics.lost;
async function frame(page) {
  return page.evaluate(async () => {
    const canvas = document.getElementById('scene'), gl = canvas.getContext('webgl2');
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight, pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))].map(b => b.toString(16).padStart(2, '0')).join('');
    let drawn = 0; for (let i = 3; i < pixels.length; i += 4) drawn += pixels[i] !== 0;
    const rows = (await window.deusExViewer.lodProbe({all: true})) ?? [], status = window.deusExViewer.status();
    return {hex, drawn, preserved: gl.getContextAttributes().preserveDrawingBuffer, paths: [...new Set(rows.map(row => row.path))].sort(),
      bindings: rows.length, error: status.runtimeError?.message ?? null, graphics: status.graphics};
  });
}
/** One Paris run: `event` (null, 'loss' or 'race') after `before` frames, then `after` frames; the last frame. */
async function paris(browser, event) {
  const {page, errors, glErrors, staleDeletes} = await open(browser, PARIS.map, '&shaderWarmup=0', PARIS);
  try {
    for (let n = 0; n < before; n++) await step(page);
    let frames = after;
    if (event && worker) {
      // A frame in flight: the context is lost in the frame callback after the page's own, in the task where animate has
      // just posted the frame, so its snapshot comes in after the loss. In the race, the restore is asked for as soon as the
      // loss has been dispatched (a restore is allowed once its event's default was prevented, after the dispatch: a
      // MessageChannel task, which the paused clock does not hold), and the snapshot is held until the context is back.
      await page.evaluate(race => {
        if (race) {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => window.loseContextForTest.restoreContext();
          document.getElementById('scene').addEventListener('webglcontextlost', () => channel.port2.postMessage(null), {once: true});
          window.holdFramesForTest = true;
        }
        requestAnimationFrame(() => window.loseContextForTest.loseContext());
      }, event === 'race');
      await page.clock.runFor(16); frames--;
      if (event === 'race') {
        await until(page, () => !document.getElementById('scene').getContext('webgl2').isContextLost(), 'the context back');
        await page.evaluate(() => window.releaseFramesForTest());
      } else { await until(page, lost, 'the loss'); await page.evaluate(() => window.deusExViewer.settled()); }
    } else if (event) { await lose(page); await until(page, lost, 'the loss'); }
    if (event) {
      if (event !== 'race') await restore(page);
      await until(page, () => { const g = window.deusExViewer.status().graphics; return !g.lost && g.restores === 1; }, 'the restore');
    }
    for (let n = 0; n < frames; n++) await step(page);
    return {...await frame(page), errors, glErrors, staleDeletes: staleDeletes()};
  } finally { await page.close(); }
}
/** The freeze on 00_Training: nothing simulated while lost, the whole wait in the next tick. */
async function freeze(browser) {
  const {page, errors, glErrors, staleDeletes} = await open(browser, '00_Training', '');
  try {
    for (let n = 0; n < 10; n++) await step(page);
    const probe = () => page.evaluate(async () => ({view: await window.deusExViewer.viewProbe({}), digest: await window.deusExViewer.stateDigest()}));
    const start = await probe();
    await lose(page); await until(page, lost, 'the loss');
    let elapsed = 0;
    for (; elapsed < 2000; elapsed += 16) await step(page);
    const frozen = await probe();
    assert.equal(frozen.view.timeSeconds, start.view.timeSeconds, 'freeze: Level.TimeSeconds does not advance while the context is lost');
    assert.deepEqual(frozen.digest, start.digest, 'freeze: no frame is simulated while the context is lost');
    await restore(page);
    // The restore's shader warm-up polls on the page's (paused) timers: the clock runs until it is done, and that time is part of the wait.
    for (let tries = 0; await page.evaluate(lost); tries++, elapsed += 16) {
      if (tries > 2000) throw new Error('validate-context-loss-play: the restore did not finish');
      await page.clock.runFor(16); await sleep(5);
    }
    await step(page); elapsed += 16;
    const next = await probe(), advanced = (next.view.timeSeconds - start.view.timeSeconds) / start.view.timeDilation;
    assert.ok(Math.abs(advanced * 1000 - elapsed) <= 16.5,
      `freeze: the first tick after the restore advances Level.TimeSeconds by the whole wait (${(advanced * 1000).toFixed(1)} ms for ${elapsed} ms)`);
    for (let n = 0; n < 10; n++) await step(page);
    const last = await frame(page);
    assert.deepEqual(errors, [], 'freeze: page errors'); assert.equal(last.error, null, 'freeze: runtime error');
    assert.deepEqual(glErrors, [], 'freeze: GL errors');
    assert.ok(last.drawn > 0, 'freeze: frames are drawn after the restore');
    return `freeze: ${elapsed} ms lost and restoring, the next tick advanced ${(advanced * 1000).toFixed(1)} ms; restore ${JSON.stringify(last.graphics.lastRestore)}, ${staleDeletes()} stale deletes`;
  } finally { await page.close(); }
}
/** A context that never comes back on 00_Training: the game waits, saying so, and a reload recovers. */
async function never(browser) {
  const {page, errors, glErrors} = await open(browser, '00_Training', '');
  try {
    for (let n = 0; n < 10; n++) await step(page);
    const digest = () => page.evaluate(() => window.deusExViewer.stateDigest());
    const start = await digest();
    await lose(page); await until(page, lost, 'the loss');
    for (let elapsed = 0; elapsed < 10000; elapsed += 100) await page.clock.runFor(100);
    await page.evaluate(() => window.deusExViewer.settled());
    assert.deepEqual(await digest(), start, 'never: nothing is simulated while the context stays lost');
    const waiting = await page.evaluate(() => ({graphics: window.deusExViewer.status().graphics, toast: document.getElementById('toast').textContent}));
    assert.equal(waiting.graphics.lost, true, 'never: the page still waits for the device');
    assert.equal(waiting.graphics.restores, 0, 'never: no restore');
    assert.equal(waiting.toast, 'The browser lost the graphics device: the game waits for it. Reload the page if it does not come back.', 'never: the toast says so');
    // the reload: a new document, a new context (the clock runs again: the page's load waits on its timers)
    await page.clock.resume();
    await page.reload();
    await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training' && s.mode === 'play'; }, {}, {timeout: 240000});
    await page.evaluate(() => window.deusExViewer.release());
    const frame = await page.evaluate(() => window.deusExViewer.status().frame), released = await digest();
    await page.waitForFunction(frame => window.deusExViewer.status().frame > frame + 30, frame, {timeout: 60000});
    const back = await page.evaluate(async () => ({status: window.deusExViewer.status(), toast: document.getElementById('toast').textContent,
      lost: document.getElementById('scene').getContext('webgl2').isContextLost()}));
    assert.equal(back.lost, false, 'never: the reloaded page has a live context');
    assert.equal(back.status.graphics.lost, false, 'never: the reloaded page draws');
    assert.equal(back.status.runtimeError, null, 'never: runtime error after the reload');
    assert.notDeepEqual(await digest(), released, 'never: the reloaded game simulates');
    assert.doesNotMatch(back.toast, /lost the graphics device/, 'never: the toast went with the reload');
    assert.deepEqual(errors, [], 'never: page errors'); assert.deepEqual(glErrors, [], 'never: GL errors');
    return 'never: 10 s lost with the toast and nothing simulated; the reload draws and simulates';
  } finally { await page.close(); }
}

const browser = engine === 'firefox' ? await firefox.launch()
  : await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const summary = [];
try {
  if (!only || only === 'loss' || only === 'race') {
    const reference = await paris(browser, null);
    assert.equal(reference.preserved, true, 'the renderer patch keeps the drawing buffer');
    assert.ok(reference.drawn > 0, 'the reference run drew its last frame');
    assert.equal(reference.error, null, 'reference: runtime error');
    const gpu = reference.paths.includes('gpu');
    for (const event of worker ? ['loss', 'race'] : ['loss']) {
      if (only && only !== event) continue;
      const run = await paris(browser, event);
      assert.deepEqual(run.errors, [], `${event}: page errors`); assert.equal(run.error, null, `${event}: runtime error`);
      assert.deepEqual(run.glErrors, [], `${event}: GL errors`);
      assert.equal(run.graphics.losses, 1, `${event}: one loss`); assert.equal(run.graphics.restores, 1, `${event}: one restore`);
      // Which path the frame in flight took (docs/context-loss.md "The frame in flight").
      if (worker && event === 'loss') assert.ok(run.graphics.lastRestore.drawnLost >= 1, 'loss: the snapshot in flight was applied while the context was lost');
      if (event === 'race') assert.ok(run.graphics.lastRestore.inFlight >= 1, 'race: the snapshot in flight was applied by the restore');
      if (gpu) {
        assert.deepEqual(run.paths, ['cpu'], `${event}: every mesh binding left the GPU path`);
        assert.ok(run.graphics.converted > 0, `${event}: the restore converted the GPU path's bindings`);
      }
      let note = '';
      if (run.hex !== reference.hex) {
        // Does the scenario reproduce its own pixels at all (asynchronous texture decoding)?
        const again = await paris(browser, null);
        note = again.hex === reference.hex ? '' : ' (the run without a loss does not reproduce its own pixels either)';
      }
      assert.equal(run.hex, reference.hex, `${event}: the last frame equals the run without a loss${note}`);
      const {converted, drawnLost, inFlight} = run.graphics.lastRestore;
      summary.push(`${event}: identical after ${after} frames (${converted} bindings to the CPU path, ${drawnLost} snapshots applied while lost, ${inFlight} by the restore, ${run.staleDeletes} stale deletes)`);
    }
    summary.unshift(`paths ${reference.paths.join('/')}, ${reference.bindings} bindings`);
  }
  if (!only || only === 'freeze') summary.push(await freeze(browser));
  if (!only || only === 'never') summary.push(await never(browser));
} finally { await browser.close(); await server.close(); }
console.log(`validate-context-loss-play: PASS (${engine} ${worker ? 'worker' : 'inline'}; ${summary.join('; ')})`);
