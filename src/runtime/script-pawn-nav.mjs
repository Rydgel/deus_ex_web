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
  x87load, x87add, x87mul, x87div, x87neg, x87recip, x87store,
  x87storeDouble, x87sqrt, x87safeNormal, x87width, x87ftol,
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
    flyMove:     0x103c3900,
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
    bCanJump: 0x00001000,     // pawn +0x318 bit 12 -> jumpArc 0x103c2f50
    bCanFly:  0x00008000,     // pawn +0x318 bit 15 -> flyReach 0x103c1190
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
const D095 = ld64(0.95), D1f = ld(1.0), D15 = ld(15.0);

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
const ltU = (a, b) => x87compare(a, b).c0 === 1;       // test ah,1 / jne
const leU = (a, b) => { const f = x87compare(a, b); return (f.c0 | f.c3) === 1; };
const geU = (a, b) => x87compare(a, b).c0 === 0;       // test ah,1 / je
const gtU = (a, b) => { const f = x87compare(a, b); return (f.c0 | f.c3) === 0; };

const st = x87store;
const sub = (a, b) => x87add(a, x87neg(b));          // FSUB: a - b in 80-bit
/** appSqrt(double): FSTP double arg -> CRT sqrt -> double result (Core thunk). */
const appSqrt = v => x87storeDouble(x87sqrt(x87storeDouble(v)));

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

/** Ordered C3 (equal) flag from FCOM — `test ah,0x40`. */
const eqU = (a, b) => x87compare(a, b).c3 === 1;

/**
 * reachMask worker 0x10326d10 — pure thiscall gather.
 *   int reachMask(this=pawn)
 *
 * Packs the pawn's +0x318 capability bits into the 7-bit ReachSpec mask.
 * The body shifts each source bit into bit0 and accumulates left, so the
 * last-shifted bit lands at the top of the result:
 *   mask = b13 | b15<<1 | b14<<2 | b12<<3 | b16<<4 | b17<<5 | b1<<6
 * (oracle bit-exact: flags318=0x1ffff -> 0x5f, each single bit verified).
 */
export function reachMask(pawn, services) {
  const f = rd(services, pawn, 'Flags318') >>> 0;           // ecx+0x318
  return ((f >>> 13) & 1)
       | (((f >>> 15) & 1) << 1)
       | (((f >>> 14) & 1) << 2)
       | (((f >>> 12) & 1) << 3)
       | (((f >>> 16) & 1) << 4)
       | (((f >>> 17) & 1) << 5)
       | (((f >>> 1) & 1) << 6);
}

/**
 * directReach worker 0x103dad20.
 *   int directReach(this=pawn; AActor* source; AActor* target)
 *
 * Scans `source`'s two NavigationPoint ReachSpec index arrays (+0x360 then
 * +0x3a0, 16 slots, -1 terminated) for a spec whose `end` (+0x08) is `target`
 * and that admits the pawn's dimensions/capabilities.  A qualifying spec is
 * confirmed by SingleLineCheck(source.loc -> target.loc, flags=6, zero extent):
 * a clear trace, or a non-Mover hit, or a Mover the pawn can open, returns 1.
 * Only a Mover the pawn cannot open makes it advance to the next index.
 *
 * ReachSpec record (level +0x8c, 28-byte stride): +0x00 start, +0x04 distance,
 * +0x08 end, +0x0c collisionRadius(int), +0x10 collisionHeight(int),
 * +0x14 reachFlags, +0x18 pruned.
 */
