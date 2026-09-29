#!/usr/bin/env node
// Original-Engine.dll comparisons for APawn::swimMove (0x103c3ca0) and
// APawn::swimReachable (0x103c15a0), and for every caller of the two bodies
// (aiPickSearch mode 3, the physics dispatcher, flyReachable's and walkReach's
// water hand-offs, pointReachable through the dispatcher, aiPickWorker). See
// docs/script-pawn-nav.md "Swimming contract".
//
// The collision boundary is a controlled double on both sides: MoveActor and
// FarMoveActor commit scripted results, Region.Zone follows a water plane
// after each committed move (a SetActorZone stand-in), PointRegion answers the
// same plane, and MoveActor's nearly-zero early return (no move, Hit untouched)
// is modeled. Passing it establishes the bodies' control flow, x87 rounding and
// boundary call sequence, not whole-scene original navigation.
//
// --original-only records the original reference cases (before the JS bodies).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {x87load, x87add, x87mul, x87store} from '../src/runtime/script-vm.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = process.env.NATIVE_PROBE_PYTHON || path.join(root, '.cache/native-probe-env/bin/python');
if (!existsSync(python)) throw new Error(`Original-DLL probe requires ${python}`);
const cache = path.join(root, '.cache/pawn-nav');
mkdirSync(cache, {recursive: true});
const f32 = Math.fround;
const io = new DataView(new ArrayBuffer(4));
const bits = v => { io.setFloat32(0, v, true); return io.getUint32(0, true).toString(16).padStart(8, '0'); };
const intBits = v => (v >>> 0).toString(16).padStart(8, '0');
const hit = (time = 1, actor = 0, nz = 0) => ({ret: 1, hit: {time, actor, normal: [0, 0, nz], item: -1}});

// Instruction ranges of the two translated bodies (SEH unwind funclets excluded).
const COVERAGE = {swimMove: ['103c3ca0', '103c402e'], swimReachable: ['103c15a0', '103c1a0d']};
const ZONES = {wet: {water: true, gravityZ: -950}, dry: {gravityZ: -950},
  painWet: {water: true, pain: true, damageType: 7, gravityZ: -950}};
const base = {location: [0, 0, 0], velocity: [3.5, -2.25, 7.75], rotation: [12, -20, 300],
  collisionRadius: 22, collisionHeight: 40, maxStepHeight: 24, groundSpeed: 200,
  physics: 3, flags318: 0x4000, field444: 0, baseEyeHeight: 40, collideFlag: 1,
  regionZone: 'wet', footZone: 'wet'};

/* A scene. `plane` is the water plane z (wet strictly below). Bodies:
 * waterMove(delta, target, scale, restore) · waterReach/flyReach/walkReach
 * (point, radius, reachFlags, target) · dispatch(point, radius, target) ·
 * pointWorker(point, 0) · aiPickSearch(origin, yaw, pitch, minR, maxR, 15, out)
 * · aiPickWorker(minDist, maxDist, cy, yd, cp, pd, tries, mult, out). */
