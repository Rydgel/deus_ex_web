#!/usr/bin/env node
/** What one HUD paint runs, per frame: the script events (receiver class and event, count and inclusive ms), the script functions they
 * call (callFunction, inclusive ms), the Rust VM's JavaScript fallbacks inside the paint (SCRIPT_VM_STATS=1 [SCRIPT_VM_STATS_DETAIL=1
 * SCRIPT_VM_STATS_TIME=1]) and the paint's total, over a fixed roam (hud-stream-digest.mjs's schedule).
 *
 *   node scripts/hud-census.mjs [--map 01_NYC_UNATCOIsland] [--frames 300] [--warm 60] [--top 25] [--rows 40] [--size 1440x960]
 *
 * Node's V8 times, with a timer around every event (about 0.1 ms a frame of its own): they say which events and calls the paint spends
 * its time in and how often, not what Firefox spends (docs/firefox-60fps-plan.md "The HUD phase in Firefox"). The events counted are the
 * paint's own, Galaxy's update inside it included (it runs scripts too, but not events: the audio is not the HUD's). Host measurement only.
 */
import {readFile, readdir} from 'node:fs/promises';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const map = flag('map', '01_NYC_UNATCOIsland'), frames = Number(flag('frames', 300)), warm = Number(flag('warm', 60));
const [width, height] = flag('size', '1440x960').split('x').map(Number), top = Number(flag('top', 25)), rows = Number(flag('rows', 40));

const realNow = performance.now.bind(performance);
globalThis.__realNow = realNow;
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', {value: () => simulatedMs, configurable: true});

const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createGame} = await import('../src/viewer/game.mjs');
const {createSimSession} = await import('../src/viewer/sim-session.mjs');
const {gameDirectory} = await import('./game-directory.mjs');
const {createPlayerInputFixture} = await import('./player-input-fixture.mjs');

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const session = createSimSession(game, {assets});
const fixture = createPlayerInputFixture(game);
const runtime = game.doors.scriptRuntime.runtime;

let inHud = false, counting = false;
const events = new Map(), calls = new Map(), fallbacks = new Map(), fallbackMs = new Map();
const add = (table, key, ms) => { const row = table.get(key) ?? {n: 0, ms: 0}; row.n++; row.ms += ms; table.set(key, row); };
const processEvent = runtime.processEvent.bind(runtime), callFunction = runtime.callFunction.bind(runtime);
runtime.processEvent = function (receiver, name, args, result, record) {
  if (!inHud || !counting) return processEvent(receiver, name, args, result, record);
  const start = realNow();
  try { return processEvent(receiver, name, args, result, record); } finally { add(events, record?.key ?? name, realNow() - start); }
};
runtime.callFunction = function (record, ...rest) {
  if (!inHud || !counting) return callFunction(record, ...rest);
  const start = realNow();
  try { return callFunction(record, ...rest); } finally { add(calls, record?.key ?? '?', realNow() - start); }
};

let tick = 0, paintMs = 0;
const step = () => {
  simulatedMs += 1000 / 60;
  if (tick === 0) fixture.key('KeyW', true);
  if (tick > 0 && tick % 90 === 0) fixture.axis('MouseX', (tick / 90) % 3 === 0 ? -40 : 40);
  if (tick > 0 && tick % 150 === 0) fixture.key('Space', true); else if (tick > 0 && tick % 150 === 1) fixture.key('Space', false);
  tick++;
  game.tick(1 / 60);
  session.sprites();
  const view = game.view();
  globalThis.__scriptVmStatsReset?.();
  inHud = true;
  const start = realNow();
  const hud = session.hud({width, height, view, stream: true});
  const elapsed = realNow() - start;
  inHud = false;
  if (counting) {
    paintMs += elapsed;
    const stats = globalThis.__scriptVmStats;
    if (stats) {
      for (const [key, n] of stats.counts) fallbacks.set(key, (fallbacks.get(key) ?? 0) + n);
      for (const [key, ms] of stats.times ?? []) fallbackMs.set(key, (fallbackMs.get(key) ?? 0) + ms);
    }
  }
  if (hud.errors.length) throw new Error(hud.errors.map(e => e.message).join('; '));
};
for (let i = 0; i < warm; i++) step();
counting = true;
for (let i = 0; i < frames; i++) step();

const per = v => (v / frames);
const table = (title, map, limit) => {
  console.log(`\n${title}`);
  for (const [key, row] of [...map].sort((a, b) => b[1].ms - a[1].ms).slice(0, limit))
    console.log(`${per(row.n).toFixed(2).padStart(8)}/frame ${per(row.ms).toFixed(3).padStart(8)} ms  ${key}`);
};
const eventCount = [...events.values()].reduce((n, row) => n + row.n, 0), eventMs = [...events.values()].reduce((n, row) => n + row.ms, 0);
console.log(`${map}: ${frames} frames after ${warm}; one HUD paint (session.hud, Galaxy's update included) ${per(paintMs).toFixed(3)} ms`);
console.log(`script events a paint: ${per(eventCount).toFixed(1)}, ${per(eventMs).toFixed(3)} ms inclusive, ${events.size} distinct`);
table('events (inclusive)', events, top);
table('script functions called by them (callFunction, inclusive)', calls, top);
if (fallbacks.size) {
  console.log('\nthe Rust VM\'s JavaScript fallbacks in a paint (SCRIPT_VM_STATS)');
  const sorted = [...fallbacks].sort((a, b) => (fallbackMs.get(b[0]) ?? 0) - (fallbackMs.get(a[0]) ?? 0) || b[1] - a[1]).slice(0, rows);
  for (const [key, n] of sorted) console.log(`${per(n).toFixed(2).padStart(8)}/frame ${fallbackMs.size ? `${per(fallbackMs.get(key) ?? 0).toFixed(3).padStart(8)} ms ` : ''} ${key}`);
}
process.exit(0);
