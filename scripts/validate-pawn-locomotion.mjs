#!/usr/bin/env node
/* Validates src/runtime/script-pawn-locomotion.mjs against the original
 * Engine.dll bodies.  The oracle is two-tiered:
 *
 *   * every setup/poll body runs in Unicorn on the hash-verified image
 *     (scripts/native-pawn-latent-probe.py) — authoritative for integer,
 *     flag, and float32-observable behavior;
 *   * the body's FVector::Rotation call (Core 0x10144390, FPATAN) is
 *     intercepted and answered from tools/pawn-rotation-probe.exe running
 *     the identical x87 sequence on real silicon through CrossOver/Wine —
 *     Unicorn is not authoritative for transcendental state.
 *
 * Each scene runs both engines and compares: the latent code, the bytecode
 * cursor advance, every mutated pawn field at float32-bit precision, the
 * object references (moveTarget/faceTarget), and the ordered event list.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modulePath = path.join(root, 'src/runtime/script-pawn-locomotion.mjs');
const module = await import(pathToFileURL(process.env.LOCOMOTION_MODULE ?? modulePath));

const python = process.env.NATIVE_PROBE_PYTHON
  || path.join(root, '.cache/native-probe-env/bin/python');
const probeScript = path.join(root, 'scripts/native-pawn-latent-probe.py');
const wine = process.env.X87_PROBE_WINE
  || '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
const bottle = process.env.X87_PROBE_BOTTLE || 'DeusEx';
const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc';
const rotationExe = path.join(root, '.cache/pawn-rotation-probe.exe');
const rotationSrc = path.join(root, 'tools/pawn-rotation-probe.c');
const cacheDir = path.join(root, '.cache/pawn-loco');
const skip = reason => {
  console.log(`SKIP validate-pawn-locomotion: ${reason}`);
  process.exit(0);
};
if (!existsSync(python)) skip(`no probe python at ${python}`);
if (!existsSync(wine)) skip(`no CrossOver/Wine at ${wine} (set X87_PROBE_WINE)`);
try { execFileSync('which', [cc], { stdio: 'ignore' }); }
catch { skip(`no ${cc} on PATH (brew install mingw-w64)`); }
mkdirSync(cacheDir, { recursive: true });
execFileSync(cc, ['-O1', '-o', rotationExe, rotationSrc]);

const f32 = Math.fround;
const io = new DataView(new ArrayBuffer(8));
const bitsOf = v => { io.setFloat32(0, v, true); return io.getUint32(0, true); };
const bitsHex = v => bitsOf(v).toString(16).padStart(8, '0');
const vecBits = v => v.map(bitsHex);
const B = n => n.toString(2).padStart(8, '0');

// -- Flag bits the bodies test (pawn +0x318 / +0x31c dwords) -----------------
const FLAGS = {
  bCanStrafe: [0x318, 0x00000200], bReducedSpeed: [0x318, 0x00000800],
  bCanSwim: [0x318, 0x00004000], bAdvancedTactics: [0x318, 0x80000000],
  bCanGlide: [0x31c, 0x02],
};

/** The JavaScript twin of the probe's fabricated actor memory: the same field
 * names the bodies touch, with the shared bool dwords kept raw and the flag
 * properties resolved through bit accessors (the native AND/ORs the dword). */
function makeActor(spec = {}) {
  const a = {
    physics: spec.physics ?? 0,
    location: (spec.location ?? [0, 0, 0]).map(f32),
    velocity: (spec.velocity ?? [0, 0, 0]).map(f32),
    acceleration: (spec.acceleration ?? [0, 0, 0]).map(f32),
    rotation: [...(spec.rotation ?? [0, 0, 0])].map(v => v | 0),
    desiredRotation: [...(spec.desiredRotation ?? [0, 0, 0])].map(v => v | 0),
    floor: (spec.floor ?? [0, 0, 0]).map(f32),
    destination: (spec.destination ?? [0, 0, 0]).map(f32),
    focus: (spec.focus ?? [0, 0, 0]).map(f32),
    latentFloat: f32(spec.latentFloat ?? 0),
    moveTimer: f32(spec.moveTimer ?? 0),
    desiredSpeed: f32(spec.desiredSpeed ?? 0),
    maxDesiredSpeed: f32(spec.maxDesiredSpeed ?? 0),
    meleeRange: f32(spec.meleeRange ?? 0),
    groundSpeed: f32(spec.groundSpeed ?? 0),
    waterSpeed: f32(spec.waterSpeed ?? 0),
    airSpeed: f32(spec.airSpeed ?? 0),
    accelRate: f32(spec.accelRate ?? 0),
    avgPhysicsTime: f32(spec.avgPhysicsTime ?? 0),
    collisionRadius: f32(spec.collisionRadius ?? 0),
    collisionHeight: f32(spec.collisionHeight ?? 0),
    rotationRate: [...(spec.rotationRate ?? [0, 0, 0])].map(v => v | 0),
    flags318: (spec.flags318 ?? 0) >>> 0,
    flags31c: (spec.flags31c ?? 0) >>> 0,
    moveTarget: null, faceTarget: null,
    zone: spec.zoneRef ?? null,
    // 'pawn*'/'inventory*' = a fabricated subclass (the body's IsA walk
    // traverses SuperField); plain names are direct class objects.
    clsChain: spec.cls
      ? spec.cls.endsWith('*') ? ['subclass', spec.cls.slice(0, -1)] : [spec.cls]
      : ['actor'],
  };
  for (const [prop, [dword, mask]] of Object.entries(FLAGS))
    Object.defineProperty(a, prop, {
      get: () => (a[dword === 0x318 ? 'flags318' : 'flags31c'] & mask) !== 0,
      set: v => {
        const key = dword === 0x318 ? 'flags318' : 'flags31c';
        a[key] = (v ? a[key] | mask : a[key] & ~mask) >>> 0;
      },
    });
  a.self = a;
  return a;
}