function scene(name, body, expected, options = {}) {
  const {point = [100, 0, 0], delta = [40, 0, 0], radius = 15, scale = 8, reachFlags = 0,
    restore = 1, target = 0, plane = 1000, wet = 'wet', search = {}, pick = {}, ...rest} = options;
  const pawn = {...base, ...rest.pawn};
  const zoneAt = z => z < plane ? wet : 'dry';
  pawn.regionZone = rest.pawn?.regionZone ?? zoneAt(f32(pawn.location[2]));
  pawn.footZone = rest.pawn?.footZone ?? pawn.regionZone;
  const s = {origin: pawn.location, yaw: 0, pitch: 0, minR: 40, maxR: 100, ...search};
  const p = {minDist: 40, maxDist: 100, cy: 0x4000, yd: 1, cp: 0, pd: 1, tries: 1, mult: 1, ...pick};
  const vec = v => v.map(f => ({f}));
  const directArgs = body === 'waterMove' ? [...vec(delta), target, {f: scale}, {i: restore}]
    : body === 'dispatch' ? [...vec(point), {f: radius}, target]
    : body === 'pointWorker' ? [...vec(point), {i: 0}]
    : body === 'aiPickSearch' ? [...vec(s.origin), {i: s.yaw}, {i: s.pitch}, {f: s.minR}, {f: s.maxR},
      {f: 15}, {ref: 'vecbuf'}]
    : body === 'aiPickWorker' ? [{f: p.minDist}, {f: p.maxDist}, {i: p.cy}, {f: p.yd}, {i: p.cp},
      {f: p.pd}, {i: p.tries}, {f: p.mult}, {ref: 'vecbuf'}]
    : [...vec(point), {f: radius}, {i: reachFlags}, target];
  return {name, body, this: 'self', actors: rest.actors, frand: rest.frand,
    pawn, zones: {...ZONES, ...rest.zones},
    waterPlane: {z: plane, wet, dry: 'dry'}, moveNearlyZero: true,
    coverage: Object.values(COVERAGE),
    moveActor: rest.moveActor || [hit()], farMove: rest.farMove || [1], fastLine: [1],
    directArgs,
    test: {expected, point, delta, radius, scale, reachFlags, restore, target, plane, wet, search: s, pick: p}};
}