export function directReach(pawn, source, target, services) {
  const table = services.reachSpecTable(pawn);              // pawn->level +0x8c
  const cri = x87ftol(ld(rd(services, pawn, 'CollisionRadius')));  // __ftol
  const chi = x87ftol(ld(rd(services, pawn, 'CollisionHeight')));
  const f318 = rd(services, pawn, 'Flags318') >>> 0;
  const mask = reachMask(pawn, services);
  const end = services.location(target), start = services.location(source);
  for (const arr of [services.paths(source), services.upstreamPaths(source)]) {
    for (let i = 0; i < 16; i++) {                          // [ebp-0x14] < 0x10
      // Fixed 16-dword array; absent slots read as the -1 terminator.
      const idx = i < arr.length ? (arr[i] | 0) : -1;
      if (idx === -1) break;                                // -1 terminator
      const spec = table[idx];
      if (!spec || spec.end !== target) continue;           // spec+0x08
      if ((spec.radius | 0) < cri) continue;                // spec+0x0c < ftoi(CR)
      if ((spec.height | 0) < chi) continue;                // spec+0x10 < ftoi(CH)
      if (((spec.reachFlags | 0) & mask) !== (spec.reachFlags | 0)) continue; // +0x14
      const hit = services.singleLineCheck(pawn, end, start, 6, [0, 0, 0], 0);
      if (!hit.actor) return 1;                             // clear trace
      if (services.isA(hit.actor, 'Mover')) {               // AMover 0x1058bb58
        if (!(f318 & 0x10000)) continue;                    // !bCanOpenDoors
        if (f318 & 0x2) return 1;                           // flags bit1
        if (!(rd(services, hit.actor, 'Flags4ec') & 8)) return 1;
        continue;                                           // mover blocks
      }
      return 1;                                             // non-mover hit
    }
  }
  return 0;
}

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
  delta = [delta[0], delta[1], 0];                       // 0x103c32c0 clears incoming Z
  const origLoc = services.location(pawn).map(f32);      // [ebp-0x2c/-0x28/-0x24]
  const rot = rd(services, pawn, 'Rotation');            // esi+0x120
  const maxStep = rd(services, pawn, 'MaxStepHeight');   // esi+0x38c
  // [ebp-0x48]: -1.0 when region-zone GravityZ (+0x324) <= 0, else +1.0.
  const sign = leU(ld(services.zoneGravity(pawn)), D0) ? -1.0 : 1.0;
  const stepSigned = f32(maxStep * sign);                // [ebp-0x14/-0x18/-0x3c]
  // [ebp-0x38/-0x34/-0x30]: (0,0,-stepSigned) = (0,0,+maxStep) step-up delta.
  const upVec = [-0, -0, f32(-stepSigned)];              // native 0.0f * -1.0f

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

/**
 * APawn::flyMove 0x103c3900. Test a 3D move, retry a partial hit after an
 * up-step, and report target-hit (5), enough displacement (1), or blocked (0).
 * Original constants/control flow and boundary calls: docs/script-pawn-nav.md.
 */
export function flyMove(pawn, delta, target, scale, restoreOnFailure, services) {
  const origLoc = services.location(pawn).map(f32);
  // The native multiplies both zero components by -1: retain their -0 bits.
  const up = [-0, -0, st(x87mul(x87mul(ld(rd(services, pawn, 'MaxStepHeight')), ld(-1)), ld(-1)))];
  let hit = moveActor(services, pawn, delta, rd(services, pawn, 'Rotation'));
  if (target && hit.actor === target) return 5;             // 0x103c3a0a
  if (ltU(ld(hit.time), D1)) {                              // 0x103c3a1e
    const remaining = st(sub(D1, ld(hit.time)));
    const retry = delta.map(v => st(x87mul(ld(v), ld(remaining))));
    moveActor(services, pawn, up, rd(services, pawn, 'Rotation'));
    hit = moveActor(services, pawn, retry, rd(services, pawn, 'Rotation'));
    if (target && hit.actor === target) return 5;           // 0x103c3ae9
  }
  // FST-free differences remain extended through the displacement compare.
  const d = services.location(pawn).map((v, i) => sub(ld(v), ld(origLoc[i])));
  const movedSq = x87add(x87add(x87mul(d[0], d[0]), x87mul(d[1], d[1])), x87mul(d[2], d[2]));
  if (leU(x87mul(ld(scale), ld(scale)), movedSq)) return 1; // 0x103c3b2d
  if (restoreOnFailure) farMove(services, pawn, origLoc);
  return 0;
}

/**
 * APawn::flyReachable 0x103c1190. Original 3D reach loop; called by the
 * PHYS_Flying dispatcher and the bCanFly fallback inside walkReach.
 * Water reach remains an explicit, unported service boundary.
 */
