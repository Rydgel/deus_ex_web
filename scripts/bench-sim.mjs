#!/usr/bin/env node
/** Headless simulation benchmark and state digest (host measurement only).
 *
 * Boots a map through Play's createGame (original LoadMap startup and Login),
 * holds the forward key through the installed input bindings and times
 * game.tick at 60 Hz. After the timed ticks it hashes every script property
 * of every Level.Actors entry (float bits, object identities, strings) so two
 * builds can be compared exactly: a host representation change must leave the
 * digest unchanged. See docs/play-frame-cost.md.
 *
 *   node scripts/bench-sim.mjs [--map 01_NYC_UNATCOIsland] [--warm 60] [--ticks 300]
 *     [--bypass] [--continue] [--render-feedback] [--tickstats] [--counts]
 *     [--digest-every 0] [--json out.json] [--dump fields.txt] [--bound-reads]
 *     [--scenario file.mjs] [--cpu-profile out.cpuprofile]
 *
 * --cpu-profile records a V8 CPU profile (node:inspector, 100 us sampling) of
 * the timed ticks only, so warm-up spawns and compilation stay out of it.
 *
 * --continue returns the declared zero value from unsupported natives (as the
 * census does) and --bypass skips the boundaries listed in bench-sim-hooks.mjs
 * (currently none). Both change behavior after the first boundary; use them
 * only for timing and for A/B digests where both sides use the same flags.
 * Tick errors are counted and the run continues; they are part of the digest.
 */