const tgt = {tgt: {collisionRadius: 10, collisionHeight: 10}};
const warp = zone => ({tgt: {cls: 'warpzonemarker', markedWarpZone: zone}});
const handwritten = [
  // swimMove: in-water tail (flyMove-shaped).
  scene('sm-clear', 'waterMove', 1, {scale: 40}),
  scene('sm-threshold-equal', 'waterMove', 1, {delta: [3, 4, 0], scale: 5}),
  scene('sm-threshold-below', 'waterMove', 0, {delta: [3, 4, 0], scale: 5.000000476837158}),
  scene('sm-under-keep', 'waterMove', 0, {delta: [1, 2, 3], restore: 0}),
  scene('sm-partial-retry', 'waterMove', 1, {delta: [40, 6, 9], moveActor: [hit(0.25), hit(0.5), hit()]}),
  scene('sm-target-first', 'waterMove', 5, {target: 'tgt', actors: tgt, moveActor: [hit(0, 'tgt')]}),
  scene('sm-target-up-only', 'waterMove', 0, {target: 'tgt', actors: tgt,
    moveActor: [hit(0), hit(0, 'tgt'), hit(0)]}),
  scene('sm-target-retry', 'waterMove', 5, {target: 'tgt', actors: tgt,
    moveActor: [hit(0), hit(0.5), hit(0, 'tgt')]}),
  scene('sm-blocked-restore', 'waterMove', 0, {moveActor: [hit(0)]}),
  scene('sm-fractional', 'waterMove', 1, {delta: [3.125, 2.3, -4.625], scale: 1,
    pawn: {location: [0.1, -3.25, 100], maxStepHeight: 17.3}, plane: 200,
    moveActor: [hit(1 / 3), hit(0.2), hit(0.75)]}),
  // Dry branch: leaving the water pulls back to the water line and returns 0.
  scene('sm-exit-waterline', 'waterMove', 0, {delta: [0, 0, 30], plane: 10, pawn: {location: [0, 0, 0]}}),
  scene('sm-exit-diagonal', 'waterMove', 0, {delta: [17.5, -9.25, 22.75], scale: 1,
    plane: 7.3, pawn: {location: [3.5, 2.25, -1.5]}}),
  scene('sm-exit-partial', 'waterMove', 0, {delta: [0, 0, 60], plane: 12,
    pawn: {location: [0, 0, 0]}, moveActor: [hit(0.5)]}),
  scene('sm-exit-restore-ignored', 'waterMove', 0, {delta: [0, 0, 30], plane: 10, restore: 1,
    pawn: {location: [0, 0, 0]}}),
  scene('sm-exit-target-first', 'waterMove', 5, {delta: [0, 0, 30], plane: 10, target: 'tgt', actors: tgt,
    pawn: {location: [0, 0, 0]}, moveActor: [hit(1, 'tgt')]}),
  // Dry start that stays dry: findWaterLine returns at once (End == Location).
  scene('sm-dry-short', 'waterMove', 0, {delta: [0.5, 0, 0], plane: -100, pawn: {location: [0, 0, 0]}}),
  scene('sm-dry-long', 'waterMove', 0, {delta: [30, 0, 0], plane: -100, pawn: {location: [0, 0, 0]}}),
  // Zero-size and nearly-zero steps: MoveActor returns before writing Hit.
  scene('sm-zero-step', 'waterMove', 1, {delta: [0, 0, 0], scale: 0}),
  scene('sm-zero-step-threshold', 'waterMove', 0, {delta: [0, 0, 0], scale: 1, restore: 1}),
  scene('sm-nearly-zero-retry-keeps-up-hit', 'waterMove', 5, {delta: [4e-4, 0, 0], target: 'tgt', actors: tgt,
    moveActor: [hit(0.8), hit(0.1, 'tgt')]}),
  scene('sm-nearly-zero-retry-plain', 'waterMove', 1, {delta: [4e-4, 0, 0], scale: 0,
    moveActor: [hit(0.8), hit(0.5)]}),
  scene('sm-negative-z', 'waterMove', 1, {delta: [0, 0, -30], scale: 10, pawn: {location: [0, 0, -50]}, plane: 0}),
  // swimReachable.
  scene('sr-inside', 'waterReach', 4, {point: [0, 0, 0]}),
  scene('sr-radius-equal', 'waterReach', 4, {point: [15, 0, 0]}),
  scene('sr-retained-distance', 'waterReach', 4, {point: [15, 0.001, 0]}),
  scene('sr-height-gate', 'waterReach', 0, {point: [0, 0, 12], radius: 30,
    pawn: {collisionHeight: 10}, moveActor: [hit(0)]}),
  scene('sr-near', 'waterReach', 4),
  scene('sr-far-diagonal', 'waterReach', 4, {point: [500, 200, -100]}),
  scene('sr-large-radius', 'waterReach', 4, {point: [1000, 0, 0], pawn: {collisionRadius: 300}}),
  scene('sr-accumulated-flags', 'waterReach', 0x47, {reachFlags: 0x43}),
  scene('sr-blocked', 'waterReach', 0, {moveActor: [hit(0)]}),
  scene('sr-target', 'waterReach', 4, {target: 'tgt', actors: tgt, moveActor: [hit(0.5, 'tgt')]}),
  scene('sr-pain-mismatch', 'waterReach', 0, {wet: 'painWet'}),
  scene('sr-pain-matching', 'waterReach', 4, {wet: 'painWet', pawn: {field444: 7}}),
  scene('sr-pain-after-target', 'waterReach', 0, {wet: 'painWet', target: 'tgt', actors: tgt,
    moveActor: [hit(0, 'tgt')]}),
  scene('sr-budget', 'waterReach', 0, {point: [50000, 0, 0]}),
  scene('sr-exit-no-capability', 'waterReach', 0, {point: [0, 0, 300], plane: 50}),
  scene('sr-exit-fly', 'waterReach', 6, {point: [0, 0, 300], plane: 50, pawn: {flags318: 0xc000}}),
  scene('sr-exit-walk', 'waterReach', 1, {point: [60, 0, 30], plane: 20,
    pawn: {flags318: 0x6000, location: [0, 0, 0]}}),
  scene('sr-exit-walk-blocked', 'waterReach', 0, {point: [60, 0, 30], plane: 20,
    pawn: {flags318: 0x6000}, moveActor: [hit(), hit(), hit(0.5)]}),
  scene('sr-exit-walk-margin', 'waterReach', 1, {point: [60, 0, 80], plane: 20,
    pawn: {flags318: 0x6000}}),
  scene('sr-exit-walk-too-high', 'waterReach', 0, {point: [0, 0, 300], plane: 20,
    pawn: {flags318: 0x6000}}),
  scene('sr-exit-after-target', 'waterReach', 4, {point: [0, 0, 300], plane: 10, target: 'tgt',
    actors: tgt, moveActor: [hit(1, 'tgt')]}),
  scene('sr-exit-fly-after-target', 'waterReach', 0, {point: [0, 0, 300], plane: 10, target: 'tgt',
    actors: tgt, pawn: {flags318: 0xc000}, moveActor: [hit(1, 'tgt'), hit(0)]}),
  scene('sr-warp-match', 'waterReach', 4, {target: 'tgt', actors: warp('wet'), moveActor: [hit(0)]}),
  scene('sr-warp-mismatch', 'waterReach', 0, {target: 'tgt', actors: warp('dry'), moveActor: [hit(0)]}),
  scene('sr-nonwarp-target', 'waterReach', 0, {target: 'tgt', actors: tgt, moveActor: [hit(0)]}),
  scene('sr-velocity', 'waterReach', 4, {point: [300, -40, 20], pawn: {velocity: [-1.5, 1e-3, 9e5]}}),
  // Callers.
  scene('dp-water', 'dispatch', 4, {pawn: {physics: 1}}),
  scene('dp-water-target', 'dispatch', 4, {target: 'tgt', actors: tgt, moveActor: [hit(0.5, 'tgt')]}),
  scene('pw-water', 'pointWorker', 4, {pawn: {physics: 2}}),
  scene('pw-dry-into-water', 'pointWorker', 5, {point: [60, 0, -60], plane: 0,
    pawn: {physics: 1, location: [0, 0, 0.5], flags318: 0x4000},
    moveActor: [hit(), hit(0.5, 0, 1), hit()]}),
  scene('wr-into-water', 'walkReach', 5, {point: [200, 0, 0], plane: 90, reachFlags: 0,
    pawn: {physics: 1, location: [0, 0, 100.5], flags318: 0x4000},
    moveActor: [hit(), hit(0.5, 0, 1), hit()]}),
  scene('fr-into-water', 'flyReach', 6, {point: [0, 0, -300], plane: 0,
    pawn: {physics: 4, location: [0, 0, 50], flags318: 0x4000}}),
  scene('as-mode3-exit', 'aiPickSearch', 1, {plane: 60, search: {yaw: 0, pitch: 0x3000, minR: 40, maxR: 400}}),
  scene('as-mode3-band', 'aiPickSearch', 1, {plane: 1000, search: {yaw: 0x2000, pitch: -0x800, minR: 40, maxR: 100}}),
  scene('as-mode3-blocked', 'aiPickSearch', 0, {moveActor: [hit(0)], search: {yaw: 0x2000, pitch: 0}}),
  scene('as-mode3-foot-pain', 'aiPickSearch', 0, {pawn: {footZone: 'painWet'}, search: {minR: 40, maxR: 100}}),
  scene('as-mode3-small-stride', 'aiPickSearch', 1, {pawn: {collisionRadius: 1}, search: {yaw: 0x6000, pitch: 0x1000}}),
  scene('ap-water-worker', 'aiPickWorker', 1, {frand: [0.25, 0.75, 0.6, 0.1], pick: {tries: 2, mult: 0.5}}),
];

