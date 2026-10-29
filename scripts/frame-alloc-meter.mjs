#!/usr/bin/env node
/** The simulation worker's frame, headless: what each step of `session.frame()` allocates, and a hash of what it posts
 * (host measurement only; docs/live-heap.md "Cut: tick and actors").
 *
 * Boots a map through `createSimHost` (the code the worker runs, with the page's GPU mesh capacities, no page world: the drawn
 * set's stamp scene is absent, so the `stamps` step does not run) and runs `session.frame()` as the worker does, with the same
 * fixed roam as hud-stream-digest.mjs (a forward hold, a turn every 90 ticks, a jump every 150) through the installed input bindings.
 *
 *   node scripts/frame-alloc-meter.mjs [--map 01_NYC_UNATCOIsland] [--frames 600] [--warm 60] [--size 1440x960]
 *     [--out FILE] [--compare FILE] [--series FILE] [--sites N] [--depth D] [--steps begin,actors] [--children]
 *
 * Without --sites: the heap-space size of V8's new space around each step (begin, lightFrame, sprites, actors, stamps, coronas, weapon,
 * hud) and around the whole call, as KB a frame (mean, median, p90). A frame a scavenge ran in is left out of that step's numbers;
 * run with --max-semi-space-size=64 --min-semi-space-size=64 so few are (the script re-executes itself with them). Exact and
 * repeatable where the browser's sampling profile is not. Allocation outside the V8 heap (large typed arrays) is not counted.
 *
 * With --sites N: V8's sampling heap profiler (inspector, 512-byte interval) runs over the same frames and the N largest leaf
 * functions and 5-frame sites of each step in --steps are printed, as KB a frame. Use it for the picture, not the totals.
 *
 * Every frame's snapshot (all but its timings) is hashed with its numbers' exact bits, so a change to how a step builds its output
 * must leave every per-frame hash alone: --out writes {map, frames, digest, hashes[]}; --compare reads such a file from another
 * build and exits 1 at the first frame whose hash differs. The simulated clocks are pinned as bench-sim pins them.
 */
import { spawnSync } from 'node:child_process';

if (!process.execArgv.some(a => a.startsWith('--max-semi-space-size')) && !process.env.FRAME_METER_CHILD) {
  const child = spawnSync(process.execPath, ['--max-semi-space-size=64', '--min-semi-space-size=64', '--expose-gc', ...process.execArgv, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, FRAME_METER_CHILD: '1' } });
  process.exit(child.status ?? 1);
}

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { getHeapSpaceStatistics } from 'node:v8';
import { Session } from 'node:inspector';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const map = flag('map', '01_NYC_UNATCOIsland'), frames = Number(flag('frames', 600)), warm = Number(flag('warm', 60));
const [width, height] = flag('size', '1440x960').split('x').map(Number);
const seriesPath = flag('series', null), outPath = flag('out', null), comparePath = flag('compare', null), siteCount = Number(flag('sites', 0));
const wantSteps = flag('steps', 'begin,actors').split(',');
const siteDepth = Number(flag('depth', 5));

const realNow = performance.now.bind(performance);
globalThis.__realNow = realNow;
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', { value: () => simulatedMs, configurable: true });

const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createSimHost } = await import('../src/viewer/sim-host.mjs');
const { createGpuMeshLayout, GPU_MESH_CAPACITIES, WEAPON_GPU_MESH_CAPACITIES } = await import('../src/viewer/gpu-mesh-layout.mjs');
const { gameDirectory } = await import('./game-directory.mjs');
const { createPlayerInputFixture } = await import('./player-input-fixture.mjs');

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get(map);
const host = await createSimHost(decodeMap(asset.bytes, { triangles: false }), asset, assets, { randomSeed: 1, subtitles: false,
  stampScene: null, panZones: [], childFrames: argv.includes('--children'),
  gpu: createGpuMeshLayout(GPU_MESH_CAPACITIES).capacities, weaponGpu: createGpuMeshLayout(WEAPON_GPU_MESH_CAPACITIES).capacities,
  onProgress: () => {} });
