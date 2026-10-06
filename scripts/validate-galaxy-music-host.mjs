// Galaxy's music host (docs/galaxy-music.md "Phase 5: Output"): the library
// in an AudioWorklet, fed by the simulation's library service over its own
// MessageChannel. Host checks, not an original-game comparison: the
// translated entries the worklet calls are verified by the loader and
// sequencer validators; this checks that the host reaches them unchanged.
//
// Node:
//  1. the batch encoding round-trips through structured clone (the
//     postMessage path) into the worklet's decoder, op codes agree, module
//     bytes cross once (transferred);
//  2. the library proxy: lock/unlock nesting makes one batch, a call outside
//     a lock is its own batch, an empty critical section sends nothing; the
//     order mirror before a report and the reported order after;
//  3. the worklet processor itself (no browser): Intro_Music section 0
//     driven through the proxy, 128-frame quanta pulled, the order advances
//     and the reports bring the proxy's order() to the library's;
//  4. the host path (host.rs per-op exports and galaxy_render) against the
//     sequencer oracle's path (galaxy_seq_load/start/callbacks, verified
//     against Galaxy.dll): the same sequencer trace (U/T/K/P records) for
//     Intro_Music section 0 over 2000 callbacks.
// Browser (headless Chromium, this tree's own Vite server), ?sim=worker and
// ?sim=inline: after a gesture the worklet opens the library; the map's own
// Galaxy Update (phase 4, galaxy-music.mjs) has loaded and started its
// LevelInfo.Song (Training_Music) in its first batch, the order advances to
// 1, the reports reach the simulation side (acknowledged == issued, its
// order() equals the library's), no fault or underrun, no console errors;
// then a map reload keeps the library (no reconnect): the old runtime's
// dispose() unregisters the song and the new runtime's first Update loads it
// again.
// Last, the page's main-thread frame time with music playing against
// ?music=0, interleaved pairs (framePhases total per animate()).
// Firefox is not automated here (no Playwright Firefox build installed).
//
//   node scripts/validate-galaxy-music-host.mjs [--node-only] [--pairs 2] [--frames 300] [--angle gl]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { MUSIC_OP, MUSIC_SLACK, encodeMusicBatch, createMusicLibraryProxy, driveMusicLibrary }
  from '../src/runtime/galaxy-music-library.mjs';
import { readMusicExport } from '../src/unreal/music-module.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const root = fileURLToPath(new URL('..', import.meta.url));
let game;
try { game = gameDirectory(); } catch { console.log('SKIP validate-galaxy-music-host: no installed game data'); process.exit(0); }
const wasm = await readFile(new URL('../src/runtime/galaxy-kernel.wasm', import.meta.url));
const assets = new AssetStore(['Music/Intro_Music.umx', 'Music/Training_Music.umx'].map(path => ({ path, read: () => readFile(`${game}/${path}`) })));
const moduleOf = async name => {
  const asset = await assets.get(name);
  return readMusicExport(asset, asset.pkg.exports.findIndex(entry => entry.className === 'Music') + 1).bytes;
};
const kernel = async () => (await WebAssembly.instantiate(wasm, {})).instance.exports;

// The worklet module, imported as Node sees it: AudioWorkletProcessor gives
// each processor its page port; registerProcessor stays absent.
globalThis.sampleRate = 44100;
globalThis.AudioWorkletProcessor = class { constructor() { const channel = new MessageChannel(); this.port = channel.port1; this.pagePort = channel.port2; } };
const worklet = await import('../src/viewer/galaxy-music-worklet.mjs');
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