export function flyReach(pawn, point, radius, reachFlags, target, services) {
  const origLoc = services.location(pawn).map(f32);
  const origVel = services.velocity(pawn).map(f32);
  const radiusSq = st(x87mul(ld(radius), ld(radius)));
  const CR = rd(services, pawn, 'CollisionRadius');
  const step = ltU(ld(200), ld(CR)) ? CR : 200;             // 0x103c1235
  const stepSq = st(x87mul(ld(step), ld(step)));
  reachFlags |= 2;
  let reached = 0, counter = 100;
  while (true) {
    const loc = services.location(pawn);
    const d = point.map((v, i) => sub(ld(v), ld(loc[i])));
    const delta = d.map(st);
    const distSq = x87add(x87add(x87mul(d[0], d[0]), x87mul(d[1], d[1])), x87mul(d[2], d[2]));
    const storedDistSq = st(distSq);
    const absZ = ltU(d[2], D0) ? x87neg(d[2]) : d[2];
    if (leU(distSq, ld(radiusSq)) && leU(absZ, ld(rd(services, pawn, 'CollisionHeight')))) {
      reached = 1;                                        // 0x103c12cc
      break;
    }
    const near = ltU(ld(storedDistSq), ld(stepSq));
    const move = near ? delta : x87safeNormal(delta).map(v => st(x87mul(ld(v), ld(step))));
    const result = flyMove(pawn, move, target, near ? 8 : f32(4.1), 0, services);
    if (result === 5) { reached = 1; break; }              // 0x103c1367
    if (!result) break;
    const zone = services.regionZone(pawn);
    if (zone.water) {
      if ((rd(services, pawn, 'Flags318') & 0x4000) &&
          !(zone.pain && zone.damageType !== rd(services, pawn, 'ReducedDamageType'))) {
        if (typeof services.waterReach !== 'function')
          throw new Error('flyReach requires the original waterReach service');
        reachFlags = services.waterReach(pawn, point, radius, reachFlags, target);
        reached = reachFlags;
      }
      break;
    }
    if (--counter < 0) break;                              // 0x103c13df
  }
  if (!reached && target && services.isA(target, 'WarpZoneMarker') &&
      services.regionZone(pawn) === rd(services, target, 'WarpDestZone')) reached = 1;
  farMove(services, pawn, origLoc);
  const velocity = services.velocity(pawn);
  for (let i = 0; i < 3; i++) velocity[i] = origVel[i];
  return reached ? reachFlags : 0;
}

/**
 * walkReach worker 0x103c1b70.
 *   int walkReach(this=pawn; FVector point; float radius; int arg18; AActor* target)
 *
 * The ~100-iteration stepped walking/swimming reachability trace.  Each step
 * calls checkMove; on blockage the pawn +0x318 flag bits select flight or jump
 * helper, otherwise a smaller step is retried.  The tail applies the pain-zone
 * and water gates, then a WarpZoneMarker fallback, restores Location+Velocity
 * through FarMoveActor, and returns `reached ? arg18 : 0`.
 *
 * Flying (0x103c1190) uses flyReach above. Jump arc (0x103c2f50) and swimming
 * (0x103c15a0) remain services.altMove / services.waterReach boundaries.
 */