const FIELD_NAME = {
  Location: 'location', CollisionRadius: 'collisionRadius',
  CollisionHeight: 'collisionHeight', Velocity: 'velocity',
};

function makeServices(objectsByName, events) {
  const zoneOf = actor => {
    const z = actor?.zone;
    return z ? {
      gravityZ: f32(z.gravityZ ?? -950), defaultGravityZ: f32(z.defaultGravityZ ?? -950),
      waterZone: (z.flags & 1) !== 0,
    } : null;
  };
  return {
    isA: (actor, name) => !!actor?.clsChain?.includes(name.toLowerCase()),
    readField: (actor, name) => actor[FIELD_NAME[name] ?? name],
    processEvent: (actor, name, args) => events.push({ this: actor, name, args }),
    zone: zoneOf,
  };
}

const nameOf = (actor, objectsByName) =>
  actor == null ? null
    : Object.entries(objectsByName).find(([, v]) => v === actor)?.[0] ?? 'unknown';

/** Runs the recovered module over a scene and returns the same result shape
 * the probe emits (object references resolved to scene names). */
function runJs(scene, mod = module) {
  const objects = {};
  const pawn = makeActor({ ...BASE_PAWN, ...scene.pawn, zoneRef: scene.pawnZone ?? scene.zone });
  objects.pawn = pawn;
  const target = scene.target
    ? makeActor({ ...scene.target, zoneRef: scene.targetZone ?? scene.zone })
    : null;
  objects.target = target;
  objects.none = null;
  pawn.moveTarget = objects[scene.pawn?.moveTarget] ?? null;
  pawn.faceTarget = objects[scene.pawn?.faceTarget] ?? null;
  const events = [];
  const services = makeServices(objects, events);
  const state = { latent: scene.latent ?? 0 };
  const frame = { code: 0 };
  const operandOf = kind => ({ vector: 12, float: 4, object: 4, nothing: 0 })[kind];
  const valueOf = arg =>
    arg.kind === 'vector' ? arg.value.map(f32)
      : arg.kind === 'float' ? f32(arg.value)
        : arg.kind === 'object' ? objects[arg.value]
          : undefined;
  const args = (scene.args ?? []).map(valueOf);
  const operandBytes = (scene.args ?? []).map(a => operandOf(a.kind));
  const call = {
    MoveTo: () => mod.execMoveTo({ pawn, frame, state, args, services, operandBytes }),
    MoveToward: () => mod.execMoveToward({ pawn, frame, state, args, services, operandBytes }),
    TurnTo: () => mod.execTurnTo({ pawn, frame, state, args, services, operandBytes: operandBytes[0] }),
    TurnToward: () => mod.execTurnToward({ pawn, frame, state, args, services, operandBytes: operandBytes[0] }),
    WaitForLanding: () => mod.execWaitForLanding({ pawn, frame, state }),
    pollMoveTo: () => mod.pollMoveTo({ pawn, state, services }),
    pollMoveToward: () => mod.pollMoveToward({ pawn, state, services }),
    pollTurnTo: () => mod.pollTurnTo({ pawn, state, services }),
    pollTurnToward: () => mod.pollTurnToward({ pawn, state, services }),
    pollWaitForLanding: () => mod.pollWaitForLanding({ pawn, state, dt: f32(scene.dt ?? 0.05), services }),
  }[scene.body];
  call();
  return {
    latent: state.latent, code: frame.code,
    events: events.map(e => ({
      this: nameOf(e.this, objects), name: e.name,
      arg0: nameOf(e.args?.[0], objects) ?? e.args?.[0] ?? null,
    })),
    pawn: {
      location: vecBits(pawn.location), velocity: vecBits(pawn.velocity),
      acceleration: vecBits(pawn.acceleration), rotation: pawn.rotation,
      desiredRotation: pawn.desiredRotation, floor: vecBits(pawn.floor),
      destination: vecBits(pawn.destination), focus: vecBits(pawn.focus),
      latentFloat: bitsHex(pawn.latentFloat), moveTimer: bitsHex(pawn.moveTimer),
      desiredSpeed: bitsHex(pawn.desiredSpeed),
      moveTarget: nameOf(pawn.moveTarget, objects),
      faceTarget: nameOf(pawn.faceTarget, objects),
      flags318: pawn.flags318 >>> 0, flags31c: pawn.flags31c >>> 0,
      physics: pawn.physics,
    },
  };
}

/** Normalizes a probe result into the same comparable shape. */
function normalizeProbe(r) {
  const ref = a => a === 0 ? null : a === r.pawnAddress ? 'pawn' : a === r.targetAddress ? 'target' : `0x${a.toString(16)}`;
  return {
    latent: r.latent, code: r.code,
    events: r.events.map(e => ({ this: ref(e.this), name: e.name, arg0: ref(e.arg0) })),
    pawn: {
      location: r.pawnBits.location, velocity: r.pawnBits.velocity,
      acceleration: r.pawnBits.acceleration, rotation: r.pawn.rotation,
      desiredRotation: r.pawn.desiredRotation, floor: r.pawnBits.floor,
      destination: r.pawnBits.destination, focus: r.pawnBits.focus,
      latentFloat: r.pawnBits.latentFloat, moveTimer: r.pawnBits.moveTimer,
      desiredSpeed: r.pawnBits.desiredSpeed,
      moveTarget: ref(r.pawn.moveTarget), faceTarget: ref(r.pawn.faceTarget),
      flags318: r.pawn.flags318 >>> 0, flags31c: r.pawn.flags31c >>> 0,
      physics: r.pawn.physics,
    },
  };
}

function compare(name, oracle, js) {
  const diffs = [];
  const eq = (label, a, b) => {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) diffs.push(`${label}: oracle ${sa} vs js ${sb}`);
  };
  eq('latent', oracle.latent, js.latent);
  eq('code', oracle.code, js.code);
  for (const k of Object.keys(oracle.pawn)) eq(`pawn.${k}`, oracle.pawn[k], js.pawn[k]);
  eq('events', oracle.events, js.events);
  return diffs.map(d => `${name}: ${d}`);
}

