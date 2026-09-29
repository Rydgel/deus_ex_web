#!/usr/bin/env node
// Original-Engine.dll comparisons for APawn::FindBestJump (0x103c2f50),
// APawn::SuggestJumpVelocity (0x103c2c80) and APawn::jumpLanding (0x103c2530),
// and for the live callers of FindBestJump: walkReachable (0x103c1b70), the
// physics dispatcher, pointReachable's worker and actorReachable's worker. See
// docs/script-pawn-nav.md "Jumping contract".
//
// The collision boundary is a controlled double on both sides: MoveActor and
// FarMoveActor commit scripted results, Region.Zone follows a water plane
// after each committed move (a SetActorZone stand-in), PointRegion answers the
// same plane, and MoveActor's nearly-zero early return (no move, Hit
// untouched) is modeled. GLog->Logf (FindBestJump's "FAILING FBJ" line) is
// captured with its raw argument bits. Passing establishes the bodies' control
// flow, x87 rounding and boundary call sequence, not whole-scene jumping.
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
// A scripted MoveActor result: Time, full Normal and an optional actor.
const hit = (time = 1, normal = [0, 0, 0], actor = 0) => ({ret: 1, hit: {time, actor, normal, item: -1}});
const floor = (time = 0.5) => hit(time, [0, 0, 1]);
const wall = (time, normal) => hit(time, normal);

// Instruction ranges of the three translated bodies (SEH unwind funclets
// excluded; SuggestJumpVelocity's loop body sits after its catch funclet).
const COVERAGE = {findBestJump: ['103c2f50', '103c31a4'], jumpLanding: ['103c2530', '103c29b7'],
  suggestJumpVelocity: ['103c2c80', '103c2e5d'], suggestJumpVelocityLoop: ['103c2e8d', '103c2eb7']};
const G = [0, 0, -950];
const ZONES = {dry: {gravity: G, zoneVelocity: [0, 0, 0], fluidFriction: 1.2},
  wet: {water: true, gravity: G, zoneVelocity: [0, 0, 0], fluidFriction: 2.4},
  painDry: {pain: true, damageType: 7, gravity: G, zoneVelocity: [0, 0, 0], fluidFriction: 1.2},
  low: {gravity: [0, 0, -1], zoneVelocity: [0, 0, 0], fluidFriction: 0},
  tiny: {gravity: [0, 0, -10], zoneVelocity: [0, 0, 0], fluidFriction: 0},
  none: {gravity: [0, 0, 0], zoneVelocity: [0, 0, 0], fluidFriction: 0},
  freefall: {gravity: G, zoneVelocity: [0, 0, 0], fluidFriction: 0},
  up: {gravity: [0, 0, 50], zoneVelocity: [0, 0, 0], fluidFriction: 0},
  drift: {gravity: [5, -3, -900], zoneVelocity: [20, -5, 3], fluidFriction: 0.5}};
const base = {location: [0, 0, 0], velocity: [3.5, -2.25, 7.75], rotation: [12, -20, 300],
  collisionRadius: 22, collisionHeight: 40, maxStepHeight: 24, groundSpeed: 320, jumpZ: 400,
  physics: 1, flags318: 0x3000, field444: 0, baseEyeHeight: 40, collideFlag: 1};

/* A scene. `plane` is the water plane z (wet strictly below). Bodies:
 * suggestJumpVelocity(dest, &vel) · jumpLanding(vel, &landing, moveActor) ·
 * findBestJump(dest, vel, &landing, moveActor) · walkReach(point, radius,
 * reachFlags, target) · dispatch(point, radius, target) · pointWorker(point, 0)
 * · actorWorker(target, argC). */