export function walkReach(pawn, point, radius, arg18, target, services) {
  const origLoc = services.location(pawn).map(f32);        // [ebp-0x58/-0x54/-0x50]
  const origVel = services.velocity(pawn).map(f32);        // [ebp-0x68/-0x64/-0x60]
  const radiusSq = st(x87mul(ld(radius), ld(radius)));     // [ebp-0x5c]
  let reached = 0;                                         // [ebp-0x14]
  arg18 = arg18 | 1;                                       // [ebp+0x18] |= 1
  const flags318 = rd(services, pawn, 'Flags318') >>> 0;   // esi+0x318
  const CR = rd(services, pawn, 'CollisionRadius');        // esi+0x1d4
  const CH = rd(services, pawn, 'CollisionHeight');        // esi+0x1d8
  const maxStep = rd(services, pawn, 'MaxStepHeight');     // esi+0x38c
  const rdt = rd(services, pawn, 'ReducedDamageType');     // esi+0x444

  // innerRadius [ebp-0x18]: GIsEditor!=0 -> 16.0; else bit 0x1000 set ->
  // max(CR,128) / clear -> CR.  innerRadiusSq [ebp-0x78] is captured once and
  // is NOT refreshed when the -1 path below clamps innerRadius to maxStep.
  let innerRadius = 16.0;
  if (!services.gIsEditor()) innerRadius = (flags318 & 0x1000) ? Math.max(CR, 128.0) : CR;
  const innerRadiusSq = st(x87mul(ld(innerRadius), ld(innerRadius)));

  // step [ebp-0x28] = max(pawnCH, targetCH); pawnCH when target==0.
  let step = CH;
  if (target) {
    const tCH = rd(services, target, 'CollisionHeight');
    if (ltU(ld(CH), ld(tCH))) step = tCH;                  // 0x103c1c4b
  }

  // Shared FCheckResult buffer [ebp-0xb0]: the native hands the same out ptr
  // to every checkMove MoveActor, so [ebp-0x94]=Normal.z is the last landing
  // slope.  The wrapper records each hit exactly as the shared buffer would.
  const hitbuf = { time: 1.0, normal: [0, 0, 0], actor: 0, item: -1 };
  const nav = {
    ...services,
    moveActor: (a, d, r, f) => {
      const h = services.moveActor(a, d, r, f);
      hitbuf.time = h.time; hitbuf.normal = h.normal;
      hitbuf.actor = h.actor; hitbuf.item = h.item;
      return h;
    },
  };

  let counter = 100;                                       // [ebp-0x34]
  let edi = 1;
  while (edi === 1) {                                      // 0x103c1cd2
    const loc = services.location(pawn);
    const dz = f32(point[2] - loc[2]);                     // [ebp+0x1c]
    const dy = f32(point[1] - loc[1]);                     // [ebp-0x20]
    const dx = f32(point[0] - loc[0]);                     // [ebp-0x24]
    let flat = [dx, dy, 0];
    const distSq = x87add(x87mul(ld(dx), ld(dx)), x87mul(ld(dy), ld(dy)));

    // Climb gate (0x103c1d36): dz>step && 0.8*(dz-step)^2 > distSq -> bail.
    if (gtU(ld(dz), ld(step))) {
      const ex = sub(ld(dz), ld(step));
      const climb = x87mul(x87mul(ex, ex), D08);
      if (!leU(climb, distSq)) { edi = 0; break; }         // 0x103c1d55
    }

    if (leU(distSq, ld(radiusSq))) {                       // 0x103c1d5c -> arrival
      edi = 0;
      // Arrival eval (0x103c1fc8): |dz| < step -> reached; else the landing
      // arc uses the last checkMove landing slope hitbuf.normal.z [ebp-0x94].
      const adz = ltU(ld(dz), D0) ? st(x87neg(ld(dz))) : dz;
      if (ltU(ld(adz), ld(step))) reached = 1;             // 0x103c20e7
      else {
        const nz = hitbuf.normal[2];
        if (ltU(ld(nz), D095) && gtU(ld(nz), D07)) {       // 0.7 < nz < 0.95
          if (ltU(ld(dz), D0)) {                           // dz<0: point below
            const sq = appSqrt(sub(x87div(D1, x87mul(ld(nz), ld(nz))), D1f));
            if (gtU(x87add(x87mul(ld(CR), sq), ld(CH)), ld(adz))) reached = 1;
          }
          if (!reached) {                                  // dz>=0 path + below-fail
            const tCR = target ? rd(services, target, 'CollisionRadius') : 46.0;
            if (ltU(ld(CR), ld(tCR))) {                    // pawnCR < tCR
              const sq = appSqrt(sub(x87div(D1, x87mul(ld(nz), ld(nz))), D1f));
              const allow = x87add(x87mul(sub(x87add(ld(tCR), D15), ld(CR)), sq), ld(step));
              if (gtU(allow, ld(dz))) reached = 1;
            }
          }
        }
      }
      break;                                               // edi=0 -> exit loop
    }

    // Step select (0x103c1d6a): distSq>=innerRadiusSq -> far step (unit flat *
    // innerRadius, scale 4.1); else near step (raw flat delta, scale 8.0).
    let delta, scale;
    if (ltU(distSq, ld(innerRadiusSq))) { delta = flat; scale = 8.0; }
    else {
      flat = x87safeNormal(flat);
      delta = [st(x87mul(ld(flat[0]), ld(innerRadius))),
               st(x87mul(ld(flat[1]), ld(innerRadius))),
               st(x87mul(ld(flat[2]), ld(innerRadius)))];
      scale = 4.1;
    }
    edi = checkMove(pawn, delta, target, scale, 0, nav);

    if (edi === 5) { reached = 1; edi = 0; }               // 0x103c1e13
    else if (edi !== 1) {                                  // 0 or -1: blocked
      const collide = rd(services, pawn, 'CollideFlag');   // esi+0xd0
      if (!collide) { reached = 0; edi = 0; }              // 0x103c1e2b
      else if (flags318 & 0x8000) {                        // bCanFly -> flyReach 0x103c1190
        const r = flyReach(pawn, point, radius, arg18, target, services);
        arg18 = r; reached = r; edi = 0;
      } else if (flags318 & 0x1000) {                      // bCanJump -> arc 0x103c2f50
        arg18 |= 8;
        if (edi === -1) {
          const u = x87safeNormal(flat);
          const gs = rd(services, pawn, 'GroundSpeed');    // esi+0x378
          const d = [st(x87mul(ld(gs), ld(u[0]))),
                     st(x87mul(ld(gs), ld(u[1]))),
                     st(x87mul(ld(gs), ld(u[2])))];
          edi = services.altMove(pawn, d, point, gs);
        }
      } else if (edi === -1) {                             // ledge, no jump/swim
        if (gtU(ld(innerRadius), ld(maxStep))) { innerRadius = maxStep; edi = 1; }
      }
    }

    // Gates (0x103c1f36): foot-zone pain, then region water/swim.
    const fz = services.footZone(pawn);                    // esi+0x330 zone
    if (fz.pain && fz.damageType !== rdt) { reached = 0; edi = 0; }
    const rz = services.regionZone(pawn);                  // esi+0xc8 zone
    if (rz.water) {
      edi = 0;
      if (flags318 & 0x4000 && !(rz.pain && rz.damageType !== rdt)) {
        const r = services.waterReach(pawn, point, radius, arg18, target);
        arg18 = r; reached = r;
      }
    }

    if (--counter < 0) edi = 0;                            // 0x103c20ee
  }

  // WarpZoneMarker fallback (0x103c2102): reached if the target is a warp and
  // the pawn already sits in its destination zone.
  if (!reached && target && services.isA(target, 'WarpZoneMarker')) {
    if (services.regionZone(pawn) === rd(services, target, 'WarpDestZone')) reached = 1;
  }
  // Restore Location + Velocity (0x103c2145-0x103c2192), return reached?arg18:0.
  farMove(services, pawn, origLoc);
  const vel = services.velocity(pawn);
  vel[0] = origVel[0]; vel[1] = origVel[1]; vel[2] = origVel[2];
  return reached ? arg18 : 0;
}

