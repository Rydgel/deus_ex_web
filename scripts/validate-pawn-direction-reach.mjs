#!/usr/bin/env node
// Original-Engine.dll comparisons for native 708 AIDirectionReachable: the exec
// APawn::execAIDirectionReachable (0x103c8560) and the band search it calls,
// APawn::AIDirectionReachable (0x103c78a0, "aiPickSearch"), with its literal
// 15.0f. See docs/script-pawn-nav.md "AIDirectionReachable native 708".
//
// The oracle runs the real exec: its six P_GET steps read a scripted token
// stream through GNatives evaluator stubs (constants copy their operand; an
// lvalue also sets Core GPropAddr, as EX_LocalVariable does), then P_FINISH,
// the body and the result store run as original machine code. The collision
// boundary is a controlled double on both sides: MoveActor/FarMoveActor commit
// scripted results, Region.Zone follows a water plane after each committed
// move (a SetActorZone stand-in), PointRegion answers the same plane, and
// MoveActor's nearly-zero early return is modeled. Each case compares the
// result dword (preset to a sentinel), the out vector (preset to a sentinel),
// a stale-GPropAddr target, final Location/Velocity/Region and every ordered
// MoveActor/FarMoveActor/PointRegion call with raw argument bits, for both the
// translated exec and Play's VM binding (ScriptRuntime.invokeNative running
// compiled bytecode with a local out variable).
//
// --original-only records the original reference cases (before the JS exec).
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
const hit = (time = 1, normal = [0, 0, 0], actor = 0) => ({ret: 1, hit: {time, actor, normal, item: -1}});
const floor = (time = 0.1) => hit(time, [0, 0, 1]);
// One flat checkMove step: the forward move completes, the down-probe lands.
const flat = n => Array.from({length: n}, () => [hit(), floor()]).flat();

// Instruction ranges: the exec, the band search's main body (its catch funclet
// 0x103c7de8.. is excluded) and the range-score helper 0x103c7f80.
const COVERAGE = {exec: ['103c8560', '103c869e'], search: ['103c78a0', '103c7de8'],
  score: ['103c7f80', '103c7fab']};
// The GIsEditor assert block runs only in the editor. The gIsEditor case
// compares the refusal (appFailAssert on the original, a throw in the
// translation); the probe reports no coverage for a failed scene, and
// appFailAssert does not return (0x103c798c is unreachable).
// 0x103c7c5c is the step switch's default arm (mode not 1/2/3): the only
// branch to it, 0x103c7bd1, follows mode checks the loop can't fail, since
// [ebp+0x1c] is set to 3, 2 or 1 before the loop and every other mode returned
// at 0x103c7b71.
const EXCLUDED = new Set(['103c7977', '103c797c', '103c7981', '103c7986', '103c798c', '103c7c5c']);
const G = [0, 0, -950];
const ZONES = {dry: {gravity: G, zoneVelocity: [0, 0, 0], fluidFriction: 1.2},
  wet: {water: true, gravity: G, zoneVelocity: [0, 0, 0], fluidFriction: 2.4},
  painDry: {pain: true, damageType: 7, gravity: G, zoneVelocity: [0, 0, 0], fluidFriction: 1.2},
  painWet: {water: true, pain: true, damageType: 7, gravity: G, zoneVelocity: [0, 0, 0], fluidFriction: 2.4},
  up: {gravity: [0, 0, 50], zoneVelocity: [0, 0, 0], fluidFriction: 0}};
const base = {location: [10, -20, 5], velocity: [3.5, -2.25, 7.75], rotation: [12, -20, 300],
  collisionRadius: 22, collisionHeight: 40, maxStepHeight: 24, groundSpeed: 320, jumpZ: 400,
  physics: 1, flags318: 0x7000, field444: 0, baseEyeHeight: 40, collideFlag: 1};
const OUT_SENTINEL = [1234.5, -678.25, 9.125];
const OUT_CONST = [-3.5, 17.25, 0.5];
const RESULT_SENTINEL = 0xa5a5a5a5;

