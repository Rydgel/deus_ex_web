/**
 * Recovered APawn navigation/reachability natives — the shared movement
 * primitives beneath pointReachable (521), actorReachable (520),
 * FindRandomDest (525), FindPathTo (518), FindPathToward (517),
 * PickWallAdjust (526) and FindStairRotation (524).
 *
 * Every body was disassembled from the hash-verified GOTY Engine.dll and is
 * reproduced instruction-faithfully: float32 stores round once through the
 * 80-bit x87 model and unordered FCOM flag bits are honored.  The collision
 * boundary is the level's MoveActor (vtable +0x88) / FarMoveActor (+0x8c) —
 * the workers drive real test-moves and read back FCheckResult fields, so a
 * validator that scripts the boundary identically on both sides exercises
 * the recovered control flow bit-exact (docs/script-pawn-nav.md records
 * provenance and the oracle-verified contracts).
 */

import {
  x87load, x87add, x87mul, x87store, x87width,
} from './script-vm.mjs';

const f32 = Math.fround;

/** Static address/byte contract for the installed GOTY Engine.dll image. */
export const PAWN_NAV_CONTRACT = Object.freeze({
  engineSha256: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  imageBase: 0x10300000,
  natives: Object.freeze({
    findPathToward:   Object.freeze({ index: 517, thunk: 0x1030333c, body: 0x103bc9c0, worker: 0x103db3f0 }),
    findPathTo:       Object.freeze({ index: 518, thunk: 0x10302c6b, body: 0x103bc800, worker: 0x103dc1d0 }),
    actorReachable:   Object.freeze({ index: 520, thunk: 0x10302969, body: 0x103bc1a0, worker: 0x103c0630 }),
    pointReachable:   Object.freeze({ index: 521, thunk: 0x103033fa, body: 0x103bc710, worker: 0x103c0d30 }),
    findStairRotation:Object.freeze({ index: 524, thunk: 0x10303111, body: 0x103bb880 }),
    findRandomDest:   Object.freeze({ index: 525, thunk: 0x103014f1, body: 0x103bcb90, worker: 0x103dc700 }),
    pickWallAdjust:   Object.freeze({ index: 526, thunk: 0x10303968, body: 0x103bb7e0, worker: 0x103c4150 }),
  }),
  // Shared workers beneath the exec bodies.
  workers: Object.freeze({
    checkMove:   0x103c3290,  // thiscall(pawn; delta vec3, hit*, target, scale, flag) -> 5/1/0/-1
    walkReach:   0x103c1b70,  // ~100-step walking/swimming reach trace
    waterReach:  0x103c15a0,
    flyReach:    0x103c1190,
    dispatch:    0x103c1000,  // physics reach dispatcher (thunk 0x1030353f)
    jumpArc:     0x103c2f50,
    reachMask:   0x10326d10,  // 7-bit capability gather (thiscall)
    directReach: 0x103dad20,  // NavigationPoint ReachSpec scan
  }),
  // Level vtable slots the workers call.
  vtable: Object.freeze({
    moveActor: 0x88, farMoveActor: 0x8c, singleLineCheck: 0xc0,
  }),
  // Pawn/Actor field offsets the bodies dereference.
  offsets: Object.freeze({
    physics: 0x30, xLevel: 0xac, levelInfo: 0xa8,
    location: 0x114, rotation: 0x120, velocity: 0x144,
    collisionRadius: 0x1d4, collisionHeight: 0x1d8,
    region: 0xc8, footRegion: 0x330, headRegion: 0x33c,
    flags318: 0x318, maxStepHeight: 0x38c, baseEyeHeight: 0x3f4,
    reducedDamageType: 0x444,
  }),
  flagBits: Object.freeze({
    bCanJump: 0x00008000,     // pawn +0x318 bit 15 -> jumpArc helper
    bCanSwim: 0x00004000,     // +0x318 bit 14
    bReducedDamageType: 0x0,  // (pawn+0x444 compared raw, not a bit)
  }),
  zoneBits: Object.freeze({
    water: 0x01, pain: 0x20,  // zone+0x388 flag byte
  }),
  constants: Object.freeze({
    zero:        Object.freeze({ address: 0x10426d54, value: 0 }),       // float
    one:         Object.freeze({ address: 0x104298a0, value: 1 }),       // double
    negOne:      Object.freeze({ address: 0x104298f0, value: -1 }),      // float
    slopeFloor:  Object.freeze({ address: 0x1042adc0, value: 0.7 }),     // double
    slopeSteep:  Object.freeze({ address: 0x1042f5e8, value: 0.95 }),    // double
    downProbePad:Object.freeze({ address: 0x1042ead0, value: 2 }),       // double
    climbCoeff:  Object.freeze({ address: 0x10431418, value: 0.8 }),     // double
    innerRadius: Object.freeze({ address: 0x104314b8, value: 15 }),      // float
    maxDistSq:   Object.freeze({ address: 0x104314a8, value: 1000000 }), // double
  }),
});

