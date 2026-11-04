// Play's sound start latency against the original's (Stage 7 row 7.5.2, decision D6; docs/audio-latency.md).
//
// Play: 00_Training (by default) in Chromium (worker mode) or Firefox (inline mode), the player walking forward and back and
// jumping for --seconds (footsteps and landings: PlaySound's glxStartSample on effect voices, as the original's capture does).
// Then main.mjs audioLatency(): the simulation side's post time of each batch holding an effect start, and the worklet's
// record of the same batch (galaxy-music-worklet.mjs "Start timing"): its arrival, the frame consumed then, the frame where the
// next callback's render begins (the voice's first frame), the time that frame was rendered and the time it is taken at the
// context's rate from the start of its burst. Per start:
//   take     = taken − post: from the start to the moment the host's audio path takes the voice's first frame out of
//              Galaxy's buffer, frames counted at the device's rate from the start of the block the audio thread renders
//              at once (a device callback's render calls), the figure D6 bounds;
//   wall     = rendered − post (the render call itself: the whole block is rendered when the device asks for it);
//   hop      = arrival − post (the simulation's thread to the audio thread; the original has none: glxStartSample writes
//              the voice the mixer reads);
//   distance = (first frame − frame at arrival) / 44,100 (how far ahead of the host's read position the voice begins);
//   latency  = hop + distance.
// The original's (scripts/audio-latency-original.mjs): the same take time, from a start to the poll where Wine's play cursor
// passes the voice's first byte (Wine's dsound mixes in periods, and the byte begins its period: Galaxy's heads move by the
// cursor's own steps), with the start placed uniformly in time over the trace's callbacks. PASS when Play's take median and
// p95 are each at most the original's plus one render quantum (128 frames, 2.9 ms). What follows the take (the browser's or Wine's buffering to the
// device: AudioContext.outputLatency, Wine's own) is each host's and is reported, not bounded.
//
//   node scripts/audio-latency.mjs [--browser chromium|firefox] [--map 00_Training] [--seconds 60] [--headed] [--url URL]
//     [--trace .work/audio-output/latency-training.txt] [--out .cache/perf/audio-latency/<browser>]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from '@playwright/test';
import { debugUrl } from './page-url.mjs';
import { gameDirectory } from './game-directory.mjs';
import { analyzeLatencyTrace, analyzePoll, summary } from './audio-latency-original.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const flag = name => argv.includes(`--${name}`);
const engine = option('browser', 'chromium'), map = option('map', '00_Training'), seconds = Number(option('seconds', 60));
if (engine !== 'chromium' && engine !== 'firefox') throw new Error('--browser must be chromium or firefox');
const QUANTUM_MS = 128 / 44100 * 1000;
const out = option('out', `.cache/perf/audio-latency/${engine}`);
mkdirSync(dirname(out), { recursive: true });
try { gameDirectory(); } catch { console.log('SKIP audio-latency: no installed game data'); process.exit(0); }