/* An exec scene. `out`: 'ref' (an lvalue: GPropAddr -> the caller's vector),
 * 'const' (a vector constant: GPropAddr stays 0) or 'nothing'. `stale` presets
 * GPropAddr to hitbuf before the call. `plane` is the water plane z. */
function scene(name, expected, options = {}) {
  const {focus, yaw = 0x4000, pitch = 0, minDist = 0, maxDist = 64, out = 'ref', stale = false,
    plane = -1e6, dry = 'dry', wet = 'wet', gIsEditor = 0, ...rest} = options;
  const pawn = {...base, ...rest.pawn};
  const zoneAt = z => z < plane ? wet : dry;
  pawn.regionZone = rest.pawn?.regionZone ?? zoneAt(f32(pawn.location[2]));
  pawn.footZone = rest.pawn?.footZone ?? pawn.regionZone;
  const origin = focus ?? pawn.location;
  const outArg = out === 'ref' ? {kind: 'out', value: 'vecbuf'}
    : out === 'const' ? {kind: 'vector', value: OUT_CONST} : {kind: 'nothing'};
  const zones = Object.fromEntries(Object.entries({...ZONES, ...rest.zones}).map(([n, z]) =>
    [n, {...z, gravityZ: z.gravity[2]}]));
  return {name, body: 'aiDirectionReachableExec', this: 'self', pawn, zones, gIsEditor,
    waterPlane: {z: plane, wet, dry}, moveNearlyZero: true,
    vecbufInit: OUT_SENTINEL, resultInit: RESULT_SENTINEL, gPropAddr: stale ? 'hitbuf' : 0,
    coverage: Object.values(COVERAGE),
    moveActor: rest.moveActor?.length ? rest.moveActor : [hit()], farMove: rest.farMove || [1],
    fastLine: [1], singleLine: [{ret: 1, hit: {time: 1}}],
    args: [{kind: 'vector', value: origin}, {kind: 'int', value: yaw}, {kind: 'int', value: pitch},
      {kind: 'float', value: minDist}, {kind: 'float', value: maxDist}, outArg],
    test: {expected, focus: origin, yaw, pitch, minDist, maxDist, out, stale, plane, dry, wet}};
}

