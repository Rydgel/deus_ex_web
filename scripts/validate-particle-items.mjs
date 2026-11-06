#!/usr/bin/env node
/** The render-iterator protocol's CurrentItem loop in Rust (particles.rs `particle_items`, script-particles.mjs `particleIteratorItems`,
 * docs/particles.md "The loop in Rust"), on a booted map, outside the browser.
 *
 * Boots a map through Play's createGame, holds every ParticleProxy as drawn (the page's render feedback writes LastRenderTime, which
 * un-freezes the generators), ticks, and after each tick runs SetupDynamics' scan over the level and three child frames' rescans
 * (sim-session.mjs childDynamics) through sprite-scan.mjs, as the simulation worker does. It prints a digest of every sprite record
 * the runs made, in order, and of the iterators' and proxies' fields at the end, and the loop's counters.
 *
 *   node scripts/validate-particle-items.mjs --map 15_Area51_Bunker [--ticks 600] [--rescans 3]    one run, in the mode PARTICLE_ITEMS holds
 *   node scripts/validate-particle-items.mjs --map NAME --compare                                    runs js, rust and verify and compares them
 *
 * `--compare` runs three child processes (js: the reference loop with FarMoveActor in JavaScript, FAR_MOVE=js; rust; verify: every Rust
 * run repeated by the reference from the same state, comparing every written field). The digests must be equal, the verify run must
 * have compared a nonzero number of steps, and no run may have thrown. A map without a ParticleGenerator reports so and passes nothing.
 */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
// Run with no arguments (the validator runner's call): the bunker and 02_NYC_Street compared in all three modes, with particles put in solid.
const bare = argv.length === 0;
const map = option('map', '15_Area51_Bunker'), ticks = Number(option('ticks', bare ? 240 : 600)), rescans = Number(option('rescans', bare ? 1 : 3));
// --inject N: every N ticks, two active particles of each particle iterator are put inside solid geometry, so FindSpot refuses their move (the
// original's false: the proxy untouched, the particle deleted) in all three modes.
const inject = Number(option('inject', bare ? 10 : 0));