function scene(name, body, expected, options = {}) {
  const {dest = [300, 0, 0], vel = [0, 0, 400], moveActorFlag = 1, point = [300, 0, 0], radius = 15,
    reachFlags = 0, target = 0, argC = 0, plane = -1e6, dry = 'dry', wet = 'wet', ...rest} = options;
  const pawn = {...base, ...rest.pawn};
  const zoneAt = z => z < plane ? wet : dry;
  pawn.regionZone = rest.pawn?.regionZone ?? zoneAt(f32(pawn.location[2]));
  pawn.footZone = rest.pawn?.footZone ?? pawn.regionZone;
  const vec = v => v.map(f => ({f}));
  const directArgs = body === 'suggestJumpVelocity' ? [...vec(dest), {ref: 'vecbuf'}]
    : body === 'jumpLanding' ? [...vec(vel), {ref: 'vecbuf'}, {i: moveActorFlag}]
    : body === 'findBestJump' ? [...vec(dest), ...vec(vel), {ref: 'vecbuf'}, {i: moveActorFlag}]
    : body === 'dispatch' ? [...vec(point), {f: radius}, target]
    : body === 'pointWorker' ? [...vec(point), {i: 0}]
    : body === 'actorWorker' ? [target, {i: argC}]
    : [...vec(point), {f: radius}, {i: reachFlags}, target];
  const zones = Object.fromEntries(Object.entries({...ZONES, ...rest.zones}).map(([n, z]) =>
    [n, {...z, gravityZ: z.gravity[2]}]));
  return {name, body, this: 'self', actors: rest.actors, pawn, zones,
    waterPlane: {z: plane, wet, dry}, moveNearlyZero: true,
    vecbufInit: body === 'suggestJumpVelocity' ? vel : undefined,
    coverage: Object.values(COVERAGE),
    moveActor: rest.moveActor?.length ? rest.moveActor : [hit()], farMove: rest.farMove || [1], fastLine: [1],
    singleLine: rest.singleLine || [{ret: 1, hit: {time: 1}}],
    directArgs,
    test: {expected, dest, vel, moveActorFlag, point, radius, reachFlags, target, argC, plane, dry, wet}};
}

const tgtActor = {tgt: {cls: 'actor', location: [300, 0, -200], collisionRadius: 10, collisionHeight: 10}};
const tgtPawn = {tgt: {cls: 'pawn', location: [420, 60, -150], collisionRadius: 20, collisionHeight: 40,
  regionZone: 'dry', footZone: 'dry'}};