import {register} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {writeSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const map = flag('map', '01_NYC_UNATCOIsland'), warm = Number(flag('warm', 60)), ticks = Number(flag('ticks', 300));
const digestEvery = Number(flag('digest-every', 0)), continueMode = argv.includes('--continue');
if (argv.includes('--bypass')) register('./bench-sim-hooks.mjs', import.meta.url);

// Determinism for digests: the Level calendar (updateTime) reads Date and the
// window host / appSeconds read performance.now. Pin both to a simulated clock
// that advances 1/60 s per tick; timing uses the saved real clock.
const realNow = performance.now.bind(performance);
// Instruments in modules loaded after the pin (script-vm-rust.mjs
// SCRIPT_VM_IMPORT_TIME) time with the real clock through this global.
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
const {ScriptRuntime} = await import('../src/runtime/script-runtime.mjs');
const {zeroValue} = await import('../src/runtime/script-values.mjs');
const {gameDirectory} = await import('./game-directory.mjs');
const {createPlayerInputFixture} = await import('./player-input-fixture.mjs');

const UNSUPPORTED_NATIVE = /^(?:Unsupported original door native|Unimplemented original native|VM does not support native) (\d+)/;
const unsupported = new Map();
if (continueMode) {
  const invokeNative = ScriptRuntime.prototype.invokeNative;
  ScriptRuntime.prototype.invokeNative = function (call) {
    try { return invokeNative.call(this, call); }
    catch (error) {
      const match = UNSUPPORTED_NATIVE.exec(error?.message ?? '');
      if (!match || Number(match[1]) !== call.index) throw error;
      unsupported.set(call.index, (unsupported.get(call.index) ?? 0) + 1);
      const result = call.record?.function?.result;
      return result ? zeroValue(result) : undefined;
    }
  };
}

// --tickstats: wall time of each Actor.Tick by class (nested ticks included).
const tickStats = new Map();
if (argv.includes('--tickstats')) {
  const processActorTick = ScriptRuntime.prototype.processActorTick;
  ScriptRuntime.prototype.processActorTick = function (receiver, ...rest) {
    const start = realNow();
    try { return processActorTick.call(this, receiver, ...rest); }
    finally {
      let key = '?'; try { key = this.instance(receiver).cls.record.key; } catch { /* released */ }
      const entry = tickStats.get(key) ?? {calls: 0, ms: 0};
      entry.calls++; entry.ms += realNow() - start; tickStats.set(key, entry);
    }
  };
}
// --bound-reads: host binding get/set calls per tick by property key, over the
// timed ticks (the reads stage 1e moves into the object image).
const boundReads = new Map();
if (argv.includes('--bound-reads')) {
  const bindProperty = ScriptRuntime.prototype.bindProperty;
  ScriptRuntime.prototype.bindProperty = function (receiver, field, binding) {
    const count = kind => { const key = `${kind} ${field.key}`; boundReads.set(key, (boundReads.get(key) ?? 0) + 1); };
    const {get, set} = binding;
    return bindProperty.call(this, receiver, field, {...binding,
      get: () => { if (globalThis.__boundReadsOn) count('get'); return get(); },
      set: value => { if (globalThis.__boundReadsOn) count('set'); return set(value); }});
  };
}
const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const log = message => process.stderr.write(`[bench-sim] ${Math.round(realNow())} ${message}\n`);
log(`${files.length} files; reading ${map}`);
const assets = new AssetStore(files), asset = await assets.get(map);
log(`boot ${map}`);
const bootStart = realNow();
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const bootMs = realNow() - bootStart;
log(`booted in ${Math.round(bootMs)} ms`);
const runtime = game.doors.scriptRuntime.runtime;
const fixture = createPlayerInputFixture(game);
// --scenario file.mjs: a scripted workload for differential runs. The module's
// default export, called with {game, runtime}, returns a function run before
// each tick with the tick index (warm ticks first). It drives inputs the map
// alone would not produce (validate-walk-loop-branches.mjs); same-mode digests
// only, never a claim about the original game.
const scenarioPath = flag('scenario', null);
const scenario = scenarioPath ? (await import(pathToFileURL(resolve(scenarioPath)).href)).default({game, runtime}) : null;
let tickIndex = 0;

// --render-feedback: Play's actor-mesh layer copies TimeSeconds to the
// LastRenderTime of every drawn mesh actor (actor-render-feedback.mjs), and
// scripts read it through LastRendered(). Headless, nothing is drawn, so NPC
// branches that depend on being seen never run. This stamps visible,
// undeleted mesh actors whose Location lies inside an approximate player-view
// frustum (75 degrees horizontal, 3:2). It is a workload approximation for
// timing and same-mode digests, not the original visibility test.
const renderFeedback = argv.includes('--render-feedback');
function stampRendered() {
  const player = game.player.collisionActor, level = runtime.levelFor(player);
  const read = (actor, name) => runtime.readNamed(actor, name);
  const now = Math.fround(read(level.actors[0], 'TimeSeconds'));
  const eye = read(player, 'Location'), [pitchUnits, yawUnits] = read(player, 'ViewRotation');
  const yaw = yawUnits * Math.PI / 32768, pitch = pitchUnits * Math.PI / 32768;
  const forward = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
  const right = [-Math.sin(yaw), Math.cos(yaw), 0];
  const up = [-Math.sin(pitch) * Math.cos(yaw), -Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch)];
  const tanH = Math.tan(37.5 * Math.PI / 180), tanV = tanH / 1.5;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const actor of level.actors) {
    if (!actor || actor === player) continue;
    let mesh;
    try { mesh = read(actor, 'Mesh'); } catch { continue; }
    if (!mesh || !['LodMesh', 'Mesh'].includes(mesh.kind) || read(actor, 'bHidden') || read(actor, 'bDeleteMe')) continue;
    const at = read(actor, 'Location'), d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const z = dot(d, forward);
    if (!(z > 0) || Math.abs(dot(d, right)) > z * tanH + 64 || Math.abs(dot(d, up)) > z * tanV + 64) continue;
    runtime.writeNamed(actor, 'LastRenderTime', now);
  }
}
const errors = new Map();
const step = () => {
  simulatedMs += 1000 / 60;
  if (scenario) scenario(tickIndex);
  tickIndex++;
  try { game.tick(1 / 60); if (renderFeedback) stampRendered(); }
  catch (error) {
    const message = String(error?.message ?? error).split('\n')[0];
    errors.set(message, (errors.get(message) ?? 0) + 1);
  }
};

/** Every property of every Level.Actors entry, in array order, but the
 * names in BENCH_DIGEST_SKIP (comma-separated): a change that moves a value
 * into a property compares against the code before it with that property
 * left out. */