/**
 * Physics reach dispatcher 0x103c1000.
 *   int dispatch(this=pawn; FVector point; float radius; AActor* target)
 *
 * Routes by the pawn's region-zone water flag ([ecx+0xc8]+0x388 bit0) then the
 * Physics byte (+0x30):  water zone -> waterReach 0x103c15a0;  PHYS_Walking(1)
 * or PHYS_Swimming(3) -> walkReach 0x103c1b70;  PHYS_Flying(4) -> flyReach
 * 0x103c1190;  otherwise -> 0.  Every helper receives (pawn, point, radius, 0,
 * target). Walking and flying call their recovered bodies; waterReach remains
 * an explicit service boundary pending its own translation.
 */
export function physicsReach(pawn, point, radius, target, services) {
  if (services.regionZone(pawn).water)                      // 0x103c102d
    return services.waterReach(pawn, point, radius, 0, target);
  const phys = rd(services, pawn, 'Physics');               // ecx+0x30
  if (phys === 1 || phys === 3)                             // 0x103c1074/0x103c1078
    return walkReach(pawn, point, radius, 0, target, services);
  if (phys === 4)                                           // 0x103c107c
    return flyReach(pawn, point, radius, 0, target, services);
  return 0;                                                 // 0x103c10b8
}

/**
 * pointReachable worker 0x103c0d30.
 *   int pointWorker(this=pawn; FVector point; int arg14)
 *
 * Gates, then a physics-dispatch reach trace.  arg14 is 0 for the
 * pointReachable exec (FastLineCheck runs); a nonzero arg14 skips it.  The
 * worker returns the dispatcher result; Location/Velocity are restored inside
 * walkReach.
 *
 * Boundary seams: services.pointRegion(point)->zone, services.fastLineCheck
 * (model, end=point, start=eye) with model = services.model(services.level(pawn)),
 * services.farMoveActor(actor,dest,test,noCheck).
 */
