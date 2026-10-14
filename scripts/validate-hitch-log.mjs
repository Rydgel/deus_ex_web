// The opt-in frame-hitch recorder (src/viewer/hitch-log.mjs, docs/hitch-log.md).
// Host checks, not an original-game comparison:
//  1. without ?hitchlog=1 nothing is installed: no deusExHitch, no
//     DEUS_EX_HITCHLOG, WebGL and WebAssembly entry points still native;
//  2. with it, a few seconds of Training (the default worker mode) give a dump
//     with the per-second table, the worker's frame record (duration, merged
//     posts, wasm size), the page's GL timings, the shader programs, a summary,
//     and rows whose width matches the column list;
//  3. Ctrl+Shift+H, and the overlay's Save button, download the same log as parseable JSON.
//
//   node scripts/validate-hitch-log.mjs [--angle gl] [--seconds 8]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const root = fileURLToPath(new URL('..', import.meta.url));
try { gameDirectory(); } catch { console.log('SKIP validate-hitch-log: no installed game data'); process.exit(0); }
const { chromium } = await import('@playwright/test');
const { createServer } = await import('vite');
const { default: base } = await import('../vite.config.mjs');
// The tree may itself sit in .work/ or .claude/worktrees/, which the config denies.
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const angle = option('angle', 'gl'), seconds = Number(option('seconds', 8));
const browser = await chromium.launch({ args: [`--use-angle=${angle}`] });
const fail = [];
try {
  async function openPage(query, map = '00_Training') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|vite/.test(message.text())) errors.push(`console: ${message.text()}`); });
    await page.goto(`${url}/?${query}`);
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 240000 });
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, { timeout: 240000 });
    await page.waitForFunction(() => window.deusExViewer.status().gameplay?.hud?.health?.head?.displayedHealth === 100, {}, { timeout: 240000 }).catch(() => {});
    await page.locator('#scene').click({ position: { x: 500, y: 300 } });
    return { page, errors, context };
  }

  // ---- 1. off: nothing installed
  for (const query of ['sim=worker', 'hitchlog=0']) {
    const { page, errors, context } = await openPage(query);
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => ({ hitch: typeof window.deusExHitch, flag: globalThis.DEUS_EX_HITCHLOG ?? null,
      draw: WebGL2RenderingContext.prototype.drawElements.toString().includes('[native code]'),
      upload: WebGL2RenderingContext.prototype.texSubImage3D.toString().includes('[native code]'),
      memory: WebAssembly.Memory.toString().includes('[native code]'), instantiate: WebAssembly.instantiate.toString().includes('[native code]'),
      overlay: [...document.querySelectorAll('div')].some(div => /hitchlog/.test(div.textContent) && div.style.position === 'fixed'),
      frames: window.deusExViewer.framePhases(false).draws }));
    assert.deepEqual({ ...state, frames: state.frames > 0 }, { hitch: 'undefined', flag: null, draw: true, upload: true, memory: true, instantiate: true, overlay: false, frames: true },
      `?${query}: the recorder is not installed`);
    assert.deepEqual(errors, [], `?${query}: page errors`);
    await context.close();
  }
  console.log('off: no recorder, WebGL and WebAssembly entry points native');

  // ---- 2. on
  const { page, errors, context } = await openPage('hitchlog=1');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up('KeyW');
  const dump = await page.evaluate(() => window.deusExHitch.dump());
  assert.equal(dump.columns.length, dump.rows[0].length, 'row width');
  assert.ok(dump.rows.every(row => row.length === dump.columns.length), 'every row has every column');
  const col = Object.fromEntries(dump.columns.map((name, i) => [name, i]));
  assert.ok(dump.summary.frames > seconds * 20, `frames recorded (${dump.summary.frames})`);
  assert.ok(dump.summary.drawn > seconds * 10, `frames drawn (${dump.summary.drawn})`);
  assert.ok(dump.seconds.length >= seconds - 1, `per-second rows (${dump.seconds.length})`);
  const playing = dump.seconds.filter(s => s.drawn > 0);
  assert.ok(playing.length >= seconds - 3, `seconds with drawn frames (${playing.length})`);
  const last = dump.seconds.at(-1);
  assert.ok(last.wasmWorkerMB >= 100 && last.wasmWorkerMems >= 1, `the worker's wasm memories are known (${last.wasmWorkerMB} MB in ${last.wasmWorkerMems})`);
  assert.ok(last.wasmPageMB >= 1, `the page's wasm memory is known (${last.wasmPageMB} MB)`);
  assert.ok(last.programs >= 3 && last.geometries > 0 && last.textures > 0, 'renderer counts');
  assert.ok(dump.programs.length >= 3 && dump.programs.every(p => typeof p.key === 'string' && p.key.length), `programs recorded (${dump.programs.length})`);
  const worker = dump.rows.filter(row => row[col['w.dur']] >= 0);
  assert.ok(worker.length > seconds * 10, `rows with a worker frame (${worker.length})`);
  assert.ok(worker.every(row => row[col['w.dur']] > 0 && row[col['w.posts']] >= 1 && row[col['w.wasmMB']] >= 100), 'worker frame records');
  assert.ok(worker.every(row => row[col['w.tick']] >= 0 && row[col['w.hud']] >= 0), 'worker step times');
  assert.ok(dump.rows.some(row => row[col['gl.draw']] > 0), 'draw calls timed');
  assert.ok(dump.rows.every(row => row[col.dt] >= 0 && row[col.animate] >= 0), 'page times');
  assert.ok(/WebGL 2/.test(dump.meta.glVersion) && dump.meta.userAgent && dump.meta.canvas.length === 2, 'meta');
  assert.ok(['p50', 'p95', 'p99', 'max'].every(k => dump.summary.drawGapMs[k] > 0), 'draw gap summary');
  const full = await page.evaluate(() => window.deusExHitch.dump({ full: true }).rows.length);
  assert.ok(full >= dump.rows.length, 'full dump keeps every frame');
  const overlay = await page.evaluate(() => [...document.querySelectorAll('div')].some(div => /hitchlog/.test(div.textContent) && div.style.position === 'fixed'));
  assert.ok(overlay, 'the overlay label shows');
  console.log(`on: ${dump.summary.frames} frames, ${dump.summary.drawn} drawn, ${dump.seconds.length} seconds, ${dump.programs.length} programs, worker wasm ${last.wasmWorkerMB} MB, ` +
    `draw gap p50 ${dump.summary.drawGapMs.p50} max ${dump.summary.drawGapMs.max} ms, ${dump.rows.length} rows kept, ${dump.events.length} events`);

  // ---- 3. Ctrl+Shift+H saves it
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.keyboard.press('Control+Shift+H')]);
  assert.match(download.suggestedFilename(), /^deusex-hitchlog-00_Training-.*\.json$/, 'file name');
  const saved = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(dump).sort(), 'saved log has the same sections');
  assert.ok(saved.seconds.length >= dump.seconds.length && saved.rows.length >= 1, 'saved log content');
  console.log(`download: ${download.suggestedFilename()}, ${saved.rows.length} rows`);
  // The overlay's button saves too, and the overlay names the saved file.
  const [clicked] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: 'Save hitch log' }).click()]);
  assert.match(clicked.suggestedFilename(), /^deusex-hitchlog-00_Training-.*\.json$/, 'button file name');
  assert.ok(await page.getByText(`saved ${clicked.suggestedFilename()}`).isVisible(), 'the overlay names the saved file');
  assert.deepEqual(errors, [], 'page errors');
  await context.close();
} catch (error) {
  fail.push(error);
} finally {
  await browser.close();
  await server.close();
}
if (fail.length) { console.error(fail[0]); process.exit(1); }
console.log('validate-hitch-log: PASS');