// ---------------------------------------------------------------------------
// x87 plumbing — identical model to script-pawn-perception.mjs: intermediates
// stay on the 80-bit stack, every dword store rounds once to float32.
// ---------------------------------------------------------------------------

const ld = x87load;
const d64io = new DataView(new ArrayBuffer(8));
const ld64 = v => {
  d64io.setFloat64(0, v, true);
  const lo = d64io.getUint32(0, true), hi = d64io.getUint32(4, true);
  const e = (hi >>> 20) & 0x7ff, m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e === 0x7ff) throw new Error('Pawn nav hit a nonfinite float64 operand');
  return { neg: hi >>> 31, sig: e ? m | (1n << 52n) : m, exp: e ? e - 1075 : -1074 };
};

const D1 = ld64(1), D07 = ld64(0.7), D2 = ld64(2), D08 = ld64(0.8), D0 = ld64(0);

/** FCOM/FUCOM status flags: C0 below, C3 equal, both when unordered. */
const x87compare = (a, b) => {
  if (a.nan !== undefined || b.nan !== undefined) return { c0: 1, c3: 1 };
  if (a.inf || b.inf) {
    if (a.inf && b.inf) return { c0: 0, c3: a.neg === b.neg ? 1 : 0 };
    return a.inf ? { c0: a.neg ? 1 : 0, c3: 0 } : { c0: b.neg ? 0 : 1, c3: 0 };
  }
  let m;
  if (a.sig === 0n && b.sig === 0n) m = 0;
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
const ltU = (a, b) => x87compare(a, b).c0 === 1;       // test ah,1
const leU = (a, b) => { const f = x87compare(a, b); return (f.c0 | f.c3) === 1; };

// ---------------------------------------------------------------------------
// Field access through the service seam.  The level-graph boundary mirrors
// the native reads/writes at the offsets in PAWN_NAV_CONTRACT.
// ---------------------------------------------------------------------------

const rd = (services, obj, name) => services.read(obj, name);

/**
 * Original ULevel::MoveActor test-move (vtable +0x88).  The boundary applies
 * position += delta * hit.time and reports the FCheckResult — exactly the
 * commit semantics the native relies on when it later reads pawn.Location.
 * Returns { time, normal:[x,y,z], actor, item }.
 */
const moveActor = (services, pawn, delta, rot) =>
  services.moveActor(pawn, delta, rot, { test: 1, ignorePawns: 1, ignoreBalls: 0, noFail: 0 });

/** Original ULevel::FarMoveActor (vtable +0x8c): restore `pawn` to `dest`. */
const farMove = (services, pawn, dest) => services.farMoveActor(pawn, dest, 1, 1);

/**
 * checkMove worker 0x103c3290.
 *   int checkMove(this=pawn; FVector delta; FCheckResult* hit;
 *                 AActor* target; float scale; int flag)
 *
 * A multi-phase MoveActor probe.  The x86 signature takes an out FCheckResult
 * buffer that is reused across the calls; here each moveActor returns a fresh
 * hit object, so the local `hit` tracks the same data.
 *
 * Return codes (oracle-verified):
 *   5  — the probe's hit.Actor == target (reached the target actor).
 *   1  — progressed: landed on a floor and displaced >= scale.
 *   0  — blocked (wall) or under-moved; flag decides whether to revert.
 *  -1  — ledge/void or steep landing; flag decides the restore point.
 */
export function checkMove(pawn, delta, target, scale, flag, services) {
  const origLoc = services.location(pawn).map(f32);      // [ebp-0x2c/-0x28/-0x24]
  const rot = rd(services, pawn, 'Rotation');            // esi+0x120
  const maxStep = rd(services, pawn, 'MaxStepHeight');   // esi+0x38c
  // [ebp-0x48]: -1.0 when region-zone GravityZ (+0x324) <= 0, else +1.0.
  const sign = leU(ld(services.zoneGravity(pawn)), D0) ? -1.0 : 1.0;
  const stepSigned = f32(maxStep * sign);                // [ebp-0x14/-0x18/-0x3c]
  // [ebp-0x38/-0x34/-0x30]: (0,0,-stepSigned) = (0,0,+maxStep) step-up delta.
  const upVec = [0, 0, f32(-stepSigned)];

  // Phase A: MoveActor(pawn, delta, rot, hit, test=1, igp=1, igb=0, nofail=0).
  let hit = moveActor(services, pawn, delta, rot);
  if (target && hit.actor === target) return 5;          // 0x103c33a4

  if (ltU(ld(hit.time), D1)) {                           // 0x103c33bc: Time<1 -> partial
    // Remaining fraction: delta *= (1 - hit.time), z forced to 0.
    const remain = f32(1.0 - hit.time);                  // 0x103c33d3
    const fwd = [f32(delta[0] * remain), f32(delta[1] * remain), 0];
    moveActor(services, pawn, upVec, rot);               // #2 step up onto ledge
    hit = moveActor(services, pawn, fwd, rot);           // #3 continue forward
    if (target && hit.actor === target) return 5;        // 0x103c349f
    hit = moveActor(services, pawn, [0, 0, stepSigned], rot); // #4 step down
    if (target && hit.actor === target) return 5;        // 0x103c3514
    // Wall after the step sequence (partial hit on a non-floor): restore, 0.
    if (ltU(ld(hit.time), D1) && ltU(ld(hit.normal[2]), D07)) {
      farMove(services, pawn, origLoc);                  // 0x103c356f
      return 0;                                          // 0x103c3575
    }
    // else: full move or floor landing -> fall through to the down-probe.
  }

  // Down-probe (0x103c358a): saveLoc2 = post-forward location, then probe
  // (0,0,(maxStep+2)*sign) — for normal gravity a (0,0,-(maxStep+2)) drop.
  const postLoc = services.location(pawn).map(f32);      // [ebp-0x44/-0x40/-0x3c]
  const downVec = [0, 0, f32(x87store(x87mul(x87add(ld(maxStep), D2), ld(sign))))];
  hit = moveActor(services, pawn, downVec, rot);         // #5
  if (ltU(ld(hit.time), D1)) {                           // 0x103c360e: hit going down
    if (ltU(ld(hit.normal[2]), D07)) {                   // 0x103c3697: steep landing
      farMove(services, pawn, origLoc);                  // 0x103c36ca
      return -1;
    }
    // Flat floor: 3D displacement vs scale (0x103c36e6, fcompp order preserved).
    const loc = services.location(pawn);
    const dx = ld(f32(loc[0] - origLoc[0])), dy = ld(f32(loc[1] - origLoc[1])),
      dz = ld(f32(loc[2] - origLoc[2]));
    const distSq = x87add(x87mul(dz, dz), x87add(x87mul(dy, dy), x87mul(dx, dx)));
    const scaleSq = x87mul(ld(scale), ld(scale));
    if (leU(scaleSq, distSq)) return 1;                  // distSq>=scale^2 -> 1
    if (flag) {                                          // 0x103c3726
      farMove(services, pawn, origLoc);                  // 0x103c3754
      return 0;
    }
    return 0;                                            // flag==0: keep position
  }
  // Moved the full drop distance -> ledge/void (0x103c361e).
  if (flag) {                                            // 0x103c3629
    farMove(services, pawn, origLoc);                    // 0x103c3648
    return -1;
  }
  farMove(services, pawn, postLoc);                      // 0x103c367b keep forward step
  return -1;
}