// Generated cases (seeded, reproducible): random positions, planes, deltas,
// hit sequences, capabilities and targets over the same double.
let seed = 0x5eed1234;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const range = (a, b) => f32(a + (b - a) * rnd());
const pickOf = list => list[Math.floor(rnd() * list.length)];
const time = () => pickOf([1, 1, 1, 0, range(0, 0.99), range(0, 0.99)]);
const hits = (n, withTarget) => Array.from({length: n}, () =>
  hit(time(), withTarget && rnd() < 0.15 ? 'tgt' : 0, pickOf([0, 1, range(-1, 1)])));
const generated = [];
for (let i = 0; i < 150; i++) {
  const plane = range(-200, 200), z = plane + range(-150, rnd() < 0.2 ? 60 : -0.5);
  const size = pickOf([range(0, 60), range(0, 5), 1e-5, 0]);
  const dir = [range(-1, 1), range(-1, 1), range(-1, 1)];
  const withTarget = rnd() < 0.3;
  generated.push(scene(`gen-sm-${i}`, 'waterMove', undefined, {plane,
    delta: dir.map(c => f32(c * size) + 0), scale: pickOf([0, 1, 4.1, 8, range(0, 40)]),
    restore: rnd() < 0.5 ? 1 : 0, target: withTarget ? 'tgt' : 0, actors: withTarget ? tgt : undefined,
    pawn: {location: [range(-500, 500), range(-500, 500), z], maxStepHeight: range(0, 40),
      rotation: [Math.floor(range(-40000, 40000)), Math.floor(range(-40000, 40000)), 0]},
    moveActor: hits(1 + Math.floor(rnd() * 4), withTarget)}));
}
for (let i = 0; i < 90; i++) {
  const plane = range(-100, 100), z = plane - range(1, 200);
  const flags = pickOf([0x4000, 0xc000, 0x6000, 0x7000, 0xe000]);
  const targetKind = pickOf([0, 0, 'tgt', 'warp']);
  const pointZ = rnd() < 0.4 ? plane + range(-40, 120) : z + range(-200, 100);
  generated.push(scene(`gen-sr-${i}`, 'waterReach', undefined, {plane,
    point: [range(-600, 600), range(-600, 600), pointZ], radius: range(0, 60),
    reachFlags: Math.floor(rnd() * 0x80), wet: rnd() < 0.15 ? 'painWet' : 'wet',
    target: targetKind ? 'tgt' : 0,
    actors: targetKind === 'tgt' ? tgt : targetKind === 'warp' ? warp(pickOf(['wet', 'dry'])) : undefined,
    pawn: {location: [range(-300, 300), range(-300, 300), z], flags318: flags,
      field444: rnd() < 0.5 ? 7 : 0, collisionRadius: pickOf([range(5, 60), range(150, 320)]),
      collisionHeight: range(5, 60), maxStepHeight: range(0, 40), physics: pickOf([1, 3, 4])},
    moveActor: [...hits(Math.floor(rnd() * 5), targetKind === 'tgt'), hit()]}));
}
for (let i = 0; i < 40; i++) {
  const plane = range(-100, 100), z = plane - range(1, 150);
  generated.push(scene(`gen-as-${i}`, 'aiPickSearch', undefined, {plane,
    search: {yaw: Math.floor(range(-70000, 70000)), pitch: Math.floor(range(-16000, 16000)),
      minR: range(0, 200), maxR: range(0, 600)},
    pawn: {location: [range(-300, 300), range(-300, 300), z], collisionRadius: range(0, 40),
      maxStepHeight: range(0, 40), collideFlag: rnd() < 0.8 ? 1 : 0},
    moveActor: [...hits(Math.floor(rnd() * 6), false), hit()]}));
}
for (let i = 0; i < 20; i++) {
  const plane = range(-100, 100), z = plane - range(1, 150);
  generated.push(scene(`gen-ap-${i}`, 'aiPickWorker', undefined, {plane,
    frand: Array.from({length: 8}, () => rnd()),
    pick: {minDist: range(0, 200), maxDist: range(0, 600), cy: Math.floor(range(-70000, 70000)),
      yd: range(0, 1), cp: Math.floor(range(-16000, 16000)), pd: range(0, 1),
      tries: 1 + Math.floor(rnd() * 3), mult: pickOf([1, range(0.2, 1)])},
    pawn: {location: [range(-300, 300), range(-300, 300), z], collisionRadius: range(5, 40)},
    moveActor: [...hits(Math.floor(rnd() * 6), false), hit()]}));
}
const scenes = [...handwritten, ...generated];
if (process.env.SWIM_CASE) {                     // print one scene definition and exit
  console.log(JSON.stringify(scenes.find(s => s.name === process.env.SWIM_CASE)));
  process.exit(0);
}

