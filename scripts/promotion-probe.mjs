#!/usr/bin/env node
/** Old-generation growth of a headless roam, per frame (host measurement only; docs/live-heap.md "Cut: promoted garbage").
 *
 * Boots a map through Play's createGame and a simulation session, holds the forward key and turns on the fixed schedule of
 * hud-stream-digest.mjs, and after every tick runs the session's `sprites()` and `hud()` as the worker's frame does (the actor mesh,
 * lighting and corona steps need the page's scene and are not run). After a warm-up it reads V8's old-space size after every frame and
 * sums the growth: what the scavenger promoted plus what allocation sites pretenured straight into old space, in KB a frame. A
 * frame whose size fell (a major GC swept) adds nothing, so a run with a major GC in it reads low; the frame count says how long.
 * `allocatedKBPerFrame` is everything the isolate allocated in the measured frames (V8's total_allocated_bytes), the same fixed route
 * on every run, so two trees compare on it (a browser roam differs from run to run by a fifth).
 *
 *   node scripts/promotion-probe.mjs [--map 01_NYC_UNATCOIsland] [--frames 1500] [--warm 300] [--json FILE]
 *   node --no-allocation-site-pretenuring scripts/promotion-probe.mjs   (the same run without pretenuring: what survives for real)
 *   node scripts/promotion-probe.mjs --sites 25 [--depth 6]   (V8's sampling heap profile of the measured frames, objects that left the
 *     young generation only, as in `hitch-run.mjs --heap-sampling promoted`: the largest leaf functions and call sites, KB a frame)
 *
 * The clocks are pinned to the simulated tick as bench-sim pins them.
 */
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {getHeapSpaceStatistics, getHeapStatistics} from 'node:v8';
import {Session} from 'node:inspector';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const map = flag('map', '01_NYC_UNATCOIsland'), frames = Number(flag('frames', 1500)), warm = Number(flag('warm', 300));
const [width, height] = flag('size', '1440x960').split('x').map(Number), jsonPath = flag('json', null);

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
// a tree from before the warm-up has no such module (the base arm of a comparison)
const warmAllocationSites = (await import('../src/runtime/allocation-site-warmup.mjs').catch(() => ({}))).warmAllocationSites;

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
// The worker warms before its first load (sim-host.mjs createSimHost); --no-warmup is the run without it.
if (!argv.includes('--no-warmup')) warmAllocationSites?.();
const assets = new AssetStore(files), asset = await assets.get(map);
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const session = createSimSession(game, {assets});
const fixture = createPlayerInputFixture(game);

const FORWARD = 'KeyW', TURN_EVERY = 90, JUMP_EVERY = 150;
let tick = 0;
const step = () => {
  simulatedMs += 1000 / 60;
  if (tick === 0) fixture.key(FORWARD, true);
  if (tick > 0 && tick % TURN_EVERY === 0) fixture.axis('MouseX', (tick / TURN_EVERY) % 3 === 0 ? -40 : 40);
  if (tick > 0 && tick % JUMP_EVERY === 0) fixture.key('Space', true);
  else if (tick > 0 && tick % JUMP_EVERY === 1) fixture.key('Space', false);
  tick++;
  game.tick(1 / 60);
  const sprites = session.sprites();
  const hud = session.hud({width, height, view: game.view()});
  const errors = [...sprites.errors, ...hud.errors];
  if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
};
const spaces = () => {
  const sizes = {};
  for (const space of getHeapSpaceStatistics()) sizes[space.space_name] = space.space_used_size;
  return sizes;
};
for (let i = 0; i < warm; i++) step();

let inspector = null;
const siteCount = Number(flag('sites', 0)), siteDepth = Number(flag('depth', 6));
const post = (method, params) => new Promise((resolve, reject) => inspector.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
if (siteCount) {
  inspector = new Session(); inspector.connect();
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', {samplingInterval: 16384, includeObjectsCollectedByMinorGC: false, includeObjectsCollectedByMajorGC: true});
}
const grown = {}, lastSizes = spaces(), allocatedBefore = getHeapStatistics().total_allocated_bytes;
let last = lastSizes, shrunk = 0;
for (let i = 0; i < frames; i++) {
  step();
  const now = spaces();
  for (const name of ['old_space', 'large_object_space', 'code_space', 'shared_space', 'trusted_space']) {
    const delta = (now[name] ?? 0) - (last[name] ?? 0);
    if (delta > 0) grown[name] = (grown[name] ?? 0) + delta;
    else if (delta < 0 && name === 'old_space') shrunk++;
  }
  last = now;
}
const allocatedAfter = getHeapStatistics().total_allocated_bytes;
const kb = bytes => +(bytes / 1024 / frames).toFixed(1);
if (siteCount) {
  const {profile} = await post('HeapProfiler.stopSampling');
  const leaf = new Map(), sites = new Map(), bump = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  const name = f => `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
  let total = 0;
  (function visit(node, stack) {
    const here = [...stack, name(node.callFrame)];
    if (node.selfSize) { total += node.selfSize; bump(leaf, name(node.callFrame).replace(/:\d+$/, ''), node.selfSize); bump(sites, here.slice(-siteDepth).reverse().join(' < '), node.selfSize); }
    for (const child of node.children) visit(child, here);
  })(profile.head, []);
  const top = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, siteCount);
  console.log(`sampled ${kb(total)} KB a frame left the young generation`);
  for (const [k, v] of top(leaf)) console.log(`${String(kb(v)).padStart(7)}  ${k}`);
  console.log('--- sites');
  for (const [k, v] of top(sites)) console.log(`${String(kb(v)).padStart(7)}  ${k}`);
}
const result = {map, frames, warm, allocatedKBPerFrame: kb(allocatedAfter - allocatedBefore), oldSpaceKBPerFrame: kb(grown.old_space ?? 0), largeObjectKBPerFrame: kb(grown.large_object_space ?? 0),
  codeKBPerFrame: kb(grown.code_space ?? 0), framesWhereOldSpaceShrank: shrunk,
  flags: process.execArgv.join(' ')};
console.log(JSON.stringify(result));
if (jsonPath) await writeFile(jsonPath, JSON.stringify(result, null, 1));
process.exit(0);