const ticks = n => Array.from({length: n}, () => hit());
const handwritten = [
  // SuggestJumpVelocity: flight time, overshoot correction, speed choice.
  scene('sjv-level', 'suggestJumpVelocity', undefined),
  scene('sjv-up', 'suggestJumpVelocity', undefined, {dest: [200, 50, 100]}),
  scene('sjv-down-far', 'suggestJumpVelocity', undefined, {dest: [400, -300, -600]}),
  scene('sjv-too-high', 'suggestJumpVelocity', undefined, {dest: [100, 0, 500]}),
  scene('sjv-gravity-zero', 'suggestJumpVelocity', undefined, {dry: 'none'}),
  scene('sjv-gravity-up', 'suggestJumpVelocity', undefined, {dry: 'up'}),
  scene('sjv-vertical', 'suggestJumpVelocity', undefined, {dest: [0, 0, 50]}),
  scene('sjv-no-launch', 'suggestJumpVelocity', undefined, {vel: [0, 0, 0], dest: [100, 20, 30]}),
  scene('sjv-negative-time', 'suggestJumpVelocity', undefined, {vel: [0, 0, -5], dest: [100, 20, 30]}),
  scene('sjv-vertical-no-time', 'suggestJumpVelocity', undefined, {vel: [0, 0, 0], dest: [0, 0, 30]}),
  scene('sjv-groundspeed-limit', 'suggestJumpVelocity', undefined, {dest: [2000, 100, 0]}),
  scene('sjv-ratio', 'suggestJumpVelocity', undefined, {dest: [60, -10, 0], pawn: {groundSpeed: 5000}}),
  scene('sjv-small-vz', 'suggestJumpVelocity', undefined, {dry: 'tiny', vel: [0, 0, 0.4],
    dest: [50, 0, -0.001]}),
  scene('sjv-ignores-xy', 'suggestJumpVelocity', undefined, {vel: [-7, 9000, 350], dest: [-120, 80, -40],
    pawn: {location: [10.5, -3.25, 7]}}),
  // jumpLanding: floors, walls, water, the tick/speed/zone limits.
  scene('jl-floor-first', 'jumpLanding', undefined, {vel: [300, 0, 400], moveActor: [floor()]}),
  scene('jl-fall-then-floor', 'jumpLanding', undefined, {vel: [300, 40, 400], moveActor: [...ticks(3), floor(0.3)]}),
  scene('jl-restore', 'jumpLanding', undefined, {vel: [300, 40, 400], moveActorFlag: 0,
    moveActor: [...ticks(3), floor(0.3)]}),
  scene('jl-water', 'jumpLanding', undefined, {vel: [200, 0, 100], plane: -50}),
  scene('jl-steep-floor', 'jumpLanding', undefined, {vel: [300, 0, 100],
    moveActor: [hit(0.5, [0, 0.8, 0.6]), hit(), floor(0.2)]}),
  scene('jl-normal-equal', 'jumpLanding', undefined, {vel: [300, 0, 100],
    moveActor: [hit(0.5, [0, 0.71414284, 0.7]), hit(), floor(0.2)]}),
  scene('jl-wall-slide', 'jumpLanding', undefined, {vel: [300, 50, 200],
    moveActor: [wall(0.4, [-1, 0, 0]), hit(), floor(0.5)]}),
  scene('jl-wall-then-floor', 'jumpLanding', undefined, {vel: [300, 50, 200],
    moveActor: [wall(0.4, [-1, 0, 0]), floor(0.5), hit()]}),
  scene('jl-two-walls', 'jumpLanding', undefined, {vel: [300, 200, 50],
    moveActor: [wall(0.4, [-1, 0, 0]), wall(0.5, [0, -1, 0]), floor(0.2)]}),
  scene('jl-two-walls-acute', 'jumpLanding', undefined, {vel: [300, 200, 50],
    moveActor: [wall(0.4, [-0.6, -0.8, 0]), wall(0.5, [-0.8, -0.6, 0]), hit(), floor(0.2)]}),
  scene('jl-two-walls-floor-last', 'jumpLanding', undefined, {vel: [300, 200, 50],
    moveActor: [wall(0.4, [-1, 0, 0]), wall(0.5, [0, -1, 0]), hit(0.25, [0.2, 0, 0.9]), hit()]}),
  // A non-unit scripted normal makes the slide oppose Adjusted: no second move.
  scene('jl-slide-opposes', 'jumpLanding', undefined, {vel: [300, 0, 10],
    moveActor: [wall(0.5, [2, 0, 0]), hit(), floor(0.1)]}),
  scene('jl-ticks', 'jumpLanding', undefined, {vel: [10, 0, 0], dry: 'low'}),
  scene('jl-land-on-tick-36', 'jumpLanding', undefined, {vel: [10, 0, 0], dry: 'low',
    moveActor: [...ticks(35), floor()]}),
  scene('jl-land-on-tick-35', 'jumpLanding', undefined, {vel: [10, 0, 0], dry: 'low',
    moveActor: [...ticks(34), floor()]}),
  scene('jl-speed', 'jumpLanding', undefined, {vel: [0, 0, -1600], dry: 'low'}),
  scene('jl-speed-later', 'jumpLanding', undefined, {vel: [300, 0, 0], dry: 'freefall'}),
  scene('jl-terminal', 'jumpLanding', undefined, {vel: [0, 0, -1600]}),
  scene('jl-zone0', 'jumpLanding', undefined, {vel: [300, 0, 400], pawn: {collideFlag: 0},
    moveActor: [floor()]}),
  scene('jl-drift', 'jumpLanding', undefined, {vel: [250, -30, 300], dry: 'drift',
    moveActor: [...ticks(4), floor(0.7)]}),
  scene('jl-zero', 'jumpLanding', undefined, {vel: [0, 0, 0], dry: 'none'}),
  scene('jl-nearly-zero-slide', 'jumpLanding', undefined, {vel: [300, 50, 200],
    moveActor: [wall(0.99999, [-1, 0, 0]), floor(0.5), hit()]}),
  scene('jl-into-water-late', 'jumpLanding', undefined, {vel: [200, 0, 300], plane: -120,
    pawn: {location: [0, 0, 0]}}),
  // FindBestJump: verdicts, the 350 drop limit and its log, zone gates.
  scene('fbj-success', 'findBestJump', undefined, {moveActor: [...ticks(4), floor(0.5)]}),
  scene('fbj-short', 'findBestJump', undefined, {moveActor: [floor(0)]}),
  scene('fbj-drop-log', 'findBestJump', undefined, {dest: [600, 100, -800], moveActor: [...ticks(14), floor(0.6)]}),
  scene('fbj-restore', 'findBestJump', undefined, {moveActorFlag: 0, moveActor: [...ticks(4), floor(0.5)]}),
  scene('fbj-foot-pain', 'findBestJump', undefined, {pawn: {footZone: 'painDry'},
    moveActor: [...ticks(4), floor(0.5)]}),
  scene('fbj-foot-pain-immune', 'findBestJump', undefined, {pawn: {footZone: 'painDry', field444: 7},
    moveActor: [...ticks(4), floor(0.5)]}),
  scene('fbj-water-noswim', 'findBestJump', undefined, {dest: [300, 0, -200], plane: -60}),
  scene('fbj-water-swim', 'findBestJump', undefined, {dest: [300, 0, -200], plane: -60,
    pawn: {flags318: 0x7000}}),
  scene('fbj-jumpz-used', 'findBestJump', undefined, {vel: [1, 2, 3], pawn: {jumpZ: 250},
    moveActor: [...ticks(2), floor(0.5)]}),
  scene('fbj-log-restore', 'findBestJump', undefined, {dest: [600, 100, -800], moveActorFlag: 0,
    moveActor: [...ticks(14), floor(0.6)]}),
  scene('fbj-failed-landing', 'findBestJump', undefined, {vel: [0, 0, 0], pawn: {collideFlag: 0}}),
  // Callers: walkReach's -1 jump path, the dispatcher and both reach workers.
  scene('wr-jump', 'walkReach', undefined, {point: [300, 0, -200],
    moveActor: [hit(), hit(), ...ticks(3), floor(0.5), floor(1)]}),
  scene('wr-jump-fail', 'walkReach', undefined, {point: [300, 0, -200],
    moveActor: [hit(), hit(), floor(0), floor(1)]}),
  scene('wr-jump-flags', 'walkReach', undefined, {point: [300, 0, -200], reachFlags: 0x40,
    moveActor: [hit(), hit(), ...ticks(3), floor(0.5), floor(1)]}),
  scene('wr-blocked-jump-flag', 'walkReach', undefined, {point: [300, 0, 0],
    moveActor: [hit(0, [-1, 0, 0]), hit(), hit(0, [-1, 0, 0]), hit()]}),
  scene('wr-no-zone', 'walkReach', undefined, {point: [300, 0, -200], pawn: {collideFlag: 0},
    moveActor: [hit(), hit()]}),
  scene('wr-fly-first', 'walkReach', undefined, {point: [300, 0, -200], pawn: {flags318: 0xb000},
    moveActor: [hit(), hit(), hit(0)]}),
  scene('wr-jump-into-water', 'walkReach', undefined, {point: [300, 0, -200], plane: -60,
    pawn: {flags318: 0x7000}, moveActor: [hit(), hit()]}),
  scene('wr-jump-arrive', 'walkReach', undefined, {point: [140, 0, -60],
    moveActor: [hit(), hit(), hit(), floor(0.5), floor(1)]}),
  scene('wr-jump-down', 'walkReach', undefined, {point: [300, 0, -200],
    moveActor: [hit(), hit(), ...ticks(9), floor(0.5), floor(0.5)]}),
  scene('wr-jump-down-far', 'walkReach', undefined, {point: [600, 80, -300], radius: 30,
    moveActor: [hit(), hit(), ...ticks(10), floor(0.25), hit(), floor(0.5), floor(0.5)]}),
  scene('aw-jump-down', 'actorWorker', undefined, {target: 'tgt', actors: tgtActor,
    moveActor: [hit(), hit(), ...ticks(9), floor(0.5), floor(0.5)]}),
  scene('dp-jump', 'dispatch', undefined, {point: [300, 0, -200],
    moveActor: [hit(), hit(), ...ticks(3), floor(0.5), floor(1)]}),
  scene('pw-jump', 'pointWorker', undefined, {point: [300, 0, -200],
    moveActor: [hit(), hit(), ...ticks(3), floor(0.5), floor(1)]}),
  scene('aw-jump-actor', 'actorWorker', undefined, {target: 'tgt', actors: tgtActor,
    moveActor: [hit(), hit(), ...ticks(3), floor(0.5), floor(1)]}),
  scene('aw-jump-pawn', 'actorWorker', undefined, {target: 'tgt', actors: tgtPawn,
    moveActor: [hit(), hit(), ...ticks(3), floor(0.5), floor(1)]}),
];

