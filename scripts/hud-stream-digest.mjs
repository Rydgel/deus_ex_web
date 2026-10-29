#!/usr/bin/env node
/** The HUD command stream of a fixed headless roam, hashed per frame (host representation check, docs/live-heap.md).
 *
 * Boots a map through Play's createGame and a simulation session (the one the worker runs), holds the forward key and turns on a
 * fixed schedule through the installed input bindings, and after every tick runs the session's `sprites()` and `hud()` as the
 * worker's frame does. Each frame's HUD result (the plain GC commands, the InfoLink text and the screen flash) is hashed with its
 * numbers' exact bits (-0 and NaN kept), so a change to how the commands are built must leave every per-frame hash alone.
 *
 *   node scripts/hud-stream-digest.mjs [--map 01_NYC_UNATCOIsland] [--frames 600] [--warm 60] [--size 1440x960]
 *     [--out FILE] [--compare FILE] [--alloc] [--sites N] [--dump FRAME]
 *
 * --out writes {map, frames, digest, hashes[], counts[]}; --compare reads such a file from another build and exits 1 at the first
 * frame whose hash differs. The roam is the same fixed schedule on every run (a forward hold, a turn every 90 ticks, a jump every
 * 150), so two builds see the same world.
 *
 * --alloc measures what each `session.hud()` call allocates in V8's new space (the heap-space size before and after the call; a
 * call a scavenge ran in is left out; run with --max-semi-space-size=64 --min-semi-space-size=64 so few are), as KB a frame: the
 * mean over the frames and the median. It is exact and repeatable where the browser's sampling profile is not (a roam differs
 * from run to run). --sites N also runs V8's sampling heap profiler (inspector, 512-byte interval) over the same calls and prints
 * the N largest leaf functions and 5-frame sites, as KB a frame, outside Galaxy's update (which runs inside the HUD step) and
 * inside it. Allocation outside the V8 heap (large typed arrays) is not counted by either.
 *
 * The clocks are pinned to the simulated tick as bench-sim pins them (the Level calendar and the window host read them). Host
 * measurement only; it makes no claim about the original game.
 */
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const map = flag('map', '01_NYC_UNATCOIsland'), frames = Number(flag('frames', 600)), warm = Number(flag('warm', 60));
const [width, height] = flag('size', '1440x960').split('x').map(Number);
const dumpFrames = new Set(argv.flatMap((a, i) => a === '--dump' ? [Number(argv[i + 1])] : []));
const outPath = flag('out', null), comparePath = flag('compare', null);

const realNow = performance.now.bind(performance);
globalThis.__realNow = realNow;
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', {value: () => simulatedMs, configurable: true});

import {getHeapSpaceStatistics} from 'node:v8';
import {Session} from 'node:inspector';
const wantAlloc = argv.includes('--alloc') || argv.includes('--sites'), siteCount = Number(flag('sites', 0));

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

/** Every value as exact bits: numbers by their float64 words (so -0, NaN payloads and 0.1 + 0.2 stay apart), strings with their
 * length, typed arrays by element, plain objects by key in insertion order (the commands' key order is part of the stream). */
const bits = new DataView(new ArrayBuffer(8));
function feed(hash, value, depth = 0) {
  if (depth > 12) { hash.update('<deep>'); return; }
  switch (typeof value) {
    case 'number': bits.setFloat64(0, value); hash.update(`n${bits.getBigUint64(0).toString(16)};`); return;
    case 'string': hash.update(`s${value.length}:${value};`); return;
    case 'boolean': hash.update(value ? 'T;' : 'F;'); return;
    case 'bigint': hash.update(`b${value};`); return;
    case 'undefined': hash.update('u;'); return;
    case 'function': hash.update('fn;'); return;
  }
  if (value === null) { hash.update('null;'); return; }
  if (ArrayBuffer.isView(value)) {
    hash.update(`t${value.constructor.name}${value.length}[`);
    for (let i = 0; i < value.length; i++) feed(hash, value[i], depth + 1);
    hash.update(']'); return;
  }
  if (Array.isArray(value)) {
    hash.update(`a${value.length}[`);
    for (let i = 0; i < value.length; i++) feed(hash, value[i], depth + 1);
    hash.update(']'); return;
  }
  const keys = Object.keys(value);
  hash.update(`o${keys.length}{`);
  for (const key of keys) { hash.update(`${key}=`); feed(hash, value[key], depth + 1); }
  hash.update('}');
}
const hashOf = value => { const hash = createHash('sha256'); feed(hash, value); return hash.digest('hex').slice(0, 16); };

