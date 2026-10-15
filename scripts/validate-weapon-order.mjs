/**
 * Stage 4: the order of a pawn's and its weapon's SetupForActor calls (docs/weapon-attachment.md "Order of SetupForActor calls").
 * DrawActorSprite calls the pawn's DrawMesh (Render.dll 0x10b25624) and then the weapon's (0x10b257da) in each frame that draws the
 * pawn, and the two share the pawn's light-manager cache (the weapon is lit with the pawn as sink), so a pawn in two frames makes
 * [pawn@child, weapon@child, pawn@main, weapon@main]. Play lit all of a pawn's frames, then its weapon's (`?weaponOrder=late`,
 * kept as the switch for this comparison).
 *
 * The scene is the `jcb` one of validate-weapon-mirror-play.mjs and the original captures: 05_NYC_UNATCOMJ12lab, JC armed with the
 * pistol, `BehindView 1`, the view off the line to the mirror pane: his back in the main frame, his reflection in the pane's child frame,
 * both drawing the pistol. Each run loads the map under a paused Playwright clock (?hold=1&seed=1), steps 16 ms frames and types the
 * console commands at fixed frames, so a run is deterministic (the same page twice gives the same words, checked). The simulation
 * side keeps every SetupForActor call from the first frame of BehindView on (mesh-lighting-view.mjs `setupLog`: the actor, the light sink,
 * the frame and the result's words) and the weapon's corner colours (float32 words) of the last frame, per frame.
 *
 * Checks: the interleaved run's calls in a frame are pawn, weapon, pawn, weapon (child frame first) and the late run's are pawn, pawn,
 * weapon, weapon; the interleaved run twice gives the same words; and the words of the two orders are compared call by call (every
 * light's identity, location, radius, colour and fade, the ambient, the flags) and the weapon's colours: the result says whether any
 * word changed. Host check of Play's wiring against the order the disassembly gives, not a comparison of pixels.
 *
 *   node scripts/validate-weapon-order.mjs [--url http://127.0.0.1:5173] [--frames 120] [--angle gl] [--dump runs.json]
 */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-weapon-order: no installed game data'); process.exit(0); }
const MAP = '05_NYC_UNATCOMJ12lab', FRAMES = Number(option('frames', 120)), angle = option('angle', process.platform === 'darwin' ? 'metal' : 'gl');
let server = null, base = option('url', null);
if (!base) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: config} = await import('../vite.config.mjs');
  const deny = config.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...config, configFile: false, root, logLevel: 'error',
    server: {...config.server, port: 0, strictPort: false, fs: {...config.server.fs, deny}, watch: null}});
  await server.listen();
  base = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const INSTALL = new Date('2001-06-23T12:00:00Z').getTime(), START = INSTALL + 3600 * 1000;

// The capture's commands (validate-weapon-mirror-play.mjs, .work/weapon/run-jcb.sh): frame -> what is typed.
const SCRIPT = new Map([
  [3, [{location: [-3086.76978, 1400.20129, -155.809525], region: {zone: 'LevelInfo0', iLeaf: 3650, zoneNumber: 7}}, {playersOnly: false}]],
  [20, [{exec: ['summon DeusEx.WeaponPistol']}]],
  [50, [{rotation: [-10130, 16432, 0]}]],
  [90, [{exec: ['ParseRightClick']}]],
  [130, [{exec: ['ActivateBelt 1']}]],
  [170, [{exec: ['BehindView 1']}, {rotation: [-400, 62536, 0]}]],
]);
const LOG_FROM = 175;

async function run(browser, order) {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); } catch { /* storage unavailable */ } });
  try {
    await page.clock.install({time: INSTALL});
    const target = new URL(base);
    for (const [key, value] of Object.entries({hold: '1', seed: '1', antialias: '0', ...(order === 'late' ? {weaponOrder: 'late'} : {})})) target.searchParams.set(key, value);
    await page.goto(target.href);
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
    await page.evaluate(map => { const menu = document.getElementById('map'); menu.value = map; menu.dispatchEvent(new Event('change')); }, MAP);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.mode === 'play'; }, MAP, {timeout: 240000});
    await page.clock.pauseAt(START);
    await page.evaluate(() => window.deusExViewer.release());
    let log = null, states = null;
    for (let frame = 1; frame <= LOG_FROM + FRAMES; frame++) {
      await page.clock.runFor(16);
      await page.evaluate(() => window.deusExViewer.settled?.());
      for (const call of SCRIPT.get(frame) ?? []) await page.evaluate(args => window.deusExViewer.viewProbe(args), call);
      if (frame === LOG_FROM) await page.evaluate(() => window.deusExViewer.lodProbe({list: 'setupLog', mode: 'on'}));
      if (frame === LOG_FROM + FRAMES) {
        // the weapon's colours of this frame, then the calls of all the frames since LOG_FROM
        states = await page.evaluate(() => window.deusExViewer.lodProbe({list: 'weapons', colors: true}));
        log = await page.evaluate(() => window.deusExViewer.lodProbe({list: 'setupLog', mode: 'off'}));
      }
      const error = await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
      if (error) throw new Error(`runtime error at frame ${frame}: ${error}`);
    }
    return {order, log, jc: states.filter(s => /^JCDentonMale/.test(s.pawn) && s.weapon), errors};
  } finally { await page.close(); }
}