// Generated cases (seeded, reproducible): random zones, velocities, targets,
// hit sequences with arbitrary normals, capabilities and water planes.
let seed = 0x1ea9f00d;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const range = (a, b) => f32(a + (b - a) * rnd());
const pickOf = list => list[Math.floor(rnd() * list.length)];
const unit = () => { const v = [range(-1, 1), range(-1, 1), range(-1, 1)];
  const n = Math.hypot(...v) || 1; return v.map(c => f32(c / n)); };
const randomHit = () => {
  const r = rnd();
  if (r < 0.45) return hit();
  if (r < 0.65) return hit(pickOf([0, range(0, 0.99)]), [range(-0.3, 0.3), range(-0.3, 0.3), range(0.7, 1)]);
  if (r < 0.9) return hit(pickOf([0, range(0, 0.99), 0.99999]), unit());
  return hit(range(0, 0.99), [range(-2, 2), range(-2, 2), range(-1, 1)]);
};
const hits = n => Array.from({length: n}, randomHit);
const genZone = () => ({gravity: [pickOf([0, range(-20, 20)]), pickOf([0, range(-20, 20)]),
  pickOf([-950, range(-1500, -20), range(-5, 60)])],
  zoneVelocity: rnd() < 0.6 ? [0, 0, 0] : [range(-50, 50), range(-50, 50), range(-20, 20)],
  fluidFriction: pickOf([0, 1.2, range(0, 4)])});