if (!host.game) throw new Error(`No game: ${host.notes.join('; ')}`);
const { game, session } = host;
const fixture = createPlayerInputFixture(game);

// ---- a fast exact-bits hash of a snapshot (two 32-bit lanes; numbers by their float64 words, -0 and NaN payloads kept)
let h1 = 0, h2 = 0;
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
const mix = w => { h1 = Math.imul(h1 ^ w, 16777619); h2 = Math.imul(h2 + w | 0, 0x85ebca6b); h2 ^= h2 >>> 15; };
const mixString = s => { mix(s.length); for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); };
function feed(value, depth) {
  switch (typeof value) {
    case 'number': f64[0] = value; mix(1); mix(u32[0]); mix(u32[1]); return;
    case 'string': mix(2); mixString(value); return;
    case 'boolean': mix(value ? 3 : 4); return;
    case 'bigint': mix(5); mixString(value.toString(16)); return;
    case 'undefined': mix(6); return;
    case 'function': mix(7); return;
  }
  if (value === null) { mix(8); return; }
  if (depth > 14) { mix(9); return; }
  if (ArrayBuffer.isView(value)) {
    mix(10); mix(value.length);
    if (value.byteOffset % 4 === 0 && value.byteLength % 4 === 0 && !(value instanceof DataView)) {
      const words = new Uint32Array(value.buffer, value.byteOffset, value.byteLength >> 2);
      for (let i = 0; i < words.length; i++) mix(words[i]);
    } else for (let i = 0; i < value.length; i++) feed(value[i], depth + 1);
    return;
  }
  if (Array.isArray(value)) { mix(11); mix(value.length); for (let i = 0; i < value.length; i++) feed(value[i], depth + 1); return; }
  if (value instanceof Map) { mix(12); mix(value.size); for (const [k, v] of value) { feed(k, depth + 1); feed(v, depth + 1); } return; }
  if (value instanceof Set) { mix(13); mix(value.size); for (const k of value) feed(k, depth + 1); return; }
  const keys = Object.keys(value);
  mix(14); mix(keys.length);
  for (const key of keys) { mixString(key); feed(value[key], depth + 1); }
}
const hashSnapshot = snapshot => {
  h1 = 0x811c9dc5 | 0; h2 = 0x9747b28c | 0;
  for (const key of Object.keys(snapshot)) { if (key === 'timings' || key === 'audioMs') continue; mixString(key); feed(snapshot[key], 0); }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
};

// ---- the per-step meters
const STEPS = ['begin', 'lightFrame', 'sprites', 'actors', 'stamps', 'coronas', 'weapon', 'hud'];
const newSpaceUsed = () => { for (const space of getHeapSpaceStatistics()) if (space.space_name === 'new_space') return space.space_used_size; return 0; };
const a0 = newSpaceUsed(), a1 = newSpaceUsed(), overhead = a1 - a0;   // what one reading allocates before the next
const samples = new Map(STEPS.map(name => [name, []])), frameSamples = [], current = new Map(), series = [];
let measuring = false;
for (const name of STEPS) {
  const original = session[name];
  session[name] = function meterStep(...args) {
    if (!measuring || siteCount) return original.apply(this, args);
    const before = newSpaceUsed();
    const result = original.apply(this, args);
    const after = newSpaceUsed();
    current.set(name, after < before ? -1 : after - before - overhead);
    return result;
  };
}

