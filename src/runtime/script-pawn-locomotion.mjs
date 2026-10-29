/**
 * Recovered APawn latent locomotion natives — MoveTo (native 500), MoveToward
 * (502), StrafeTo (504), StrafeFacing (506), TurnTo (508), TurnToward (510),
 * WaitForLanding (527) — and their per-tick latent polls (501, 503, 505, 507,
 * 509, 511, 528), plus the three shared
 * Engine helpers every body reaches: the move-timer setter 0x103be160 (thunk
 * 0x10301226), the steer/arrive helper 0x103be200 (thunk 0x103024fa), and the
 * facing helper 0x103be980 (thunk 0x10303aa3).
 *
 * Every body was disassembled from the hash-verified GOTY Engine.dll and is
 * reproduced instruction-faithfully: float32 stores round once through the
 * 80-bit x87 model, unordered FCOM flag bits are honored, and the rotator
 * fields keep the original 16-bit masking.  FVector::Rotation (the only
 * transcendental on these paths) goes through the hardware-validated
 * vectorToRotator (docs/script-pawn-locomotion.md records provenance).
 *
 * Physics integration itself stays outside this module: the natives only
 * read Physics/Location/Velocity/Floor and write Acceleration/Desired* —
 * moving the pawn is the physics host's job, exactly as in the original.
 */

import { rotatorSin } from './coords.mjs';
import { scriptVmKernel } from './script-vm-kernel.mjs';
import { vectorToRotator } from './script-decoration-primitives.mjs';
import {
  x87load, x87add, x87neg, x87mul, x87div, x87recip, x87sqrt, x87store,
  x87storeDouble, x87safeNormal, x87width,
} from './script-vm.mjs';

const f32 = Math.fround;