// --------------------------------------------------------------------------
// Scene corpus — every physics gate, class gate, tolerance boundary, optional
// argument form, and event path the bodies contain.
// --------------------------------------------------------------------------
const W = 'WaitForLanding', PW = 'pollWaitForLanding';
const MT = 'MoveTo', PMT = 'pollMoveTo', MW = 'MoveToward', PMW = 'pollMoveToward';
const TT = 'TurnTo', PTT = 'pollTurnTo', TTD = 'TurnToward', PTTD = 'pollTurnToward';
const vec = (x, y, z) => ({ kind: 'vector', value: [x, y, z] });
const flt = v => ({ kind: 'float', value: v });
const obj = v => ({ kind: 'object', value: v });
const none = { kind: 'object', value: 'none' };
const nothing = { kind: 'nothing' };
const LOW_GRAV = { gravityZ: -100, defaultGravityZ: -950 };
const NORMAL_GRAV = { gravityZ: -950, defaultGravityZ: -950 };
const GLIDE = { flags31c: 0x2, flags318: 0x0 };        // bCanGlide, !bCanStrafe

// The probe zero-fills unspecified memory; scenes spread this base under the
// pawn so speed/timer fields carry the class-default-like magnitudes a real
// pawn would have.
const BASE_PAWN = {
  groundSpeed: 200, waterSpeed: 100, airSpeed: 150, accelRate: 500,
  maxDesiredSpeed: 1, avgPhysicsTime: 0.1, collisionRadius: 32,
  collisionHeight: 44,
};