const wall = [hit(0.5, [-1, 0, 0]), hit(), hit(0, [-1, 0, 0]), hit(0.5, [-1, 0, 0])];
const handwritten = [
  // GetNextVector's call: band [0, 64] around Location, yaw toward the target;
  // the walk leaves the band on the third 22-unit step and keeps the second.
  scene('walk-follow', 1, {pitch: 0x0e00, moveActor: flat(8)}),
  scene('walk-follow-const-out', 1, {out: 'const', moveActor: flat(8)}),
  scene('walk-follow-nothing-out', 1, {out: 'nothing', moveActor: flat(8)}),
  scene('walk-follow-stale-gpropaddr', 1, {out: 'const', stale: true, moveActor: flat(8)}),
  scene('walk-follow-stale-ref', 1, {stale: true, moveActor: flat(8)}),
  scene('walk-blocked', 0, {moveActor: wall}),
  scene('walk-blocked-const-out', 0, {out: 'const', moveActor: wall}),
  scene('walk-ledge-retry', undefined, {pawn: {collisionRadius: 30, maxStepHeight: 20},
    moveActor: [hit(), hit(), ...flat(8)]}),
  scene('walk-ledge-stop', 0, {pawn: {collisionRadius: 10}, moveActor: [hit(), hit()]}),
  scene('walk-zone0-blocked', 0, {pawn: {collideFlag: 0}, moveActor: wall}),
  scene('walk-zone0-flat', 1, {pawn: {collideFlag: 0}, moveActor: flat(8)}),
  scene('walk-foot-pain', undefined, {pawn: {footZone: 'painDry'}, moveActor: flat(8)}),
  scene('walk-foot-pain-immune', 1, {pawn: {footZone: 'painDry', field444: 7}, moveActor: flat(8)}),
  scene('walk-into-water', undefined, {plane: 3, moveActor: flat(8)}),
  scene('walk-iteration-cap', 1, {maxDist: 100000, pawn: {collisionRadius: 25}, moveActor: flat(120)}),
  scene('walk-approach-focus', 1, {focus: [10, 180, 5], moveActor: flat(12)}),
  scene('walk-backpedal', 1, {focus: [10, -40, 5], minDist: 100, maxDist: 160, moveActor: flat(12)}),
  scene('walk-jump-over-band', 1, {minDist: 30, maxDist: 31, moveActor: flat(8)}),
  scene('walk-inverted-band', undefined, {minDist: 100, maxDist: 50, moveActor: flat(12)}),
  scene('walk-negative-min', undefined, {minDist: -30, maxDist: 70, moveActor: flat(8)}),
  scene('walk-focus-far-side', undefined, {focus: [300, 400, -50], yaw: 0x8000, minDist: 20, maxDist: 500,
    moveActor: flat(10)}),
  scene('walk-physics3-dry', 1, {pawn: {physics: 3}, moveActor: flat(8)}),
  scene('walk-up-gravity', undefined, {dry: 'up', moveActor: flat(8)}),
  scene('walk-stride-min', undefined, {pawn: {collisionRadius: 2}, moveActor: flat(20)}),
  scene('walk-stride-max', undefined, {pawn: {collisionRadius: 60}, moveActor: flat(8)}),
  scene('walk-stride-mid', undefined, {pawn: {collisionRadius: 12.5}, moveActor: flat(8)}),
  scene('walk-yaw-wrap', undefined, {yaw: 70000, pitch: -5000, moveActor: flat(8)}),
  scene('walk-yaw-negative', undefined, {yaw: -16384, moveActor: flat(8)}),
  scene('walk-partial-steps', undefined, {moveActor: [hit(0.5, [-0.8, 0, 0.6]), hit(), hit(), floor(0.3),
    hit(), floor(0.9), hit(0.25, [0, -1, 0]), hit(), hit(0.5, [0, 0, 1]), floor(0.5), ...flat(6)]}),
  scene('fly-pitch', undefined, {pawn: {physics: 4}, pitch: 0x2000, maxDist: 120}),
  scene('fly-pitch-wrap', undefined, {pawn: {physics: 4}, pitch: 0x11000, yaw: -3000, maxDist: 120}),
  scene('fly-blocked', 0, {pawn: {physics: 4}, pitch: -0x1000, moveActor: [hit(0, [0, -1, 0])]}),
  // The up-step of flyMove's retry moves MaxStepHeight: enough for code 1.
  scene('fly-upstep', undefined, {pawn: {physics: 4}, pitch: -0x1000, moveActor: [hit(0, [0, -1, 0]), hit(), hit(0, [0, -1, 0])]}),
  scene('fly-zone0-blocked', 0, {pawn: {physics: 4, collideFlag: 0}, moveActor: [hit(0, [0, -1, 0])]}),
  scene('fly-backpedal', undefined, {pawn: {physics: 4}, pitch: 0x1800, focus: [0, 0, 0], minDist: 60, maxDist: 90}),
  scene('swim', undefined, {plane: 1000, pawn: {physics: 3}, pitch: 0x0800, maxDist: 100}),
  scene('swim-leaves-water', undefined, {plane: 20, pawn: {physics: 3}, pitch: 0x3000, maxDist: 100}),
  scene('swim-foot-pain', undefined, {plane: 1000, wet: 'painWet', pawn: {physics: 3}, maxDist: 100}),
  scene('swim-while-falling', undefined, {plane: 1000, pawn: {physics: 2}, pitch: -0x0800, maxDist: 100}),
  scene('swim-flying-in-water', undefined, {plane: 1000, pawn: {physics: 4}, pitch: 0x0800, maxDist: 100}),
  scene('falling-early', 0, {pawn: {physics: 2}}),
  scene('none-early', 0, {pawn: {physics: 0}}),
  scene('rotating-early', 0, {pawn: {physics: 5}, out: 'const'}),
  scene('spider-early', 0, {pawn: {physics: 7}, stale: true, out: 'nothing'}),
  scene('gisediter-refuses', undefined, {gIsEditor: 1, moveActor: flat(8)}),
];

