/**
 * Native 722 Actor.ParabolicTrace against the original Engine.dll under Unicorn
 * (scripts/native-parabolic-trace-oracle.py): the whole exec 0x1036e190 with its
 * argument defaults and the worker 0x1036c0a0, the slide helper 0x1036ca90 and
 * TwoWallAdjust 0x10323770 on their own. The two level services the worker calls
 * (PointRegion, MultiLineCheck) are fixture doubles in the oracle; the validator
 * replays their recorded answers into src/runtime/script-actor-parabolic-trace.mjs,
 * so each case also proves the translation issues the same service calls, with the
 * same float32 arguments, in the same order. Every comparison is on float32 words.
 *
 *   NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-parabolic-trace.mjs
 *   ... --coverage      also report the worker/slide/TwoWallAdjust instructions the corpus never executed
 *   ... --no-mutants    skip the planted-mutation check
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { f32bits, f32num, refValue } from '../src/runtime/script-vm.mjs';
import { setX87Precision } from '../src/runtime/x87-precision.mjs';
import { gameDirectory } from './game-directory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(here, '..', 'src', 'runtime', 'script-actor-parabolic-trace.mjs');
const W = f32bits, N = f32num;
const vec = v => v.map(W);

// ---- deterministic corpus -------------------------------------------------------------------------------------
let seed = 0x2f6a1c;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const range = (lo, hi) => lo + rnd() * (hi - lo);
const pick = list => list[Math.floor(rnd() * list.length)];
const chance = p => rnd() < p;
const unit = () => {
  const v = [range(-1, 1), range(-1, 1), range(-1, 1)], l = Math.hypot(...v) || 1;
  return v.map(c => c / l);
};

const zone = (over = {}) => ({ gravity: vec([0, 0, -950]), velocity: vec([0, 0, 0]), terminal: W(2500), water: false, ...over });
const sceneOf = (parts = {}) => ({ zones: [zone()], planes: [{ normal: [0, 0, 1], offset: 0 }], ...parts });

function randomScene({ actors = false, hazards = true } = {}) {
  const scene = sceneOf();
  scene.zones = [zone({
    gravity: vec([chance(.2) ? range(-60, 60) : 0, chance(.2) ? range(-60, 60) : 0, chance(.15) ? 0 : -range(300, 1300)]),
    velocity: vec(chance(.25) ? [range(-40, 40), range(-40, 40), range(-10, 10)] : [0, 0, 0]),
    terminal: W(chance(.3) ? range(150, 900) : range(1500, 4000)),
  })];
  scene.planes = [{ normal: chance(.1) ? unitFloor() : [0, 0, 1], offset: range(-30, 20) }];
  if (hazards && chance(.55)) scene.planes.push({ normal: wallNormal(), offset: -range(120, 700) });
  if (hazards && chance(.35)) scene.planes.push({ normal: wallNormal(), offset: -range(120, 700) });
  if (hazards && chance(.15)) scene.planes.push({ normal: [0, 0, -1], offset: -range(250, 900) });
  scene.regions = [];
  scene.defaultRegion = { zone: 0, zoneNumber: 1 + Math.floor(rnd() * 3), leaf: Math.floor(rnd() * 50) };
  if (hazards && chance(.15)) {
    scene.zones.push(zone({ water: true, gravity: vec([0, 0, -range(200, 900)]), terminal: W(range(100, 600)) }));
    scene.regions.push({ min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, range(-200, 60)], zone: 1, zoneNumber: 2, leaf: 3 });
  }
  if (hazards && chance(.1)) scene.regions.push({ min: [range(100, 600), -1e9, -1e9], max: [1e9, 1e9, 1e9], zone: 0, zoneNumber: 0, leaf: 4 });
  if (actors) {
    scene.actors = [];
    const count = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < count; i++) {
      scene.actors.push({ center: [range(-100, 400), range(-200, 200), range(10, 120)], radius: range(8, 60), halfHeight: range(10, 60),
        owner: chance(.25) ? pick([1, 2]) : null, blocks: chance(.75) });
    }
  }
  return scene;
}
function wallNormal() {
  const a = rnd() * Math.PI * 2, tilt = chance(.2) ? range(.05, .6) : 0;
  return [Math.cos(a) * Math.sqrt(1 - tilt * tilt), Math.sin(a) * Math.sqrt(1 - tilt * tilt), tilt];
}
function unitFloor() { const t = range(.05, .75); return [Math.sin(t), 0, Math.cos(t)]; }

const specials = {
  granularity: [0.025, .01, .005, .004999, .0049, 0, -1, 1, .999, 1.5, 2, 100, .3, .12345],
  maxTime: [5, 0.01, 0.05, .1, .5, 1, 2, 3, 8],
  elasticity: [.9, 0, .2, .5, .75, 1, 1.3],
  landingSpeed: [60, 0, 10, 25, 120, 400, -5],
};

const execCases = [];
function execCase(id, { actor, params, scene, outRef = true, count = 10, cw }) {
  execCases.push({ id, mode: 'exec', actor, params: params.map((p, i) => (i >= count ? SKIP : p)), scene, outRef, count, cw });
}
const vecParam = v => ({ words: vec(v) }), floatParam = x => ({ words: [W(x)] }), boolParam = b => ({ words: [b ? 1 : 0] });
const SKIP = { skip: true };
const OUT = () => ({ out: true, words: [0, 0, 0] });
const baseActor = (over = {}) => ({ location: vec([0, 0, 100]), velocity: vec([200, 40, 150]), radius: W(4), height: W(4), collide: 1, bounce: 0, ...over });

// A readable core set first.
const floor = sceneOf();
execCase('default-landing', { actor: baseActor(), params: [OUT(), ...Array(9).fill(SKIP)], scene: floor });
execCase('default-no-out-ref', { actor: baseActor(), params: [OUT(), ...Array(9).fill(SKIP)], scene: floor, outRef: false });
execCase('default-bounce-actor', { actor: baseActor({ bounce: 1 }), params: [OUT(), ...Array(9).fill(SKIP)], scene: floor });
execCase('free-flight-timeout', { actor: baseActor({ velocity: vec([20, 0, 20]) }), params: [OUT(), SKIP, SKIP, SKIP, SKIP, floatParam(.5), ...Array(4).fill(SKIP)], scene: floor });
execCase('nine-args-like-GetProjectileList', { actor: baseActor(), params: [OUT(), vecParam([300, -80, 120]), vecParam([10, 20, 90]), boolParam(true), vecParam([5, 5, 6]), floatParam(2), floatParam(.2), boolParam(false), floatParam(60), SKIP], scene: floor, count: 9 });
execCase('ten-args-like-AISafeToThrow', { actor: baseActor(), params: [OUT(), vecParam([500, 100, 300]), vecParam([0, 0, 70]), boolParam(true), vecParam([2, 2, 2]), floatParam(5), floatParam(.5), boolParam(true), floatParam(60), floatParam(.01)], scene: floor });
execCase('water-landing', { actor: baseActor(), params: [OUT(), ...Array(9).fill(SKIP)], scene: sceneOf({ zones: [zone(), zone({ water: true })], regions: [{ min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 20], zone: 1, zoneNumber: 2 }], planes: [{ normal: [0, 0, 1], offset: -400 }] }) });
execCase('outside-world', { actor: baseActor(), params: [OUT(), ...Array(9).fill(SKIP)], scene: sceneOf({ regions: [{ min: [80, -1e9, -1e9], max: [1e9, 1e9, 1e9], zone: 0, zoneNumber: 0 }] }) });
execCase('fast-step-abort', { actor: baseActor({ velocity: vec([4000, 0, 0]) }), params: [OUT(), SKIP, SKIP, SKIP, SKIP, SKIP, SKIP, SKIP, SKIP, floatParam(1)], scene: floor });
execCase('bounce-down-the-stairs', { actor: baseActor({ bounce: 1, velocity: vec([260, 0, 40]) }), params: [OUT(), ...Array(9).fill(SKIP)], scene: floor });
execCase('corner-two-walls', { actor: baseActor({ bounce: 1, location: vec([0, 0, 40]), velocity: vec([400, 400, 20]) }), params: [OUT(), ...Array(9).fill(SKIP)],
  scene: sceneOf({ planes: [{ normal: [0, 0, 1], offset: 0 }, { normal: [-1, 0, 0], offset: -150 }, { normal: [0, -1, 0], offset: -170 }] }) });

for (let i = 0; i < 520; i++) {
  const scene = randomScene({ actors: chance(.4) });
  const location = [range(-200, 200), range(-200, 200), range(40, 400)];
  const actor = baseActor({ location: vec(location), velocity: vec([range(-600, 600), range(-600, 600), range(-200, 600)]),
    radius: W(range(1, 25)), height: W(range(1, 50)), collide: chance(.5) ? 1 : 0, bounce: chance(.5) ? 1 : 0 });
  const params = [OUT()];
  const given = (p, make) => params.push(chance(p) ? make() : SKIP);
  const startVelocity = chance(.7) ? [range(-700, 700), range(-700, 700), range(-300, 700)] : null;
  const startLocation = chance(.7) ? [range(-200, 200), range(-200, 200), range(20, 300)] : null;
  params.push(startVelocity ? vecParam(startVelocity) : SKIP, startLocation ? vecParam(startLocation) : SKIP);
  given(.5, () => boolParam(chance(.8)));
  given(.5, () => vecParam([range(1, 12), range(1, 12), range(1, 30)].map((v, k) => (k < 2 ? v : v))));
  given(.6, () => floatParam(chance(.5) ? pick(specials.maxTime) : range(.1, 5)));
  given(.5, () => floatParam(chance(.5) ? pick(specials.elasticity) : range(0, 1.1)));
  given(.5, () => boolParam(chance(.6)));
  given(.5, () => floatParam(chance(.5) ? pick(specials.landingSpeed) : range(0, 200)));
  given(.65, () => floatParam(chance(.5) ? pick(specials.granularity) : range(.005, .1)));
  const where = startLocation ?? location;
  if (scene.actors && chance(.6)) scene.self = { center: where, radius: range(5, 25), halfHeight: range(5, 40) };
  // Some floors sit between the start and the actors; keep the start above the floor most of the time.
  scene.planes[0].offset = Math.min(scene.planes[0].offset, where[2] - 20);
  execCase(`random-${i}`, { actor, params, scene, outRef: chance(.9), count: chance(.8) ? 10 : 9 });
}
// Corners: a floor and two walls (some tilted), thrown into the crease at random angles and speeds, so the second hit
// (TwoWallAdjust with Desired = SafeNormal(Delta)) and the third slide run with varied geometry.
for (let i = 0; i < 260; i++) {
  const a = rnd() * Math.PI * 2, b = a + range(.4, 2.6);
  const tilt = () => (chance(.3) ? range(-.4, .5) : 0);
  const wall = angle => { const t = tilt(), s = Math.sqrt(1 - t * t); return [Math.cos(angle) * s, Math.sin(angle) * s, t]; };
  const planes = [{ normal: [0, 0, 1], offset: 0 }, { normal: wall(a), offset: -range(60, 240) }, { normal: wall(b), offset: -range(60, 240) }];
  if (chance(.3)) planes.push({ normal: wall(range(0, 6.28)), offset: -range(100, 300) });
  const heading = a + range(-1.2, 2.4), speed = range(100, 900);
  execCase(`corner-${i}`, { actor: baseActor({ bounce: chance(.7) ? 1 : 0, location: vec([range(-30, 30), range(-30, 30), range(15, 120)]),
    velocity: vec([Math.cos(heading) * speed, Math.sin(heading) * speed, range(-300, 200)]) }),
  params: [OUT(), SKIP, SKIP, SKIP, SKIP, floatParam(range(.5, 4)), floatParam(range(.1, 1)), SKIP, floatParam(range(0, 80)), SKIP], scene: sceneOf({ planes }) });
}
// The 0.7 floor test on the hit normal's Z (an embedded double): a float32 normal at, just below and above it.
for (const nz of [0.69999, 0.7, 0.70000005, 0.7000001, 0.7001, 0.705, 0.71, 0.72]) {
  for (const bounce of [0, 1]) {
    execCase(`ramp-nz-${nz}-bounce-${bounce}`, { actor: baseActor({ bounce, location: vec([0, 0, 200]), velocity: vec([40, 0, -120]) }),
      params: [OUT(), ...Array(9).fill(SKIP)], scene: sceneOf({ planes: [{ normal: [Math.sqrt(1 - nz * nz), 0, nz], offset: 0 }] }) });
  }
}
// Granularity edge words: NaN, infinities, denormal; both clamps.
for (const [name, bits] of [['nan', 0x7fc00000], ['inf', 0x7f800000], ['neg-inf', 0xff800000], ['denormal', 1], ['neg-zero', 0x80000000]]) {
  const params = [OUT(), SKIP, SKIP, SKIP, SKIP, SKIP, SKIP, SKIP, SKIP, { words: [bits] }];
  execCase(`granularity-${name}`, { actor: baseActor(), params, scene: floor });
}
// Edge arguments: negative maxTime, NaN velocity, huge gravity, zero gravity zone, NaN elasticity with a bounce.
execCase('max-time-zero', { actor: baseActor(), params: [OUT(), SKIP, SKIP, SKIP, SKIP, floatParam(0), ...Array(4).fill(SKIP)], scene: floor });
execCase('max-time-negative', { actor: baseActor(), params: [OUT(), SKIP, SKIP, SKIP, SKIP, floatParam(-1), ...Array(4).fill(SKIP)], scene: floor });
execCase('nan-velocity', { actor: baseActor({ velocity: [0x7fc00000, 0, 0] }), params: [OUT(), ...Array(9).fill(SKIP)], scene: floor });
execCase('inf-velocity', { actor: baseActor({ velocity: [0x7f800000, 0, 0] }), params: [OUT(), ...Array(9).fill(SKIP)], scene: floor });
execCase('nan-elasticity-bounce', { actor: baseActor({ bounce: 1 }), params: [OUT(), SKIP, SKIP, SKIP, SKIP, SKIP, { words: [0x7fc00000] }, ...Array(3).fill(SKIP)], scene: floor });
execCase('zero-gravity-zone', { actor: baseActor(), params: [OUT(), SKIP, SKIP, SKIP, SKIP, floatParam(.4), ...Array(4).fill(SKIP)], scene: sceneOf({ zones: [zone({ gravity: vec([0, 0, 0]) })] }) });
execCase('zero-velocity-zero-gravity', { actor: baseActor({ velocity: vec([0, 0, 0]) }), params: [OUT(), ...Array(9).fill(SKIP)], scene: sceneOf({ zones: [zone({ gravity: vec([0, 0, 0]) })] }) });
execCase('terminal-clamp', { actor: baseActor({ velocity: vec([0, 0, -2000]) }), params: [OUT(), ...Array(9).fill(SKIP)], scene: sceneOf({ zones: [zone({ terminal: W(300) })], planes: [{ normal: [0, 0, 1], offset: -2000 }] }) });
// The translation follows script-vm's precision control, so it also matches the original run at PC24 (0x007f; the
// model has no PC53). The game thread's word is 64 bits; these prove the rounding width is not hard-coded.
for (let i = 0; i < 12; i++) {
  const scene = randomScene({ actors: false });
  execCase(`x87-precision-24-${i}`, { cw: 0x007f, actor: baseActor({ bounce: i & 1, velocity: vec([range(-400, 400), range(-400, 400), range(0, 300)]) }),
    params: [OUT(), ...Array(9).fill(SKIP)], scene });
}

// slide helper cases
const slideCases = [];
for (let i = 0; i < 360; i++) {
  const scene = randomScene({ actors: chance(.5), hazards: false });
  scene.planes = [];
  if (chance(.7)) scene.planes.push({ normal: chance(.3) ? unit() : [0, 0, 1], offset: range(-40, 40) });
  if (chance(.5)) scene.planes.push({ normal: wallNormal(), offset: -range(30, 300) });
  scene.defaultRegion = { zone: 0, zoneNumber: 1 + Math.floor(rnd() * 3), leaf: Math.floor(rnd() * 90) };
  const start = [range(-80, 80), range(-80, 80), range(0, 120)];
  const length = pick([0, 1e-5, 5e-5, 1e-4, 1.5e-4, .5, 3, 12, 60, 200, 900]);
  let delta = unit().map(c => c * length * (chance(.2) ? 0 : 1));
  if (chance(.1)) delta = delta.map((c, k) => (k === 0 ? c : 0));
  if (chance(.05)) delta = [0, 0, 0];
  if (scene.actors && chance(.7)) scene.self = { center: start, radius: range(5, 20), halfHeight: range(5, 30) };
  const hit0 = chance(.5) ? Array(11).fill(0) : [0, 0, W(1), W(2), W(3), W(.6), W(.2), W(.77), 0, W(chance(.5) ? .37 : 1), chance(.5) ? 0xffffffff : 5];
  slideCases.push({ id: `slide-${i}`, mode: 'slide', scene, start: vec(start), delta: vec(delta),
    extent: vec(pick([[0, 0, 0], [4, 4, 4], [10, 10, 20], [1, 1, 1], [0, 0, 6]])), check: chance(.6) ? 1 : 0, ignore: chance(.8), hit0 });
}
// A few slide edge words: NaN, infinity, denormal deltas; tiny and exactly-at-threshold components.
for (const [name, delta] of [['nan', [0x7fc00000, 0, 0]], ['inf', [0x7f800000, 0, 0]], ['at-threshold', vec([1e-4, 0, 0])], ['below-threshold', vec([9.9e-5, -9.9e-5, 9.9e-5])],
  ['neg-zero', [0x80000000, 0x80000000, 0x80000000]], ['denormal', [1, 0, 0]], ['one-large', vec([0, 0, -50])]]) {
  slideCases.push({ id: `slide-edge-${name}`, mode: 'slide', scene: sceneOf(), start: vec([0, 0, 60]), delta, extent: vec([4, 4, 4]), check: 1, ignore: true, hit0: [0, 0, 0, 0, 0, 0, 0, 0, 0, W(.5), 7] });
}

// TwoWallAdjust cases, word inputs
const twoWallCases = [];
const nrm = v => { const l = Math.hypot(...v) || 1; return v.map(c => c / l); };
for (let i = 0; i < 700; i++) {
  const a = chance(.3) ? wallNormal() : unit();
  let b = unit();
  if (chance(.15)) b = a.slice();
  if (chance(.1)) b = a.map(c => -c);
  if (chance(.2)) b = nrm(a.map((c, k) => c + range(-.3, .3) * (k + 1) / 3));
  const delta = chance(.1) ? [0, 0, 0] : [range(-50, 50), range(-50, 50), range(-30, 30)];
  const t = chance(.15) ? pick([0, 1, .5, .999999, 1.5, -.5]) : rnd();
  twoWallCases.push({ id: `twowall-${i}`, mode: 'twowall', desired: vec(chance(.5) ? unit() : delta.map(c => c * .1)), delta: vec(delta), normal: vec(a), old: vec(b), time: W(t) });
}
for (const [name, normal, old, delta, time] of [
  ['nan-normal', [0x7fc00000, 0, 0x3f800000], vec([0, 0, 1]), vec([1, 2, 3]), W(.3)],
  ['nan-time', vec([0, 0, 1]), vec([0, 1, 0]), vec([1, 2, 3]), 0x7fc00000],
  ['inf-delta', vec([0, 0, 1]), vec([1, 0, 0]), [0x7f800000, 0, 0], W(.3)],
  ['parallel', vec([0, 0, 1]), vec([0, 0, 1]), vec([3, 4, 5]), W(.25)],
  ['opposite', vec([0, 0, 1]), vec([0, 0, -1]), vec([3, 4, 5]), W(.25)],
  ['perpendicular', vec([0, 0, 1]), vec([1, 0, 0]), vec([3, 4, -5]), W(.25)],
]) twoWallCases.push({ id: `twowall-edge-${name}`, mode: 'twowall', desired: vec([1, 0, 0]), delta, normal, old, time });

// ---- oracle ----------------------------------------------------------------------------------------------------
const python = process.env.NATIVE_PROBE_PYTHON ?? process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const wantCoverage = process.argv.includes('--coverage');
const cases = [...execCases, ...slideCases, ...twoWallCases];
const request = { cases: cases.map(c => ({ ...c, coverage: wantCoverage })), coverage: wantCoverage };
const oracle = JSON.parse(execFileSync(python, [path.join(here, 'native-parabolic-trace-oracle.py'), gameDirectory()],
  { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1 << 30 }));
const byId = new Map(oracle.results.map(r => [r.id, r]));

// ---- replay of the recorded level services ---------------------------------------------------------------------
class Mismatch extends Error {}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const hex = a => `[${a.map(v => `0x${(v >>> 0).toString(16)}`).join(',')}]`;

function buildWorld(scene, calls) {
  const level = { id: 0, owner: null, blocks: false };
  const self = { id: 1, owner: null, blocks: true };
  const actors = [level, self];
  (scene.actors ?? []).forEach((spec, i) => actors.push({ id: 2 + i, owner: null, blocks: spec.blocks !== false, ownerId: spec.owner ?? null }));
  for (const a of actors) a.owner = a.ownerId === null || a.ownerId === undefined ? null : actors[a.ownerId];
  const zones = (scene.zones ?? []).map(z => ({ gravity: z.gravity, velocity: z.velocity, terminalVelocity: z.terminal, water: Boolean(z.water) }));
  const queue = calls.filter(c => c.kind !== 'arg');
  let next = 0;
  const take = kind => {
    const call = queue[next++];
    if (!call) throw new Mismatch(`the translation made an extra ${kind} service call (the original made ${queue.length})`);
    if (call.kind !== kind) throw new Mismatch(`service call ${next - 1}: the original called ${call.kind}, the translation ${kind}`);
    return call;
  };
  const services = {
    levelInfo: level,
    pointRegion(position) {
      const call = take('region');
      if (!same(position, call.position)) throw new Mismatch(`PointRegion position ${hex(position)} != original ${hex(call.position)}`);
      return { zone: zones[call.zone], leaf: call.leaf, zoneNumber: call.zoneNumber };
    },
    multiLineCheck(query) {
      const call = take('mlc');
      for (const key of ['end', 'start', 'extent']) {
        if (!same(query[key], call[key])) throw new Mismatch(`MultiLineCheck ${key} ${hex(query[key])} != original ${hex(call[key])}`);
      }
      if (Boolean(query.checkActors) !== Boolean(call.check)) throw new Mismatch(`MultiLineCheck bCheckActors ${query.checkActors} != ${call.check}`);
      if (query.extra !== call.extra) throw new Mismatch('MultiLineCheck extra flags differ');
      return call.hits.map(h => ({ actor: actors[h.actor], location: h.location, normal: h.normal, time: h.time, item: h.item, primitive: h.primitive }));
    },
    isOwnedBy(actor, owner) {
      for (let a = actor; a; a = a.owner) if (a === owner) return true;
      return false;
    },
    blocksActors: actor => actor.blocks,
  };
  return { services, self, actors, zones, finish: () => { if (next !== queue.length) throw new Mismatch(`the translation made ${next} service calls, the original ${queue.length}`); } };
}

const reference = (object, key) => ({ reference: true, get: () => object[key], set: value => (object[key] = value) });
const writeSlot = value => (value?.reference && typeof value.set === 'function' ? value : { set() {} });

function checkExec(c, module) {
  const expected = byId.get(c.id);
  if (expected.status !== 'ok') throw new Mismatch(`oracle ${expected.status}: ${expected.reason}`);
  const world = buildWorld(c.scene, expected.calls);
  const a = c.actor;
  const fields = { Velocity: a.velocity.map(N), Location: a.location.map(N), bCollideActors: Boolean(a.collide), CollisionRadius: N(a.radius),
    CollisionHeight: N(a.height), bBounce: Boolean(a.bounce) };
  const slot = { value: null };
  const evaluate = index => {
    const p = c.params[index];
    if (!p || p.skip) return undefined;
    if (p.out) return c.outRef ? reference(slot, 'value') : [0, 0, 0];
    return p.words.length === 3 ? p.words.map(N) : p.words.length === 1 && c.boolIndexes.has(index) ? Boolean(p.words[0]) : N(p.words[0]);
  };
  const call = { receiver: world.self, argumentCount: c.count, evaluateArgument: evaluate };
  const host = { read: (actor, name) => fields[name], services: () => world.services, refValue, writeSlot };
  const previous = setX87Precision(c.cw === 0x007f ? 24 : 64);
  let returned;
  try { returned = module.execParabolicTrace(call, host); } finally { setX87Precision(previous); }
  world.finish();
  const got = W(returned);
  if (got !== expected.result) throw new Mismatch(`result 0x${got.toString(16)} != original 0x${expected.result.toString(16)} (${returned} vs ${N(expected.result)})`);
  if (c.outRef) {
    const out = slot.value.map(W);
    if (!same(out, expected.out)) throw new Mismatch(`finalLocation ${hex(out)} != original ${hex(expected.out)}`);
    if (!expected.gpropaddr) throw new Mismatch('the original did not store the out through GPropAddr');
  }
  if (expected.paramsLeft !== 0) throw new Mismatch('the original left parameters unevaluated');
}
// ParabolicTrace's bool parameters: bCheckActors (3) and bBounce (7).
for (const c of execCases) { c.boolIndexes = new Set([3, 7]); }

function checkSlide(c, module) {
  const expected = byId.get(c.id);
  if (expected.status !== 'ok') throw new Mismatch(`oracle ${expected.status}: ${expected.reason}`);
  const world = buildWorld(c.scene, expected.calls);
  const h = c.hit0;
  const state = { pos: c.start.slice(), region: { zone: world.zones[0], leaf: -7, zoneNumber: 0x5a },
    hit: { actor: null, location: h.slice(2, 5), normal: h.slice(5, 8), primitive: h[8], time: h[9], item: h[10] | 0 } };
  const returned = module.slideStepWords(world.services, c.ignore ? world.self : null, state, c.delta, c.extent, c.check);
  world.finish();
  if (returned !== expected.return) throw new Mismatch(`return ${returned} != original ${expected.return}`);
  if (!same(state.pos, expected.start)) throw new Mismatch(`start ${hex(state.pos)} != original ${hex(expected.start)}`);
  const region = { zone: world.zones.indexOf(state.region.zone), leaf: state.region.leaf, zoneNumber: state.region.zoneNumber & 0xff };
  assert.deepEqual(region, expected.region);
  const hit = state.hit, e = expected.hit;
  const parts = [[hit.location, e.location, 'location'], [hit.normal, e.normal, 'normal']];
  for (const [mine, theirs, name] of parts) if (!same(mine, theirs)) throw new Mismatch(`hit.${name} ${hex(mine)} != original ${hex(theirs)}`);
  if (hit.time !== e.time) throw new Mismatch(`hit.time 0x${hit.time.toString(16)} != original 0x${e.time.toString(16)}`);
  if ((hit.item | 0) !== e.item) throw new Mismatch(`hit.item ${hit.item} != original ${e.item}`);
  if (hit.primitive !== e.primitive) throw new Mismatch('hit.primitive differs');
  const actorId = hit.actor === null ? -1 : hit.actor.id;
  if (actorId !== e.actor) throw new Mismatch(`hit.actor ${actorId} != original ${e.actor}`);
}

function checkTwoWall(c, module) {
  const expected = byId.get(c.id);
  if (expected.status !== 'ok') throw new Mismatch(`oracle ${expected.status}: ${expected.reason}`);
  const delta = c.delta.slice();
  module.twoWallAdjustWords(c.desired, delta, c.normal, c.old, c.time);
  if (!same(delta, expected.delta)) throw new Mismatch(`delta ${hex(delta)} != original ${hex(expected.delta)}`);
}

function run(module, { quiet = false } = {}) {
  const failures = [];
  const tally = { exec: 0, slide: 0, twowall: 0 };
  for (const c of cases) {
    try {
      ({ exec: checkExec, slide: checkSlide, twowall: checkTwoWall })[c.mode](c, module);
      tally[c.mode]++;
    } catch (error) {
      failures.push(`${c.id}: ${error.message}`);
      if (!(error instanceof Mismatch) && !quiet) failures.push(error.stack.split('\n').slice(0, 4).join('\n'));
    }
  }
  return { failures, tally };
}

const module = await import(pathToFileURL(MODULE).href);
const { failures, tally } = run(module);
const serviceCalls = oracle.results.reduce((n, r) => n + (r.calls ? r.calls.filter(k => k.kind !== 'arg').length : 0), 0);
if (failures.length) {
  console.error(`FAIL ${failures.length} of ${cases.length} cases (exec ${tally.exec}/${execCases.length}, slide ${tally.slide}/${slideCases.length}, twowall ${tally.twowall}/${twoWallCases.length})`);
  for (const f of failures.slice(0, 12)) console.error(' ', f);
  process.exit(1);
}
// outcome statistics: which paths the exec corpus reached (all original-derived)
const outcomes = { landed: 0, failed: 0, bounced: 0 };
for (const c of execCases) {
  const r = byId.get(c.id);
  if (N(r.result) === 0) outcomes.failed++; else outcomes.landed++;
}
console.log(`PASS ${cases.length} cases bit-identical to Engine.dll: ${execCases.length} execParabolicTrace (${outcomes.landed} returned a time, ${outcomes.failed} returned 0), `
  + `${slideCases.length} slide-step, ${twoWallCases.length} TwoWallAdjust; ${serviceCalls} recorded level-service calls replayed.`);
if (wantCoverage) {
  for (const [name, info] of Object.entries(oracle.coverage)) {
    console.log(`coverage ${name}: ${info.executed}/${info.instructions} instructions executed${info.uncovered.length ? `, uncovered ${info.uncovered.join(' ')}` : ''}`);
  }
}

// ---- planted mutations ------------------------------------------------------------------------------------------
if (!process.argv.includes('--no-mutants')) {
  const source = readFileSync(MODULE, 'utf8');
  const mutants = [
    ['floor normal 0.7 -> 0.71', s => s.replace('x87double(0.7)', 'x87double(0.71)')],
    ['Z keeps no extended sum', s => s.replace('const newZ = add(gravityZ, L(velocity[2]));', 'const newZ = x87loadWord(S(add(gravityZ, L(velocity[2]))));')],
    ['hit time keeps the 2 unit backoff', s => s.replace('hit.time = S(x87div(sub(L(adjustedStored), L(F_TWO)), L(size)));', 'hit.time = S(x87div(L(adjustedStored), L(size)));')],
    ['maxTime test >= instead of >', s => s.replace("x87cmp(mul(x87int32(steps), g), L(a.maxTime)) === 'gt'", "x87cmp(mul(x87int32(steps), g), L(a.maxTime)) !== 'lt'")],
    ['terminal velocity clamp skipped for bounce', s => s.replace('if (!(bounce && hitThisStep)) {', 'if (!bounce) {')],
    ['TwoWallAdjust crease sign test', s => s.replace("if (c0(x87cmp(side, ZERO))) for (let axis", "if (notGreater(x87cmp(side, ZERO))) for (let axis")],
    ['TwoWallAdjust hit and old normal swapped', s => s.replace('twoWallAdjustWords(desired, remainder, M, N, hit.time);', 'twoWallAdjustWords(desired, remainder, N, M, hit.time);')],
    ['TwoWallAdjust hit time off by one ulp', s => s.replace('twoWallAdjustWords(desired, remainder, M, N, hit.time);', 'twoWallAdjustWords(desired, remainder, M, N, F_ONE - 1);')],
    ['elasticity applied to X only', s => s.replace('S(mul(L(mirrored[1]), elasticity))', 'mirrored[1]')],
    ['slide early-out threshold 0.0001 -> 0.001', s => s.replace('x87double(0.0001)', 'x87double(0.001)')],
    ['IsOwnedBy skipped', s => s.replace('if (self && services.isOwnedBy(candidate.actor, self)) continue;', '')],
  ];
  let caught = 0;
  for (const [name, mutate] of mutants) {
    const mutated = mutate(source);
    assert.notEqual(mutated, source, `mutant "${name}" no longer matches the module source`);
    const file = path.join(path.dirname(MODULE), `.parabolic-trace-mutant-${process.pid}.mjs`);
    writeFileSync(file, mutated);
    try {
      const result = run(await import(`${pathToFileURL(file).href}?m=${encodeURIComponent(name)}`), { quiet: true });
      assert.ok(result.failures.length > 0, `planted mutation not caught: ${name}`);
      caught++;
    } finally { unlinkSync(file); }
  }
  console.log(`PASS planted mutations: ${caught}/${mutants.length} caught`);
}
