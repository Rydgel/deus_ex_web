#!/usr/bin/env node
// Focused original-Engine.dll comparisons for flyMove/flyReach and their
// existing walk/physics/point callers. See docs/script-pawn-nav.md.
// --original-only records reference cases before implementing the JS bodies.
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
const hit = (time = 1, actor = 0, nz = 0) =>
  ({ret: 1, hit: {time, actor, normal: [0, 0, nz], item: -1}});
const base = {location: [0, 0, 0], velocity: [3.5, -2.25, 7.75], rotation: [12, -20, 300],
  collisionRadius: 22, collisionHeight: 40, maxStepHeight: 24, groundSpeed: 200,
  physics: 4, flags318: 0, field444: 0, baseEyeHeight: 40,
  regionZone: 'dry', footZone: 'dry'};
const scene = (name, body, expected, options = {}) => {
  const {point = [100, 0, 0], delta = [40, 0, 0], radius = 15, scale = 8,
    reachFlags = 0, restore = 1, target = 0, ...rest} = options;
  const vector = body === 'flyMove' ? delta : point;
  const tail = body === 'flyMove' ? [target, {f: scale}, {i: restore}]
    : body === 'dispatch' ? [{f: radius}, target]
    : body === 'pointWorker' ? [{i: 0}]
    : [{f: radius}, {i: reachFlags}, target];
  return {name, body, this: 'self', ...rest,
    pawn: {...base, ...rest.pawn},
    zones: {dry: {gravityZ: -950}, ...rest.zones},
    moveActor: rest.moveActor || [hit()], farMove: rest.farMove || [1],
    pointRegion: [{zone: 'dry'}], fastLine: [1],
    directArgs: [...vector.map(f => ({f})), ...tail],
    test: {expected, point, delta, radius, scale, reachFlags, restore, target}};
};
const scenes = [
  scene('fm-clear', 'flyMove', 1, {scale: 40}),
  scene('fm-threshold-equal', 'flyMove', 1, {delta: [3, 4, 0], scale: 5}),
  scene('fm-threshold-below', 'flyMove', 0, {delta: [3, 4, 0], scale: 5.000000476837158}),
  scene('fm-under-keep', 'flyMove', 0, {delta: [1, 2, 3], restore: 0}),
  scene('fm-vertical', 'flyMove', 1, {delta: [0, 0, 20], scale: 20}),
  scene('fm-partial-retry', 'flyMove', 1,
    {delta: [40, 6, 9], moveActor: [hit(0.25), hit(0.5), hit()]}),
  scene('fm-target-first', 'flyMove', 5,
    {target: 'tgt', actors: {tgt: {}}, moveActor: [hit(0, 'tgt')]}),
  scene('fm-target-up-only', 'flyMove', 0,
    {target: 'tgt', actors: {tgt: {}}, moveActor: [hit(0), hit(0, 'tgt'), hit(0)]}),
  scene('fm-target-retry', 'flyMove', 5,
    {target: 'tgt', actors: {tgt: {}}, moveActor: [hit(0), hit(0.5), hit(0, 'tgt')]}),
  scene('fm-blocked-restore', 'flyMove', 0, {moveActor: [hit(0)]}),
  scene('fm-blocked-keep', 'flyMove', 0, {restore: 0, moveActor: [hit(0)]}),
  scene('fm-fractional', 'flyMove', 1, {delta: [3.125, 2.3, -4.625], scale: 1,
    pawn: {location: [0.1, -3.25, 100], maxStepHeight: 17.3},
    moveActor: [hit(1 / 3), hit(0.2), hit(0.75)]}),
  scene('fr-inside', 'flyReach', 2, {point: [0, 0, 0]}),
  scene('fr-radius-equal', 'flyReach', 2, {point: [15, 0, 0]}),
  // Retained distance is >225 although its f32 store rounds to exactly 225.
  scene('fr-retained-distance', 'flyReach', 2, {point: [15, 0.001, 0]}),
  scene('fr-height-gate', 'flyReach', 0, {point: [0, 0, 12], radius: 30,
    pawn: {collisionHeight: 10}, moveActor: [hit(0)]}),
  scene('fr-near', 'flyReach', 2),
  scene('fr-far-diagonal', 'flyReach', 2, {point: [500, 200, 100]}),
  scene('fr-large-radius', 'flyReach', 2, {point: [1000, 0, 0], pawn: {collisionRadius: 300}}),
  scene('fr-accumulated-flags', 'flyReach', 0x43, {reachFlags: 0x41}),
  scene('fr-blocked', 'flyReach', 0, {moveActor: [hit(0)]}),
  scene('fr-water-no-swim', 'flyReach', 0,
    {zones: {wet: {water: true}}, pawn: {regionZone: 'wet'}}),
  scene('fr-water-pain', 'flyReach', 0, {zones: {wet: {water: true, pain: true, damageType: 7}},
    pawn: {regionZone: 'wet', flags318: 0x4000}}),
  scene('fr-water-target', 'flyReach', 2, {target: 'tgt', actors: {tgt: {}},
    zones: {wet: {water: true}}, pawn: {regionZone: 'wet'}, moveActor: [hit(0, 'tgt')]}),
  scene('fr-warp-match', 'flyReach', 2, {target: 'tgt',
    actors: {tgt: {cls: 'warpzonemarker', markedWarpZone: 'dry'}}, moveActor: [hit(0)]}),
  scene('fr-warp-mismatch', 'flyReach', 0, {target: 'tgt', zones: {other: {}},
    actors: {tgt: {cls: 'warpzonemarker', markedWarpZone: 'other'}}, moveActor: [hit(0)]}),
  scene('fr-budget', 'flyReach', 0, {point: [50000, 0, 0]}),
  scene('dp-flying', 'dispatch', 2),
  scene('pw-flying', 'pointWorker', 2),
  scene('wr-flying-fallback', 'walkReach', 3, {pawn: {physics: 1, flags318: 0x8000, collideFlag: 1},
    moveActor: [hit(0), hit(0), hit(0), hit(0.5), hit()]}),
];