const scenes = [
  // -- WaitForLanding setup: latent only while PHYS_Falling ------------------
  { name: 'wfl-falling', body: W, pawn: { physics: 2 } },
  { name: 'wfl-walking', body: W, pawn: { physics: 1 }, latent: 777 },
  { name: 'wfl-swimming', body: W, pawn: { physics: 3 }, latent: 777 },
  { name: 'wfl-flying', body: W, pawn: { physics: 4 }, latent: 777 },
  // -- WaitForLanding poll: countdown then LongFall, resume when landed ------
  { name: 'pwfl-countdown', body: PW, pawn: { physics: 2, latentFloat: 2.0 }, dt: 0.5, latent: 528 },
  { name: 'pwfl-expired', body: PW, pawn: { physics: 2, latentFloat: 0.4 }, dt: 0.5, latent: 528 },
  { name: 'pwfl-zero-edge', body: PW, pawn: { physics: 2, latentFloat: 0.5 }, dt: 0.5, latent: 528 },
  { name: 'pwfl-negative', body: PW, pawn: { physics: 2, latentFloat: 0 }, dt: 0.05, latent: 528 },
  { name: 'pwfl-landed', body: PW, pawn: { physics: 1, latentFloat: 0.4 }, dt: 0.5, latent: 528 },
  { name: 'pwfl-swim-abort', body: PW, pawn: { physics: 3, latentFloat: -1 }, dt: 0.5, latent: 528 },

  // -- TurnTo setup ----------------------------------------------------------
  { name: 'tt-basic', body: TT, pawn: { physics: 1, rotation: [0, 8192, 0] }, args: [vec(0, 100, 0)] },
  { name: 'tt-ahead', body: TT, pawn: { physics: 1, rotation: [0, 0, 0] }, args: [vec(100, 0, 0)] },
  { name: 'tt-glide-fly', body: TT, pawn: { physics: 4, rotation: [0, 8192, 0], ...GLIDE }, args: [vec(0, 100, 30)] },
  { name: 'tt-glide-swim', body: TT, pawn: { physics: 3, rotation: [4096, 0, 0], ...GLIDE }, args: [vec(0, 100, -30)] },
  { name: 'tt-strafe-block', body: TT, pawn: { physics: 4, rotation: [0, 0, 0], flags31c: 0x2, flags318: 0x200 }, args: [vec(0, 100, 30)] },
  { name: 'tt-no-glide-flag', body: TT, pawn: { physics: 4, rotation: [0, 0, 0], flags31c: 0, flags318: 0 }, args: [vec(0, 100, 30)] },
  { name: 'tt-spider', body: TT, pawn: { physics: 0xa, rotation: [0, 0, 0] }, args: [vec(50, 50, 0)] },
  // -- TurnTo poll -----------------------------------------------------------
  { name: 'ptt-facing', body: PTT, pawn: { physics: 1, rotation: [0, 0, 0], focus: [100, 0, 0] }, latent: 509 },
  { name: 'ptt-turning', body: PTT, pawn: { physics: 1, rotation: [0, 8192, 0], focus: [0, 100, 0] }, latent: 509 },
  // DesiredRotation.yaw for a due-east focus is 0; the check masks both yaws
  // to 16 bits then completes on |d|<0x7d0 or |d|>0xf82f — so rotation +1999
  // clears and +2000/±2001 do not, while -2000 masks to 63536 > 63535.
  { name: 'ptt-tol-1999', body: PTT, pawn: { physics: 1, rotation: [0, 1999, 0], focus: [1, 0, 0] }, latent: 509 },
  { name: 'ptt-tol-2000', body: PTT, pawn: { physics: 1, rotation: [0, 2000, 0], focus: [1, 0, 0] }, latent: 509 },
  { name: 'ptt-tol-2001', body: PTT, pawn: { physics: 1, rotation: [0, 2001, 0], focus: [1, 0, 0] }, latent: 509 },
  { name: 'ptt-wrap-63535', body: PTT, pawn: { physics: 1, rotation: [0, -2001, 0], focus: [1, 0, 0] }, latent: 509 },
  { name: 'ptt-wrap-63536', body: PTT, pawn: { physics: 1, rotation: [0, -2000, 0], focus: [1, 0, 0] }, latent: 509 },
  { name: 'ptt-glide', body: PTT, pawn: { physics: 4, rotation: [0, 8192, 0], focus: [0, 100, 0], ...GLIDE }, latent: 509 },
  { name: 'ptt-walk-pitch-pawn', body: PTT, pawn: { physics: 1, rotation: [0, 8192, 0], focus: [10, 0, 50], moveTarget: 'target' }, target: { cls: 'pawn', location: [10, 0, 50] }, latent: 509 },
  { name: 'ptt-walk-pitch-nonpawn', body: PTT, pawn: { physics: 1, rotation: [0, 8192, 0], focus: [10, 0, 50], moveTarget: 'target' }, target: { cls: 'inventory', location: [10, 0, 50] }, latent: 509 },

  // -- TurnToward setup ------------------------------------------------------
  { name: 'ttd-basic', body: TTD, pawn: { physics: 1, rotation: [0, 8192, 0] }, target: { cls: 'pawn', location: [50, 50, 0] }, args: [obj('target')] },
  { name: 'ttd-null', body: TTD, pawn: { physics: 1, faceTarget: 'none' }, target: { cls: 'pawn', location: [50, 50, 0] }, args: [none], latent: 999 },
  { name: 'ttd-glide', body: TTD, pawn: { physics: 4, rotation: [0, 0, 0], ...GLIDE }, target: { cls: 'actor', location: [10, 0, 30] }, args: [obj('target')] },
  { name: 'ttd-subclass', body: TTD, pawn: { physics: 1, rotation: [0, 0, 0] }, target: { cls: 'pawn*', location: [50, 50, 0] }, args: [obj('target')] },
  // -- TurnToward poll -------------------------------------------------------
  { name: 'pttd-no-target', body: PTTD, pawn: { physics: 1, faceTarget: 'none' }, latent: 511 },
  { name: 'pttd-facing', body: PTTD, pawn: { physics: 1, rotation: [0, 0, 0], faceTarget: 'target' }, target: { cls: 'pawn', location: [100, 0, 0] }, latent: 511 },
  { name: 'pttd-moving', body: PTTD, pawn: { physics: 1, rotation: [0, 8192, 0], faceTarget: 'target', focus: [0, 0, 0] }, target: { cls: 'pawn', location: [0, 77, 0] }, latent: 511 },
  { name: 'pttd-glide', body: PTTD, pawn: { physics: 4, rotation: [0, 8192, 0], faceTarget: 'target', ...GLIDE }, target: { cls: 'actor', location: [0, 100, 20] }, latent: 511 },

  // -- MoveTo setup ----------------------------------------------------------
  { name: 'mt-basic', body: MT, pawn: { physics: 1 }, args: [vec(100, 0, 0), flt(1)] },
  { name: 'mt-speed-omitted', body: MT, pawn: { physics: 1 }, args: [vec(100, 0, 0), nothing] },
  { name: 'mt-speed-clamped', body: MT, pawn: { physics: 1, maxDesiredSpeed: 1 }, args: [vec(100, 0, 0), flt(5)] },
  { name: 'mt-speed-half', body: MT, pawn: { physics: 1, maxDesiredSpeed: 1 }, args: [vec(100, 0, 0), flt(0.5)] },
  { name: 'mt-speed-zero', body: MT, pawn: { physics: 1 }, args: [vec(100, 0, 0), flt(0)] },
  { name: 'mt-speed-negative', body: MT, pawn: { physics: 1 }, args: [vec(100, 0, 0), flt(-2)] },
  { name: 'mt-swim', body: MT, pawn: { physics: 3 }, args: [vec(100, 50, 0), flt(0.8)] },
  { name: 'mt-fly', body: MT, pawn: { physics: 4 }, args: [vec(100, 50, 20), flt(0.8)] },
  { name: 'mt-spider', body: MT, pawn: { physics: 0xa }, args: [vec(100, 0, 0), flt(1)] },
  { name: 'mt-phys-other', body: MT, pawn: { physics: 7 }, args: [vec(100, 0, 0), flt(1)] },
  { name: 'mt-fall-normal-grav', body: MT, pawn: { physics: 2, velocity: [0, 0, -50] }, pawnZone: NORMAL_GRAV, args: [vec(100, 0, 50), flt(1)] },
  { name: 'mt-fall-low-grav', body: MT, pawn: { physics: 2, velocity: [0, 0, -50] }, pawnZone: LOW_GRAV, args: [vec(100, 0, 50), flt(1)] },
  { name: 'mt-fall-resume', body: MT, pawn: { physics: 2, velocity: [0, 0, -50], location: [0, 0, 0] }, pawnZone: LOW_GRAV, args: [vec(10, 0, 500), flt(1)] },
  { name: 'mt-fall-rising', body: MT, pawn: { physics: 2, velocity: [0, 0, 50] }, pawnZone: LOW_GRAV, args: [vec(10, 0, 500), flt(1)] },
  { name: 'mt-arrived-setup', body: MT, pawn: { physics: 1 }, args: [vec(10, 0, 0), flt(1)] },
  { name: 'mt-reduced-preset', body: MT, pawn: { physics: 1, flags318: 0x800 }, args: [vec(100, 0, 0), flt(1)] },

  // -- MoveTo poll -----------------------------------------------------------
  { name: 'pmt-arrived', body: PMT, pawn: { physics: 1, destination: [10, 0, 0] }, latent: 501 },
  { name: 'pmt-arrive-edge-in', body: PMT, pawn: { physics: 1, destination: [15.9, 0, 0] }, latent: 501 },
  { name: 'pmt-arrive-edge-out', body: PMT, pawn: { physics: 1, destination: [16.1, 0, 0] }, latent: 501 },
  // Vertical arrive bound: |dz| < max(CollisionHeight,48) — only reachable in
  // non-walking physics since walking zeroes the z delta first.
  { name: 'pmt-arrive-vert-in', body: PMT, pawn: { physics: 3, destination: [5, 0, 47] }, latent: 501 },
  { name: 'pmt-arrive-vert-out', body: PMT, pawn: { physics: 3, destination: [5, 0, 49] }, latent: 501 },
  { name: 'pmt-arrive-vert-collh', body: PMT, pawn: { physics: 3, destination: [5, 0, 60], collisionHeight: 80 }, latent: 501 },
  { name: 'pmt-moving', body: PMT, pawn: { physics: 1, destination: [100, 0, 0], moveTimer: 5 }, latent: 501 },
  { name: 'pmt-tactics', body: PMT, pawn: { physics: 1, destination: [100, 0, 0], flags318: 0x80000000 }, latent: 501 },
  { name: 'pmt-tactics-falling', body: PMT, pawn: { physics: 2, destination: [100, 0, 500], flags318: 0x80000000, velocity: [0, 0, -50] }, pawnZone: LOW_GRAV, latent: 501 },
  { name: 'pmt-timer-negative', body: PMT, pawn: { physics: 1, destination: [100, 0, 0], moveTimer: -0.5 }, latent: 501 },
  { name: 'pmt-timer-zero', body: PMT, pawn: { physics: 1, destination: [100, 0, 0], moveTimer: 0 }, latent: 501 },
  { name: 'pmt-fall-steer', body: PMT, pawn: { physics: 2, destination: [100, 0, 50], velocity: [0, 0, -50] }, pawnZone: LOW_GRAV, latent: 501 },
  { name: 'pmt-fall-no-steer', body: PMT, pawn: { physics: 2, destination: [100, 0, 50], velocity: [0, 0, -50] }, pawnZone: NORMAL_GRAV, latent: 501 },
  { name: 'pmt-fall-resume', body: PMT, pawn: { physics: 2, destination: [10, 0, 500], velocity: [0, 0, -50], location: [0, 0, 0] }, pawnZone: LOW_GRAV, latent: 501 },
  { name: 'pmt-fall-rising', body: PMT, pawn: { physics: 2, destination: [10, 0, 500], velocity: [0, 0, 50] }, pawnZone: LOW_GRAV, latent: 501 },
  { name: 'pmt-touch-inventory', body: PMT, pawn: { physics: 1, destination: [30, 0, 0], moveTarget: 'target', moveTimer: 5, collisionRadius: 40, collisionHeight: 60 }, target: { cls: 'inventory', location: [10, 0, 5] }, latent: 501 },
  { name: 'pmt-touch-outside', body: PMT, pawn: { physics: 1, destination: [200, 0, 0], moveTarget: 'target', moveTimer: 5, collisionRadius: 40, collisionHeight: 60 }, target: { cls: 'inventory', location: [100, 0, 0] }, latent: 501 },
  { name: 'pmt-touch-subclass', body: PMT, pawn: { physics: 1, destination: [30, 0, 0], moveTarget: 'target', moveTimer: 5, collisionRadius: 40, collisionHeight: 60 }, target: { cls: 'inventory*', location: [10, 0, 5] }, latent: 501 },
  { name: 'pmt-melee-in', body: PMT, pawn: { physics: 1, destination: [50, 0, 0], moveTarget: 'target', moveTimer: 5, collisionRadius: 32, meleeRange: 40 }, target: { cls: 'pawn', location: [50, 0, 0], collisionRadius: 30 }, latent: 501 },
  { name: 'pmt-melee-out', body: PMT, pawn: { physics: 1, destination: [200, 0, 0], moveTarget: 'target', moveTimer: 5, collisionRadius: 32, meleeRange: 40 }, target: { cls: 'pawn', location: [200, 0, 0], collisionRadius: 30 }, latent: 501 },
  // bound = 30+32+40*0.8 — the embedded double 0.8000000000000000444 makes it
  // 94+ε, so dist 94 completes.  dist 98 sits between the 0.8 bound (94+ε,
  // not done) and a 1.0-mutant bound (102, done).
  { name: 'pmt-melee-boundary', body: PMT, pawn: { physics: 1, destination: [98, 0, 0], moveTarget: 'target', moveTimer: 5, collisionRadius: 32, meleeRange: 40 }, target: { cls: 'pawn', location: [98, 0, 0], collisionRadius: 30 }, latent: 501 },
  { name: 'pmt-touch-far-z', body: PMT, pawn: { physics: 1, destination: [30, 0, 0], moveTarget: 'target', moveTimer: 5, collisionRadius: 40, collisionHeight: 60 }, target: { cls: 'inventory', location: [10, 0, 100] }, latent: 501 },
  { name: 'pmt-brake', body: PMT, pawn: { physics: 1, destination: [30, 0, 0], velocity: [50, 0, 0], avgPhysicsTime: 10, moveTimer: 5, desiredSpeed: 1 }, latent: 501 },
  { name: 'pmt-brake-cap', body: PMT, pawn: { physics: 1, destination: [30, 0, 0], velocity: [50, 0, 0], avgPhysicsTime: 10, moveTimer: 5, desiredSpeed: 10 }, latent: 501 },
  { name: 'pmt-brake-again', body: PMT, pawn: { physics: 1, destination: [30, 0, 0], velocity: [50, 0, 0], avgPhysicsTime: 10, moveTimer: 5, desiredSpeed: 1, flags318: 0x800 }, latent: 501 },
  { name: 'pmt-far', body: PMT, pawn: { physics: 1, destination: [3000, 0, 0], velocity: [50, 0, 0], avgPhysicsTime: 0.1, moveTimer: 5, desiredSpeed: 1 }, latent: 501 },
  { name: 'pmt-decel', body: PMT, pawn: { physics: 1, destination: [100, 0, 0], velocity: [200, 0, 0], avgPhysicsTime: 0.1, moveTimer: 5, desiredSpeed: 1 }, latent: 501 },
  { name: 'pmt-decel-offaxis', body: PMT, pawn: { physics: 1, destination: [0, 100, 0], velocity: [200, 0, 30], avgPhysicsTime: 0.1, moveTimer: 5, desiredSpeed: 1 }, latent: 501 },
  { name: 'pmt-glide-arrive', body: PMT, pawn: { physics: 4, destination: [10, 0, 0], ...GLIDE }, latent: 501 },
  { name: 'pmt-swim', body: PMT, pawn: { physics: 3, destination: [100, 0, 30], moveTimer: 5 }, latent: 501 },
  { name: 'pmt-spider', body: PMT, pawn: { physics: 0xa, destination: [100, 0, 30], moveTimer: 5 }, latent: 501 },
  { name: 'pmt-dest-preserved', body: PMT, pawn: { physics: 1, destination: [10, 0, 0], flags318: 0x80000000 }, latent: 501 },

  // -- MoveToward setup ------------------------------------------------------
  { name: 'mtw-pawn', body: MW, pawn: { physics: 1 }, target: { cls: 'pawn', location: [100, 0, 0] }, args: [obj('target'), flt(1)] },
  { name: 'mtw-pawn-subclass', body: MW, pawn: { physics: 1 }, target: { cls: 'pawn*', location: [100, 0, 0] }, args: [obj('target'), flt(1)] },
  { name: 'mtw-inventory', body: MW, pawn: { physics: 1 }, target: { cls: 'inventory', location: [100, 0, 0] }, args: [obj('target'), flt(1)] },
  { name: 'mtw-actor', body: MW, pawn: { physics: 1 }, target: { cls: 'actor', location: [100, 0, 0] }, args: [obj('target'), flt(1)] },
  { name: 'mtw-null', body: MW, pawn: { physics: 1 }, args: [none, flt(1)], latent: 999 },
  { name: 'mtw-speed-omitted', body: MW, pawn: { physics: 1 }, target: { cls: 'pawn', location: [100, 0, 0] }, args: [obj('target'), nothing] },
  { name: 'mtw-speed-clamped', body: MW, pawn: { physics: 1, maxDesiredSpeed: 0.5 }, target: { cls: 'pawn', location: [100, 0, 0] }, args: [obj('target'), flt(5)] },

  // -- MoveToward poll -------------------------------------------------------
  { name: 'pmtw-no-target', body: PMW, pawn: { physics: 1, moveTarget: 'none' }, latent: 503 },
  // Speed 150 sits between the 100 decel gate and the 200 mutation bound;
  // dest off-axis so the deceleration vector is nonzero.
  { name: 'pmt-decel-mid', body: PMT, pawn: { physics: 1, destination: [0, 300, 0], velocity: [150, 0, 0], avgPhysicsTime: 0.1, moveTimer: 5, desiredSpeed: 1 }, latent: 501 },
  // A glider that does not arrive: normalize is skipped, d becomes the
  // FCoords XAxis — distinguishes axes[1] from axes[2] mutations.
  { name: 'pmt-glide-far', body: PMT, pawn: { physics: 4, destination: [1000, 0, 0], moveTimer: 5, ...GLIDE }, latent: 501 },
  { name: 'pmtw-follow', body: PMW, pawn: { physics: 1, moveTarget: 'target', moveTimer: 5, desiredSpeed: 1 }, target: { cls: 'pawn', location: [100, 0, 0], collisionRadius: 30 }, latent: 503 },
  { name: 'pmtw-fly-pawn', body: PMW, pawn: { physics: 4, moveTarget: 'target', moveTimer: 5, desiredSpeed: 1, ...GLIDE }, target: { cls: 'pawn', location: [100, 0, 0], collisionRadius: 30, collisionHeight: 44 }, latent: 503 },
  { name: 'pmtw-fly-nonpawn', body: PMW, pawn: { physics: 4, moveTarget: 'target', moveTimer: 5, desiredSpeed: 1, ...GLIDE }, target: { cls: 'inventory', location: [100, 0, 0], collisionRadius: 30, collisionHeight: 44 }, latent: 503 },
  { name: 'pmtw-spider', body: PMW, pawn: { physics: 0xa, moveTarget: 'target', moveTimer: 5, desiredSpeed: 1, floor: [0, 0, 1] }, target: { cls: 'pawn', location: [100, 0, 0], collisionRadius: 30 }, latent: 503 },
  { name: 'pmtw-water-abort', body: PMW, pawn: { physics: 1, moveTarget: 'target', moveTimer: 5, desiredSpeed: 0.7, flags318: 0 }, target: { cls: 'pawn', location: [100, 0, 0], collisionRadius: 30 }, targetZone: { gravityZ: -950, defaultGravityZ: -950, flags: 1 }, latent: 503 },
  { name: 'pmtw-water-swim', body: PMW, pawn: { physics: 1, moveTarget: 'target', moveTimer: 5, desiredSpeed: 0.7, flags318: 0x4000 }, target: { cls: 'pawn', location: [100, 0, 0], collisionRadius: 30 }, targetZone: { gravityZ: -950, defaultGravityZ: -950, flags: 1 }, latent: 503 },
  { name: 'pmtw-water-nonpawn', body: PMW, pawn: { physics: 1, moveTarget: 'target', moveTimer: 5, desiredSpeed: 0.7, flags318: 0 }, target: { cls: 'inventory', location: [100, 0, 0], collisionRadius: 30 }, targetZone: { gravityZ: -950, defaultGravityZ: -950, flags: 1 }, latent: 503 },
  { name: 'pmtw-tactics', body: PMW, pawn: { physics: 1, moveTarget: 'target', moveTimer: 5, desiredSpeed: 1, flags318: 0x80000000 }, target: { cls: 'pawn', location: [100, 0, 0], collisionRadius: 30 }, latent: 503 },
  { name: 'pmtw-nonpawn-brake', body: PMW, pawn: { physics: 1, moveTarget: 'target', moveTimer: 5, desiredSpeed: 1, velocity: [50, 0, 0], avgPhysicsTime: 10 }, target: { cls: 'inventory', location: [30, 0, 0], collisionRadius: 30 }, latent: 503 },
  // Flying pawn target: the adjusted dest (z += CollisionHeight*0.7) differs
  // from the live location, so the post-helper re-snapshot is observable.
  { name: 'pmtw-resnapshot', body: PMW, pawn: { physics: 4, moveTarget: 'target', moveTimer: 5, desiredSpeed: 1, destination: [999, 999, 999], focus: [888, 888, 888], ...GLIDE }, target: { cls: 'pawn', location: [40, 20, 0], collisionRadius: 30, collisionHeight: 44 }, latent: 503 },
];