export function pointWorker(pawn, point, arg14, services) {
  const loc = services.location(pawn);
  // GIsEditor==0 gate + 2D distance limit (0x103c0d65): dx^2+dy^2 <= 1e6, z
  // ignored.  fld m32/fsub m32 keep the deltas in 80-bit for the compare.
  if (!services.gIsEditor()) {
    const dy = sub(ld(point[1]), ld(loc[1])), dx = sub(ld(point[0]), ld(loc[0]));
    const d2 = x87add(x87mul(dx, dx), x87mul(dy, dy));
    if (gtU(d2, ld(1000000.0))) return 0;                 // 0x103c0d90
  }
  const destZone = services.pointRegion(point);           // 0x103c0d92 -> [ebp-0x30]
  const rz = services.regionZone(pawn);
  const flags318 = rd(services, pawn, 'Flags318') >>> 0;
  // Water gate (0x103c0dc4): pawn not in water && !canSwim && dest is water -> 0.
  if (!rz.water && !(flags318 & 0x4000) && destZone.water) return 0;
  const fz = services.footZone(pawn);
  const rdt = rd(services, pawn, 'ReducedDamageType');
  // Pain gate (0x103c0e02): foot not in pain && dest is pain && dt != rdt -> 0.
  if (!fz.pain && destZone.pain && destZone.damageType !== rdt) return 0;
  // FastLineCheck (0x103c0e2a): arg14==0 only — FastLineCheck(End=point,
  // Start=eye) where eye = loc.z + BaseEyeHeight (fadd m32, stored to f32).
  if (arg14 === 0) {
    const model = services.model(services.level(pawn));
    const eye = [loc[0], loc[1], st(x87add(ld(loc[2]), ld(rd(services, pawn, 'BaseEyeHeight'))))];
    if (!services.fastLineCheck(model, point, eye)) return 0;
  }
  // Test FarMoveActor to the point (0x103c0e8c), restore on success (0x103c0ecf).
  const origLoc = loc.map(f32);
  if (services.farMoveActor(pawn, point, 1, 0))
    services.farMoveActor(pawn, origLoc, 1, 1);
  // Physics dispatch (0x103c0f22): radius 15.0, target 0.
  return physicsReach(pawn, point, 15.0, 0, services);
}

/**
 * actorReachable worker 0x103c0630.
 *   int actorWorker(this=pawn; AActor* target; int argC)
 *
 * The actor-analog of pointWorker: zone/class gates, an optional SingleLineCheck
 * (argC==0), a collision-fit test FarMoveActor, then physicsReach.  The exec's
 * nav-graph fast path runs ahead of this; the worker is the single-hop fallback.
 *
 * Distance is the full 3D distSq [ebp-0x14].  Non-pawn targets are limited to
 * 800 units (distSq<=640000) outside the editor and checked against their
 * regionZone pain flag; pawn targets instead check footZone pain.  Both then
 * apply the shared regionZone water/canSwim gate, the argC LOS gate, and a
 * reach radius:
 *   pawn target  — R = max(CR*1.5, meleeRange) + targetCR + pawnCR;
 *                  distSq<=R^2 returns 1 immediately, else (dist>800 only)
 *                  R=max(R, sqrt(distSq)-800); physicsReach target=actor.
 *   other target — R = 15.0, or targetCR+pawnCR-2.0 for Inventory/Trigger;
 *                  physicsReach target = actor only when +0x1dc&4 or a
 *                  WarpZoneMarker, else 0.
 */