// ---- 1. encoding -----------------------------------------------------------
{
  assert.deepEqual({ ...worklet.OPS }, { ...MUSIC_OP }, 'worklet and library op codes differ');
  const a = new Uint8Array(4096).map((_, i) => i * 7), b = new Uint8Array(3000).map((_, i) => 255 - i);
  const view = new Uint8Array(new ArrayBuffer(5000), 100, 2000).fill(9);
  const ops = [['setSampleVolume', 127, 0], ['setMusicVolume', 76, -3], ['loadMusic', a], ['unloadMusic'], ['stopMusic'],
    ['startMusic'], ['controlMusic', 2, -1], ['clearVoiceActive', 16, 32], ['setBreakFlag'], ['loadMusic', view], ['loadMusic', b]];
  const expected = ops.map(([name, x, y]) => [MUSIC_OP[name], x instanceof Uint8Array ? [...x] : x ?? 0, x instanceof Uint8Array ? null : y ?? 0]);
  const { message, transfer } = encodeMusicBatch(7, ops, { owned: true });
  const received = structuredClone(message, { transfer });
  assert.equal(a.byteLength, 0, 'an owned whole-buffer module is transferred, not copied');
  assert.equal(view.byteLength, 2000, 'a module view is copied before the transfer');
  assert.equal(received.id, 7);
  const decoded = [];
  worklet.forEachMusicOp(received, (code, x, y, module) => decoded.push([code, module ? [...module] : x, module ? null : y]));
  assert.deepEqual(decoded, expected, 'decoded ops differ from the encoded ones');
  console.log(`PASS encoding: ${ops.length} ops (3 modules, ${received.modules.reduce((n, m) => n + m.byteLength, 0)} bytes) round-trip`);
}

// ---- 2. proxy batching and the order mirror ----------------------------------
{
  const sent = [], library = createMusicLibraryProxy(message => sent.push(message));
  library.lock(); library.unlock();
  assert.equal(sent.length, 0, 'an empty critical section sends a batch');
  library.setMusicVolume(10, 0);
  assert.equal(sent.length, 1, 'a call outside lock() is not its own batch');
  assert.equal(library.order(), 0xff, 'glxInit leaves the order at 0xff');
  library.lock(); library.lock(); library.loadMusic(new Uint8Array(MUSIC_SLACK + 16)); library.unlock();
  library.controlMusic(2, 3);
  assert.equal(library.order(), 2, 'controlMusic(2, 3) inside the open section mirrors 3 - 1');
  library.unlock();
  assert.equal(sent.length, 2, 'nested locks make one batch');
  assert.equal(library.order(), 2, 'the mirror covers an unacknowledged batch');
  library.report({ type: 'report', batch: 1, state: 0xff });
  assert.equal(library.order(), 2, 'a report older than the last batch keeps the mirror');
  library.report({ type: 'report', batch: 2, state: 0x01170105 });
  assert.equal(library.order(), 5, 'a report covering every batch gives the library order');
  library.controlMusic(1, -2);
  assert.equal(library.order(), 4, 'relative positions mirror value + order + 2 - 1');
  library.report({ type: 'report', batch: 3, state: 0x01170104 });
  library.controlMusic(2, 0x30);
  assert.equal(library.order(), 4, 'a position past the reported song length leaves the order (0x11)');
  console.log('PASS proxy: batches per critical section, order mirror and reports');
}