// --------------------------------------------------------------------------
// Run the batch probe; fill FVector::Rotation misses from the hardware table.
// --------------------------------------------------------------------------
const runProbe = payload =>
  JSON.parse(execFileSync(python, [probeScript], {
    input: JSON.stringify(payload.map(s => ({
      ...s, pawn: { ...BASE_PAWN, ...s.pawn },
    }))), maxBuffer: 1 << 28, encoding: 'utf8',
    cwd: root,
  }));

const missRe = /Rotation for ([0-9a-f]{24})/;
const rotationTable = {};
for (let round = 0; round < 4; round++) {
  const payload = scenes.map(s => ({ ...s, rotationTable }));
  const results = runProbe(payload);
  const missing = new Set();
  results.forEach((r, i) => {
    if (r.ok === false && r.type === 'RotationOracleMiss') {
      const key = r.error.match(missRe)?.[1];
      if (key) missing.add(key);
    }
    scenes[i].result = r.ok ? r.result : r;
  });
  if (!missing.size) break;
  // The probe keys rows by raw little-endian memory bytes; the wine probe
  // wants the f32 bit patterns in normal hex.  Swap each 4-byte group.
  const swap = h => h.match(/../g).reverse().join('');
  const lines = [...missing].map(key =>
    `${swap(key.slice(0, 8))} ${swap(key.slice(8, 16))} ${swap(key.slice(16, 24))}`);
  const csv = execFileSync(wine, [rotationExe], {
    input: lines.join('\n') + '\n',
    env: { ...process.env, CX_BOTTLE: bottle }, encoding: 'utf8', maxBuffer: 1 << 24,
  });
  for (const line of csv.split('\n')) {
    const parts = line.trim().split(',');
    if (parts.length !== 6 || parts[0].startsWith('#')) continue;
    const key = parts.slice(0, 3)
      .map(h => h.toLowerCase().padStart(8, '0').match(/../g).reverse().join('')).join('');
    rotationTable[key] = parts.slice(3).map(h => Number(BigInt.asIntN(32, BigInt('0x' + h))));
  }
  writeFileSync(path.join(cacheDir, 'rotation-table.json'), JSON.stringify(rotationTable));
  if (round === 3) throw new Error('Rotation oracle misses did not converge');
}