export function actorWorker(pawn, target, argC, services) {
  if (!target) return 0;                                    // 0x103c065f
  const ploc = services.location(pawn), tloc = services.location(target);
  const dx = sub(ld(tloc[0]), ld(ploc[0])),
        dy = sub(ld(tloc[1]), ld(ploc[1])),
        dz = sub(ld(tloc[2]), ld(ploc[2]));
  // [ebp-0x34/-0x30/-0x2c]: the f32-stored deltas, reused by the sqrt recompute.
  const dxf = st(dx), dyf = st(dy), dzf = st(dz);
  // [ebp-0x14] distSq: (dx^2+dy^2)+dz^2 in 80-bit, stored f32 and reloaded.
  const distSq = ld(st(x87add(
    x87add(x87mul(dx, dx), x87mul(dy, dy)), x87mul(dz, dz))));
  const rdt = rd(services, pawn, 'ReducedDamageType');      // pawn+0x444
  const f318 = rd(services, pawn, 'Flags318') >>> 0;
  const isPawn = services.isA(target, 'Pawn');              // target IsA APawn
  if (isPawn) {                                             // 0x103c0747
    const fz = services.footZone(target);                   // target+0x330
    if (fz.pain && fz.damageType !== rdt) return 0;         // foot pain, !resist
  } else if (!services.gIsEditor()) {                       // 0x103c06e0 [10599c94]
    if (gtU(distSq, ld64(640000.0))) return 0;              // dist>800 -> 0
    const rz = services.regionZone(target);                 // target+0xc8
    if (rz.pain && rz.damageType !== rdt) return 0;         // pain, !resist
  }
  const rz = services.regionZone(target);                   // 0x103c077b
  if (rz.water && !(f318 & 0x4000)) return 0;               // water, !canSwim
  if (argC === 0) {                                         // 0x103c07aa LOS gate
    const eye = [ploc[0], ploc[1],
      st(x87add(ld(ploc[2]), ld(rd(services, pawn, 'BaseEyeHeight'))))];
    const hit = services.singleLineCheck(pawn, tloc, eye, 6, [0, 0, 0], 0);
    if (!eqU(ld(hit.time), D1) && hit.actor !== target) return 0; // blocked, !target
  }
  const pCR = rd(services, pawn, 'CollisionRadius');
  const origLoc = ploc.map(f32);
  if (isPawn) {                                             // 0x103c08a3
    const tCR = rd(services, target, 'CollisionRadius');
    const melee = rd(services, pawn, 'MeleeRange');         // pawn+0x374
    const scaled = x87mul(ld(pCR), ld(1.5));                // CR*1.5
    // fcom+test ah,0x41 keeps st0 when scaled<=melee, else reloads melee: a MIN.
    let R = leU(scaled, ld(melee)) ? scaled : ld(melee);    // min(scaled, melee)
    R = x87add(x87add(R, ld(tCR)), ld(pCR));                // + tCR + pCR
    const Rf = ld(st(R));                                   // f32 store [ebp+0xc]
    const Rsq = x87mul(R, Rf);                              // R * f32(R)
    if (leU(distSq, Rsq)) return 1;                         // distSq<=R^2 -> 1
    if (gtU(distSq, ld64(640000.0))) {                      // dist>800: widen
      // Recompute dzf^2+dyf^2+dxf^2 from the f32 stores, then appSqrt - 800.
      const sq = x87add(x87add(x87mul(ld(dzf), ld(dzf)), x87mul(ld(dyf), ld(dyf))),
                        x87mul(ld(dxf), ld(dxf)));
      const widened = sub(appSqrt(sq), ld(800.0));          // sqrt(dsq)-800
      // fcom dword[ebp+0xc]: widened vs the f32-stored R; keep the larger.
      if (geU(widened, Rf)) R = widened;                    // R = max(R, widened)
    }
    if (services.farMoveActor(pawn, tloc.map(f32), 1, 0))   // fit test
      services.farMoveActor(pawn, origLoc, 1, 1);
    return physicsReach(pawn, tloc.map(f32), st(R), target, services);
  }
  let R = 15.0;                                             // 0x103c0a26
  if (services.isA(target, 'Inventory') || services.isA(target, 'Trigger'))
    R = st(sub(x87add(ld(rd(services, target, 'CollisionRadius')), ld(pCR)), ld(2.0)));
  if (services.farMoveActor(pawn, tloc.map(f32), 1, 0))
    services.farMoveActor(pawn, origLoc, 1, 1);
  const f1dc = rd(services, target, 'Flags1dc') >>> 0;      // target+0x1dc
  const arg4 = (f1dc & 4) || services.isA(target, 'WarpZoneMarker') ? target : 0;
  return physicsReach(pawn, tloc.map(f32), R, arg4, services);
}