// ---- 3. the worklet processor under Node ------------------------------------
async function drivenProcessor(callbacks) {
  const processor = new worklet.GalaxyMusicProcessor();
  processor.page({ type: 'init', wasm: wasm.slice().buffer });
  const channel = new MessageChannel(), library = createMusicLibraryProxy((message, transfer) => channel.port2.postMessage(message, transfer));
  channel.port2.onmessage = ({ data }) => library.report(data);
  processor.page({ type: 'connect', port: channel.port1, effectsChannels: 16, pc: 64, ahead: 176400 - 882 * 4 });
  while (!processor.open) await turn();
  await driveMusicLibrary(library, assets, { song: 'Intro_Music', section: 0 });
  assert.equal(library.order(), 0xff, 'the start batch mirrors order 0xff before any report');
  while (processor.stats.batches < 1) await turn();
  const left = new Float32Array(128), right = new Float32Array(128), orders = [];
  const quanta = Math.ceil(callbacks * 882 / 128);
  for (let i = 0; i < quanta; i++) {
    processor.process([], [[left, right]]);
    const order = processor.kernel.state() & 0xff;
    if (orders.at(-1)?.[1] !== order) orders.push([processor.stats.callbacks, order]);
    if (i % 64 === 0) await turn();
  }
  await turn(); await turn();
  channel.port1.close(); channel.port2.close(); processor.port.close(); processor.pagePort.close();
  return { processor, library, orders };
}
{
  const { processor, library, orders } = await drivenProcessor(700);
  const s = processor.stats;
  assert.equal(s.error, null, s.error);
  assert.equal(s.fault, 0, `fault 0x${s.fault.toString(16)}`);
  assert.equal(s.underruns, 0, 'underruns while the library is open');
  assert.equal(s.loads, 1);
  assert.equal(processor.kernel.results.load, 0, 'glxLoadMusic status');
  assert.ok(s.callbacks >= 700, `${s.callbacks} callbacks`);
  // The kernel smoke run: order 0 at the first callback, 1 at the 314th, 2 at the 628th.
  assert.deepEqual(orders, [[1, 0], [314, 1], [628, 2]], 'order changes');
  const status = library.status();
  assert.equal(status.acknowledged, status.issued, 'every batch acknowledged');
  assert.equal(library.order(), processor.kernel.state() & 0xff, "the proxy's order() is the library's");
  console.log(`PASS worklet (Node): ${s.callbacks} callbacks of 882 frames from ${s.quanta} quanta, order changes ${JSON.stringify(orders)}, ` +
    `${status.reports} reports, order() ${library.order()}`);
}

// ---- 4. host path against the oracle-verified sequencer path -----------------
{
  const CALLBACKS = 2000, CHUNK = 50, SKIP = new Set(['M', 'R', 'L', 'S']);
  const intro = await moduleOf('Intro_Music');
  async function traced(path, { mutant = null } = {}) {
    const x = await kernel(), hash = createHash('sha256');
    let records = 0;
    const drain = (end = false) => {
      if (end) x.galaxy_seq_end();
      const groups = new Uint32Array(x.memory.buffer, x.galaxy_trace_groups_ptr(), x.galaxy_trace_groups_len());
      const stop = groups.length ? groups[groups.length - 1] : 0;
      const bytes = new Uint8Array(x.memory.buffer, x.galaxy_trace_ptr(), x.galaxy_trace_len()), view = new DataView(bytes.buffer, bytes.byteOffset);
      for (let at = 0; at < stop;) {
        const tag = String.fromCharCode(bytes[at]), size = view.getUint32(at + 1, true);
        if (!SKIP.has(tag)) { hash.update(bytes.subarray(at, at + 5 + size)); records++; }
        at += 5 + size;
      }
      x.galaxy_trace_consume();
    };
    const input = () => { const ptr = x.galaxy_input(intro.length); new Uint8Array(x.memory.buffer, ptr, intro.length).set(intro); };
    if (path === 'oracle') {
      x.galaxy_reset(16); x.galaxy_seq_setup(64); x.galaxy_seq_ahead(176400 - 882 * 4); x.galaxy_seq_trace(1);
      input(); assert.equal(x.galaxy_seq_load(intro.length, 127, 76), 0); x.galaxy_seq_start(16, 0);
      for (let done = 0; done < CALLBACKS; done += CHUNK) { assert.equal(x.galaxy_seq_callbacks(CHUNK), 0); drain(); }
    } else {
      x.galaxy_host_open(16, 64, 176400 - 882 * 4); x.galaxy_seq_trace(1);
      const kernelOps = worklet.createMusicKernel(x), bytes = new Uint8Array(intro.length + MUSIC_SLACK);
      bytes.set(intro);
      for (const [code, a, b, module] of [[1, 127, 0], [2, 76, 0], [3, 0, 0, bytes], [1, 127, 0], [2, 76, 0], [5, 0, 0], [8, 16, 32], [6, 0, 0], [7, 2, 0], [9, 0, 0]])
        if (code !== mutant) kernelOps.apply(code, a, b, module ?? null);
      assert.equal(kernelOps.results.load, 0);
      for (let done = 0; done < CALLBACKS; done += CHUNK) {
        for (let i = 0; i < CHUNK; i++) assert.notEqual(x.galaxy_render(882), 0, `fault 0x${x.galaxy_fault().toString(16)}`);
        drain();
      }
    }
    drain(true);
    return { digest: hash.digest('hex').slice(0, 16), records, order: x.galaxy_music_order() };
  }
  const oracle = await traced('oracle'), host = await traced('host');
  assert.deepEqual(host, oracle, 'the host path diverges from the sequencer oracle path');
  // Mutant: Update's break flag store left out of the host batch.
  const mutant = await traced('host', { mutant: MUSIC_OP.setBreakFlag });
  assert.notEqual(mutant.digest, oracle.digest, 'the comparison misses a dropped setBreakFlag');
  console.log(`PASS host path = sequencer path: Intro_Music section 0, ${CALLBACKS} callbacks, ${host.records} U/T/K/P/E records, digest ${host.digest}, order ${host.order}; ` +
    `a dropped setBreakFlag is caught (order ${mutant.order})`);
}