// Generated cases (seeded, reproducible): modes, focus offsets, directions,
// bands, strides, capabilities, water planes and arbitrary hit sequences.
let seed = 0x708d1e;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const range = (a, b) => f32(a + (b - a) * rnd());
const pickOf = list => list[Math.floor(rnd() * list.length)];
const unit = () => { const v = [range(-1, 1), range(-1, 1), range(-1, 1)];
  const n = Math.hypot(...v) || 1; return v.map(c => f32(c / n)); };
const randomHit = () => {
  const r = rnd();
  if (r < 0.4) return hit();
  if (r < 0.7) return floor(pickOf([0, range(0, 0.99), 0.1]));
  if (r < 0.9) return hit(pickOf([0, range(0, 0.99)]), unit());
  return hit(range(0, 0.99), [range(-0.3, 0.3), range(-0.3, 0.3), range(0.5, 1)]);
};
const generated = [];
for (let i = 0; i < 240; i++) {
  const kind = pickOf(['walk', 'walk', 'walk', 'fly', 'swim', 'early']);
  const physics = kind === 'walk' ? pickOf([1, 1, 3]) : kind === 'fly' ? 4 : kind === 'swim' ? pickOf([3, 2, 4, 1])
    : pickOf([0, 2, 5, 6, 7]);
  const location = [range(-300, 300), range(-300, 300), range(-50, 50)];
  const plane = kind === 'swim' ? pickOf([1e4, range(location[2] + 1, location[2] + 150)])
    : rnd() < 0.15 ? range(location[2] - 30, location[2] - 1) : -1e6;
  const focus = rnd() < 0.5 ? location
    : location.map(c => f32(c + pickOf([range(-40, 40), range(-300, 300)])));
  const minDist = pickOf([0, 0, range(0, 120), range(-40, 0), 40]);
  const maxDist = pickOf([64, range(0, 300), f32(minDist + range(0, 30)), range(0, 40)]);
  const n = kind === 'early' ? 1 : Math.floor(rnd() * 40);
  generated.push(scene(`gen-${kind}-${i}`, undefined, {focus, plane, minDist, maxDist,
    yaw: Math.floor(range(-70000, 140000)), pitch: Math.floor(range(-40000, 40000)),
    out: pickOf(['ref', 'ref', 'ref', 'ref', 'const', 'nothing']), stale: rnd() < 0.2,
    dry: rnd() < 0.1 ? 'up' : 'dry', wet: rnd() < 0.1 ? 'painWet' : 'wet',
    pawn: {location, physics, collisionRadius: pickOf([22, range(1, 40), range(4, 30)]),
      maxStepHeight: pickOf([24, range(0, 40)]), collideFlag: rnd() < 0.1 ? 0 : 1,
      footZone: rnd() < 0.08 ? 'painDry' : undefined, field444: rnd() < 0.5 ? 7 : 0,
      velocity: [range(-50, 50), range(-50, 50), range(-50, 50)],
      rotation: [Math.floor(range(-40000, 40000)), Math.floor(range(-40000, 40000)), 0]},
    moveActor: [...Array.from({length: n}, randomHit), pickOf([hit(), floor(), ...flat(2)])]}));
}
const scenes = [...handwritten, ...generated];
if (process.env.DIRECTION_CASE) {                 // print one scene definition and exit
  console.log(JSON.stringify(scenes.find(s => s.name === process.env.DIRECTION_CASE)));
  process.exit(0);
}

// Capture the original machine code first. No JS result supplies oracle inputs.
const probe = input => JSON.parse(execFileSync(python, [path.join(root, 'scripts/native-pawn-nav-probe.py')], {
  input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 28}));