/**
 * actorReachable exec 0x103bc1a0 (native 520).
 *   void actorReachable(this=pawn; FFrame; result*)
 *
 * The native evaluates one actor arg through GNatives[opcode] (null -> result
 * 0) and writes the verdict to the result out-pointer; here the already
 * evaluated `target` is the parameter and the int is the return.  The
 * [0x10599dac]/Level+0x1128 rdtsc block is a native-call timer, not behavior.
 *
 * Path: an Inventory target with a holder (+0x398) is redirected for the
 * NavigationPoint fast path only (restored before the worker call).  A
 * NavigationPoint target first tries the pawn's Anchor (+0x34c) then walks the
 * level's nav list (level+0x90 gate, actors[0].NavigationPointList +0x548,
 * +0x42c links) for a point within (|dz|<CH and dx^2+dy^2<max(CR,48)^2) that
 * equals the target or satisfies directReach -> 1.  A nearby candidate that
 * nothing reaches returns 0 unless the pawn is PHYS_Flying (4).  Everything
 * else falls through to actorWorker(pawn, target, 0).
 */
export function actorReachable(pawn, target, services) {
  if (!target) return 0;                                    // 0x103bc1dc
  let t = target, origInv = 0;                              // [ebp-4] / [ebp-0xc]
  // Inventory redirect (chain 0x10576f70): use the +0x398 holder if present.
  if (services.isA(t, 'Inventory')) {
    const holder = rd(services, t, 'Field398');             // target+0x398
    if (holder) { origInv = t; t = holder; }                // 0x103bc245
  }
  // NavigationPoint fast path (chain 0x1057a128).
  if (services.isA(t, 'NavPoint')) {
    const head = services.navListHead(pawn);                // level+0x90 head
    const CR = rd(services, pawn, 'CollisionRadius');       // pawn+0x1d4
    // level+0x90!=0 gate and pawn CR<=115.0 (0x10431434).
    if (head && leU(ld(CR), ld(115.0))) {
      const radius = geU(ld(CR), ld(48.0)) ? ld(CR) : ld(48.0); // max(CR,48)
      const radiusSq = x87mul(radius, radius);              // [ebp-8]
      const ploc = services.location(pawn);
      const CH = ld(rd(services, pawn, 'CollisionHeight')); // pawn+0x1d8
      // |nav.z-pawn.z|<CH (0.0 abs via fchs) and horizontal dx^2+dy^2<radius^2.
      const within = nav => {
        const nl = services.location(nav);
        const dz = sub(ld(nl[2]), ld(ploc[2]));
        if (geU(ltU(dz, D0) ? x87neg(dz) : dz, CH)) return false;
        const dx = sub(ld(nl[0]), ld(ploc[0])),
              dy = sub(ld(nl[1]), ld(ploc[1]));
        return ltU(x87add(x87mul(dx, dx), x87mul(dy, dy)), radiusSq);
      };
      let found = 0;                                        // [ebp+8]
      const anchor = rd(services, pawn, 'Anchor');          // pawn+0x34c
      if (anchor && services.isA(anchor, 'NavPoint') && within(anchor)) {
        found = 1;                                          // 0x103bc35b
        if (anchor === t || directReach(pawn, anchor, t, services)) return 1;
      }
      for (let nav = head; nav; nav = services.nextNav(nav)) {
        if (!within(nav)) continue;
        found = 1;                                          // 0x103bc4aa
        if (nav === t || directReach(pawn, nav, t, services)) return 1;
      }
      // Nearby candidate(s) but nothing reached: 0 unless PHYS_Flying.
      if (found && rd(services, pawn, 'Physics') !== 4) return 0; // 0x103bc4d6
    }
  }
  if (origInv) t = origInv;                                 // 0x103bc583 undo
  return actorWorker(pawn, t, 0, services);                 // 0x103024be
}