const generated = [];
for (let i = 0; i < 60; i++) {
  generated.push(scene(`gen-sjv-${i}`, 'suggestJumpVelocity', undefined, {zones: {gz: genZone()}, dry: 'gz',
    dest: [range(-800, 800), range(-800, 800), pickOf([range(-900, 300), range(-20, 20), 0])],
    vel: [range(-500, 500), range(-500, 500), pickOf([400, range(0, 700), range(-10, 10), 0])],
    pawn: {location: [range(-300, 300), range(-300, 300), range(-100, 100)],
      groundSpeed: pickOf([320, range(0, 1500), 0])}}));
}
for (let i = 0; i < 90; i++) {
  const plane = rnd() < 0.3 ? range(-400, -1) : -1e6;
  generated.push(scene(`gen-jl-${i}`, 'jumpLanding', undefined, {zones: {gz: genZone()}, dry: 'gz', plane,
    vel: [range(-600, 600), range(-600, 600), pickOf([range(-800, 800), 400, 0])],
    moveActorFlag: rnd() < 0.5 ? 1 : 0,
    pawn: {location: [range(-300, 300), range(-300, 300), 0], collideFlag: rnd() < 0.05 ? 0 : 1,
      rotation: [Math.floor(range(-40000, 40000)), Math.floor(range(-40000, 40000)), 0]},
    moveActor: hits(Math.floor(rnd() * 20))}));
}
for (let i = 0; i < 90; i++) {
  const plane = rnd() < 0.25 ? range(-400, -1) : -1e6;
  const foot = rnd() < 0.1 ? 'painDry' : undefined;
  generated.push(scene(`gen-fbj-${i}`, 'findBestJump', undefined, {zones: {gz: genZone()}, dry: 'gz', plane,
    dest: [range(-800, 800), range(-800, 800), pickOf([range(-900, 300), range(-20, 20)])],
    vel: [range(-500, 500), range(-500, 500), range(-500, 500)], moveActorFlag: rnd() < 0.5 ? 1 : 0,
    pawn: {location: [range(-300, 300), range(-300, 300), 0], jumpZ: pickOf([400, range(0, 800), 0]),
      groundSpeed: pickOf([320, range(0, 1000)]), flags318: pickOf([0x3000, 0x7000, 0x1000]),
      footZone: foot, field444: rnd() < 0.5 ? 7 : 0, collideFlag: rnd() < 0.05 ? 0 : 1},
    moveActor: hits(Math.floor(rnd() * 24))}));
}
for (let i = 0; i < 60; i++) {
  const plane = rnd() < 0.2 ? range(-400, -1) : -1e6;
  const body = pickOf(['walkReach', 'walkReach', 'dispatch', 'pointWorker', 'actorWorker']);
  const targetKind = body === 'actorWorker' ? pickOf(['actor', 'pawn']) : 0;
  const tLoc = [range(-600, 600), range(-600, 600), range(-400, 100)];
  generated.push(scene(`gen-${body}-${i}`, body, undefined, {zones: {gz: genZone()}, dry: 'gz', plane,
    point: tLoc, radius: range(0, 60), reachFlags: Math.floor(rnd() * 0x80),
    target: targetKind ? 'tgt' : 0, argC: rnd() < 0.5 ? 1 : 0,
    actors: targetKind ? {tgt: {cls: targetKind, location: tLoc, collisionRadius: range(5, 40),
      collisionHeight: range(5, 60), regionZone: 'gz', footZone: 'gz'}} : undefined,
    pawn: {location: [range(-200, 200), range(-200, 200), 0], flags318: pickOf([0x3000, 0x7000, 0x1000, 0x3000]),
      jumpZ: pickOf([400, range(0, 800)]), groundSpeed: pickOf([320, range(50, 1000)]),
      collisionRadius: range(5, 40), collisionHeight: range(5, 60), maxStepHeight: range(0, 40),
      collideFlag: rnd() < 0.9 ? 1 : 0},
    moveActor: [...hits(Math.floor(rnd() * 30)), pickOf([hit(), floor(1), floor(0)])]}));
}
const scenes = [...handwritten, ...generated];
if (process.env.JUMP_CASE) {                     // print one scene definition and exit
  console.log(JSON.stringify(scenes.find(s => s.name === process.env.JUMP_CASE)));
  process.exit(0);
}

// Capture the original machine code first. No JS result supplies oracle inputs.
const probe = input => JSON.parse(execFileSync(python, [path.join(root, 'scripts/native-pawn-nav-probe.py')], {
  input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 28}));
const results = probe(scenes.map(({test, ...s}) => s));
const [listing] = probe([{disasm: COVERAGE}]);
writeFileSync(path.join(cache, 'jumping-reference.json'), JSON.stringify(results));
for (let i = 0; i < scenes.length; i++) {
  assert.equal(results[i]?.ok, true, `${scenes[i].name}: ${results[i]?.error}`);
  if (scenes[i].test.expected !== undefined)
    assert.equal(results[i].result.returned, scenes[i].test.expected, `${scenes[i].name}: original verdict`);
}
const covered = new Set(results.flatMap(r => r.result.coverage));
const uncovered = Object.fromEntries(Object.entries(listing.result.instructions)
  .map(([name, list]) => [name, list.filter(a => !covered.has(a))]));