const FORWARD = 'KeyW', TURN_EVERY = 90, JUMP_EVERY = 150;
let tick = 0, seconds = 0, scavenged = 0;
const digestHashes = [];
function step() {
  simulatedMs += 1000 / 60; seconds += 1 / 60;
  if (tick === 0) fixture.key(FORWARD, true);
  if (tick > 0 && tick % TURN_EVERY === 0) fixture.axis('MouseX', (tick / TURN_EVERY) % 3 === 0 ? -40 : 40);
  if (tick > 0 && tick % JUMP_EVERY === 0) fixture.key('Space', true);
  else if (tick > 0 && tick % JUMP_EVERY === 1) fixture.key('Space', false);
  tick++;
  current.clear();
  const before = measuring && !siteCount ? newSpaceUsed() : 0;
  const snapshot = session.frame({ play: true, dt: 1 / 60, run: true, halted: false, size: [width, height], aspect: width / height,
    resizes: 1, seconds, mirrors: true, pixelRatio: 1, now: seconds, inspect: null });
  const after = measuring && !siteCount ? newSpaceUsed() : 0;
  if (snapshot.errors.length) throw new Error(snapshot.errors.map(e => e.message).join('; '));
  if (measuring && !siteCount) {
    let valid = true;
    for (const name of STEPS) { const v = current.get(name); if (v === undefined) continue; if (v < 0) valid = false; else samples.get(name).push(v); }
    series.push(Object.fromEntries(STEPS.map(name => [name, current.get(name) ?? null])));
    if (after < before || !valid) scavenged++;
    else frameSamples.push(after - before - overhead * (1 + 2 * STEPS.length));
  }
  return snapshot;
}
for (let i = 0; i < warm; i++) step();
globalThis.gc?.();