const results = probe(scenes.map(({test, ...s}) => s));
const [listing] = probe([{disasm: COVERAGE}]);
writeFileSync(path.join(cache, 'direction-reach-reference.json'), JSON.stringify(results));
const refused = new Set(scenes.filter(s => s.gIsEditor).map(s => s.name));
for (let i = 0; i < scenes.length; i++) {
  if (refused.has(scenes[i].name)) {
    assert.equal(results[i]?.ok, false, `${scenes[i].name}: the original asserts !GIsEditor`);
    assert.match(results[i].error, /appFailAssert fired/, scenes[i].name);
    continue;
  }
  assert.equal(results[i]?.ok, true, `${scenes[i].name}: ${results[i]?.error}`);
  const r = results[i].result;
  // The exec steps over its six expressions plus P_FINISH's end byte and
  // always stores the whole result dword.
  const tokens = scenes[i].args.reduce((n, a) => n + 1 + ({vector: 12, int: 4, float: 4, out: 4, nothing: 0})[a.kind], 0);
  assert.equal(r.codeConsumed, tokens + 1, `${scenes[i].name}: exec consumed its arguments and P_FINISH`);
  assert.ok(['00000000', '00000001'].includes(r.resultOut), `${scenes[i].name}: result dword ${r.resultOut}`);
  assert.equal(parseInt(r.resultOut, 16), r.returned, `${scenes[i].name}: *Result is the body's eax`);
  assert.deepEqual(r.hitbuf.slice(0, 3), ['00000000', '00000000', '00000000'],
    `${scenes[i].name}: a stale GPropAddr is never written`);
  if (scenes[i].test.expected !== undefined)
    assert.equal(r.returned, scenes[i].test.expected, `${scenes[i].name}: original verdict`);
}
const covered = new Set(results.flatMap(r => r.ok ? r.result.coverage : []));
const uncovered = Object.fromEntries(Object.entries(listing.result.instructions)
  .map(([name, list]) => [name, list.filter(a => !covered.has(a) && !EXCLUDED.has(a))]));
const verdicts = {};
for (let i = 0; i < scenes.length; i++) {
  const key = results[i].ok ? `${scenes[i].test.out}:${results[i].result.returned}` : 'refused';
  verdicts[key] = (verdicts[key] ?? 0) + 1;
}
const outBitsOf = vals => vals.map(bits);
if (process.argv.includes('--original-only')) {
  for (let i = 0; i < handwritten.length; i++) {
    if (!results[i].ok) { console.log(`${scenes[i].name}: refused (${results[i].error.split(';')[0]})`); continue; }
    const r = results[i].result;
    const out = r.vecbuf.slice(0, 3).map(h => { io.setUint32(0, parseInt(h, 16), true); return +io.getFloat32(0, true).toFixed(3); });
    console.log(`${scenes[i].name}: ${r.resultOut}, moves=${r.counts.moveActor}, restores=${r.counts.farMoveActor}, ` +
      `out=${JSON.stringify(out)}, loc=${JSON.stringify(r.pawn.location.map(v => +v.toFixed(3)))}`);
  }
  console.log(JSON.stringify({verdicts, uncovered}));
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
      : assert.fail(`Unexpected original boundary ${c.op}`);
    if (!buckets.has(c.op)) buckets.set(c.op, []);
    buckets.get(c.op).push(n);
  }
  return {result: r.resultOut, out: r.vecbuf.slice(0, 3), location: r.pawn.locationBits,
    velocity: r.pawn.velocityBits, region: name(r.pawn.regionZone),
    commands: r.callsites.map(([op]) => buckets.get(op).shift())};
}

const X_SMALL = 1e-4;
/* The translated world for one scene: the pawn, its zones and the scripted
 * boundary services, recording the same ordered calls the probe records. */