let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { createServer } = await import('vite');
  const { default: base } = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({ ...base, configFile: false, root, logLevel: 'error',
    server: { ...base.server, port: 0, strictPort: false, host: '127.0.0.1', fs: { ...base.server.fs, deny }, watch: null } });
  await server.listen(); url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = engine === 'chromium'
  ? await chromium.launch({ headless: !flag('headed'), args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`,
    '--autoplay-policy=no-user-gesture-required'] })
  : await firefox.launch({ headless: !flag('headed'), firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = [];
page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
page.on('console', message => { if (message.type() === 'error' && !/vite|Failed to load resource/.test(message.text())) errors.push(`console: ${message.text()}`); });

let play = null;
try {
  await page.goto(debugUrl(`${url}/?`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 300000 });
  await page.evaluate(name => { const menu = document.getElementById('map'); menu.value = name; menu.dispatchEvent(new Event('change')); }, map);
  await page.waitForFunction(name => { const s = window.deusExViewer.status(); return s.ready && s.map === name && s.gameplay; }, map, { timeout: 300000 });
  // A gesture: the page creates its AudioContext, and the worklet opens the library.
  await page.locator('#scene').click({ position: { x: 512, y: 384 } });
  await page.waitForFunction(async () => (await window.deusExViewer.musicStatus()).output?.worklet?.open, {}, { timeout: 60000, polling: 500 });
  await page.waitForTimeout(3000);
  const walk = [['KeyW', 1800], [null, 400], ['Space', 100], [null, 1200], ['KeyS', 1800], [null, 400]];
  for (const end = Date.now() + seconds * 1000; Date.now() < end;)
    for (const [key, ms] of walk) {
      if (key) { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); }
      else await page.waitForTimeout(ms);
    }
  await page.waitForTimeout(500);
  play = await page.evaluate(() => window.deusExViewer.audioLatency());
  play.status = await page.evaluate(() => window.deusExViewer.status().sim ?? null).catch(() => null);
} finally {
  await browser.close();
  await server?.close();
}
if (!play?.worklet) throw new Error(`no worklet timing: ${JSON.stringify(play)}`);

const posts = new Map((play.posts ?? []).map(p => [p.batch, p])), clock = play.worklet.clock;
const starts = [];
for (const w of play.worklet.starts) {
  const p = posts.get(w.batch);
  if (!p || w.first === null) continue;
  const posted = clock === 'performance' ? p.at : p.date, hop = w.at - posted, distance = (w.first - w.frame) / 44100 * 1000;
  starts.push({ batch: w.batch, hop, distance, latency: hop + distance, wall: w.playedAt === null ? null : w.playedAt - posted,
    take: w.takenAt === null ? null : w.takenAt - posted });
}
const result = {
  browser: engine, mode: play.mode, map, seconds, clock, sampleRate: play.worklet.sampleRate, state: play.worklet.state,
  baseLatencyMs: play.worklet.baseLatency === null ? null : play.worklet.baseLatency * 1000,
  outputLatencyMs: play.worklet.outputLatency === null ? null : play.worklet.outputLatency * 1000,
  starts: starts.length, posts: play.posts?.length ?? 0, recorded: play.worklet.starts.length, errors,
  hop: summary(starts.map(s => s.hop)), distance: summary(starts.map(s => s.distance)),
  latency: summary(starts.map(s => s.latency)), wall: summary(starts.map(s => s.wall ?? NaN)),
  take: summary(starts.map(s => s.take ?? NaN)), raw: starts,
};
// The original's figure, from the stored traces.
const trace = option('trace', '.work/audio-output/latency-training.txt');
if (existsSync(trace)) result.original = { file: trace, ...analyzeLatencyTrace(readFileSync(trace, 'utf8')) };
const polls = ['.work/audio-output/training-load1.poll.txt', '.work/audio-output/training-load2.poll.txt'].filter(existsSync);
result.originalPolls = polls.map(file => ({ file, ...analyzePoll(readFileSync(file, 'utf8')) }));
writeFileSync(`${out}.json`, JSON.stringify(result, null, 1));

const line = s => s ? `median ${s.median} ms, mean ${s.mean}, p5 ${s.p5}, p95 ${s.p95}, max ${s.max} (n ${s.n})` : 'none';
console.log(`${engine} ${play.mode} ${map}: ${starts.length} effect starts timed (${result.recorded} recorded by the worklet, ${result.posts} posted); ` +
  `worklet clock ${clock}; context ${result.state}, ${result.sampleRate} Hz, baseLatency ${result.baseLatencyMs?.toFixed(1)} ms, outputLatency ${result.outputLatencyMs?.toFixed(1)} ms`);
console.log(`  hop:      ${line(result.hop)}`);
console.log(`  distance: ${line(result.distance)}`);
console.log(`  latency:  ${line(result.latency)}`);
console.log(`  wall:     ${line(result.wall)}`);
console.log(`  take:     ${line(result.take)}`);
if (errors.length) console.log(`  errors: ${errors.slice(0, 5).join(' | ')}`);
const reference = result.original?.uniformWall;
if (reference && result.take) {
  const ok = result.take.median <= reference.median + QUANTUM_MS && result.take.p95 <= reference.p95 + QUANTUM_MS;
  console.log(`original take (${trace}, Wine's cursor, starts uniform in time): ${line(reference)}; its ${result.original.starts} real starts: ${line(result.original.wall)}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} D6: Play's take median ${result.take.median} <= ${(reference.median + QUANTUM_MS).toFixed(2)} and ` +
    `p95 ${result.take.p95} <= ${(reference.p95 + QUANTUM_MS).toFixed(2)} (the original's plus 128 frames)`);
  process.exitCode = ok && !errors.length ? 0 : 1;
} else console.log('no original trace: run scripts/galaxy-output-capture.sh latency first');
console.log(`saved ${out}.json`);
