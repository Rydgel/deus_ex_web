// Galaxy's effect voices in the browser (docs/galaxy-audio.md "Effects
// through Galaxy's mixer"): headless Chromium, this tree's own Vite server,
// the default ?sim=worker. Host checks, not an original-game comparison (the
// translated entries are verified by validate-galaxy-effects.mjs).
//
// 01_NYC_UNATCOIsland, after a gesture:
//  - Galaxy's voices: the worklet opened the library; every sound the
//    simulation registered reached it once with the registry's handle; voice
//    ops arrive (Update's starts and controls, nothing through the page);
//    the reports reach the simulation side (live, acknowledged == issued)
//    and some effect voices are Active (the ambient scan's); no fault, no
//    underrun, no console error; the page started no Web Audio voice;
//  - ?sfx=webaudio: the previous host mapping: Web Audio voices start on the
//    page and the worklet loads no sample (music only);
// then the page's main-thread frame time and the worker's frame time with
// Galaxy's voices against ?sfx=webaudio, interleaved pairs.
//
//   node scripts/validate-galaxy-effects-browser.mjs [--map 01_NYC_UNATCOIsland] [--pairs 2] [--frames 300] [--angle gl]
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const root = fileURLToPath(new URL('..', import.meta.url));
try { gameDirectory(); } catch { console.log('SKIP validate-galaxy-effects-browser: no installed game data'); process.exit(0); }
const map = option('map', '01_NYC_UNATCOIsland'), frames = Number(option('frames', 300)), pairs = Number(option('pairs', 2));
const { chromium } = await import('@playwright/test');
const { createServer } = await import('vite');
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: [`--use-angle=${option('angle', 'gl')}`, '--autoplay-policy=no-user-gesture-required'] });

async function openMap(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.goto(`${url}/?${query}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 240000 });
  await page.evaluate(name => { const menu = document.getElementById('map'); menu.value = name; menu.dispatchEvent(new Event('change')); }, map);
  await page.waitForFunction(name => { const s = window.deusExViewer.status(); return s.ready && s.map === name && s.gameplay; },
    map, { timeout: 400000 });
  return { page, errors };
}
const musicStatus = page => page.evaluate(() => window.deusExViewer.musicStatus());
async function waitFor(page, predicate, what, timeout = 60000) {
  const start = Date.now();
  for (;;) {
    const status = await musicStatus(page);
    if (predicate(status)) return status;
    if (Date.now() - start > timeout) throw new Error(`${what}: ${JSON.stringify(status)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
const worklet = s => s.output?.worklet;

try {
  // Galaxy's voices (the default).
  {
    const { page, errors } = await openMap('sim=worker');
    try {
      await page.click('#state');
      await waitFor(page, s => worklet(s)?.open, 'the worklet did not open the library');
      const status = await waitFor(page, s => worklet(s)?.results?.sampleLoads > 0 && s.library?.live && s.library.acknowledged === s.library.issued
        && s.library.active !== 0, 'no effect voice became active', 90000);
      await page.waitForTimeout(4000);
      const after = await waitFor(page, s => s.library.acknowledged === s.library.issued, 'reports lag', 10000);
      const w = worklet(after), lib = after.library, page_ = await page.evaluate(() => window.deusExViewer.status().galaxy);
      assert.equal(w.error, null, w.error); assert.equal(w.fault, 0, `fault 0x${w.fault.toString(16)}`);
      assert.equal(w.underruns, 0, 'underruns');
      assert.equal(w.results.sampleMismatches, 0, 'sample handle mismatches');
      assert.equal(w.results.sampleLoads, lib.samples, 'every registered sample reached the worklet once');
      assert.ok(w.results.voiceOps > 0 && lib.voiceOps >= w.results.voiceOps, 'voice ops');
      assert.equal(page_.starts, 0, 'the page started Web Audio voices');
      assert.deepEqual(errors, [], 'console errors');
      console.log(`PASS Galaxy voices ?sim=worker ${map}: ${lib.samples} samples (${lib.sampleBytes} bytes), ${w.results.voiceOps} voice ops in ` +
        `${w.batches} batches, ${w.callbacks} callbacks, ${w.reports} reports; active ${lib.active.toString(2)}; 0 underruns, 0 faults; ` +
        `first active ${status.library.active.toString(2)}`);
    } finally { await page.close(); }
  }
  // The previous host mapping.
  {
    const { page, errors } = await openMap('sim=worker&sfx=webaudio');
    try {
      await page.click('#state');
      await waitFor(page, s => worklet(s)?.open, 'the worklet did not open the library');
      await page.waitForFunction(() => window.deusExViewer.status().galaxy.starts > 0, {}, { timeout: 90000 });
      const s = await musicStatus(page), w = worklet(s), page_ = await page.evaluate(() => window.deusExViewer.status().galaxy);
      assert.equal(w.results.sampleLoads, 0, 'the worklet loaded samples with ?sfx=webaudio');
      assert.equal(w.fault, 0);
      assert.deepEqual(errors, [], 'console errors');
      console.log(`PASS ?sfx=webaudio: ${page_.starts} Web Audio voices started on the page, ${page_.controls} controls; the worklet loaded no sample`);
    } finally { await page.close(); }
  }

  // Frame time, interleaved: main thread (framePhases) and the worker's frame.
  async function frameTime(sfx) {
    const { page, errors } = await openMap(sfx ? 'sim=worker&sfx=webaudio' : 'sim=worker');
    try {
      await page.click('#state');
      await waitFor(page, s => worklet(s)?.open, 'the worklet did not open the library');
      if (!sfx) await waitFor(page, s => s.library?.live && s.library.active !== 0, 'no effect voice became active', 90000);
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.deusExViewer.framePhases(true));
      const intervals = await page.evaluate(async count => {
        const samples = []; let last = performance.now();
        for (let i = 0; i < count; i++) { const now = await new Promise(requestAnimationFrame); samples.push(now - last); last = now; }
        return samples;
      }, frames);
      const phases = await page.evaluate(() => window.deusExViewer.framePhases(true));
      const sorted = intervals.toSorted((a, b) => a - b);
      const s = await musicStatus(page);
      assert.deepEqual(errors, [], 'console errors');
      return { sfx, mainMs: phases.total / phases.frames, frames: phases.frames, worker: phases.worker ?? null,
        intervalMedian: sorted[sorted.length >> 1], underruns: worklet(s).underruns };
    } finally { await page.close(); }
  }
  const runs = [];
  for (let i = 0; i < pairs; i++) { runs.push(await frameTime(false)); runs.push(await frameTime(true)); }
  const median = values => { const s = values.toSorted((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  for (const run of runs) console.log(`  ${run.sfx ? '?sfx=webaudio' : 'Galaxy voices'} main thread ${run.mainMs.toFixed(3)} ms/frame over ${run.frames} frames, ` +
    `rAF median ${run.intervalMedian.toFixed(2)} ms, underruns ${run.underruns}${run.worker ? `, worker ${JSON.stringify(run.worker)}` : ''}`);
  const on = median(runs.filter(run => !run.sfx).map(run => run.mainMs)), off = median(runs.filter(run => run.sfx).map(run => run.mainMs));
  assert.ok(runs.every(run => run.underruns === 0), 'underruns while measuring');
  console.log(`PASS frame time (host measurement): main thread median ${on.toFixed(3)} ms/frame with Galaxy voices, ${off.toFixed(3)} ms with ?sfx=webaudio ` +
    `(${(on - off >= 0 ? '+' : '') + (on - off).toFixed(3)} ms)`);
} finally {
  await browser.close();
  await server.close();
}