function world(s) {
  const zones = Object.fromEntries(Object.entries(s.zones).map(([name, z]) =>
    [name, {name, water: !!z.water, pain: !!z.pain, damageType: z.damageType | 0, gravityZ: f32(z.gravityZ),
      gravity: z.gravity.map(f32), velocity: z.zoneVelocity.map(f32), fluidFriction: f32(z.fluidFriction)}]));
  const zoneAt = z => zones[z < s.waterPlane.z ? s.waterPlane.wet : s.waterPlane.dry];
  const a = s.pawn;
  const pawn = {name: 'self', cls: 'pawn', location: a.location.map(f32), velocity: a.velocity.map(f32),
    Rotation: a.rotation, CollisionRadius: f32(a.collisionRadius), CollisionHeight: f32(a.collisionHeight),
    MaxStepHeight: f32(a.maxStepHeight), GroundSpeed: f32(a.groundSpeed), JumpZ: f32(a.jumpZ),
    BaseEyeHeight: f32(a.baseEyeHeight), Physics: a.physics | 0, Flags318: a.flags318 | 0,
    CollideFlag: a.collideFlag | 0, ReducedDamageType: a.field444 | 0,
    region: zones[a.regionZone], foot: zones[a.footZone]};
  const commands = [];
  let mi = 0, fi = 0;
  const services = {
    read: (actor, n) => actor[n], location: actor => actor.location, velocity: actor => actor.velocity,
    regionZone: actor => actor.region, footZone: actor => actor.foot, zoneGravity: actor => actor.region.gravityZ,
    isA: (actor, cls) => actor.cls.toLowerCase() === cls.toLowerCase(), gIsEditor: () => !!s.gIsEditor,
    level: () => ({}), model: () => ({}),
    moveActor(actor, delta, rotation, flags) {
      commands.push({op: 'moveActor', actor: actor.name, delta: delta.map(bits), rotation: rotation.map(intBits),
        flags: [flags.test, flags.ignorePawns, flags.ignoreBalls, flags.noFail]});
      if (delta.every(c => !(Math.abs(f32(c)) >= X_SMALL)) && rotation.every((r, i) => r === actor.Rotation[i]))
        return {time: 1, normal: [0, 0, 0], actor: 0, item: -1};
      const h = s.moveActor[Math.min(mi++, s.moveActor.length - 1)].hit;
      for (let i = 0; i < 3; i++) actor.location[i] = x87store(x87add(x87load(actor.location[i]),
        x87mul(x87load(f32(delta[i])), x87load(f32(h.time)))));
      actor.region = zoneAt(actor.location[2]);
      return {...h, time: f32(h.time), normal: h.normal.map(f32), actor: 0};
    },
    farMoveActor(actor, dest, test, noCheck) {
      commands.push({op: 'farMoveActor', actor: actor.name, dest: dest.map(bits), test, noCheck});
      const r = s.farMove[Math.min(fi++, s.farMove.length - 1)];
      if (r) actor.location = dest.map(f32);
      actor.region = zoneAt(actor.location[2]);
      return r;
    },
    pointRegion(point) { commands.push({op: 'pointRegion', point: point.map(bits)}); return zoneAt(f32(point[2])); },
    fastLineCheck() { throw new Error('FastLineCheck is outside this corpus'); },
    singleLineCheck() { throw new Error('SingleLineCheck is outside this corpus'); },
  };
  const snapshot = (result, out) => ({result: intBits(result ? 1 : 0), out: out.map(bits),
    location: pawn.location.map(bits), velocity: pawn.velocity.map(bits), region: pawn.region.name, commands});
  return {pawn, services, snapshot};
}

/* The translated exec, called the way the runtime binding calls it: `dest` is
 * a {reference, set} lvalue for 'ref', a plain vector value for 'const' and
 * undefined for EX_Nothing. */
function translatedDirect(s, nav) {
  const t = s.test, {pawn, services, snapshot} = world(s);
  const variable = {value: OUT_SENTINEL.map(f32)};
  const dest = t.out === 'ref' ? {reference: true, get: () => variable.value, set: v => { variable.value = v; }}
    : t.out === 'const' ? OUT_CONST.map(f32) : undefined;
  const ret = nav.execAiDirectionReachable(pawn, t.focus.map(f32), t.yaw | 0, t.pitch | 0,
    f32(t.minDist), f32(t.maxDist), dest, services);
  return snapshot(ret, variable.value);
}