const VOID = new Set(['suggestJumpVelocity', 'jumpLanding']);
const verdicts = {};
for (const s of scenes) {
  const r = results[scenes.indexOf(s)].result;
  const key = `${s.body}:${VOID.has(s.body) ? 'void' : r.returned}`;
  verdicts[key] = (verdicts[key] ?? 0) + 1;
}
const logs = results.reduce((n, r) => n + r.result.logf.length, 0);
if (process.argv.includes('--original-only')) {
  for (let i = 0; i < handwritten.length; i++) {
    const r = results[i].result;
    const out = r.vecbuf.slice(0, 3).map(h => { io.setUint32(0, parseInt(h, 16), true); return +io.getFloat32(0, true).toFixed(3); });
    console.log(`${scenes[i].name}: ${VOID.has(scenes[i].body) ? '-' : r.returned}, moves=${r.counts.moveActor}, ` +
      `restores=${r.counts.farMoveActor}, logf=${r.logf.length}, out=${JSON.stringify(out)}, ` +
      `loc=${JSON.stringify(r.pawn.location.map(v => +v.toFixed(3)))}`);
  }
  console.log(JSON.stringify({verdicts, logs, uncovered}));
  process.exit(0);
}

const d64 = new DataView(new ArrayBuffer(8));
const doubleWords = v => { d64.setFloat64(0, v, true);
  return [d64.getUint32(0, true), d64.getUint32(4, true)].map(intBits); };

function originalSnapshot(r, body) {
  const buckets = new Map();
  const name = a => Object.entries(r.addresses).find(([, v]) => v === a)?.[0] ?? a;
  for (const c of r.commands) {
    const n = c.op === 'moveActor' ? {op: c.op, actor: name(c.actor), delta: c.deltaBits,
      rotation: c.rotationBits, flags: c.flags}
      : c.op === 'farMoveActor' ? {op: c.op, actor: name(c.actor), dest: c.destBits, test: c.test, noCheck: c.noCheck}
      : c.op === 'pointRegion' ? {op: c.op, point: c.point.map(bits)}
      : c.op === 'fastLineCheck' ? {op: c.op, end: c.end.map(bits), start: c.start.map(bits)}
      : c.op === 'singleLineCheck' ? {op: c.op, source: name(c.source), end: c.end.map(bits),
        start: c.start.map(bits), flags: c.flags, extent: c.extent.map(bits)}
      : assert.fail(`Unexpected original boundary ${c.op}`);
    if (!buckets.has(c.op)) buckets.set(c.op, []);
    buckets.get(c.op).push(n);
  }
  buckets.set('logf', r.logf.map(l => ({op: 'logf', format: l.format, args: l.args})));
  return {ret: VOID.has(body) ? null : r.returned, location: r.pawn.locationBits, velocity: r.pawn.velocityBits,
    region: name(r.pawn.regionZone),
    out: ['suggestJumpVelocity', 'jumpLanding', 'findBestJump'].includes(body) ? r.vecbuf.slice(0, 3) : null,
    commands: r.callsites.map(([op]) => buckets.get(op).shift())};
}