// --------------------------------------------------------------------------
// Compare every scene.
// --------------------------------------------------------------------------
let failures = 0, misses = 0;
for (const scene of scenes) {
  const r = scene.result;
  if (!r || r.ok === false) {
    console.log(`FAIL ${scene.name}: probe error — ${r?.error ?? 'no result'}`);
    failures++; continue;
  }
  if (r.findFunction?.some(n => !['LongFall', 'Touch', 'SpawnNotification'].includes(n))) {
    console.log(`FAIL ${scene.name}: unexpected FindFunctionChecked ${JSON.stringify(r.findFunction)}`);
    failures++; continue;
  }
  let js;
  try { js = runJs(scene); }
  catch (e) { console.log(`FAIL ${scene.name}: js threw ${e.stack ?? e}`); failures++; continue; }
  const diffs = compare(scene.name, normalizeProbe(r), js);
  if (diffs.length) { failures++; diffs.forEach(d => console.log(`FAIL ${d}`)); }
}
const passed = scenes.length - failures;
console.log(`${failures ? 'FAIL' : 'PASS'} validate-pawn-locomotion: ${passed}/${scenes.length} scenes bit-exact`);
if (failures) process.exit(1);

// --------------------------------------------------------------------------
// Mutation coverage: each edit rewrites one behavior the disassembly dictates;
// the suite proves sensitivity by requiring the listed scenes to flip.
// --------------------------------------------------------------------------
const MUTATIONS = [
  { name: 'wfl-physics-gate', pattern: 'if (p.physics === 2) state.latent = 528;',
    replacement: 'if (p.physics !== 2) state.latent = 528;',
    expect: ['wfl-falling', 'wfl-walking'] },
  { name: 'wfl-poll-resume', pattern: 'if (p.physics !== 2) { state.latent = 0; return; }',
    replacement: 'if (p.physics === 2) { state.latent = 0; return; }',
    expect: ['pwfl-countdown', 'pwfl-landed'] },
  { name: 'mt-latent-code', pattern: 'state.latent = 501;',
    replacement: 'state.latent = 502;', expect: ['mt-basic'] },
  { name: 'mt-speed-default', pattern: 'const speed = args[1] === undefined ? 1 : f32(args[1]);\n  // d stays',
    replacement: 'const speed = args[1] === undefined ? 0 : f32(args[1]);\n  // d stays',
    expect: ['mt-speed-omitted'] },
  { name: 'mtw-pawn-timer', pattern: 'p.moveTimer = f32(1.2);',
    replacement: 'p.moveTimer = f32(1.3);', expect: ['mtw-pawn', 'mtw-pawn-subclass'] },
  { name: 'fall-velocity-gate', pattern: 'if (!ltU(ld(p.velocity[2]), ZERO)) return 0;',
    replacement: 'if (!ltU(ld(p.velocity[2]), ld(100))) return 0;',
    expect: ['pmt-fall-rising'] },
  { name: 'fall-dz-kept', pattern: 'd[2] = 0;                                      // scratch dz zeroed at 0x103be2f3',
    replacement: '', expect: ['pmt-fall-steer', 'mt-fall-low-grav'] },
  { name: 'gravity-compare-dir', pattern: 'if (!ltU(x87mul(ld(zone.defaultGravityZ), D90), ld(zone.gravityZ))) return 0;',
    replacement: 'if (!ltU(ld(zone.gravityZ), x87mul(ld(zone.defaultGravityZ), D90))) return 0;',
    expect: ['pmt-fall-steer', 'pmt-fall-no-steer'] },
  { name: 'turn-tolerance', pattern: 'return (a < 0x7d0 || a > 0xf82f) ? 1 : 0;',
    replacement: 'return (a < 0x7d1 || a > 0xf82f) ? 1 : 0;', expect: ['ptt-tol-2000'] },
  { name: 'turn-wrap-clause', pattern: '|| a > 0xf82f) ? 1 : 0;',
    replacement: ') ? 1 : 0;', expect: ['ptt-wrap-63536'] },
  { name: 'spider-early-return', pattern: 'if (p.physics === 0xa) return 1;                       // PHYS_Spider',
    replacement: '', expect: ['tt-spider', 'pmt-spider'] },
  { name: 'walk-pitch-pawn-gate', pattern: 'if (!(target && services.isA(target, \'Pawn\'))) desired = [0, yaw, rot[2]];',
    replacement: 'if (target && services.isA(target, \'Pawn\')) desired = [0, yaw, rot[2]];',
    expect: ['ptt-walk-pitch-pawn', 'ptt-walk-pitch-nonpawn'] },
  { name: 'tactics-physics-gate', pattern: 'if (p.bAdvancedTactics && p.physics === 1) s.processEvent',
    replacement: 'if (p.bAdvancedTactics && p.physics === 2) s.processEvent',
    expect: ['pmt-tactics', 'pmt-tactics-falling', 'pmtw-tactics'] },
  { name: 'swim-gate', pattern: 'if (!p.bCanSwim && zone && zone.waterZone) p.moveTimer = -1;',
    replacement: 'if (!p.bCanSwim && zone && !zone.waterZone) p.moveTimer = -1;',
    expect: ['pmtw-water-abort'] },
  { name: 'arrive-radius', pattern: 'if (ltU(x87add(x87mul(dl[1], dl[1]), x87mul(dl[0], dl[0])), ld(256)))',
    replacement: 'if (ltU(x87add(x87mul(dl[1], dl[1]), x87mul(dl[0], dl[0])), ld(250)))',
    expect: ['pmt-arrive-edge-in'] },
  { name: 'melee-factor', pattern: 'x87mul(ld(p.meleeRange), D08));',
    replacement: 'x87mul(ld(p.meleeRange), D1));', expect: ['pmt-melee-boundary'] },
  { name: 'decel-speed-gate', pattern: 'if (!glide && !leU(ld(speed), ld(100))) {',
    replacement: 'if (!glide && !leU(ld(speed), ld(200))) {', expect: ['pmt-decel-mid'] },
  { name: 'operand-advance', pattern: 'advanceFrameCode(frame, 1 + operandBytes[0] + 1 + operandBytes[1] + 1);\n  const dest',
    replacement: 'advanceFrameCode(frame, 1 + operandBytes[0] + 1 + operandBytes[1]);\n  const dest',
    expect: ['mt-basic'] },
  { name: 'mtw-resnapshot', pattern: "p.destination = fieldVector(s.readField(target, 'Location'), 'MoveTarget Location');\n  if (s.isA(target, 'Pawn')) {",
    replacement: "if (s.isA(target, 'Pawn')) {", expect: ['pmtw-resnapshot'] },
  { name: 'timer-distance-factor', pattern: 'x87div(x87mul(ld(dist), D13), eff)',
    replacement: 'x87div(x87mul(ld(dist), D14), eff)', expect: ['mt-basic', 'mtw-inventory'] },
  { name: 'glide-axes-field', pattern: 'if (glide) d = fcoordsAxes(p.rotation)[1].slice();',
    replacement: 'if (glide) d = fcoordsAxes(p.rotation)[2].slice();', expect: ['pmt-glide-far'] },
];