// Capture the original machine code first. No JS result supplies oracle inputs.
const probe = input => JSON.parse(execFileSync(python, [path.join(root, 'scripts/native-pawn-nav-probe.py')], {
  input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 28}));
const results = probe(scenes.map(({test, ...s}) => s));
const [listing] = probe([{disasm: COVERAGE}]);
writeFileSync(path.join(cache, 'swimming-reference.json'), JSON.stringify(results));
for (let i = 0; i < scenes.length; i++) {
  assert.equal(results[i]?.ok, true, `${scenes[i].name}: ${results[i]?.error}`);
  if (scenes[i].test.expected !== undefined)
    assert.equal(results[i].result.returned, scenes[i].test.expected, `${scenes[i].name}: original verdict`);
}
const covered = new Set(results.flatMap(r => r.result.coverage));
const uncovered = Object.fromEntries(Object.entries(listing.result.instructions)
  .map(([name, list]) => [name, list.filter(a => !covered.has(a))]));
const verdicts = {};
for (const s of scenes) {
  const r = results[scenes.indexOf(s)].result.returned;
  const key = `${s.body}:${r}`;
  verdicts[key] = (verdicts[key] ?? 0) + 1;
}
if (process.argv.includes('--original-only')) {
  for (let i = 0; i < handwritten.length; i++) {
    const r = results[i].result;
    console.log(`${scenes[i].name}: ${r.returned}, moves=${r.counts.moveActor}, restores=${r.counts.farMoveActor}, regions=${r.counts.pointRegion}`);
  }
  console.log(JSON.stringify({verdicts, uncovered}));
  process.exit(0);
}