/** Static address/byte contract for the installed GOTY Engine.dll image. */
export const PAWN_LOCOMOTION_CONTRACT = Object.freeze({
  engineSha256: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  imageBase: 0x10300000,
  // native setup body -> latent poll body; each setup installs the poll index
  // through Pawn->StateFrame+0x24.
  natives: Object.freeze({
    moveTo:        Object.freeze({ index: 500, poll: 501, setup: 0x103bceb0, pollBody: 0x103bd060,
      setupBytes: [0x83, 0xec, 0x10, 0x53, 0x55, 0x56, 0x57, 0x8b, 0x7c, 0x24, 0x24, 0x33],
      pollBytes:  [0x83, 0xec, 0x0c, 0x53, 0x56, 0x8b, 0xf1, 0x57, 0x8d, 0xbe, 0x54, 0x03] }),
    strafeTo:      Object.freeze({ index: 504, poll: 505, setup: 0x103bd5f0, pollBody: 0x103bd7d0 }),
    strafeFacing:  Object.freeze({ index: 506, poll: 507, setup: 0x103bd8c0, pollBody: 0x103bdad0 }),
    moveToward:    Object.freeze({ index: 502, poll: 503, setup: 0x103bd150, pollBody: 0x103bd370,
      setupBytes: [0x83, 0xec, 0x14, 0x56, 0x8b, 0x74, 0x24, 0x1c, 0x33, 0xd2, 0xc7, 0x44],
      pollBytes:  [0x83, 0xec, 0x20, 0x56, 0x8b, 0xf1, 0x8b, 0x8e, 0x4c, 0x03, 0x00, 0x00] }),
    turnTo:        Object.freeze({ index: 508, poll: 509, setup: 0x103bdec0, pollBody: 0x103be020,
      setupBytes: [0x83, 0xec, 0x48, 0x33, 0xd2, 0x53, 0x55, 0x56, 0x8b, 0x74, 0x24, 0x58],
      pollBytes:  [0x83, 0xec, 0x3c, 0x53, 0x8b, 0xd9, 0xf6, 0x83, 0x1c, 0x03, 0x00, 0x00] }),
    turnToward:    Object.freeze({ index: 510, poll: 511, setup: 0x103bdbf0, pollBody: 0x103bdd60,
      setupBytes: [0x83, 0xec, 0x40, 0x53, 0x56, 0x8b, 0x74, 0x24, 0x4c, 0x33, 0xd2, 0xc7],
      pollBytes:  [0x83, 0xec, 0x3c, 0x53, 0x8b, 0xd9, 0x8b, 0x83, 0x50, 0x03, 0x00, 0x00] }),
    waitForLanding: Object.freeze({ index: 527, poll: 528, setup: 0x103bb6f0, pollBody: 0x103bb730,
      setupBytes: [0x8b, 0x44, 0x24, 0x04, 0x8b, 0x50, 0x0c, 0x42, 0x89, 0x50, 0x0c, 0x8a],
      pollBytes:  [0x56, 0x8b, 0xf1, 0x80, 0x7e, 0x30, 0x02, 0x74, 0x0e, 0x8b, 0x46, 0x0c] }),
  }),
  helpers: Object.freeze({
    setMoveTimer: Object.freeze({ thunk: 0x10301226, body: 0x103be160 }),
    steerArrive:  Object.freeze({ thunk: 0x103024fa, body: 0x103be200 }),
    turnSetup:    Object.freeze({ thunk: 0x10303aa3, body: 0x103be980 }),
  }),
  // Pawn field offsets recovered from the APawn/AActor property registration
  // sites (the ECppProperty offset immediates paired with name pushes in the
  // net-diff constructor region 0x10363xxx and the Actor diff table).
  pawnOffsets: Object.freeze({
    physics: 0x30, stateFrame: 0x0c, latentFloat: 0xe0,
    location: 0x114, rotation: 0x120, velocity: 0x144, acceleration: 0x150,
    collisionRadius: 0x1d4, collisionHeight: 0x1d8, rotationRate: 0x1fc,
    desiredRotation: 0x208, avgPhysicsTime: 0x32c,
    moveTimer: 0x348, moveTarget: 0x34c, faceTarget: 0x350,
    destination: 0x354, focus: 0x360,
    desiredSpeed: 0x36c, maxDesiredSpeed: 0x370, meleeRange: 0x374,
    groundSpeed: 0x378, waterSpeed: 0x37c, airSpeed: 0x380, accelRate: 0x384,
    floor: 0x3fc,
  }),
  flagBits: Object.freeze({
    bCanStrafe: 0x00000200,   // pawn +0x318 bit 9
    bReducedSpeed: 0x00000800, // +0x318 bit 11
    bCanSwim: 0x00004000,      // +0x318 bit 14 (tested via ah,0x40)
    bAdvancedTactics: 0x80000000, // +0x318 bit 31
    bCanGlide: 0x02,           // +0x31c low byte bit 1
  }),
  stateFrameLatentOffset: 0x24,
  // EPhysics: PHYS_Walking=1 PHYS_Falling=2 PHYS_Swimming=3 PHYS_Flying=4
  // PHYS_Spider=0xa (the glide/double-use gates key on 3 and 4).
  physics: Object.freeze({ walking: 1, falling: 2, swimming: 3, flying: 4, spider: 0xa }),
  constants: Object.freeze({
    zeroSingle: Object.freeze({ address: 0x10426d54, value: 0 }),
    baseSpeed: Object.freeze({ address: 0x10431444, value: 200 }),
    timerDistance: Object.freeze({ address: 0x10431438, value: 1.3 }),   // double
    timerBase: Object.freeze({ address: 0x104298a0, value: 1 }),         // double
    timerZeroFallback: 0.5,
    gravityFactor: Object.freeze({ address: 0x1042f570, value: 0.9 }),   // double
    // The fall-resume addend: poll compares Location.Z+100 against dest.Z.
    fallZOffset: Object.freeze({ address: 0x104299a8, value: 100 }),
    arriveRadiusSquared: Object.freeze({ address: 0x10429878, value: 256 }),
    arriveMinHeight: Object.freeze({ address: 0x10430a68, value: 48 }),
    meleeFactor: Object.freeze({ address: 0x10431418, value: 0.8 }),     // double
    decelOffset: Object.freeze({ address: 0x10429c50, value: 1 }),
    decelScale: Object.freeze({ address: 0x1042b8e8, value: 0.2 }),      // double
    brakeFactor: Object.freeze({ address: 0x10431448, value: 1.4 }),     // double
    reducedSpeedFactor: Object.freeze({ address: 0x1042ac10, value: 0.5 }), // double
    flyTargetHeight: Object.freeze({ address: 0x1042adc0, value: 0.7 }), // double
    waitForLandingTime: 2.5,
    moveTowardPawnTimer: 1.2,          // 0x3f99999a
    waterAbortTimer: -1,               // 0xbf800000
  }),
  eventNames: Object.freeze({ touch: 'Touch', longFall: 'LongFall', alterDestination: 'AlterDestination' }),
  turnCone: Object.freeze({ facing: 0x7d0, behind: 0xf82f }),
});

// ---------------------------------------------------------------------------
// x87 plumbing — the bodies keep intermediates on the 80-bit stack and store
// float32 per component; the same model helpers the VM's operator natives use.
// ---------------------------------------------------------------------------

const ld = x87load;            // FLD dword: float32 memory -> 80-bit
const st = x87store;           // FSTP dword: 80-bit -> float32

const d64io = new DataView(new ArrayBuffer(8));
// FLD qword / embedded double constant: exact widening into the model.
const ld64 = v => {
  d64io.setFloat64(0, v, true);
  const lo = d64io.getUint32(0, true), hi = d64io.getUint32(4, true);
  const e = (hi >>> 20) & 0x7ff, m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e === 0x7ff) throw new Error('Pawn locomotion hit a nonfinite float64 operand');
  return { neg: hi >>> 31, sig: e ? m | (1n << 52n) : m, exp: e ? e - 1075 : -1074 };
};

const ZERO = ld(0), D90 = ld64(0.9), D1 = ld64(1), D13 = ld64(1.3),
  D08 = ld64(0.8), D02 = ld64(0.2), D14 = ld64(1.4), D05 = ld64(0.5), D07 = ld64(0.7);

const sub = (a, b) => x87add(a, x87neg(b));       // FSUB: a - b in 80-bit
const sub32 = (a, b) => st(sub(ld(a), ld(b)));    // fld a; fsub b; fstp dword

/** FCOM/FUCOM status flags: C0 for below, C3 for equal — both set when
 * unordered.  The bodies test ah,1 / ah,0x40 / ah,0x41, so unordered reads as
 * below/equal/below-equal respectively (NaN operand included). */