const digestSkip = new Set((process.env.BENCH_DIGEST_SKIP ?? '').split(',').filter(Boolean));
function digest(dump = null) {
  const hash = createHash('sha256'), bits = new DataView(new ArrayBuffer(8));
  const identity = value => {
    try { const instance = runtime.instance(value); return `@${value.name ?? '?'}:${instance.cls.record.key}`; }
    catch { return null; }
  };
  // Class and other metadata values are plain host graphs; a reference with a
  // string key is recorded by that key, and each property walk is bounded.
  let budget = 0;
  const put = (value, depth = 0) => {
    if (depth > 8 || --budget < 0) { hash.update('<bound>'); return; }
    if (value === null || value === undefined) { hash.update(`${value};`); return; }
    switch (typeof value) {
      case 'number': bits.setFloat64(0, value); hash.update(`n${bits.getBigUint64(0).toString(16)};`); return;
      case 'boolean': case 'bigint': hash.update(`${typeof value[0]}${value};`); return;
      case 'string': hash.update(`s${value.length}:${value};`); return;
      case 'function': hash.update('fn;'); return;
    }
    if (ArrayBuffer.isView(value)) { hash.update(`t${value.length};`); for (const v of value) put(v, depth + 1); return; }
    const id = identity(value);
    if (id) { hash.update(id); return; }
    if (Array.isArray(value)) { hash.update(`[${value.length}`); for (const v of value) put(v, depth + 1); hash.update(']'); return; }
    // Script values are plain arrays/objects; any other host object (a level,
    // an asset, a native heap view) is recorded by its constructor only.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) { hash.update(`<${value.constructor?.name ?? '?'}>`); return; }
    if (typeof value.key === 'string' && depth > 0) { hash.update(`#${value.key}`); return; }
    if (typeof value.key === 'string' && (value.record || value.asset || value.linkedClass)) { hash.update(`#${value.key}`); return; }
    hash.update('{');
    for (const key of Object.keys(value).sort()) { hash.update(`${key}=`); put(value[key], depth + 1); }
    hash.update('}');
  };
  const level = runtime.levelFor(game.player.collisionActor);
  hash.update(`time ${level.timeSeconds};`);
  for (const actor of level.actors) {
    if (!actor) { hash.update('null-actor;'); continue; }
    let instance;
    try { instance = runtime.instance(actor); } catch (error) { hash.update(`detached ${actor.name};`); continue; }
    hash.update(`actor ${actor.name} ${instance.cls.record.key};`);
    for (let cls = instance.cls; cls; cls = cls.base) for (const field of cls.propertyOrder) {
      if (digestSkip.size && digestSkip.has(field.metadata.name ?? field.name)) continue;
      hash.update(`${field.metadata.name ?? field.name}=`);
      if (process.env.BENCH_TRACE) writeSync(2, `${actor.name}.${field.metadata.name ?? field.name}\n`);
      budget = 4096;
      const before = dump ? hash.copy().digest('hex') : null;
      try { put(runtime.fieldReference(actor, field).get()); }
      catch (error) { hash.update(`!${String(error?.message).split('\n')[0]};`); }
      if (dump) dump.push(`${actor.name}.${field.metadata.name ?? field.name} ${hash.copy().digest('hex').slice(0, 12)} ${before.slice(0, 12)}`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

// --script-profile: inclusive and self wall time per UnrealScript function
// (ScriptRuntime.executeScript), keyed by the original function path.
const scriptProfile = new Map();
if (argv.includes('--script-profile')) {
  const executeScript = runtime.executeScript;
  const stack = [];
  runtime.executeScript = function (fn, receiver, locals) {
    const key = fn.compiled?.name ?? fn.entry?.path ?? '?';
    const frame = {start: realNow(), child: 0};
    stack.push(frame);
    try { return executeScript.call(this, fn, receiver, locals); }
    finally {
      stack.pop();
      const total = realNow() - frame.start;
      if (stack.length) stack.at(-1).child += total;
      const entry = scriptProfile.get(key) ?? {calls: 0, total: 0, self: 0};
      entry.calls++; entry.total += total; entry.self += total - frame.child;
      scriptProfile.set(key, entry);
    }
  };
}
// --script-frames: run each UnrealScript function through a trampoline named
// after it (uscript_Class_Function), so CPU profiles attribute JS time to the
// UnrealScript function executing it.
if (argv.includes('--script-frames')) {
  const executeScript = runtime.executeScript, trampolines = new Map();
  runtime.executeScript = function (fn, receiver, locals) {
    const path = fn.compiled?.name ?? fn.entry?.path ?? '?';
    let trampoline = trampolines.get(path);
    if (!trampoline) {
      const name = `uscript_${path.replace(/[^A-Za-z0-9]/g, '_')}`;
      trampoline = new Function('run', `return function ${name}(self, fn, receiver, locals) { return run.call(self, fn, receiver, locals); }`)(executeScript);
      trampolines.set(path, trampoline);
    }
    return trampoline(this, fn, receiver, locals);
  };
}
// --read-sites: count readNamed/writeNamed calls by JS call site over 20 ticks.
if (argv.includes('--read-sites')) {
  const sites = new Map();
  for (const name of ['readNamed', 'writeNamed', 'fieldReference']) {
    const original = runtime[name];
    runtime[name] = function (...args) {
      if (globalThis.__sitesOn) {
        const frames = new Error().stack.split('\n').slice(2, 5).map(l => l.trim().replace(/^at /, '').replace(/\(.*\/(src|scripts)\//, '(').replace(/:\d+\)$/, ')'));
        const key = `${name} ${args[1] && typeof args[1] === 'string' ? args[1] : ''} <- ${frames.join(' <- ')}`;
        sites.set(key, (sites.get(key) ?? 0) + 1);
      }
      return original.apply(this, args);
    };
  }
  for (let i = 0; i < 60; i++) step();
  globalThis.__sitesOn = true;
  for (let i = 0; i < 20; i++) step();
  globalThis.__sitesOn = false;
  const bySite = new Map();
  for (const [key, n] of sites) { const site = key.replace(/^(\w+) \S* <- /, '$1 <- '); bySite.set(site, (bySite.get(site) ?? 0) + n); }
  console.error([...bySite].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${(n / 20).toFixed(0).padStart(6)} ${k}`).join('\n'));
  process.exit(0);
}
// --counts: calls per tick of the runtime's main work entry points.
const counts = new Map();
if (argv.includes('--counts')) {
  // Counts are attributed to the class whose Actor.Tick is running (or
  // 'level' outside one); nested ticks attribute to the innermost.
  let ticking = 'level';
  const count = (target, name, label = name) => {
    const original = target[name];
    target[name] = function (...args) {
      const key = `${ticking} ${label}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (name !== 'processActorTick') return original.apply(this, args);
      const outer = ticking;
      try { ticking = this.instance(args[0]).cls.record.key.split('.').at(-1); } catch { ticking = '?'; }
      try { return original.apply(this, args); } finally { ticking = outer; }
    };
  };
  for (const name of ['callFunction', 'processEvent', 'invokeNative', 'readNamed', 'writeNamed', 'fieldReference',
    'readField', 'writeField', 'boundField', 'instance', 'processActorTick', 'processActorPhysics'])
    count(runtime, name);
  for (const name of ['fieldValue', 'localValue', 'fieldReference', 'localReference', 'invoke', 'invokeNative'])
    count(runtime.services, name, `vm.${name}`);
  // Level collision queries, with wall time.
  const queries = runtime.levelFor(game.player.collisionActor).hash;
  for (const name of ['lineCheck', 'multiLineCheck', 'pointCheck', 'actorEncroachmentCheck']) {
    if (typeof queries?.[name] !== 'function') continue;
    const original = queries[name];
    queries[name] = function (...args) {
      const start = realNow();
      try { return original.apply(this, args); }
      finally {
        counts.set(`${ticking} hash.${name}`, (counts.get(`${ticking} hash.${name}`) ?? 0) + 1);
        counts.set(`${ticking} hash.${name}.us`, (counts.get(`${ticking} hash.${name}.us`) ?? 0) + (realNow() - start) * 1000);
      }
    };
  }
}
// --microbench: ns per readNamed on live actors after boot (host measurement).
if (argv.includes('--microbench')) {
  for (let i = 0; i < 30; i++) step();
  const level = runtime.levelFor(game.player.collisionActor);
  const actors = level.actors.filter(Boolean);
  const pawns = actors.filter(a => { try { return runtime.readNamed(a, 'bIsPawn'); } catch { return false; } });
  const time = (label, fn, n) => { fn(); const t = realNow(); for (let i = 0; i < n; i++) fn(); const ns = (realNow() - t) * 1e6 / n;
    console.error(`${label}: ${ns.toFixed(1)} ns`); };
  let sink = 0;
  const one = pawns[0];
  time('readNamed Health (same actor)', () => { sink += runtime.readNamed(one, 'Health'); }, 1e6);
  time('readNamed Location (same actor)', () => { sink += runtime.readNamed(one, 'Location')[0]; }, 1e6);
  let k = 0;
  time('readNamed Health (rotating pawns)', () => { sink += runtime.readNamed(pawns[k++ % pawns.length], 'Health'); }, 1e6);
  time('readNamed bHidden (all actors)', () => { sink += runtime.readNamed(actors[k++ % actors.length], 'bHidden') ? 1 : 0; }, 1e6);
  time('instance (all actors)', () => { sink += runtime.instance(actors[k++ % actors.length]) ? 1 : 0; }, 1e6);
  time('writeNamed Health', () => { runtime.writeNamed(one, 'Health', 100); }, 1e6);
  if (process.env.MB_NATIVES) {
    const fast = new Function('o', 'return %HasFastProperties(o)');
    const fastCount = actors.filter(a => fast(a)).length;
    const maps = new Set(actors.map(a => Object.getOwnPropertyNames(a).join(',')));
    console.error(`fast-properties receivers ${fastCount}/${actors.length}; distinct own-key sets ${maps.size}`);
    console.error('runtime fast', fast(runtime), 'own props', Reflect.ownKeys(runtime).length,
      'objects fast', fast(runtime.objects), 'level fast', fast(level), 'instance fast', fast(runtime.instance(actors[5])),
      'services fast', fast(runtime.services));
    const sample = actors[5];
    console.error('sample own keys', Reflect.ownKeys(sample).map(String).join(','));
    console.error('proto', Object.getPrototypeOf(sample)?.constructor?.name);
    const weak = runtime.instances;
    time('WeakMap instances.get (all actors)', () => { sink += weak.get(actors[k++ % actors.length]) ? 1 : 0; }, 1e6);
    const key = runtime.instanceKey;
    time('symbol load only (all actors)', () => { sink += actors[k++ % actors.length][key] ? 1 : 0; }, 1e6);
    time('name load (all actors)', () => { sink += actors[k++ % actors.length].name ? 1 : 0; }, 1e6);
  }
  console.error('sink', sink > 0);
  process.exit(0);
}
fixture.key('KeyW', true);
log('warming');
for (let i = 0; i < warm; i++) step();
log('timing');
tickStats.clear(); counts.clear(); scriptProfile.clear(); globalThis.__scriptVmStatsReset?.(); globalThis.__scriptVmImportTime?.clear(); if (argv.includes('--vm-counts')) { globalThis.__stmtCounts = new Map(); globalThis.__exprCounts = new Map(); }
const times = [], digests = [];
const profilePath = flag('cpu-profile', null);
let profiler = null;
if (profilePath) {
  const {Session} = await import('node:inspector');
  profiler = new Session(); profiler.connect();
  const post = (method, params) => new Promise((ok, fail) => profiler.post(method, params, (e, r) => e ? fail(e) : ok(r)));
  profiler.call = post;
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval', {interval: 100}); await post('Profiler.start');
}
globalThis.__callerOn?.(true);
const cpuStart = process.cpuUsage();
for (let i = 0; i < ticks; i++) {
  globalThis.__boundReadsOn = true;
  const start = realNow(); step(); times.push(realNow() - start);
  globalThis.__boundReadsOn = false;
  if (digestEvery && (i + 1) % digestEvery === 0) digests.push(digest());
}
const cpuUsed = process.cpuUsage(cpuStart);
if (profiler) await writeFile(profilePath, JSON.stringify((await profiler.call('Profiler.stop')).profile));
globalThis.__callerOn?.(false);
fixture.key('KeyW', false);
log('digest');
if (globalThis.__riderVerify) report.riderVerify = globalThis.__riderVerify;
const dumpLines = flag('dump', null) ? [] : null;
const sorted = times.toSorted((a, b) => a - b), pct = p => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(2);
const report = {map, warm, ticks, bypass: argv.includes('--bypass'), continue: continueMode, renderFeedback, bootMs: Math.round(bootMs),
  tickMs: {mean: +(times.reduce((a, b) => a + b, 0) / ticks).toFixed(2), median: pct(0.5), p95: pct(0.95), max: pct(1)},
  // Process CPU per tick (user+system, all threads incl. GC helpers): less
  // sensitive to preemption by other processes than the wall-clock times.
  cpuMsPerTick: +((cpuUsed.user + cpuUsed.system) / 1000 / ticks).toFixed(2),
  digest: digest(dumpLines), digests, errors: Object.fromEntries(errors), unsupportedNatives: Object.fromEntries(unsupported)};
if (scriptProfile.size) {
  const row = ([key, e]) => `self ${(e.self / ticks).toFixed(3)} incl ${(e.total / ticks).toFixed(3)} ms ${(e.calls / ticks).toFixed(1)}/tick ${key}`;
  report.scriptProfile = [...scriptProfile].sort((a, b) => b[1].self - a[1].self).slice(0, 30).map(row);
  report.scriptCalls = [...scriptProfile].sort((a, b) => b[1].calls - a[1].calls).slice(0, 15).map(row);
}
if (globalThis.__stmtCounts) {
  const st = globalThis.__stmtCounts, ex = globalThis.__exprCounts;
  report.vmCounts = {statements: Math.round([...st.values()].reduce((a, b) => a + b, 0) / ticks),
    expressions: Math.round([...ex.values()].reduce((a, b) => a + b, 0) / ticks),
    top: [...st].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${Math.round(n / ticks)} stmts ${Math.round((ex.get(k) ?? 0) / ticks)} exprs ${k}`)};
}
if (counts.size) {
  const total = new Map();
  for (const [key, n] of counts) { const label = key.split(' ')[1]; total.set(label, (total.get(label) ?? 0) + n); }
  report.countsPerTick = Object.fromEntries([...total].sort((a, b) => b[1] - a[1]).map(([key, n]) => [key, Math.round(n / ticks)]));
  report.countsByClass = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([key, n]) => `${(n / ticks).toFixed(0)} ${key}`);
}
if (argv.includes('--bound-reads')) {
  report.boundReadsPerTick = Object.fromEntries([...boundReads].sort((a, b) => b[1] - a[1])
    .map(([key, n]) => [key, +(n / ticks).toFixed(2)]));
  // The keys the Rust interpreter leaves to JavaScript on bound receivers.
  report.boundKeys = [...runtime.boundKeys ?? []].sort();
}
if (tickStats.size) report.tickStats = [...tickStats].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)
  .map(([key, e]) => `${(e.ms / ticks).toFixed(3)} ms ${(e.calls / ticks).toFixed(1)}/tick ${(e.ms / e.calls * 1000).toFixed(0)} us ${key}`);
// SCRIPT_VM_IMPORT_TIME=1 (script-vm-rust.mjs timedImports): JavaScript wall
// time behind each Rust VM import per tick, self (nested imports excluded)
// and inclusive. An instrumented run: not an A/B timing.
const importTime = globalThis.__scriptVmImportTime;
if (importTime?.size) {
  let self = 0, incl = 0, calls = 0;
  for (const e of importTime.values()) { self += e.self; incl += e.ms; calls += e.calls; }
  report.importTimeTotals = {selfMsPerTick: +(self / ticks).toFixed(3), inclusiveMsPerTick: +(incl / ticks).toFixed(3), callsPerTick: +(calls / ticks).toFixed(1)};
  report.importTimes = [...importTime].sort((a, b) => b[1].self - a[1].self).slice(0, 40)
    .map(([key, e]) => `${(e.self / ticks).toFixed(3)} ms self ${(e.ms / ticks).toFixed(3)} ms incl ${(e.calls / ticks).toFixed(1)}/tick ${(e.self / e.calls * 1e6).toFixed(0)} ns ${key}`);
}
if (dumpLines) await writeFile(flag('dump'), dumpLines.join('\n'));
if (flag('json', null)) await writeFile(flag('json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(0);
