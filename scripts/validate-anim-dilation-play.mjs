// An actor's animation advances by the level's dilated, clamped delta in Play
// (worker mode): ULevel::Tick multiplies the frame's delta by
// LevelInfo.TimeDilation and clamps it to [0.005, 0.4] for the actors
// (Engine.dll 103a5468..103a54df, docs/script-level-tick.md, 31 original-DLL
// cases in validate-level-tick); AActor::Tick's animation phase adds
// remaining * AnimRate to AnimFrame with that delta (103a1bf0..103a1fd2,
// docs/script-animation-tick.md), while TimeSeconds adds the unclamped product.
// The page runs under a paused Playwright clock (16 ms frames, each settled
// before the next so the worker never merges frames); at TimeDilation 1, 0.5,
// 0.01, 0.001, 0.0001 and 50 the ghost player's looping Tread animation
// (AnimRate 1.25) and TimeSeconds are read before and after N frames and
// compared with the delta the original's rule gives, frame by frame in float32.
//
//   node scripts/validate-anim-dilation-play.mjs [--ticks 12]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {levelTickTime} from '../src/runtime/level-tick.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-anim-dilation-play: no installed game data'); process.exit(0); }
const ticks = Number(option('ticks', 12)), f = Math.fround;
const root = fileURLToPath(new URL('..', import.meta.url));
const {default: base} = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
const server = await createServer({...base, configFile: false, root, logLevel: 'error',
  server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const INSTALL = new Date('2001-06-23T12:00:00Z').getTime(), START = INSTALL + 3600 * 1000;
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const rows = [];
try {
  const page = await browser.newPage({viewport: {width: 640, height: 360}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); } catch { /* storage unavailable */ } });
  await page.clock.install({time: INSTALL});
  await page.goto(debugUrl(`${url}/?hold=1&seed=1`));   // the default simulation: the worker
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  assert.ok(!await page.evaluate(() => new URLSearchParams(location.search).has('sim')), 'worker mode is the default');
  const probe = args => page.evaluate(args => window.deusExViewer.viewProbe(args), args);
  await probe({ghost: true});
  await page.clock.pauseAt(START);
  await page.evaluate(() => window.deusExViewer.release());
  const step = async n => { for (let k = 0; k < n; k++) { await page.clock.runFor(16); await page.evaluate(() => window.deusExViewer.settled()); } };
  await step(6);
  // The input delta each frame posts: TimeSeconds at TimeDilation 1 (no clamp: 0.016 s).
  await probe({timeDilation: 1});
  await step(1);
  const before = await probe({}); await step(ticks); const after = await probe({});
  const dt = f((after.timeSeconds - before.timeSeconds) / ticks);
  assert.ok(Math.abs(dt - 0.016) < 1e-4, `frames post 16 ms (${dt})`);
  for (const dilation of [1, 0.5, 0.01, 0.001, 0.0001, 50]) {
    // Start the row early in the loop and take as many frames as keep the sum
    // of the advance below its end, or one frame (one wrap at the largest
    // delta: an AnimEnd script could change the sequence's course).
    await probe({timeDilation: 1});
    for (let guard = 0; guard < 600; guard++) { const {anim} = await probe({}); if (anim.frame >= 0 && anim.frame <= 0.3) break; await step(1); }
    await probe({timeDilation: dilation});
    await step(1);
    const from = await probe({});
    assert.ok(from.anim.rate > 0 && from.anim.sequence !== 'None', `the ghost plays a sequence: ${JSON.stringify(from.anim)}`);
    const n = Math.max(1, Math.min(ticks, Math.floor((0.9 - from.anim.frame) / (levelTickTime(0, dt, dilation).delta * from.anim.rate))));
    await step(n);
    const to = await probe({});
    // The original's rule frame by frame: the clock adds the product, the actors the clamped one.
    let clock = from.timeSeconds, frame = f(from.anim.frame);
    const rate = from.anim.rate;
    for (let k = 0; k < n; k++) {
      const tick = levelTickTime(clock, dt, dilation);
      clock = tick.timeSeconds;
      frame = f(frame + f(tick.delta * rate));
      if (frame >= 1) frame = f(frame - 1);   // a loop wraps keeping the overshoot (docs/script-animation-tick.md)
    }
    const delta = levelTickTime(0, dt, dilation).delta;
    assert.ok(Math.abs(to.timeSeconds - clock) < 1e-4, `TimeSeconds advanced by the unclamped product at ${dilation}: ${to.timeSeconds - from.timeSeconds}`);
    assert.ok(Math.abs(to.anim.frame - frame) < 2e-6, `AnimFrame at TimeDilation ${dilation}: ${to.anim.frame} against ${frame} (delta ${delta}, from ${JSON.stringify(from.anim)}, n ${n}, to ${JSON.stringify(to.anim)})`);
    rows.push({dilation, delta, n, clock: +(to.timeSeconds - from.timeSeconds).toFixed(6), frame: +(((to.anim.frame - from.anim.frame) + 1) % 1).toFixed(6),
      expected: +(((frame - from.anim.frame) + 1) % 1).toFixed(6)});
  }
  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null), null, 'no runtime error');
} finally { await browser.close(); await server.close(); }
// The clamp separates the rows: 0.016 x 50 = 0.8 -> 0.4; 0.016 x 0.001 -> 0.005.
const deltas = new Set(rows.map(row => row.delta));
assert.ok(deltas.size >= 4 && deltas.has(f(0.005)) && deltas.has(f(0.4)), 'the rows cover the clamp at both ends');
console.log(`validate-anim-dilation-play: PASS (worker mode, ${ticks} frames per row; ${rows.map(row =>
  `x${row.dilation} (${row.n} frames): actor delta ${row.delta}, clock +${row.clock}, AnimFrame +${row.frame} (expected +${row.expected})`).join('; ')})`);