const x87compare = (a, b) => {
  if (a.nan !== undefined || b.nan !== undefined) return { c0: 1, c3: 1 };
  if (a.inf || b.inf) {
    if (a.inf && b.inf) return { c0: 0, c3: a.neg === b.neg ? 1 : 0 };
    return a.inf ? { c0: a.neg ? 1 : 0, c3: 0 } : { c0: b.neg ? 0 : 1, c3: 0 };
  }
  let m;
  // A zero significand is ±0 whatever its exponent field (x87add/x87mul leave
  // arithmetic zeros at exp 0), so it must not enter the magnitude compare
  // (the same fix as script-pawn-nav.mjs).
  if (a.sig === 0n && b.sig === 0n) m = 0;
  else if (a.sig === 0n) m = b.neg ? 1 : -1;
  else if (b.sig === 0n) m = a.neg ? -1 : 1;
  else if (a.neg !== b.neg) m = a.neg ? -1 : 1;
  else {
    const ea = a.exp + x87width(a.sig), eb = b.exp + x87width(b.sig);
    if (ea !== eb) m = ea < eb ? -1 : 1;
    else {
      const e = Math.min(a.exp, b.exp);
      const A = a.sig << BigInt(a.exp - e), B = b.sig << BigInt(b.exp - e);
      m = A === B ? 0 : A < B ? -1 : 1;
    }
    if (a.neg) m = -m;
  }
  return { c0: m < 0 ? 1 : 0, c3: m === 0 ? 1 : 0 };
};
const ltU = (a, b) => x87compare(a, b).c0 === 1;      // test ah,1
const leU = (a, b) => { const f = x87compare(a, b); return (f.c0 | f.c3) === 1; }; // test ah,0x41
const eqU = (a, b) => x87compare(a, b).c3 === 1;      // test ah,0x40

/** appSqrt through the cdecl double thunk: the 80-bit sum is FSTP'd to a
 * qword stack argument (53-bit store), FLD'd back, FSQRT'd, and the result is
 * FSTP'd to float32 by the caller. */
const appSqrt32 = sum80 => st(x87sqrt(x87storeDouble(sum80)));

// ---------------------------------------------------------------------------
// FCoords::FCoords(FRotator) — Core 0x1011b690.  The ctor runs three in-place
// passes over a UnitCoords-initialized buffer (roll, then pitch, then yaw);
// each pass transforms all four fields with TransformPointBy/VectorBy
// (0x10119d70/0x10119e40): out_i = (v0*a0 + v1*a1) + v2*a2 dotted against the
// stored matrix axes, one float32 store per component.  Table sines only.
// ---------------------------------------------------------------------------

const dot3 = (t, r) => st(x87add(
  x87add(x87mul(t[0], ld(r[0])), x87mul(t[1], ld(r[1]))),
  x87mul(t[2], ld(r[2]))));

/** The Rust core's callers.rs `fcoords_axes_out` (percep.rs's fcoords_axes) computes it once the script VM kernel is loaded
 * (docs/live-heap.md "Cut: x87 math in Rust"); `fcoordsAxesReference` is the BigInt body it is compared with. */
export function fcoordsAxes(rotation) {
  const kernel = scriptVmKernel?.fcoordsAxes;
  return kernel ? kernel(rotation) : fcoordsAxesReference(rotation);
}
export function fcoordsAxesReference(rotation) {
  const [pitch, yaw, roll] = rotation.map(v => v | 0);
  const s = rotatorSin, c = a => rotatorSin((a + 0x4000) | 0);
  // Stored matrix axes [origin, XAxis, YAxis, ZAxis] per pass — verified
  // bit-exact against the real ctor in Unicorn (roll->pitch->yaw order).
  const passes = [
    [[0, 0, 0], [1, 0, 0], [0, c(roll), s(roll)], [0, -s(roll), c(roll)]],
    [[0, 0, 0], [c(pitch), 0, -s(pitch)], [0, 1, 0], [s(pitch), 0, c(pitch)]],
    [[0, 0, 0], [c(yaw), -s(yaw), 0], [s(yaw), c(yaw), 0], [0, 0, 1]],
  ];
  let fields = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const m of passes)
    fields = fields.map((v, i) => {
      // Field 0 is the origin: TransformPointBy subtracts the matrix origin
      // (always zero here) keeping the difference on the stack per component.
      const t = i === 0 ? v.map((x, j) => sub(ld(x), ld(m[0][j]))) : v.map(ld);
      return [dot3(t, m[1]), dot3(t, m[2]), dot3(t, m[3])];
    });
  return fields;
}

// ---------------------------------------------------------------------------
// Shared conditions.
// ---------------------------------------------------------------------------

const isGliding = p =>
  p.bCanGlide && !p.bCanStrafe && (p.physics === 4 || p.physics === 3);

/** The glide-only acceleration block shared by the turn setups and polls:
 * Acceleration = XAxis(FCoords(Rotation)) * AccelRate, one f32 store per
 * component, AR held in st1 in 80-bit. */
function glideAcceleration(p) {
  const ar = ld(p.accelRate);
  const x = fcoordsAxes(p.rotation)[1];
  p.acceleration = [st(x87mul(ld(x[0]), ar)), st(x87mul(ld(x[1]), ar)), st(x87mul(ld(x[2]), ar))];
}