function originalSnapshot(r, body) {
  const buckets = new Map();
  const name = a => Object.entries(r.addresses).find(([, v]) => v === a)?.[0] ?? a;
  for (const c of r.commands) {
    const n = c.op === 'moveActor' ? {op: c.op, actor: name(c.actor), delta: c.deltaBits,
      rotation: c.rotationBits, flags: c.flags}
      : c.op === 'farMoveActor' ? {op: c.op, actor: name(c.actor), dest: c.destBits, test: c.test, noCheck: c.noCheck}
      : c.op === 'pointRegion' ? {op: c.op, point: c.point.map(bits)}
      : c.op === 'fastLineCheck' ? {op: c.op, end: c.end.map(bits), start: c.start.map(bits)}
      : assert.fail(`Unexpected original boundary ${c.op}`);
    if (!buckets.has(c.op)) buckets.set(c.op, []);
    buckets.get(c.op).push(n);
  }
  return {ret: r.returned, location: r.pawn.locationBits, velocity: r.pawn.velocityBits,
    region: name(r.pawn.regionZone),
    out: body.startsWith('aiPick') ? r.vecbuf.slice(0, 3) : null,
    commands: r.callsites.map(([op]) => buckets.get(op).shift())};
}

const X_SMALL = 1e-4;
function translatedSnapshot(s, mod) {
  const t = s.test;
  const zones = Object.fromEntries(Object.entries(s.zones).map(([name, z]) =>
    [name, {name, water: !!z.water, pain: !!z.pain, damageType: z.damageType | 0, gravityZ: f32(z.gravityZ ?? -950)}]));
  const zoneAt = z => zones[z < s.waterPlane.z ? s.waterPlane.wet : s.waterPlane.dry];
  const makeActor = (name, a) => ({name, cls: a.cls || 'actor',
    location: (a.location || [0, 0, 0]).map(f32), velocity: (a.velocity || [0, 0, 0]).map(f32),
    Rotation: a.rotation || [0, 0, 0], CollisionRadius: f32(a.collisionRadius || 0),
    CollisionHeight: f32(a.collisionHeight || 0), MaxStepHeight: f32(a.maxStepHeight || 0),
    GroundSpeed: f32(a.groundSpeed || 0), BaseEyeHeight: f32(a.baseEyeHeight || 0),
    Physics: a.physics | 0, Flags318: a.flags318 | 0, CollideFlag: a.collideFlag | 0,
    ReducedDamageType: a.field444 | 0, WarpDestZone: zones[a.markedWarpZone] || 0,
    region: zones[a.regionZone] || zones.dry, foot: zones[a.footZone] || zones.dry});
  const actors = Object.fromEntries(Object.entries(s.actors || {}).map(([n, a]) => [n, makeActor(n, a)]));
  const pawn = actors.self = makeActor('self', s.pawn);
  const target = actors[t.target] || 0;
  const commands = [];
  let mi = 0, fi = 0, ri = 0;
  const frand = s.frand || [0.5];
  const services = {
    read: (a, n) => a[n], location: a => a.location, velocity: a => a.velocity,
    regionZone: a => a.region, footZone: a => a.foot, zoneGravity: a => a.region.gravityZ,
    isA: (a, cls) => a.cls.toLowerCase() === cls.toLowerCase(), gIsEditor: () => false,
    level: () => ({}), model: () => ({}),
    frand: () => frand[Math.min(ri++, frand.length - 1)],
    moveActor(a, delta, rotation, flags) {
      commands.push({op: 'moveActor', actor: a.name, delta: delta.map(bits), rotation: rotation.map(intBits),
        flags: [flags.test, flags.ignorePawns, flags.ignoreBalls, flags.noFail]});
      // MoveActor's early return: no move, no zone update, Hit unwritten.
      if (delta.every(c => !(Math.abs(f32(c)) >= X_SMALL)) && rotation.every((r, i) => r === a.Rotation[i]))
        return {time: 1, normal: [0, 0, 0], actor: 0, item: -1};
      const h = s.moveActor[Math.min(mi++, s.moveActor.length - 1)].hit;
      for (let i = 0; i < 3; i++) a.location[i] = x87store(x87add(x87load(a.location[i]),
        x87mul(x87load(f32(delta[i])), x87load(f32(h.time)))));
      a.region = zoneAt(a.location[2]);
      return {...h, time: f32(h.time), normal: h.normal.map(f32), actor: actors[h.actor] || 0};
    },
    farMoveActor(a, dest, test, noCheck) {
      commands.push({op: 'farMoveActor', actor: a.name, dest: dest.map(bits), test, noCheck});
      const r = s.farMove[Math.min(fi++, s.farMove.length - 1)];
      if (r) a.location = dest.map(f32);
      a.region = zoneAt(a.location[2]);
      return r;
    },
    pointRegion(point) { commands.push({op: 'pointRegion', point: point.map(bits)}); return zoneAt(f32(point[2])); },
    fastLineCheck(model, end, start) {
      commands.push({op: 'fastLineCheck', end: end.map(bits), start: start.map(bits)}); return 1;
    },
    altMove() { throw new Error('jumpArc is outside the verified swimming slice'); },
  };
  const point = t.point.map(f32), out = [0, 0, 0];
  const ret = s.body === 'waterMove' ? mod.swimMove(pawn, t.delta.map(f32), target, f32(t.scale), t.restore, services)
    : s.body === 'waterReach' ? mod.swimReach(pawn, point, f32(t.radius), t.reachFlags, target, services)
    : s.body === 'dispatch' ? mod.physicsReach(pawn, point, f32(t.radius), target, services)
    : s.body === 'pointWorker' ? mod.pointWorker(pawn, point, 0, services)
    : s.body === 'aiPickSearch' ? mod.aiPickSearch(pawn, t.search.origin.map(f32), t.search.yaw | 0,
      t.search.pitch | 0, f32(t.search.minR), f32(t.search.maxR), 15, out, services)
    : s.body === 'aiPickWorker' ? mod.aiPickWorker(pawn, f32(t.pick.minDist), f32(t.pick.maxDist), t.pick.cy | 0,
      f32(t.pick.yd), t.pick.cp | 0, f32(t.pick.pd), t.pick.tries | 0, f32(t.pick.mult), out, services)
    : mod[s.body](pawn, point, f32(t.radius), t.reachFlags, target, services);
  return {ret, location: pawn.location.map(bits), velocity: pawn.velocity.map(bits), region: pawn.region.name,
    out: s.body.startsWith('aiPick') ? out.map(bits) : null, commands};
}