// Capture the original machine code first. No JS result supplies oracle inputs.
const results = JSON.parse(execFileSync(python, [path.join(root, 'scripts/native-pawn-nav-probe.py')], {
  input: JSON.stringify(scenes.map(({test, ...s}) => s)), encoding: 'utf8', maxBuffer: 1 << 26,
}));
writeFileSync(path.join(cache, 'flying-reference.json'), JSON.stringify(results, null, 2));
for (let i = 0; i < scenes.length; i++) {
  assert.equal(results[i]?.ok, true, `${scenes[i].name}: ${results[i]?.error}`);
  assert.equal(results[i].result.returned, scenes[i].test.expected, `${scenes[i].name}: original verdict`);
}
if (process.argv.includes('--original-only')) {
  for (let i = 0; i < scenes.length; i++) {
    const r = results[i].result;
    console.log(`${scenes[i].name}: ${r.returned}, moves=${r.counts.moveActor}, restores=${r.counts.farMoveActor}`);
  }
  process.exit(0);
}

function originalSnapshot(r) {
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
    commands: r.callsites.map(([op]) => buckets.get(op).shift())};
}

function translatedSnapshot(s, mod) {
  const t = s.test;
  const zones = Object.fromEntries(Object.entries(s.zones).map(([name, z]) =>
    [name, {water: !!z.water, pain: !!z.pain, damageType: z.damageType | 0, gravityZ: f32(z.gravityZ ?? -950)}]));
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
  let mi = 0, fi = 0;
  const services = {
    read: (a, n) => a[n], location: a => a.location, velocity: a => a.velocity,
    regionZone: a => a.region, footZone: a => a.foot, zoneGravity: a => a.region.gravityZ,
    isA: (a, cls) => a.cls.toLowerCase() === cls.toLowerCase(), gIsEditor: () => false,
    level: () => ({}), model: () => ({}),
    moveActor(a, delta, rotation, flags) {
      commands.push({op: 'moveActor', actor: a.name, delta: delta.map(bits), rotation: rotation.map(intBits),
        flags: [flags.test, flags.ignorePawns, flags.ignoreBalls, flags.noFail]});
      const h = s.moveActor[Math.min(mi++, s.moveActor.length - 1)].hit;
      for (let i = 0; i < 3; i++) a.location[i] = x87store(x87add(x87load(a.location[i]),
        x87mul(x87load(f32(delta[i])), x87load(f32(h.time)))));
      return {...h, time: f32(h.time), normal: h.normal.map(f32), actor: actors[h.actor] || 0};
    },
    farMoveActor(a, dest, test, noCheck) {
      commands.push({op: 'farMoveActor', actor: a.name, dest: dest.map(bits), test, noCheck});
      const r = s.farMove[Math.min(fi++, s.farMove.length - 1)];
      if (r) a.location = dest.map(f32);
      return r;
    },
    pointRegion(point) { commands.push({op: 'pointRegion', point: point.map(bits)}); return zones.dry; },
    fastLineCheck(model, end, start) {
      commands.push({op: 'fastLineCheck', end: end.map(bits), start: start.map(bits)}); return 1;
    },
    waterReach() { throw new Error('waterReach is outside the verified flying slice'); },
  };
  const point = t.point.map(f32);
  const ret = s.body === 'flyMove' ? mod.flyMove(pawn, t.delta.map(f32), target, f32(t.scale), t.restore, services)
    : s.body === 'dispatch' ? mod.physicsReach(pawn, point, f32(t.radius), target, services)
    : s.body === 'pointWorker' ? mod.pointWorker(pawn, point, 0, services)
    : mod[s.body](pawn, point, f32(t.radius), t.reachFlags, target, services);
  return {ret, location: pawn.location.map(bits), velocity: pawn.velocity.map(bits), commands};
}