const X_SMALL = 1e-4;
function translatedSnapshot(s, mod) {
  const t = s.test;
  const zones = Object.fromEntries(Object.entries(s.zones).map(([name, z]) =>
    [name, {name, water: !!z.water, pain: !!z.pain, damageType: z.damageType | 0, gravityZ: f32(z.gravityZ),
      gravity: z.gravity.map(f32), velocity: z.zoneVelocity.map(f32), fluidFriction: f32(z.fluidFriction)}]));
  const zoneAt = z => zones[z < s.waterPlane.z ? s.waterPlane.wet : s.waterPlane.dry];
  const makeActor = (name, a) => ({name, cls: a.cls || 'actor',
    location: (a.location || [0, 0, 0]).map(f32), velocity: (a.velocity || [0, 0, 0]).map(f32),
    Rotation: a.rotation || [0, 0, 0], CollisionRadius: f32(a.collisionRadius || 0),
    CollisionHeight: f32(a.collisionHeight || 0), MaxStepHeight: f32(a.maxStepHeight || 0),
    GroundSpeed: f32(a.groundSpeed || 0), JumpZ: f32(a.jumpZ || 0), BaseEyeHeight: f32(a.baseEyeHeight || 0),
    MeleeRange: f32(a.meleeRange || 0), Physics: a.physics | 0, Flags318: a.flags318 | 0,
    Flags1dc: a.flags1dc | 0, CollideFlag: a.collideFlag | 0,
    ReducedDamageType: a.field444 | 0, WarpDestZone: zones[a.markedWarpZone] || 0,
    region: zones[a.regionZone] || zones.dry, foot: zones[a.footZone] || zones.dry});
  const actors = Object.fromEntries(Object.entries(s.actors || {}).map(([n, a]) => [n, makeActor(n, a)]));
  const pawn = actors.self = makeActor('self', s.pawn);
  const target = actors[t.target] || 0;
  const commands = [];
  let mi = 0, fi = 0, si = 0;
  const services = {
    read: (a, n) => a[n], location: a => a.location, velocity: a => a.velocity,
    regionZone: a => a.region, footZone: a => a.foot, zoneGravity: a => a.region.gravityZ,
    isA: (a, cls) => a.cls.toLowerCase() === cls.toLowerCase(), gIsEditor: () => false,
    level: () => ({}), model: () => ({}),
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
    singleLineCheck(source, end, start, flags, extent) {
      commands.push({op: 'singleLineCheck', source: source.name, end: end.map(bits), start: start.map(bits),
        flags, extent: extent.map(bits)});
      const r = s.singleLine[Math.min(si++, s.singleLine.length - 1)];
      return {time: f32(r.hit?.time ?? 1), actor: actors[r.hit?.actor] || 0};
    },
    logf(event) {
      assert.equal(event.args.length, 5);
      commands.push({op: 'logf', format: event.format,
        args: [...event.args.slice(0, 4).flatMap(doubleWords), intBits(event.args[4])]});
    },
  };
  const f = v => v.map(f32), out = [0, 0, 0];
  let ret = null;
  if (s.body === 'suggestJumpVelocity') { out.splice(0, 3, ...f(t.vel)); mod.suggestJumpVelocity(pawn, f(t.dest), out, services); }
  else if (s.body === 'jumpLanding') mod.jumpLanding(pawn, f(t.vel), out, t.moveActorFlag, services);
  else if (s.body === 'findBestJump') ret = mod.findBestJump(pawn, f(t.dest), f(t.vel), out, t.moveActorFlag, services);
  else if (s.body === 'dispatch') ret = mod.physicsReach(pawn, f(t.point), f32(t.radius), target, services);
  else if (s.body === 'pointWorker') ret = mod.pointWorker(pawn, f(t.point), 0, services);
  else if (s.body === 'actorWorker') ret = mod.actorWorker(pawn, target, t.argC, services);
  else ret = mod.walkReach(pawn, f(t.point), f32(t.radius), t.reachFlags, target, services);
  return {ret, location: pawn.location.map(bits), velocity: pawn.velocity.map(bits), region: pawn.region.name,
    out: ['suggestJumpVelocity', 'jumpLanding', 'findBestJump'].includes(s.body) ? out.map(bits) : null, commands};
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
console.log(`PASS jump reach: ${scenes.length}/${scenes.length} original-DLL cases (${handwritten.length} targeted, ` +
  `${generated.length} generated; ${commandCount} ordered boundary calls with argument bits incl. ${logs} GLog lines, ` +
  `verdict, Location/Velocity/Region, out vector), 0 mismatches`);
console.log(`verdicts ${JSON.stringify(verdicts)}`);
console.log(`instruction coverage: ${Object.entries(listing.result.instructions).map(([n, l]) =>
  `${n} ${l.length - uncovered[n].length}/${l.length}`).join(', ')}${missing ? ` uncovered ${JSON.stringify(uncovered)}` : ''}`);
assert.equal(missing, 0, 'every instruction of the three bodies executes in some original case');

// Check only the new translation boundaries; reuse the original captures.
const mutations = [
  ['no-gravity-default', 'gravityZ = -100;          // 0x103c2cc6', 'gravityZ = -950;', 'sjv-gravity-zero'],
  ['stored-current-z', 'currentZ = x87add(x87mul(vz, D005), currentZ);',
    'currentZ = x87add(x87mul(ld(vel[2]), D005), currentZ);', 'gen-sjv-50'],
  ['no-overshoot', 'flightTime = st(sub(ld(flightTime), x87div(sub(currentZ, ld(deltaZ)), vz)));', '', 'sjv-down-far'],
  ['speed-choice', 'speed = gtU(groundSpeed, ratio) ? ratio : groundSpeed;',
    'speed = ratio;', 'sjv-groundspeed-limit'],
  ['keep-xy', 'for (let i = 0; i < 3; i++) vel[i] = st(sub(ld(dest[i]), ld(loc[i])));  // 0x103c2d40',
    'for (let i = 2; i < 3; i++) vel[i] = st(sub(ld(dest[i]), ld(loc[i])));', 'sjv-ignores-xy'],
  ['friction', 'const k = sub(D1f, x87mul(t, ld(f32(zone.fluidFriction))));', 'const k = D1f;', 'jl-fall-then-floor'],
  ['zone-velocity', "st(x87mul(ld(st(x87add(ld(v[0]), ld(zv[0])))), t)),", 'st(x87mul(ld(v[0]), t)),', 'jl-drift'],
  ['stored-tgz', 'const tgz = x87mul(t, ld(g[2]));', 'const tgz = ld(st(x87mul(t, ld(g[2]))));', 'jl-fall-then-floor'],
  ['tick-limit', 'ticks > 35', 'ticks > 36', 'jl-land-on-tick-36'],
  ['speed-limit', 'gtU(speedSq, ld(2500000))', 'gtU(speedSq, ld(25000000))', 'jl-speed-later'],
  ['no-zone-check', "!(rd(services, pawn, 'CollideFlag') & 0xff) || ", '', 'jl-zone0'],
  ['water-landing', 'if (services.regionZone(pawn).water) landed = 1;        // 0x103c26f0', 'if (false) landed = 1;', 'jl-water'],
  ['slide-gate', 'if (!ltU(along, ld(0))) {', 'if (true) {', 'jl-slide-opposes'],
  ['landing-keeps-sliding', 'if (gtU(ld(hit.normal[2]), D07)) landed = 1;    // 0x103c283c',
    'if (gtU(ld(hit.normal[2]), D07)) { landed = 1; continue; }', 'jl-wall-then-floor'],
  ['hit-retention', 'if (!nearlyZero(delta)) hit = result;', 'hit = result;',
    'jl-nearly-zero-slide'],
  ['landing-restore', 'if (!moveActorFlag) farMove(services, pawn, origin);      // 0x103c299e', '', 'jl-restore'],
  ['jumpz', "f32(rd(services, pawn, 'JumpZ'))];", 'f32(vel[2])];', 'fbj-jumpz-used'],
  ['drop-limit', 'if (ltU(sub(ld(real[2]), ld(at[2])), ld(350)))', 'if (true)', 'fbj-drop-log'],
  ['gain', 'success = gtU(ld(netchange), D8) ? 1 : 0;', 'success = gtU(ld(netchange), D0) ? 1 : 0;', 'gen-fbj-3'],
  ['foot-pain', "if (foot.pain && foot.damageType !== rd(services, pawn, 'ReducedDamageType')) success = 0;\n  else if",
    'if', 'fbj-foot-pain'],
  ['swim-gate', "else if (!(rd(services, pawn, 'Flags318') & 0x4000) && services.regionZone(pawn).water) success = 0;",
    '', 'fbj-water-noswim'],
  ['fbj-restore', 'if (!moveActorFlag) farMove(services, pawn, real);        // 0x103c3189', '', 'fbj-restore'],
  ['log-args', 'x87number(appSqrt(sizeSq(old))), st(appSqrt(sizeSq(dist))),',
    'oldSize, st(appSqrt(sizeSq(dist))),', 'fbj-drop-log'],
];
const source = readFileSync(modulePath, 'utf8');
const runtimeUrl = pathToFileURL(path.dirname(modulePath) + path.sep).href;
for (const [name, before, after, caseName] of mutations) {
  assert.equal(source.split(before).length, 2, `${name}: unique mutation site`);
  const file = path.join(cache, `mut-jumping-${name}.mjs`);
  try {
    writeFileSync(file, source.replace(before, after).replace(/from '\.\//g, `from '${runtimeUrl}`));
    const mutant = await import(pathToFileURL(file));
    if (process.env.JUMP_MUTANT_SEARCH) {         // list every detecting case
      const hits = scenes.filter((s, j) => { try { return !isDeepStrictEqual(translatedSnapshot(s, mutant), originals[j]); }
        catch { return true; } }).map(s => s.name);
      console.log(`${name}: ${hits.length} ${hits.slice(0, 8).join(' ')}`);
      continue;
    }
    const i = scenes.findIndex(s => s.name === caseName);
    assert.ok(i >= 0, `${name}: case ${caseName}`);
    let detected;
    try { detected = !isDeepStrictEqual(translatedSnapshot(scenes[i], mutant), originals[i]); }
    catch { detected = true; }
    assert.ok(detected, `${name}: original case ${caseName} must detect mutation`);
  } finally { if (existsSync(file)) unlinkSync(file); }
}
console.log(`PASS jump reach mutations: ${mutations.length}/${mutations.length}`);

function isDeepStrictEqual(a, b) {
  try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
}