if (bare) {
  // (the runner passes no argument: two maps, one process each)
  for (const name of ['15_Area51_Bunker', '02_NYC_Street']) {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--map', name, '--ticks', '240', '--rescans', '1', '--inject', '10', '--compare'],
      {encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit']});
    console.log(out.trim().split('\n').at(-1));
  }
  process.exit(0);
}
if (argv.includes('--compare')) {
  const script = fileURLToPath(import.meta.url), results = {};
  for (const [name, env] of [['js', {PARTICLE_ITEMS: 'js', FAR_MOVE: 'js'}], ['rust', {PARTICLE_ITEMS: 'rust'}], ['verify', {PARTICLE_ITEMS: 'verify', FAR_MOVE: 'verify'}]]) {
    const out = execFileSync(process.execPath, [script, '--map', map, '--ticks', String(ticks), '--rescans', String(rescans), '--inject', String(inject)],
      {env: {...process.env, ...env}, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit']});
    results[name] = JSON.parse(out.trim().split('\n').at(-1));
    console.log(name, JSON.stringify(results[name]));
  }
  const failures = [];
  if (!results.js.sprites) failures.push(`${map}: no sprite records were made (no iterating generator in view)`);
  for (const name of ['rust', 'verify']) if (results[name].digest !== results.js.digest) failures.push(`${name}: digest ${results[name].digest} != js ${results.js.digest}`);
  if (!results.verify.counts.verifiedSteps) failures.push('verify compared no steps');
  if (inject && !results.rust.counts.failed) failures.push('no move was refused by FindSpot (--inject found no solid point)');
  if (!results.rust.counts.steps) failures.push('the Rust loop ran no steps');
  if (failures.length) { console.error(`FAIL validate-particle-items\n${failures.join('\n')}`); process.exit(1); }
  console.log(`PASS validate-particle-items ${map}: js, rust and verify agree over ${results.js.sprites} sprite records; verify compared ` +
    `${results.verify.counts.verified} runs, ${results.verify.counts.verifiedSteps} steps${inject ? `; ${results.verify.counts.failed} particles deleted by a refused move` : ''}`);
  process.exit(0);
}

// Determinism: the clock the Level calendar reads is a simulated one (as scripts/bench-sim.mjs does it).
const realNow = performance.now.bind(performance);
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', {value: () => simulatedMs, configurable: true});
globalThis.__realNow = realNow;

const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createGame} = await import('../src/viewer/game.mjs');
const {createSpriteScan} = await import('../src/viewer/sprite-scan.mjs');
const {constructRenderIterator, renderIteratorNativeClass} = await import('../src/runtime/script-render-iterator.mjs');
const {particleItemCounts} = await import('../src/runtime/script-vm-particles.mjs');

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime;
const read = (actor, name) => runtime.readNamed(actor, name);
const MEMBER = name => `deusex.particleiterator.sparticle.${name}`;

// sim-session.mjs's constructIterator.
const iteratorNatives = {
  write: (identity, name, value) => runtime.writeNamed(identity, name, value),
  isActor: record => runtime.classIsA(runtime.instance(record.identity).cls, runtime.actorClass.record),
  destroyObjectBase: receiver => runtime.destroyObjectBase(receiver),
};
const constructIterator = (cls, outer) => {
  const linked = [...runtime.linkedClasses].find(candidate => candidate.record.key === (cls.key ?? cls.record?.key));
  const row = renderIteratorNativeClass(linked);
  const native = runtime.instance(outer).nativeObject;
  if (!Number.isInteger(native.index) && !Number.isInteger(native.hashIndex)) native.hashIndex = runtime.measuredObjectIndex(outer);
  return runtime.constructObject(linked, {outer: native, name: 'None', flags: 0, template: null}, {
    ...runtime.actorLifecycle.construction, validate: () => true, initNativeProperties: () => {},
    nativeConstructor: object => constructRenderIterator(object, row, iteratorNatives)});
};
const spriteScan = createSpriteScan(runtime, {player: () => game.player.collisionActor, constructIterator, frand: () => runtime.rng.frand()});

const hash = createHash('sha256'), bits = new DataView(new ArrayBuffer(8));
const put = value => {
  if (typeof value === 'number') { bits.setFloat64(0, value); hash.update(`n${bits.getBigUint64(0).toString(16)};`); }
  else if (Array.isArray(value)) { hash.update('['); value.forEach(put); hash.update(']'); }
  else if (value && typeof value === 'object') { for (const key of Object.keys(value).sort()) { hash.update(`${key}:`); put(value[key]); } }
  else hash.update(`${value};`);
};
const level = () => runtime.levelFor(game.player.collisionActor);
// The proxies, found again every 30 ticks (the generators spawn theirs at start; a destroyed one is released with its generator).
let proxyList = [], proxyAt = -1e9;
const proxies = tick => {
  if (tick - proxyAt >= 30) {
    proxyAt = tick;
    proxyList = level().actors.filter(actor => actor && runtime.instance(actor).cls.record.key === 'deusex.particleproxy');
  }
  return proxyList.filter(actor => !read(actor, 'bDeleteMe'));
};
const recordSprites = out => { for (const sprite of out.sprites) put({h: sprite.handle, o: sprite.order, l: sprite.location, d: sprite.drawScale, g: sprite.scaleGlow, s: sprite.style}); return out.sprites.length; };

// Solid points near the player (a point check of a zero extent on the world, as FindSpot's: 0 is inside), found once with a seeded walk.
const solidPoints = [];
if (inject) {
  let state = 0x5a17;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const around = read(game.player.collisionActor, 'Location');
  for (let i = 0; i < 40000 && solidPoints.length < 24; i++) {
    const point = around.map(v => Math.fround(v + (random() * 2 - 1) * 2500));
    if (level().hash.pointCheck(point, [0, 0, 0], 0, 0) === 0) solidPoints.push(point);
  }
  if (!solidPoints.length) throw new Error('--inject found no solid point near the player');
}
let injected = 0;
const injectSolid = tick => {
  if (!inject || tick % inject) return;
  for (const actor of level().actors) {
    if (!actor || !read(actor, 'RenderIteratorClass')) continue;
    const iterator = read(actor, 'RenderInterface');
    if (!iterator || runtime.instance(iterator).cls.record.key !== 'deusex.particleiterator') continue;
    const particles = read(iterator, 'Particles'), live = particles.flatMap((p, i) => p[MEMBER('bactive')] ? [i] : []);
    for (const i of [live[0], live[2]]) if (i !== undefined) particles[i][MEMBER('location')] = solidPoints[injected++ % solidPoints.length];
    runtime.writeNamed(iterator, 'Particles', particles);
  }
};
let sprites = 0, errors = 0, firstError = null;
for (let tick = 0; tick < ticks; tick++) {
  simulatedMs += 1000 / 60;
  try {
    game.tick(1 / 60);
    // The page's render feedback: a drawn proxy's LastRenderTime is the level's clock.
    const now = Math.fround(read(level().actors[0], 'TimeSeconds'));
    for (const proxy of proxies(tick)) runtime.writeNamed(proxy, 'LastRenderTime', now);
    injectSolid(tick);
    const scan = spriteScan.scan();
    sprites += recordSprites(scan);
    for (let k = 0; k < rescans; k++) sprites += recordSprites(spriteScan.rescan(scan.iteratorIndex));
  } catch (error) {
    errors++;
    firstError ??= String(error?.stack ?? error).split('\n').slice(0, 4).join(' | ');
    if (!/^(Error: )?PARTICLE_ITEMS=verify|FAR_MOVE=verify/.test(String(error?.message ?? error))) continue;
    break;
  }
}
// The iterators' and proxies' end state.
for (const actor of level().actors) {
  if (!actor || !read(actor, 'RenderIteratorClass')) continue;
  const iterator = read(actor, 'RenderInterface');
  if (!iterator || runtime.instance(iterator).cls.record.key !== 'deusex.particleiterator') continue;
  put({name: actor.name, index: read(iterator, 'Index'), next: read(iterator, 'nextFreeParticle'),
    particles: read(iterator, 'Particles').map(p => Object.values(p))});
  const proxy = read(iterator, 'proxy');
  if (proxy) put({proxy: proxy.name, at: ['Location', 'OldLocation', 'DrawScale', 'ScaleGlow', 'bJustTeleported', 'bHidden'].map(name => read(proxy, name)),
    zone: read(proxy, 'Region')['engine.actor.pointregion.zonenumber']});
}
console.log(JSON.stringify({map, ticks, mode: process.env.PARTICLE_ITEMS ?? 'rust', inject, injected, sprites, errors, firstError, digest: hash.digest('hex').slice(0, 16),
  counts: {...particleItemCounts}, iterators: [...level().actors].filter(a => a && read(a, 'RenderInterface')).length}));