// The roam: a fixed schedule on the installed bindings (forward hold; a turn every 90 ticks; a jump every 150).
const FORWARD = 'KeyW', TURN_EVERY = 90, JUMP_EVERY = 150;
let tick = 0, lastHudAllocation = 0, audioAllocation = 0, lastAudioAllocation = 0;
const newSpaceUsed = () => { for (const space of getHeapSpaceStatistics()) if (space.space_name === 'new_space') return space.space_used_size; return 0; };
let allocated = [], audioAllocated = [], overhead = 0, scavenged = 0, profile = null, inspector = null;
const step = () => {
  simulatedMs += 1000 / 60;
  if (tick === 0) fixture.key(FORWARD, true);
  if (tick > 0 && tick % TURN_EVERY === 0) fixture.axis('MouseX', (tick / TURN_EVERY) % 3 === 0 ? -40 : 40);
  if (tick > 0 && tick % JUMP_EVERY === 0) { fixture.key('Space', true); }
  else if (tick > 0 && tick % JUMP_EVERY === 1) { fixture.key('Space', false); }
  tick++;
  game.tick(1 / 60);
  const sprites = session.sprites();
  const view = game.view();
  const before = wantAlloc ? newSpaceUsed() : 0;
  const hud = session.hud({width, height, view});
  if (wantAlloc) { const after = newSpaceUsed(); lastHudAllocation = after < before ? -1 : after - before - overhead; }
  const errors = [...sprites.errors, ...hud.errors];
  if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
  return hud;
};
for (let i = 0; i < warm; i++) step();