/* Play's binding: compiled bytecode `return AIDirectionReachable(<consts>,
 * BestDest)` run by the script VM, whose native call reaches
 * ScriptRuntime.invokeNative with a local out variable (or a non-lvalue). */
function translatedRuntime(s, Runtime, compileFunction) {
  const t = s.test, {pawn, services, snapshot} = world(s);
  const le = (n, write) => { const b = new DataView(new ArrayBuffer(4)); write(b, n); return [...new Uint8Array(b.buffer)]; };
  const float = v => le(v, (b, n) => b.setFloat32(0, n, true)), int = v => le(v, (b, n) => b.setInt32(0, n, true));
  const vector = v => [0x23, ...v.flatMap(float)];
  const outBytes = t.out === 'ref' ? [0x00, 1] : t.out === 'const' ? vector(OUT_CONST) : [0x0b];
  const bytes = Uint8Array.from([0x04, 0x62, 0xc4, ...vector(t.focus), 0x1d, ...int(t.yaw), 0x1d, ...int(t.pitch),
    0x1e, ...float(t.minDist), 0x1e, ...float(t.maxDist), ...outBytes, 0x16]);
  const vm = compileFunction({pkg: {imports: [], exports: [{name: 'BestDest'}]}, entry: {path: s.name},
    bytes, size: bytes.length + (t.out === 'ref' ? 3 : 0)});
  const host = {boundaryNatives: new Set(), collisionViewActors: new WeakSet(), pawnNavServices: () => services};
  const locals = {BestDest: OUT_SENTINEL.map(f32)};
  const ret = vm.run(pawn, locals, {invokeNative: call => Runtime.prototype.invokeNative.call(host, call)});
  assert.equal(typeof ret, 'boolean', `${s.name}: the bool native returns a boolean`);
  return snapshot(ret, locals.BestDest);
}

const navPath = path.join(root, 'src/runtime/script-pawn-nav.mjs');
const runtimePath = path.join(root, 'src/runtime/script-runtime.mjs');
const nav = await import(pathToFileURL(navPath));
const {ScriptRuntime} = await import(pathToFileURL(runtimePath));
const {compileFunction} = await import(pathToFileURL(path.join(root, 'src/runtime/script-vm.mjs')));
const originals = results.map(r => r.ok ? originalSnapshot(r.result) : null);
const refuses = fn => { try { fn(); return false; } catch (error) { return /GIsEditor/.test(error.message); } };
let commandCount = 0;
for (let i = 0; i < scenes.length; i++) {
  const s = scenes[i];
  if (!originals[i]) {
    assert.ok(refuses(() => translatedDirect(s, nav)), `${s.name}: the translation refuses in the editor`);
    assert.ok(refuses(() => translatedRuntime(s, ScriptRuntime, compileFunction)), `${s.name}: Play refuses in the editor`);
    continue;
  }
  assert.deepEqual(translatedDirect(s, nav), originals[i], `${s.name} (translated exec)`);
  assert.deepEqual(translatedRuntime(s, ScriptRuntime, compileFunction), originals[i], `${s.name} (VM binding)`);
  commandCount += originals[i].commands.length;
}
const missing = Object.values(uncovered).flat().length;
console.log(`PASS direction reach: ${scenes.length}/${scenes.length} original-DLL cases (${handwritten.length} targeted, ` +
  `${generated.length} generated; ${commandCount} ordered boundary calls with argument bits, result dword, out vector, ` +
  `Location/Velocity/Region), each through the translated exec and the VM binding, 0 mismatches`);