let inspector = null;
if (siteCount) {
  inspector = new Session(); inspector.connect();
  const post = (method, params) => new Promise((resolve, reject) => inspector.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true });
  inspector.finish = async () => (await post('HeapProfiler.stopSampling')).profile;
}
measuring = true;
const hashes = [];
// --profile-frame N: the sampling profiler runs for that measured frame alone (a frame that allocates megabytes once), and its
// largest leaf functions and 5-frame sites print (as KB, not KB a frame).
const profileFrame = Number(flag('profile-frame', -1));
if (profileFrame >= 0) {
  const session2 = new Session(); session2.connect();
  const post2 = (method, params) => new Promise((resolve, reject) => session2.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  await post2('HeapProfiler.enable');
  for (let i = 0; i < frames; i++) {
    if (i === profileFrame) await post2('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true });
    hashes.push(hashSnapshot(step()));
    if (i === profileFrame) {
      const { profile } = await post2('HeapProfiler.stopSampling');
      const leaves = new Map(), sites = new Map();
      const fn = f => `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber + 1}`;
      let total = 0;
      (function visit(node, stack) {
        const here = [...stack, fn(node.callFrame)];
        if (node.selfSize) { total += node.selfSize; leaves.set(here.at(-1), (leaves.get(here.at(-1)) ?? 0) + node.selfSize); const key = here.slice(-6).reverse().join(' < '); sites.set(key, (sites.get(key) ?? 0) + node.selfSize); }
        for (const child of node.children) visit(child, here);
      })(profile.head, []);
      console.log(`frame ${i}: ${(total / 1024).toFixed(0)} KB sampled`);
      for (const [name, bytes] of [...sites].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${(bytes / 1024).toFixed(0).padStart(7)} KB  ${name}`);
    }
  }
} else for (let i = 0; i < frames; i++) hashes.push(hashSnapshot(step()));
measuring = false;

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const kb = bytes => (bytes / 1024).toFixed(1);
if (!siteCount) {
  const row = (name, list) => {
    if (!list.length) return `${name.padEnd(11)} (no frames)`;
    const sorted = [...list].sort((x, y) => x - y), mean = sorted.reduce((x, y) => x + y, 0) / sorted.length;
    const keep = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.99))), trimmed = keep.reduce((x, y) => x + y, 0) / keep.length;
    return `${name.padEnd(11)} mean ${kb(mean).padStart(8)}  trimmed ${kb(trimmed).padStart(8)}  median ${kb(quantile(sorted, .5)).padStart(8)}  p90 ${kb(quantile(sorted, .9)).padStart(8)}  p99 ${kb(quantile(sorted, .99)).padStart(8)} KB a frame  (${list.length} frames)`;
  };
  for (const name of STEPS) console.log(row(name, samples.get(name)));
  console.log(row('whole call', frameSamples), `; ${scavenged} frames left out for a scavenge`);
}
if (inspector) {
  const profile = await inspector.finish();
  const label = f => `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber + 1}`;
  const fn = f => `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}`;
  const bump = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  const perStep = new Map(), totals = new Map();
  (function visit(node, stack, stepName, parentFn) {
    const here = [...stack, label(node.callFrame)];
    let st = stepName;
    if (parentFn && /^frame viewer\/sim-session\.mjs/.test(parentFn)) st = fn(node.callFrame);
    else if (parentFn && /^meterStep /.test(parentFn)) st = fn(node.callFrame);
    if (node.selfSize) {
      const key = st?.split(' ')[0] ?? '(outside)';
      bump(totals, key, node.selfSize);
      const entry = perStep.get(key) ?? perStep.set(key, { leaf: new Map(), sites: new Map() }).get(key);
      // a builtin (Array.prototype.map, Map.set, an iterator's next) has no file: it is attributed to its caller
      const leafName = node.callFrame.url ? fn(node.callFrame) : `${fn(node.callFrame).trim()} < ${parentFn ?? '?'}`;
      bump(entry.leaf, leafName, node.selfSize); bump(entry.sites, here.slice(-siteDepth).reverse().join(' < '), node.selfSize);
    }
    // the wrapper level keeps the step unset until its callee
    for (const child of node.children) visit(child, here, /^meterStep /.test(fn(node.callFrame)) ? null : st, fn(node.callFrame));
  })(profile.head, [], null, null);
  const perFrame = bytes => (bytes / 1024 / frames).toFixed(1).padStart(7);
  const top = (m, n) => [...m].sort((x, y) => y[1] - x[1]).slice(0, n);
  console.log('sampled, KB a frame by step:', top(totals, 12).map(([name, bytes]) => `${name} ${perFrame(bytes).trim()}`).join(', '));
  for (const name of wantSteps) {
    const entry = perStep.get(name);
    if (!entry) { console.log(`\n${name}: no samples`); continue; }
    console.log(`\n== ${name}: ${perFrame(totals.get(name))} KB a frame; leaves`);
    for (const [leaf, bytes] of top(entry.leaf, siteCount)) console.log(`${perFrame(bytes)}  ${leaf}`);
    console.log('  sites:');
    for (const [site, bytes] of top(entry.sites, siteCount)) console.log(`${perFrame(bytes)}  ${site}`);
  }
}

let digest = 0n;
for (const h of hashes) digest = (digest * 1099511628211n + BigInt('0x' + h)) & 0xffffffffffffffffn;
const digestText = digest.toString(16).padStart(16, '0');
console.log(JSON.stringify({ map, frames, warm, digest: digestText, distinct: new Set(hashes).size }));
if (seriesPath) await writeFile(seriesPath, JSON.stringify(series));
if (outPath) await writeFile(outPath, JSON.stringify({ map, frames, warm, digest: digestText, hashes }));
let status = 0;
if (comparePath) {
  const before = JSON.parse(await readFile(comparePath, 'utf8'));
  const first = hashes.findIndex((h, i) => h !== before.hashes[i]);
  if (before.frames !== frames || before.map !== map) { console.log(`compare: different run (${before.map} ${before.frames} frames)`); status = 1; }
  else if (first >= 0) { console.log(`compare: DIFFERENT at frame ${first} (${before.hashes[first]} against ${hashes[first]})`); status = 1; }
  else console.log(`compare: identical ${frames} frames (${digestText})`);
}
if (globalThis.__hn) console.log('hostnative', JSON.stringify([...globalThis.__hn].sort((a,b)=>b[1]-a[1]).slice(0,20)));
process.exit(status);