if (wantAlloc) {
  const a = newSpaceUsed(), b = newSpaceUsed(); overhead = b - a;     // what one reading allocates before the next
  if (siteCount) {
    inspector = new Session(); inspector.connect();
    const post = (method, params) => new Promise((resolve, reject) => inspector.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
    await post('HeapProfiler.enable');
    await post('HeapProfiler.startSampling', {samplingInterval: 512, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true});
    inspector.finish = async () => (await post('HeapProfiler.stopSampling')).profile;
  }
}
// Galaxy's Update runs inside the HUD draw (game.mjs wraps hud.commands); its share is measured on its own.
const audio = game.doors.scriptRuntime.runtime.audio;
if (wantAlloc && audio?.update) {
  const update = audio.update.bind(audio);
  audio.update = view => { const before = newSpaceUsed(); const result = update(view); const after = newSpaceUsed(); lastAudioAllocation = after < before ? -1 : after - before - overhead; return result; };
}
const hashes = [], counts = [], total = createHash('sha256');
const kinds = new Map();
for (let i = 0; i < frames; i++) {
  const hud = step();
  if (wantAlloc) { const delta = lastHudAllocation; if (delta >= 0 && lastAudioAllocation >= 0) { allocated.push(delta); audioAllocated.push(lastAudioAllocation); } else scavenged++; }
  const h = hashOf({commands: hud.commands, infoLink: hud.infoLink, flash: hud.flash});
  hashes.push(h); counts.push(hud.commands.length); total.update(h);
  if (dumpFrames.has(i)) {   // --dump FRAME: the frame's commands by texture, and its InfoLink text
    const byTexture = new Map();
    for (const command of hud.commands) { const key = command.texture?.key ?? command.kind; byTexture.set(key, (byTexture.get(key) ?? 0) + 1); }
    console.log(`frame ${i}: ${hud.commands.length} commands`, JSON.stringify(Object.fromEntries(byTexture)), JSON.stringify(hud.infoLink));
  }
  for (const command of hud.commands) { const kind = command.kind ?? 'tile'; kinds.set(kind, (kinds.get(kind) ?? 0) + 1); }
}
const digest = total.digest('hex').slice(0, 16);
if (wantAlloc) {
  allocated.sort((x, y) => x - y);
  const mean = allocated.reduce((x, y) => x + y, 0) / allocated.length / 1024, median = allocated[allocated.length >> 1] / 1024;
  const audioMean = audioAllocated.reduce((x, y) => x + y, 0) / audioAllocated.length / 1024;
  console.log(`hud() allocation: mean ${mean.toFixed(1)} KB, median ${median.toFixed(1)} KB a frame over ${allocated.length} calls (${scavenged} left out for a scavenge); Galaxy's update inside it: mean ${audioMean.toFixed(1)} KB; the rest ${(mean - audioMean).toFixed(1)} KB`);
}
if (profile = inspector ? await inspector.finish() : null) {
  const label = f => `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber + 1}`;
  const fn = f => `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}`;
  const leaf = {inside: new Map(), outside: new Map()}, site = {inside: new Map(), outside: new Map()}, sums = {inside: 0, outside: 0};
  const bump = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  (function visit(node, stack, inHud, inAudio) {
    const here = [...stack, label(node.callFrame)];
    const hudNow = inHud || /^hud viewer\/sim-session\.mjs/.test(fn(node.callFrame));
    const audioNow = inAudio || /^update runtime\/script-audio-live\.mjs/.test(fn(node.callFrame));
    if (hudNow && node.selfSize) {
      const part = audioNow ? 'inside' : 'outside';   // 'inside': Galaxy's update (script-audio-live.mjs update)
      sums[part] += node.selfSize; bump(leaf[part], fn(node.callFrame), node.selfSize); bump(site[part], here.slice(-5).reverse().join(' < '), node.selfSize);
    }
    for (const child of node.children) visit(child, here, hudNow, audioNow);
  })(profile.head, [], false, false);
  const kb = bytes => (bytes / 1024 / frames).toFixed(1).padStart(7);
  const top = (m, n) => [...m].sort((x, y) => y[1] - x[1]).slice(0, n);
  for (const part of ['outside', 'inside']) {
    console.log(`\nsampled, hud() ${part === 'inside' ? 'inside Galaxy update' : 'outside Galaxy update'}: ${kb(sums[part])} KB a frame`);
    for (const [name, bytes] of top(leaf[part], siteCount)) console.log(`${kb(bytes)}  ${name}`);
    console.log(`  sites:`);
    for (const [name, bytes] of top(site[part], siteCount)) console.log(`${kb(bytes)}  ${name}`);
  }
}
const report = {map, frames, warm, size: [width, height], digest, hashes, counts};
console.log(JSON.stringify({map, frames, warm, digest, commandsPerFrame: +(counts.reduce((a, b) => a + b, 0) / frames).toFixed(1),
  distinctFrames: new Set(hashes).size, kinds: Object.fromEntries(kinds)}));
if (outPath) await writeFile(outPath, JSON.stringify(report));
let status = 0;
if (comparePath) {
  const before = JSON.parse(await readFile(comparePath, 'utf8'));
  const first = hashes.findIndex((h, i) => h !== before.hashes[i]);
  if (before.frames !== frames || before.map !== map) { console.log(`compare: different run (${before.map} ${before.frames} frames)`); status = 1; }
  else if (first >= 0) { console.log(`compare: DIFFERENT at frame ${first} (${before.hashes[first]} against ${hashes[first]}, commands ${before.counts[first]} against ${counts[first]})`); status = 1; }
  else console.log(`compare: identical ${frames} frames (${digest})`);
}
process.exit(status);