const modulePath = path.join(root, 'src/runtime/script-pawn-nav.mjs');
const mod = await import(pathToFileURL(modulePath));
const originals = results.map((r, i) => originalSnapshot(r.result, scenes[i].body));
let commandCount = 0;
for (let i = 0; i < scenes.length; i++) {
  assert.deepEqual(translatedSnapshot(scenes[i], mod), originals[i], scenes[i].name);
  commandCount += originals[i].commands.length;
}
const missing = Object.values(uncovered).flat().length;
console.log(`PASS swimming reach: ${scenes.length}/${scenes.length} original-DLL cases (${handwritten.length} targeted, ` +
  `${generated.length} generated; ${commandCount} ordered boundary calls with argument bits, verdict, ` +
  `Location/Velocity/Region, out vector), 0 mismatches`);
console.log(`verdicts ${JSON.stringify(verdicts)}`);
console.log(`instruction coverage: ${Object.entries(listing.result.instructions).map(([n, l]) =>
  `${n} ${l.length - uncovered[n].length}/${l.length}`).join(', ')}${missing ? ` uncovered ${JSON.stringify(uncovered)}` : ''}`);
assert.equal(missing, 0, 'every instruction of both bodies executes in some original case');

// Check only the new translation boundaries; reuse the original captures.
const mutations = [
  ['swim-bit', 'reachFlags |= 4;', 'reachFlags |= 2;', 'sr-accumulated-flags'],
  ['walk-flags', 'reachFlags = 1;                                    // 0x103c192c', 'reachFlags |= 1;', 'sr-exit-walk'],
  ['walk-margin', 'const top = x87add(x87add(ld(maxStep), ld(at[2])), ld(50));',
    'const top = x87add(ld(maxStep), ld(at[2]));', 'sr-exit-walk-margin'],
  // An arithmetic zero (exp 0) against a small positive: FCOM orders +0 below.
  ['zero-compare', '  else if (a.sig === 0n) m = b.neg ? 1 : -1;\n', '', 'gen-sr-4'],
  ['dry-restore', 'return 0;                                           // 0x103c3e97 dry',
    'if (restoreOnFailure) farMove(services, pawn, start); return 0;', 'sm-exit-restore-ignored'],
  ['hit-retention', 'if (!nearlyZero(d)) hit = h;', 'hit = h;', 'sm-nearly-zero-retry-keeps-up-hit'],
  ['pain-after-target', 'stillmoving = 0; success = 0;', 'stillmoving = 0;', 'sr-pain-after-target'],
  ['retained-arrival', 'leU(distSq, ld(closeSq)) && leU(absZ,',
    'leU(ld(storedDistSq), ld(closeSq)) && leU(absZ,', 'sr-retained-distance'],
  ['swim-budget', 'if (--ticks < 0) stillmoving = 0;', 'if (--ticks <= 0) stillmoving = 0;', 'sr-budget'],
];
const source = readFileSync(modulePath, 'utf8');
const runtimeUrl = pathToFileURL(path.dirname(modulePath) + path.sep).href;
for (const [name, before, after, caseName] of mutations) {
  assert.equal(source.split(before).length, 2, `${name}: unique mutation site`);
  const file = path.join(cache, `mut-swimming-${name}.mjs`);
  try {
    writeFileSync(file, source.replace(before, after).replace(/from '\.\//g, `from '${runtimeUrl}`));
    const mutant = await import(pathToFileURL(file));
    const i = scenes.findIndex(s => s.name === caseName);
    let detected;
    try { detected = !isDeepStrictEqual(translatedSnapshot(scenes[i], mutant), originals[i]); }
    catch { detected = true; }
    assert.ok(detected, `${name}: original case must detect mutation`);
  } finally { if (existsSync(file)) unlinkSync(file); }
}
console.log(`PASS swimming reach mutations: ${mutations.length}/${mutations.length}`);

function isDeepStrictEqual(a, b) {
  try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
}