const modulePath = path.join(root, 'src/runtime/script-pawn-nav.mjs');
const mod = await import(pathToFileURL(modulePath));
const originals = results.map(r => originalSnapshot(r.result));
for (let i = 0; i < scenes.length; i++)
  assert.deepEqual(translatedSnapshot(scenes[i], mod), originals[i], scenes[i].name);
console.log(`PASS flying reach: ${scenes.length}/${scenes.length} original-DLL cases (ordered calls, arguments, verdict, Location/Velocity bits)`);

// Check only the new translation boundaries; reuse the original captures.
const mutations = [
  ['retry-z', 'const retry = delta.map(v => st(x87mul(ld(v), ld(remaining))));',
    'const retry = delta.map((v,i) => i === 2 ? 0 : st(x87mul(ld(v), ld(remaining))));', 'fm-partial-retry'],
  ['failure-restore', 'if (restoreOnFailure) farMove(services, pawn, origLoc);',
    'if (!restoreOnFailure) farMove(services, pawn, origLoc);', 'fm-threshold-below'],
  ['reach-bit', 'reachFlags |= 2;', 'reachFlags |= 1;', 'fr-accumulated-flags'],
  ['retained-arrival', 'leU(distSq, ld(radiusSq)) && leU(absZ,',
    'leU(ld(storedDistSq), ld(radiusSq)) && leU(absZ,', 'fr-retained-distance'],
  ['move-budget', 'if (--counter < 0) break;', 'if (--counter <= 0) break;', 'fr-budget'],
  ['step-minimum', 'const step = ltU(ld(200), ld(CR)) ? CR : 200;',
    'const step = ltU(ld(200), ld(CR)) ? CR : 100;', 'fr-far-diagonal'],
];
const source = readFileSync(modulePath, 'utf8');
const runtimeUrl = pathToFileURL(path.dirname(modulePath) + path.sep).href;
for (const [name, before, after, caseName] of mutations) {
  assert.equal(source.split(before).length, 2, `${name}: unique mutation site`);
  const file = path.join(cache, `mut-flying-${name}.mjs`);
  try {
    writeFileSync(file, source.replace(before, after).replace(/from '\.\//g, `from '${runtimeUrl}`));
    const mutant = await import(pathToFileURL(file));
    const i = scenes.findIndex(s => s.name === caseName);
    assert.notDeepEqual(translatedSnapshot(scenes[i], mutant), originals[i], `${name}: original case must detect mutation`);
  } finally { if (existsSync(file)) unlinkSync(file); }
}
console.log(`PASS flying reach mutations: ${mutations.length}/${mutations.length}`);