/** The calls per frame, in order: [{frame, calls: [{key, role, where, sink, setup}]}]. A call is named by its actor, light sink and
 * frame; a pawn's own call has itself as sink, its weapon's the pawn. The main frame is the pawn's last call's (its frame is the
 * last DrawFrame makes); the weapon's lighting frame is the frame's with Mirror 1.0, so its origin words, not its Mirror, name the frame. */
function byFrame(log, pawn) {
  const frames = [];
  for (const entry of log) {
    if (entry.frame !== undefined) { frames.push({frame: entry.frame, calls: []}); continue; }
    frames.at(-1)?.calls.push({actor: entry.actor, sink: entry.sink, origin: entry.origin.join(','), role: entry.actor === entry.sink ? 'P' : 'W', setup: entry.setup});
  }
  for (const frame of frames) {
    const mine = frame.calls.filter(call => call.sink === pawn && call.role === 'P'), main = mine.at(-1)?.origin;
    for (const call of frame.calls) {
      call.where = call.origin === main ? 'main' : 'child';
      call.key = `${call.actor}<-${call.sink} @${call.origin}`;
    }
  }
  return frames;
}

const browser = await chromium.launch({args: [`--use-angle=${angle}`]});
let runs;
try {
  runs = {a: await run(browser, 'interleaved'), again: await run(browser, 'interleaved'), late: await run(browser, 'late')};
} finally { await browser.close(); await server?.close(); }

if (option('dump', null)) (await import('node:fs')).writeFileSync(option('dump', null), JSON.stringify(runs));
for (const run of Object.values(runs)) assert.deepEqual(run.errors, [], `${run.order}: page errors`);
const pawnName = runs.a.jc[0]?.pawn;
assert.ok(pawnName, 'the player holds the pistol');
const frames = {a: byFrame(runs.a.log, pawnName), again: byFrame(runs.again.log, pawnName), late: byFrame(runs.late.log, pawnName)};
// the pawn's own and its weapon's calls in a frame, as "P@child W@child ..."
const sequenceOf = frame => frame.calls.filter(call => call.sink === pawnName).map(call => `${call.role}@${call.where}`);
// the frames in which the pawn is drawn in both the child frame and the main frame (the two-frame case)
const twoFrames = frames.a.filter(frame => ['P@child', 'P@main'].every(label => sequenceOf(frame).includes(label)));
assert.ok(twoFrames.length > 0, `the pawn is lit in a child frame and the main frame in the same frame (${twoFrames.length} of ${frames.a.length} frames)`);
const last = twoFrames.at(-1), interleaved = sequenceOf(last).join(' '), late = sequenceOf(frames.late.find(frame => frame.frame === last.frame)).join(' ');
console.log(`calls of ${pawnName} in a frame with it in two frames:\n  interleaved: ${interleaved}\n  late:        ${late}`);
assert.equal(interleaved, 'P@child W@child P@main W@main', 'interleaved: pawn, weapon, pawn, weapon (child frame first)');
assert.equal(late, 'P@child P@main W@child W@main', 'late: pawn, pawn, weapon, weapon');

// determinism: the same order twice gives the same words
const compare = (x, y) => {
  let calls = 0, differing = [];
  assert.equal(x.length, y.length, 'the same number of frames');
  x.forEach((frame, i) => {
    const other = y[i], seen = new Map(other.calls.map(call => [call.key, call.setup]));
    for (const call of frame.calls) {
      calls++;
      if (!seen.has(call.key)) differing.push({frame: frame.frame, key: call.key, why: 'call missing'});
      else if (seen.get(call.key) !== call.setup) differing.push({frame: frame.frame, key: call.key, why: 'words differ'});
    }
  });
  return {calls, differing};
};
const same = compare(frames.a, frames.again);
assert.equal(same.differing.length, 0, `the same order twice gives the same SetupForActor words (${JSON.stringify(same.differing.slice(0, 3))})`);
assert.equal(JSON.stringify(runs.a.jc.map(s => s.colors)), JSON.stringify(runs.again.jc.map(s => s.colors)), 'the same order twice gives the same weapon colours');
const order = compare(frames.a, frames.late);
const colours = JSON.stringify(runs.a.jc.map(s => s.colors)) === JSON.stringify(runs.late.jc.map(s => s.colors));
const lights = frames.a.at(-1).calls.find(call => call.sink === pawnName && call.role === 'P' && call.where === 'main')?.setup ?? '{}';
console.log(JSON.stringify({frames: frames.a.length, twoFrameFrames: twoFrames.length, calls: order.calls, wordsChanged: order.differing.length, firstDifferences: order.differing.slice(0, 5),
  weaponColoursEqual: colours, mainFrameLights: JSON.parse(lights).lights?.length ?? null}));
console.log(order.differing.length || !colours
  ? `validate-weapon-order: PASS (the orders differ in ${order.differing.length} of ${order.calls} SetupForActor results, weapon colours ${colours ? 'equal' : 'differ'})`
  : `validate-weapon-order: PASS (${order.calls} SetupForActor results over ${frames.a.length} frames, ${twoFrames.length} with the pawn in two frames: no word changed by the order, weapon colours equal)`);