console.log(`verdicts ${JSON.stringify(verdicts)}`);
console.log(`instruction coverage: ${Object.entries(listing.result.instructions).map(([n, l]) =>
  `${n} ${l.length - uncovered[n].length}/${l.length}`).join(', ')} (${EXCLUDED.size} excluded: the editor-only ` +
  `assert block and the unreachable default step arm)` +
  `${missing ? ` uncovered ${JSON.stringify(uncovered)}` : ''}`);
assert.equal(missing, 0, 'every instruction of the exec and the band search executes in some original case');

// Check only the new translation boundaries; reuse the original captures.
const mutations = [
  [navPath, 'swap-yaw-pitch', 'focus.map(f32), yaw | 0, pitch | 0,', 'focus.map(f32), pitch | 0, yaw | 0,',
    'walk-follow', 'direct'],
  [navPath, 'swap-min-max', 'f32(minDist), f32(maxDist), 15.0, sink, services);',
    'f32(maxDist), f32(minDist), 15.0, sink, services);', 'walk-backpedal', 'direct'],
  [navPath, 'focus-is-location', 'const found = aiPickSearch(receiver, focus.map(f32),',
    'const found = aiPickSearch(receiver, services.location(receiver).map(f32),', 'walk-backpedal', 'direct'],
  [navPath, 'out-on-early-return', '&& written) dest.set(sink);', ') dest.set(sink);', 'falling-early', 'direct'],
  [navPath, 'search-origin', 'let prevScore = aiScore(minSq, dsqInit(startLoc, origin), maxSq);',
    'let prevScore = aiScore(minSq, dsqInit(startLoc, startLoc), maxSq);', 'walk-approach-focus', 'direct'],
  [navPath, 'fell-back-into-band', 'if (prevScore > 0) cont = 0;', '', 'walk-approach-focus', 'direct'],
  [runtimePath, 'out-by-value', 'const dest=call.evaluateArgument(5);', 'const dest=refValue(call.evaluateArgument(5));',
    'walk-follow', 'runtime'],
  [runtimePath, 'argument-shift', 'const [focus,yaw,pitch,minDist,maxDist]=[0,1,2,3,4]',
    'const [focus,yaw,pitch,minDist,maxDist]=[0,1,2,4,3]', 'walk-backpedal', 'runtime'],
];
const sources = new Map();
for (const [file, name, before, after, caseName, route] of mutations) {
  if (!sources.has(file)) sources.set(file, readFileSync(file, 'utf8'));
  const source = sources.get(file);
  assert.equal(source.split(before).length, 2, `${name}: unique mutation site`);
  const out = path.join(cache, `mut-direction-${name}.mjs`);
  const here = pathToFileURL(file);
  try {
    // The mutant lives in the cache; its relative imports resolve to the
    // original module files (shared instances).
    writeFileSync(out, source.replace(before, after)
      .replace(/(from\s+')(\.{1,2}\/[^']+)'/g, (m, head, rel) => `${head}${new URL(rel, here).href}'`));
    const mutant = await import(pathToFileURL(out));
    const run = s => route === 'direct' ? translatedDirect(s, mutant)
      : translatedRuntime(s, mutant.ScriptRuntime, compileFunction);
    if (process.env.DIRECTION_MUTANT_SEARCH) {       // list every detecting case
      const hits = scenes.filter((s, j) => originals[j] && (() => { try { return !isDeepStrictEqual(run(s), originals[j]); }
        catch { return true; } })()).map(s => s.name);
      console.log(`${name}: ${hits.length} ${hits.slice(0, 8).join(' ')}`);
      continue;
    }
    const i = scenes.findIndex(s => s.name === caseName);
    assert.ok(i >= 0 && originals[i], `${name}: case ${caseName}`);
    let detected;
    try { detected = !isDeepStrictEqual(run(scenes[i]), originals[i]); }
    catch { detected = true; }
    assert.ok(detected, `${name}: original case ${caseName} must detect mutation`);
  } finally { if (existsSync(out)) unlinkSync(out); }
}
console.log(`PASS direction reach mutations: ${mutations.length}/${mutations.length}`);

function isDeepStrictEqual(a, b) {
  try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
}