const src = readFileSync(modulePath, 'utf8');
const runtimeUrl = pathToFileURL(path.join(root, 'src/runtime/')).href;
let mutFailures = 0;
for (const mut of MUTATIONS) {
  if (!src.includes(mut.pattern)) {
    console.log(`MUTATION ${mut.name}: pattern not found — ${mut.pattern.slice(0, 60)}`);
    mutFailures++; continue;
  }
  if (src.split(mut.pattern).length !== 2) {
    console.log(`MUTATION ${mut.name}: pattern not unique`); mutFailures++; continue;
  }
  const mutated = src.replace(mut.pattern, mut.replacement)
    .replace(/from '\.\//g, `from '${runtimeUrl}`);
  const mutPath = path.join(cacheDir, `mut-${mut.name}.mjs`);
  writeFileSync(mutPath, mutated);
  let mutMod;
  try { mutMod = await import(pathToFileURL(mutPath).href + `?v=${Date.now()}`); }
  catch (e) { console.log(`MUTATION ${mut.name}: import threw ${e.message}`); mutFailures++; continue; }
  const flipped = [];
  for (const scene of scenes) {
    const r = scene.result;
    if (!r?.pawn) continue;
    let js;
    try { js = runJs(scene, mutMod); } catch { flipped.push(scene.name); continue; }
    if (compare(scene.name, normalizeProbe(r), js).length) flipped.push(scene.name);
  }
  const missed = mut.expect.filter(n => !flipped.includes(n));
  if (!flipped.length || missed.length) {
    console.log(`MUTATION ${mut.name}: expected ${mut.expect.join(',')} to flip; flipped=[${flipped.join(',')}]`);
    mutFailures++;
  }
}
try { unlinkSync(path.join(cacheDir, 'mut-dummy')); } catch { /* none */ }
console.log(`${mutFailures ? 'FAIL' : 'PASS'} mutation coverage: ${MUTATIONS.length - mutFailures}/${MUTATIONS.length} mutants detected`);
process.exit(mutFailures ? 1 : 0);