function requirePawn(pawn) {
  if (!pawn || typeof pawn !== 'object') throw new TypeError('Pawn locomotion requires a pawn field view');
  return pawn;
}
function advanceFrameCode(frame, count) {
  if (!frame || !Number.isInteger(frame.code)) throw new Error('Pawn locomotion requires FFrame.Code as an integer');
  frame.code = ((frame.code >>> 0) + count) >>> 0;
}
function requireServices(services) {
  if (!services || typeof services.isA !== 'function' || typeof services.processEvent !== 'function'
    || typeof services.readField !== 'function')
    throw new Error('Pawn locomotion requires isA/processEvent/readField services');
  return services;
}
function fieldVector(v, name) {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${name} requires a three-component vector`);
  return v.map(f32);
}

// ---------------------------------------------------------------------------
// Helper 0x103be980 — face a destination.  thiscall(pawn, &vector) -> eax.
// ---------------------------------------------------------------------------

function turnSetup980(p, dest, services) {
  if (p.physics === 0xa) return 1;                       // PHYS_Spider
  const d = [sub32(dest[0], p.location[0]), sub32(dest[1], p.location[1]), sub32(dest[2], p.location[2])];
  const rot = vectorToRotator(d);                        // [pitch,yaw,0], hardware-validated
  const yaw = rot[1] & 0xffff;                           // +0x20c masked back
  let desired = [rot[0], yaw, rot[2]];
  if (p.physics === 1) {                                 // walking zeroes pitch
    const target = p.moveTarget;
    if (!(target && services.isA(target, 'Pawn'))) desired = [0, yaw, rot[2]];
  }
  p.desiredRotation = desired;
  const dyaw = (yaw - (p.rotation[1] & 0xffff)) | 0;
  const a = Math.abs(dyaw);
  return (a < 0x7d0 || a > 0xf82f) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Helper 0x103be160 — MoveTimer setter.  thiscall(pawn, float dist).
// ---------------------------------------------------------------------------

function setMoveTimer160(p, dist) {
  const phys = p.physics;
  const base = phys === 4 ? ld(p.airSpeed)
    : phys === 3 ? ld(p.waterSpeed)
    : (phys === 1 || phys === 2 || phys === 0xa) ? ld(p.groundSpeed)
    : ld(200);
  const eff = x87mul(base, ld(p.desiredSpeed));
  // FCOM 0.0 + test ah,0x40: zero *or unordered* takes the 0.5 fallback.
  if (eqU(eff, ZERO)) { p.moveTimer = 0.5; return; }
  p.moveTimer = st(x87add(x87div(x87mul(ld(dist), D13), eff), D1));
}

// ---------------------------------------------------------------------------
// Helper 0x103be200 — steer/arrive.  thiscall(pawn, &dest) -> eax (1 = done).
// ---------------------------------------------------------------------------

function steerArrive200(p, dest, services) {
  const phys = p.physics;
  let d = [sub32(dest[0], p.location[0]), sub32(dest[1], p.location[1]), sub32(dest[2], p.location[2])];
  if (phys === 1) d[2] = 0;

  if (phys === 2) {
    // Falling: steering exists only when the zone's gravity is weaker than
    // 90% of the class default (fcompp tests DefaultGravityZ*0.9 < ZoneG.z;
    // default -950*0.9=-855, so a -100 low-gravity zone qualifies and a
    // normal-gravity zone does not — low gravity grants air control).
    const zone = services.zone(p.self);
    if (!zone) throw new Error('Falling pawn has no Region.Zone');
    if (!ltU(x87mul(ld(zone.defaultGravityZ), D90), ld(zone.gravityZ))) return 0;
    d[2] = 0;                                      // scratch dz zeroed at 0x103be2f3
    const n = x87safeNormal(d);
    const ar = ld(p.accelRate);
    p.acceleration = [st(x87mul(ar, ld(n[0]))), st(x87mul(ar, ld(n[1]))), st(x87mul(ar, ld(n[2])))];
    if (!ltU(ld(p.velocity[2]), ZERO)) return 0;   // resume checks need v.z < 0
    // 0x103be35d's `jmp` lands on the JNE at 0x103be7a9, skipping the
    // `test esi,esi` glide reload — so the surviving flags are the
    // Location.Z+100 < dest.Z compare (the glider check is dead on this path).
    return ltU(x87add(ld(p.location[2]), ld(100)), ld(dest[2])) ? 1 : 0;
  }

  const target = p.moveTarget;
  if (target && services.isA(target, 'Inventory')) {
    const tl = fieldVector(services.readField(target, 'Location'), 'MoveTarget Location');
    let dz = sub(ld(p.location[2]), ld(tl[2]));
    if (ltU(dz, ZERO)) dz = x87neg(dz);                  // FCHS after FCOM 0
    if (ltU(dz, ld(p.collisionHeight))) {
      const dx = sub(ld(p.location[0]), ld(tl[0])), dy = sub(ld(p.location[1]), ld(tl[1]));
      const cr = ld(p.collisionRadius);
      const d2 = x87add(x87mul(dy, dy), x87mul(dx, dx));
      if (!leU(x87mul(cr, cr), d2))
        services.processEvent(target, 'Touch', [p.self]);   // FindFunctionChecked + ProcessEvent
    }
  }

  const dl = d.map(ld);
  const dist = appSqrt32(x87add(x87add(x87mul(dl[1], dl[1]), x87mul(dl[0], dl[0])), x87mul(dl[2], dl[2])));
  const glide = isGliding(p);

  // Arrive: horizontal < 16 and |dz| < max(CollisionHeight, 48).
  if (ltU(x87add(x87mul(dl[1], dl[1]), x87mul(dl[0], dl[0])), ld(256))) {
    let az = dl[2];
    if (ltU(az, ZERO)) az = x87neg(az);
    const bound = ltU(ld(48), ld(p.collisionHeight)) ? ld(p.collisionHeight) : ld(48);
    if (ltU(az, bound)) {
      if (!glide) {
        p.acceleration = [0, 0, 0];
        d = [0, 0, 0];
      }
      return 1;
    }
  }

  if (glide) d = fcoordsAxes(p.rotation)[1].slice();
  else if (!leU(ld(dist), ZERO)) {
    // 1.0/dist: dx,dy multiply by the f32-stored reciprocal, dz by the
    // retained 80-bit value (the fst dword keeps st0).
    const s80 = x87recip(ld(dist));
    const s32 = st(s80);
    d = [st(x87mul(ld(s32), dl[0])), st(x87mul(ld(s32), dl[1])), st(x87mul(s80, dl[2]))];
  }

  const ar = ld(p.accelRate);
  p.acceleration = [st(x87mul(ar, ld(d[0]))), st(x87mul(ar, ld(d[1]))), st(x87mul(ar, ld(d[2])))];

  if (ltU(ld(p.moveTimer), x87storeDouble(ZERO))) return 1;

  if (target && services.isA(target, 'Pawn')) {
    // Melee approach: within radii + MeleeRange*0.8 reports done.
    const bound = x87add(x87add(ld(services.readField(target, 'CollisionRadius')),
      ld(p.collisionRadius)), x87mul(ld(p.meleeRange), D08));
    return leU(bound, ld(dist)) ? 0 : 1;
  }

  const speed = appSqrt32(x87add(
    x87add(x87mul(ld(p.velocity[0]), ld(p.velocity[0])), x87mul(ld(p.velocity[1]), ld(p.velocity[1]))),
    x87mul(ld(p.velocity[2]), ld(p.velocity[2]))));
  if (!glide && !leU(ld(speed), ld(100))) {
    // Deceleration steering: r = (v/speed) - d̂, Accel -= r * (1 - v̂·d̂)·speed·0.2.
    const s80 = x87recip(ld(speed));
    const svx = st(x87mul(s80, ld(p.velocity[0]))), svy = st(x87mul(s80, ld(p.velocity[1])));
    const svz80 = x87mul(s80, ld(p.velocity[2]));
    const rx = st(sub(ld(svx), ld(d[0]))), ry = st(sub(ld(svy), ld(d[1])));
    const rz = st(sub(svz80, ld(d[2])));
    const dot = x87add(x87mul(ld(svx), ld(d[0])),
      x87add(x87mul(svz80, ld(d[2])), x87mul(ld(svy), ld(d[1]))));
    const scale = x87mul(x87mul(sub(D1, dot), ld(speed)), D02);
    d = [st(x87mul(ld(rx), scale)), st(x87mul(ld(ry), scale)), rz];
    const a = p.acceleration;
    p.acceleration = [st(sub(ld(a[0]), ld(d[0]))), st(sub(ld(a[1]), ld(d[1]))),
      st(sub(ld(a[2]), x87mul(scale, ld(rz))))];
  }
  // Brake radius: AvgPhysicsTime*speed*1.4 <= dist means still outside — keep
  // polling (fcompp bound vs dist, C0|C3 -> return 0).
  if (leU(x87mul(x87mul(ld(p.avgPhysicsTime), ld(speed)), D14), ld(dist))) return 0;
  if (!p.bReducedSpeed) {
    p.bReducedSpeed = true;
    p.desiredSpeed = st(x87mul(ld(p.desiredSpeed), D05));
  }
  if (!leU(ld(speed), ZERO)) {
    const cap = x87div(ld(200), ld(speed));
    if (!leU(ld(p.desiredSpeed), cap)) p.desiredSpeed = st(cap);
  }
  return glide ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Setup bodies.  `frame.code` advances by the encoded token+operand sizes the
// caller supplies (oracle scenes pass the real emitted sizes; the VM path uses
// the dispatch* entries which leave the cursor to the bytecode evaluator).
// ---------------------------------------------------------------------------

/** Engine 0x103bb6f0 — WaitForLanding setup.  LatentFloat=2.5 unconditionally;
 * latent 528 installs only while PHYS_Falling. */
export function execWaitForLanding({ pawn, frame, state } = {}) {
  const p = requirePawn(pawn);
  advanceFrameCode(frame, 1);
  p.latentFloat = 2.5;
  if (p.physics === 2) state.latent = 528;
}
export const dispatchWaitForLanding = ({ pawn, state } = {}) =>
  execWaitForLanding({ pawn, frame: { code: 0 }, state });

/** Engine 0x103bdec0 — TurnTo setup. */
export function execTurnTo({ pawn, frame, state, args, services, operandBytes = 12 } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  advanceFrameCode(frame, 1 + operandBytes + 1);
  const focus = fieldVector(args[0], 'TurnTo NewFocus');
  // Store order follows the body: MoveTarget clears, the latent installs,
  // then Focus takes the evaluated vector.
  p.moveTarget = null;
  state.latent = 509;
  p.focus = focus;
  if (isGliding(p)) glideAcceleration(p);
  turnSetup980(p, p.focus, s);
}
export const dispatchTurnTo = ({ pawn, state, args, services } = {}) =>
  execTurnTo({ pawn, frame: { code: 0 }, state, args, services });

/** Engine 0x103bdbf0 — TurnToward setup.  A null target leaves the latent
 * action untouched and returns immediately. */
export function execTurnToward({ pawn, frame, state, args, services, operandBytes = 4 } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  advanceFrameCode(frame, 1 + operandBytes + 1);
  const target = args[0] ?? null;
  if (!target) return;
  p.faceTarget = target;
  state.latent = 511;
  if (isGliding(p)) glideAcceleration(p);
  p.focus = fieldVector(s.readField(target, 'Location'), 'TurnToward target Location');
  turnSetup980(p, p.focus, s);
}
export const dispatchTurnToward = ({ pawn, state, args, services } = {}) =>
  execTurnToward({ pawn, frame: { code: 0 }, state, args, services });

/** Shared by MoveTo/MoveToward setups: bReducedSpeed clears, then
 * DesiredSpeed = clamp(speed, 0, MaxDesiredSpeed) — min via FCOM+test ah,0x41
 * then max via FLD 0 + FCOMP st(1)+test ah,1, both unordered-friendly. */
function setupDesiredSpeed(p, speed) {
  p.bReducedSpeed = false;
  const s = ld(speed), mds = ld(p.maxDesiredSpeed);
  const min = leU(mds, s) ? mds : s;
  p.desiredSpeed = st(ltU(ZERO, min) ? min : ZERO);
}

/** Engine 0x103bceb0 — MoveTo setup. */
export function execMoveTo({ pawn, frame, state, args, services, operandBytes = [12, 4] } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  advanceFrameCode(frame, 1 + operandBytes[0] + 1 + operandBytes[1] + 1);
  const dest = fieldVector(args[0], 'MoveTo NewDestination');
  const speed = args[1] === undefined ? 1 : f32(args[1]);
  // d stays on the 80-bit stack through the distance sum (no f32 stores).
  const d = [sub(ld(dest[0]), ld(p.location[0])), sub(ld(dest[1]), ld(p.location[1])),
    sub(ld(dest[2]), ld(p.location[2]))];
  p.moveTarget = null;
  p.bReducedSpeed = false;
  const s80 = ld(speed), mds = ld(p.maxDesiredSpeed);
  const min = leU(mds, s80) ? mds : s80;
  p.desiredSpeed = st(ltU(ZERO, min) ? min : ZERO);
  const dist = appSqrt32(x87add(x87add(x87mul(d[2], d[2]), x87mul(d[1], d[1])), x87mul(d[0], d[0])));
  setMoveTimer160(p, dist);
  state.latent = 501;
  p.destination = dest;
  p.focus = dest.slice();
  turnSetup980(p, p.focus, s);
  steerArrive200(p, p.destination, s);
}
export const dispatchMoveTo = ({ pawn, state, args, services } = {}) =>
  execMoveTo({ pawn, frame: { code: 0 }, state, args, services });

/** Engine 0x103bd150 — MoveToward setup.  A null target returns before any
 * state write.  Pawn targets pin MoveTimer=1.2; others use the distance
 * formula on f32-rounded deltas. */
export function execMoveToward({ pawn, frame, state, args, services, operandBytes = [4, 4] } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  advanceFrameCode(frame, 1 + operandBytes[0] + 1 + operandBytes[1] + 1);
  const target = args[0] ?? null;
  const speed = args[1] === undefined ? 1 : f32(args[1]);
  if (!target) return;
  const tl = fieldVector(s.readField(target, 'Location'), 'MoveToward target Location');
  const d = [sub32(tl[0], p.location[0]), sub32(tl[1], p.location[1]), sub32(tl[2], p.location[2])];
  p.bReducedSpeed = false;
  setupDesiredSpeed(p, speed);
  if (s.isA(target, 'Pawn')) p.moveTimer = f32(1.2);   // native stores 0x3f99999a
  else {
    const dl = d.map(ld);
    const dist = appSqrt32(x87add(x87add(x87mul(dl[2], dl[2]), x87mul(dl[1], dl[1])), x87mul(dl[0], dl[0])));
    setMoveTimer160(p, dist);
  }
  p.moveTarget = target;
  p.destination = tl;
  p.focus = tl;
  state.latent = 503;
  turnSetup980(p, p.focus, s);
  steerArrive200(p, p.destination, s);
}
export const dispatchMoveToward = ({ pawn, state, args, services } = {}) =>
  execMoveToward({ pawn, frame: { code: 0 }, state, args, services });

/** StrafeTo/StrafeFacing speed: bReducedSpeed clears; a bIsPlayer pawn
 * (+0x318 bit 1, tested on the dword read before the clear) copies
 * MaxDesiredSpeed, any other clamps like MoveTo (Deus Ex's added speed). */
function strafeDesiredSpeed(p, speed) {
  const isPlayer = p.bIsPlayer;
  p.bReducedSpeed = false;
  if (isPlayer) p.desiredSpeed = p.maxDesiredSpeed;
  else setupDesiredSpeed(p, speed);
}
const moveDistance = (p, dest) => {
  // Dest − Location stays on the 80-bit stack; the size sums z², y², x².
  const d = [sub(ld(dest[0]), ld(p.location[0])), sub(ld(dest[1]), ld(p.location[1])),
    sub(ld(dest[2]), ld(p.location[2]))];
  return appSqrt32(x87add(x87add(x87mul(d[2], d[2]), x87mul(d[1], d[1])), x87mul(d[0], d[0])));
};

/** Engine 0x103bd5f0 — StrafeTo(NewDestination, NewFocus, optional Speed=1)
 * setup: MoveTarget clears, DesiredSpeed, the move timer from the distance,
 * latent 505, Destination and Focus, then the facing and steer helpers. */
export function execStrafeTo({ pawn, frame, state, args, services, operandBytes = [12, 12, 4] } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  advanceFrameCode(frame, operandBytes.reduce((n, bytes) => n + 1 + bytes, 0) + 1);
  const dest = fieldVector(args[0], 'StrafeTo NewDestination');
  const focus = fieldVector(args[1], 'StrafeTo NewFocus');
  const speed = args[2] === undefined ? 1 : f32(args[2]);
  const dist = moveDistance(p, dest);
  p.moveTarget = null;
  strafeDesiredSpeed(p, speed);
  setMoveTimer160(p, dist);
  state.latent = 505;
  p.destination = dest;
  p.focus = focus;
  turnSetup980(p, p.focus, s);
  steerArrive200(p, p.destination, s);
}
export const dispatchStrafeTo = ({ pawn, state, args, services } = {}) =>
  execStrafeTo({ pawn, frame: { code: 0 }, state, args, services });

/** Engine 0x103bd8c0 — StrafeFacing(NewDestination, NewTarget, optional
 * Speed=1) setup.  A null target returns after P_FINISH with no write; else
 * as StrafeTo but MoveTarget is untouched, FaceTarget takes the target, Focus
 * its Location, and the latent is 507. */
export function execStrafeFacing({ pawn, frame, state, args, services, operandBytes = [12, 4, 4] } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  advanceFrameCode(frame, operandBytes.reduce((n, bytes) => n + 1 + bytes, 0) + 1);
  const dest = fieldVector(args[0], 'StrafeFacing NewDestination');
  const target = args[1] ?? null;
  const speed = args[2] === undefined ? 1 : f32(args[2]);
  if (!target) return;
  const dist = moveDistance(p, dest);
  strafeDesiredSpeed(p, speed);
  setMoveTimer160(p, dist);
  p.destination = dest;
  p.faceTarget = target;
  p.focus = fieldVector(s.readField(target, 'Location'), 'StrafeFacing target Location');
  state.latent = 507;
  turnSetup980(p, p.focus, s);
  steerArrive200(p, p.destination, s);
}
export const dispatchStrafeFacing = ({ pawn, state, args, services } = {}) =>
  execStrafeFacing({ pawn, frame: { code: 0 }, state, args, services });

// ---------------------------------------------------------------------------
// Latent polls — each receives (pawn, state, dt, services) and clears
// state.latent exactly when the original writes 0 to StateFrame+0x24.
// ---------------------------------------------------------------------------

/** Engine 0x103bb730 — WaitForLanding poll: resumes when physics leaves
 * Falling; while falling LatentFloat -= dt (f32) and LongFall fires every
 * tick once it is negative, without clearing the latent. */
export function pollWaitForLanding({ pawn, state, dt, services } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  if (p.physics !== 2) { state.latent = 0; return; }
  // `fst dword [+0xe0]` stores the f32 result but keeps the 80-bit value on
  // the stack; the FCOMP of the zero constant below compares the RETAINED
  // 80-bit value, not the rounded store.
  const left80 = sub(ld(p.latentFloat), ld(f32(dt)));
  p.latentFloat = st(left80);
  if (ltU(left80, ZERO)) s.processEvent(p.self, 'LongFall', []);
}

/** Engine 0x103be020 — TurnTo poll. */
export function pollTurnTo({ pawn, state, services } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  if (isGliding(p)) glideAcceleration(p);
  if (turnSetup980(p, p.focus, s)) state.latent = 0;
}

/** Engine 0x103bdd60 — TurnToward poll: FaceTarget==0 resumes; each tick
 * Focus re-snapshots the live target location before the facing check. */
export function pollTurnToward({ pawn, state, services } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  const target = p.faceTarget;
  if (!target) { state.latent = 0; return; }
  if (isGliding(p)) glideAcceleration(p);
  p.focus = fieldVector(s.readField(target, 'Location'), 'FaceTarget Location');
  if (turnSetup980(p, p.focus, s)) state.latent = 0;
}

/** The bAdvancedTactics+PHYS_Walking AlterDestination event shared by the
 * move polls (FindFunctionChecked then ProcessEvent on the pawn itself).
 * The name is the FName global 0x105835c8, which Engine.dll builds from the
 * string "AlterDestination" at 0x1047d00c (0x103806d2..0x103806e0; the
 * neighbours are 0x105835c4 SpawnNotification and 0x105835c0 UpdateTactics,
 * which an earlier reading took for this one) and which the original,
 * traced on Island, ProcessEvents inside UNATCOTroop6's MoveTo poll
 * (docs/script-pawn-locomotion.md "Live divergence").  ScriptedPawn declares
 * it: the function rewrites Destination to walk around ActorAvoiding and,
 * once TurnDirection clears, undoes Bump's `MoveTimer += 4`.  A class that
 * does not declare it gets the original's NULL-resolution no-op (logged
 * through GWarn->Logf, nonfatal; AActor::ProcessEvent's XLevel+0x4f0 bit-0x2
 * gate drops the NULL before Core ProcessEvent can dereference it): the
 * dispatch fires only when the class actually resolves the function. */
function tacticsEvent(p, s) {
  if (!(p.bAdvancedTactics && p.physics === 1)) return;
  if (s.findFunction?.(p.self, 'AlterDestination')) s.processEvent(p.self, 'AlterDestination', []);
}

/** Engine 0x103bd060 — MoveTo poll.  Destination is snapshotted across the
 * event+helpers and restored unconditionally on exit. */
export function pollMoveTo({ pawn, state, services } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  const dest = fieldVector(p.destination, 'Pawn Destination');
  tacticsEvent(p, s);
  // Both helpers receive the Destination field itself (edi = pawn+0x354 at
  // 0x103bd0b1..0x103bd0bc): they see what the event rewrote.
  const live = fieldVector(p.destination, 'Pawn Destination');
  turnSetup980(p, live, s);
  if (steerArrive200(p, live, s)) state.latent = 0;
  p.destination = dest;
}

/** Engine 0x103bd7d0 — StrafeTo poll: Destination is saved, the tactics
 * event, facing on the live Focus, steering on the live Destination (arrival
 * resumes), then Destination is restored. */
export function pollStrafeTo({ pawn, state, services } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  const saved = fieldVector(p.destination, 'Pawn Destination');
  tacticsEvent(p, s);
  turnSetup980(p, fieldVector(p.focus, 'Pawn Focus'), s);
  if (steerArrive200(p, fieldVector(p.destination, 'Pawn Destination'), s)) state.latent = 0;
  p.destination = saved;
}

/** Engine 0x103bdad0 — StrafeFacing poll: FaceTarget==0 resumes.  Focus
 * re-copies the target's Location and Destination is saved; facing runs
 * before the tactics event here, then steering on the live Destination, then
 * Destination is restored. */
export function pollStrafeFacing({ pawn, state, services } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  const target = p.faceTarget;
  if (!target) { state.latent = 0; return; }
  p.focus = fieldVector(s.readField(target, 'Location'), 'FaceTarget Location');
  const saved = fieldVector(p.destination, 'Pawn Destination');
  turnSetup980(p, fieldVector(p.focus, 'Pawn Focus'), s);
  tacticsEvent(p, s);
  if (steerArrive200(p, fieldVector(p.destination, 'Pawn Destination'), s)) state.latent = 0;
  p.destination = saved;
}

/** Engine 0x103bd370 — MoveToward poll.  MoveTarget==0 resumes.  The
 * Destination is re-snapshotted from the target each tick, offset upward for
 * Flying pawn targets or pushed along Floor for Spider, then restored after
 * the helpers.  Pawn targets restore DesiredSpeed and force MoveTimer=-1 when
 * the target treads water the pawn cannot swim. */
export function pollMoveToward({ pawn, state, services } = {}) {
  const p = requirePawn(pawn), s = requireServices(services);
  const target = p.moveTarget;
  if (!target) { state.latent = 0; return; }
  const tl = fieldVector(s.readField(target, 'Location'), 'MoveTarget Location');
  let dest = tl.slice();
  if (p.physics === 4) {
    if (s.isA(target, 'Pawn'))
      dest[2] = st(x87add(ld(dest[2]), x87mul(ld(services.readField(target, 'CollisionHeight')), D07)));
  } else if (p.physics === 0xa) {
    const t = ld(services.readField(target, 'CollisionRadius'));
    const off = [st(x87mul(t, ld(p.floor[0]))), st(x87mul(t, ld(p.floor[1]))), x87mul(t, ld(p.floor[2]))];
    dest = [st(sub(ld(dest[0]), ld(off[0]))), st(sub(ld(dest[1]), ld(off[1]))), st(sub(ld(dest[2]), off[2]))];
  }
  p.destination = dest;
  p.focus = dest.slice();
  const savedSpeed = p.desiredSpeed;
  tacticsEvent(p, s);
  // The helpers take the Destination field itself (edi = pawn+0x354 at
  // 0x103bd4a4..0x103bd4af): the event's rewrite is what they steer on.
  const live = fieldVector(p.destination, 'Pawn Destination');
  turnSetup980(p, live, s);
  if (steerArrive200(p, live, s)) state.latent = 0;
  p.destination = fieldVector(s.readField(target, 'Location'), 'MoveTarget Location');
  if (s.isA(target, 'Pawn')) {
    p.desiredSpeed = savedSpeed;
    const zone = s.zone(target);
    if (!p.bCanSwim && zone && zone.waterZone) p.moveTimer = -1;
  }
}