if (process.argv.includes('--node-only')) process.exit(0);

// ---- browser ----------------------------------------------------------------
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
const angle = option('angle', 'gl'), frames = Number(option('frames', 300)), pairs = Number(option('pairs', 2));
const browser = await chromium.launch({ args: [`--use-angle=${angle}`, '--autoplay-policy=no-user-gesture-required'] });

async function openPage(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.goto(`${url}/?${query}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready && window.deusExViewer.status().gameplay, {}, { timeout: 240000 });
  return { page, errors };
}
const musicStatus = page => page.evaluate(() => window.deusExViewer.musicStatus());
async function waitMusic(page, predicate, what, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    const status = await musicStatus(page);
    if (predicate(status)) return status;
    if (Date.now() - start > timeout) throw new Error(`${what}: ${JSON.stringify(status)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
const worklet_ = status => status.output?.worklet;
const libraryOrder = status => (status.output?.worklet?.state ?? 0) & 0xff;

try {
  for (const sim of ['worker', 'inline']) {
    const { page, errors } = await openPage(`sim=${sim}`);
    try {
      // A gesture on the toolbar (not the game view): the context is created
      // and the worklet opens the library.
      await page.click('#state');
      let status = await waitMusic(page, s => worklet_(s)?.open, 'the worklet did not open the library');
      assert.equal(status.context, 'running');
      // Update's first-music batch, issued by the map's first painted frame.
      const started = Date.now();
      status = await waitMusic(page, s => worklet_(s)?.loads === 1 && libraryOrder(s) === 1, 'the order did not reach 1', 60000);
      const driven = { bytes: status.library.moduleBytes };
      const seconds = (Date.now() - started) / 1000;
      // The simulation side has the report for every batch it issued.
      status = await waitMusic(page, s => s.library && s.library.acknowledged === s.library.issued && s.library.order === libraryOrder(s),
        'the reports did not reach the simulation side', 5000);
      const w = worklet_(status);
      assert.equal(w.error, null, w.error); assert.equal(w.fault, 0); assert.equal(w.underruns, 0, 'underruns');
      assert.equal(w.results.load, 0, 'glxLoadMusic status'); assert.equal(w.connects, 1);
      assert.ok(w.callbacks >= 313, `${w.callbacks} callbacks`);
      // A map reload (the same map): the library outlives it; a second
      // start (unregister, then Training_Music) still flows.
      await page.evaluate(() => { const menu = document.getElementById('map'); menu.dispatchEvent(new Event('change')); });
      await page.waitForFunction(revision => { const s = window.deusExViewer.status(); return s.ready && s.revision > revision; },
        await page.evaluate(() => window.deusExViewer.status().revision), { timeout: 240000 });
      const after = await waitMusic(page, s => worklet_(s)?.loads === 2 && s.library?.acknowledged === s.library?.issued
        && (worklet_(s)?.state & 0x100), 'the reloaded map did not unregister and load its song again', 60000);
      const w2 = worklet_(after);
      assert.equal(w2.connects, 1, 'the map reload reconnected the library');
      assert.equal(w2.results.load, 0); assert.equal(w2.results.unload, 0); assert.equal(w2.fault, 0); assert.equal(w2.underruns, 0);
      assert.deepEqual(errors, [], 'console errors');
      console.log(`PASS browser ?sim=${sim}: ${driven.bytes} module bytes; order 1 after ${seconds.toFixed(1)} s; ` +
        `${w.callbacks} callbacks, ${w.batches} batches, ${w.reports} reports, ${w.underruns} underruns; ` +
        `simulation issued ${status.library.issued}, acknowledged ${status.library.acknowledged}, order() ${status.library.order}; ` +
        `after the map reload: ${w2.loads} loads, ${w2.batches} batches, order ${libraryOrder(after)}`);
    } finally { await page.close(); }
  }

  // Main-thread frame time, music playing against ?music=0, worker mode.
  async function frameTime(music) {
    const { page, errors } = await openPage(music ? 'sim=worker' : 'sim=worker&music=0');
    try {
      await page.click('#state');
      if (music) {
        await waitMusic(page, s => worklet_(s)?.open, 'the worklet did not open the library');
        await waitMusic(page, s => worklet_(s)?.loads === 1 && (worklet_(s)?.state & 0x100), 'the map\'s song did not start', 60000);
      }
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.deusExViewer.framePhases(true));
      const intervals = await page.evaluate(async frames => {
        const samples = []; let last = performance.now();
        for (let i = 0; i < frames; i++) { const now = await new Promise(requestAnimationFrame); samples.push(now - last); last = now; }
        return samples;
      }, frames);
      const phases = await page.evaluate(() => window.deusExViewer.framePhases(true));
      const sorted = intervals.toSorted((a, b) => a - b);
      const status = music ? await musicStatus(page) : null;
      assert.deepEqual(errors, [], 'console errors');
      return { music, mainMs: phases.total / phases.frames, frames: phases.frames, draws: phases.draws,
        intervalMedian: sorted[sorted.length >> 1], underruns: status ? worklet_(status).underruns : null };
    } finally { await page.close(); }
  }
  const runs = [];
  for (let i = 0; i < pairs; i++) { runs.push(await frameTime(true)); runs.push(await frameTime(false)); }
  const median = values => { const s = values.toSorted((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  for (const run of runs) console.log(`  ${run.music ? 'music on ' : '?music=0 '} main thread ${run.mainMs.toFixed(3)} ms/frame over ${run.frames} frames (${run.draws} draws), ` +
    `rAF median ${run.intervalMedian.toFixed(2)} ms${run.music ? `, underruns ${run.underruns}` : ''}`);
  const on = median(runs.filter(run => run.music).map(run => run.mainMs)), off = median(runs.filter(run => !run.music).map(run => run.mainMs));
  assert.ok(runs.filter(run => run.music).every(run => run.underruns === 0), 'underruns while measuring');
  console.log(`PASS frame time (host measurement): main thread median ${on.toFixed(3)} ms/frame with music, ${off.toFixed(3)} ms with ?music=0 ` +
    `(${(on - off >= 0 ? '+' : '') + (on - off).toFixed(3)} ms)`);
} finally {
  await browser.close();
  await server.close();
}
