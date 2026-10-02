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
import { fcoordsAxes } from './script-pawn-locomotion.mjs';
import { findWaterLine } from './swimming.mjs';
import { twoWallAdjust } from './steps.mjs';

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
    aiDirectionReachable:    Object.freeze({ index: 708, thunk: 0x103022cf, body: 0x103c8560, worker: 0x103c78a0 }),
    // 709's exec thunk; 0x1030181b is the worker's (APawn::AIPickRandomDestination).
    aiPickRandomDestination: Object.freeze({ index: 709, thunk: 0x103029b9, body: 0x103c86f0, worker: 0x103c7fc0 }),
  }),
  // Shared workers beneath the exec bodies.
  workers: Object.freeze({
    checkMove:   0x103c3290,  // thiscall(pawn; delta vec3, hit*, target, scale, flag) -> 5/1/0/-1
    walkReach:   0x103c1b70,  // ~100-step walking/swimming reach trace
    waterReach:  0x103c15a0,  // APawn::swimReachable (thunk 0x10301406)
    flyReach:    0x103c1190,
    flyMove:     0x103c3900,
    dispatch:    0x103c1000,  // physics reach dispatcher (thunk 0x1030353f)
    jumpArc:     0x103c2f50,  // APawn::FindBestJump (thunk 0x10303422)
    findBestJump:        0x103c2f50,  // FindBestJump(Dest, vel, &Landing, moveActor)
    suggestJumpVelocity: 0x103c2c80,  // thunk 0x103035a8
    jumpLanding:         0x103c2530,  // thunk 0x103016ae
    reachMask:   0x10326d10,  // 7-bit capability gather (thiscall)
    directReach: 0x103dad20,  // NavigationPoint ReachSpec scan
    aiDirection: 0x1036d030,  // biased random rotator (thunk 0x10301f0f)
    aiPickSearch:0x103c78a0,  // stepped-move band search (thunk 0x103011d6)
    aiScore:     0x103c7f80,  // f32 range classifier (thunk 0x10303319)
    waterMove:   0x103c3ca0,  // APawn::swimMove (thunk 0x10303f53)
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
    flags318: 0x318, groundSpeed: 0x378, jumpZ: 0x388, maxStepHeight: 0x38c, baseEyeHeight: 0x3f4,
    reducedDamageType: 0x444,
  }),
  flagBits: Object.freeze({
    bCanJump: 0x00001000,     // pawn +0x318 bit 12 -> FindBestJump 0x103c2f50
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
    reachStep:   Object.freeze({ address: 0x10431444, value: 200 }),     // float (fly/swim reach)
    swimWalkMargin: Object.freeze({ address: 0x104314b4, value: 50 }),   // float (swimReachable)
    // Jumping (FindBestJump / SuggestJumpVelocity / jumpLanding).
    jumpTick:     Object.freeze({ address: 0, value: 0.10000000149011612 }), // 0x3dcccccd immediate
    jumpMaxSpeedSq: Object.freeze({ address: 0x1042adb4, value: 2500000 }), // float
    jumpMaxTicks: Object.freeze({ address: 0, value: 35 }),                // immediate
    jumpStep:     Object.freeze({ address: 0x10426d58, value: 0.05 }),     // double
    jumpNoGravity:Object.freeze({ address: 0, value: -100 }),              // 0xc2c80000 immediate
    jumpMaxDrop:  Object.freeze({ address: 0x104314cc, value: 350 }),      // float
    jumpMinGain:  Object.freeze({ address: 0x104314c0, value: 8 }),        // double
    // AIPickRandomDestination constants (709 chain).
    yawPosScale:  Object.freeze({ address: 0x1042ae00, value: 32767 }),    // float
    yawNegScale:  Object.freeze({ address: 0x1042ae04, value: -32768 }),   // float
    pitchPosScale:Object.freeze({ address: 0x1042adf8, value: 16383 }),    // float
    pitchNegScale:Object.freeze({ address: 0x1042adfc, value: -16384 }),   // float
    oneFloat:     Object.freeze({ address: 0x10429c50, value: 1 }),        // float
    multFloor:    Object.freeze({ address: 0x1042d544, value: 9.999999747378752e-05 }), // float 0x38d1b717
    stepMin:      Object.freeze({ address: 0x1042eae4, value: 5 }),        // float
    stepMax:      Object.freeze({ address: 0x104316a0, value: 25 }),       // float
    searchRadius: Object.freeze({ address: 0, value: 15 }),                // arg24 (unused by 0x103c78a0)
    half:         Object.freeze({ address: 0x1042ac10, value: 0.5 }),      // double
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
const D095 = ld64(0.95), D1f = ld(1.0), D15 = ld(15.0), D05 = ld64(0.5);
const f32buf = new Float32Array(1), u32buf = new Uint32Array(f32buf.buffer);
const ldBits = u => { u32buf[0] = u >>> 0; return ld(f32buf[0]); };

/** FCOM/FUCOM status flags: C0 below, C3 equal, both when unordered. */
const x87compare = (a, b) => {
  if (a.nan !== undefined || b.nan !== undefined) return { c0: 1, c3: 1 };
  if (a.inf || b.inf) {
    if (a.inf && b.inf) return { c0: 0, c3: a.neg === b.neg ? 1 : 0 };
    return a.inf ? { c0: a.neg ? 1 : 0, c3: 0 } : { c0: b.neg ? 0 : 1, c3: 0 };
  }
  let m;
  // A zero significand is ±0 whatever its exponent field (x87add/x87mul leave
  // arithmetic zeros at exp 0), so it must not enter the magnitude compare.
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
 * Scans `source`'s two outbound NavigationPoint ReachSpec index arrays
 * (Paths +0x360 then PrunedPaths +0x3a0, 16 slots, -1 terminated) for a spec
 * whose `end` (+0x08) is `target` and that admits the pawn's
 * dimensions/capabilities.  A qualifying spec is confirmed by
 * SingleLineCheck(source.loc -> target.loc, flags=6, zero extent): a clear
 * trace, or a non-Mover hit, or a Mover the pawn can open, returns 1.
 * Only a Mover the pawn cannot open makes it advance to the next index.
 *
 * ReachSpec record (level +0x8c, 28-byte stride): +0x00 distance,
 * +0x04 start, +0x08 end, +0x0c collisionRadius(int), +0x10
 * collisionHeight(int), +0x14 reachFlags, +0x18 pruned.
 */
export function directReach(pawn, source, target, services) {
  const table = services.reachSpecTable(pawn);              // pawn->level +0x8c
  const cri = x87ftol(ld(rd(services, pawn, 'CollisionRadius')));  // __ftol
  const chi = x87ftol(ld(rd(services, pawn, 'CollisionHeight')));
  const f318 = rd(services, pawn, 'Flags318') >>> 0;
  const mask = reachMask(pawn, services);
  const end = services.location(target), start = services.location(source);
  for (const arr of [services.paths(source), services.prunedPaths(source)]) {
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

/** ULevel::MoveActor's early return (0x1039915a..0x103991c6): every |Delta|
 * component below the double 1e-4 (unordered counts as below) with an
 * unchanged rotation returns before `Hit = FCheckResult(1)`, so the caller's
 * Hit keeps its contents (docs/swimming.md). swimMove/swimReachable always
 * pass the pawn's own Rotation, so only Delta decides. */
const D1em4 = ld64(0.0001);
const nearlyZero = delta => delta.every(c => {
  const v = ld(c);
  return ltU(ltU(v, D0) ? x87neg(v) : v, D1em4);
});
/** findWaterLine's world view over the nav services: PointRegion's water bit
 * at a midpoint and the pawn's current Region.Zone water bit. */
const waterView = (pawn, services) => ({
  waterAt: point => services.pointRegion(point).water,
  get regionWater() { return services.regionZone(pawn).water; },
});

/**
 * APawn::swimMove 0x103c3ca0 (swimMove(Delta, GoalActor, threshold, bAdjust)).
 * flyMove's body with a dry branch after the first move: out of the water,
 * pull back to the water line (findWaterLine 0x103d3b10) and return 0.
 * Returns 5 (GoalActor hit), 1 (moved at least threshold) or 0.
 * Contract and evidence: docs/script-pawn-nav.md "Swimming contract".
 */
export function swimMove(pawn, delta, target, scale, restoreOnFailure, services) {
  const start = services.location(pawn).map(f32);          // [ebp-0x30..-0x28]
  // Up = -1 * ((0,0,-1)*MaxStepHeight): (-0, -0, f32(M)) as in flyMove.
  const up = [-0, -0, st(x87mul(x87mul(ld(rd(services, pawn, 'MaxStepHeight')), ld(-1)), ld(-1)))];
  // One FCheckResult Hit(1.f) shared by every MoveActor ([ebp-0x68]).
  let hit = { time: 1, normal: [0, 0, 0], actor: 0, item: -1 };
  const move = d => {
    const h = moveActor(services, pawn, d, rd(services, pawn, 'Rotation'));
    if (!nearlyZero(d)) hit = h;
  };
  move(delta);                                              // 0x103c3d9a
  if (target && hit.actor === target) return 5;             // 0x103c3dac
  if (!services.regionZone(pawn).water) {                   // 0x103c3dca
    const location = services.location(pawn).map(f32);
    const end = findWaterLine(waterView(pawn, services), start, location);  // 0x103c3e0c
    // `fcomp; test ah,0x40` per component: equal or unordered is the same.
    if (!end.every((v, i) => eqU(ld(v), ld(location[i]))))
      move(end.map((v, i) => st(sub(ld(v), ld(location[i])))));           // 0x103c3e91
    return 0;                                           // 0x103c3e97 dry
  }
  if (ltU(ld(hit.time), D1)) {                              // 0x103c3eaf
    const remaining = st(sub(D1, ld(hit.time)));
    const retry = delta.map(c => st(x87mul(ld(c), ld(remaining))));  // 0x103c3ed8
    move(up);                                               // 0x103c3f2f
    move(retry);                                            // 0x103c3f75
    if (target && hit.actor === target) return 5;           // 0x103c3f87
  }
  const d = services.location(pawn).map((v, i) => sub(ld(v), ld(start[i])));
  const movedSq = x87add(x87add(x87mul(d[0], d[0]), x87mul(d[1], d[1])), x87mul(d[2], d[2]));
  if (leU(x87mul(ld(scale), ld(scale)), movedSq)) return 1; // 0x103c3fd8
  if (restoreOnFailure) farMove(services, pawn, start);     // 0x103c400d
  return 0;
}

/**
 * APawn::swimReachable 0x103c15a0 (swimReachable(Dest, intRadius,
 * reachFlags, GoalActor)). flyReachable's loop over swimMove; leaving the
 * water hands over to flyReachable (bCanFly) or, for bCanWalk with Dest.Z
 * below (MaxStepHeight + Location.Z) + 50, a step-up MoveActor and then
 * flyReachable with reachFlags forced to 1. Returns success ? reachFlags : 0.
 * Contract and evidence: docs/script-pawn-nav.md "Swimming contract".
 */
export function swimReach(pawn, point, radius, reachFlags, target, services) {
  reachFlags |= 4;
  const closeSq = st(x87mul(ld(radius), ld(radius)));       // [ebp-0x6c]
  const origLoc = services.location(pawn).map(f32);         // [ebp-0x78..-0x70]
  const origVel = services.velocity(pawn).map(f32);         // [ebp-0x5c..-0x54]
  const CR = rd(services, pawn, 'CollisionRadius');
  const stepsize = ltU(ld(200), ld(CR)) ? CR : 200;         // 0x103c162e
  const stepSq = st(x87mul(ld(stepsize), ld(stepsize)));    // [ebp-0x34]
  let success = 0, stillmoving = 1, ticks = 100;
  while (stillmoving) {                                     // 0x103c1664
    const loc = services.location(pawn);
    const d = point.map((v, i) => sub(ld(v), ld(loc[i])));
    const direction = d.map(st);
    const distSq = x87add(x87add(x87mul(d[0], d[0]), x87mul(d[1], d[1])), x87mul(d[2], d[2]));
    const storedDistSq = st(distSq);                        // [ebp-0x1c]
    const absZ = ltU(d[2], D0) ? x87neg(d[2]) : d[2];
    if (leU(distSq, ld(closeSq)) && leU(absZ, ld(rd(services, pawn, 'CollisionHeight')))) {
      success = 1; stillmoving = 0;                         // 0x103c16e3
    } else {
      const near = ltU(ld(storedDistSq), ld(stepSq));       // 0x103c16fc
      const move = near ? direction : x87safeNormal(direction).map(v => st(x87mul(ld(v), ld(stepsize))));
      stillmoving = swimMove(pawn, move, target, near ? 8 : f32(4.1), 0, services);  // 0x103c177a
      if (stillmoving === 5) { success = 1; stillmoving = 0; }
      const zone = services.regionZone(pawn);               // 0x103c1790
      if (!zone.water) {
        stillmoving = 0;
        const flags = rd(services, pawn, 'Flags318') >>> 0;
        if (flags & 0x8000) {                               // bCanFly
          success = reachFlags = flyReach(pawn, point, radius, reachFlags, target, services);
        } else if (flags & 0x2000) {                        // bCanWalk
          const at = services.location(pawn);
          const maxStep = rd(services, pawn, 'MaxStepHeight');
          const top = x87add(x87add(ld(maxStep), ld(at[2])), ld(50));
          if (gtU(top, ld(point[2]))) {                     // 0x103c1805
            const rise = x87add(ld(rd(services, pawn, 'CollisionHeight')), ld(maxStep));
            const dz = st(sub(ld(point[2]), ld(at[2])));    // [ebp-0x2c]
            const delta = [0, 0, ltU(rise, ld(dz)) ? dz : st(rise)];
            let hitTime = 1;                                // fresh FCheckResult(1)
            const h = moveActor(services, pawn, delta, rd(services, pawn, 'Rotation'));
            if (!nearlyZero(delta)) hitTime = h.time;
            if (eqU(ld(hitTime), D1)) {                     // 0x103c18fc
              success = flyReach(pawn, point, radius, reachFlags, target, services);
              reachFlags = 1;                                    // 0x103c192c
            }
          }
        }
      } else if (zone.pain && zone.damageType !== rd(services, pawn, 'ReducedDamageType')) {
        stillmoving = 0; success = 0;                       // 0x103c194c
      }
    }
    if (--ticks < 0) stillmoving = 0;                       // 0x103c195b
  }
  if (!success && target && services.isA(target, 'WarpZoneMarker'))
    success = services.regionZone(pawn) === rd(services, target, 'WarpDestZone') ? 1 : 0;
  farMove(services, pawn, origLoc);                         // 0x103c19d2
  const velocity = services.velocity(pawn);
  for (let i = 0; i < 3; i++) velocity[i] = origVel[i];
  return success ? reachFlags : 0;
}

/**
 * APawn::flyReachable 0x103c1190. Original 3D reach loop; called by the
 * PHYS_Flying dispatcher, the bCanFly fallback inside walkReach and
 * swimReachable's exits from the water.
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
        reachFlags = swimReach(pawn, point, radius, reachFlags, target, services);  // 0x103c13cd
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

// ---------------------------------------------------------------------------
// Jumping: APawn::SuggestJumpVelocity 0x103c2c80, APawn::jumpLanding 0x103c2530
// and APawn::FindBestJump 0x103c2f50 (docs/script-pawn-nav.md "Jumping
// contract"). walkReachable calls FindBestJump for a bCanJump pawn whose
// checkMove returned -1.
// ---------------------------------------------------------------------------

const D005 = ld64(0.05), D8 = ld64(8);
const JUMP_TICK = f32(0.1);                                   // 0x3dcccccd
/** The original flight-time loop has no bound; a gravity whose 0.05 step no
 * longer changes the stored Vel.Z would hang it. Stop explicitly instead. */
const SUGGEST_JUMP_STEP_LIMIT = 100000;
const FBJ_FORMAT = 'FAILING FBJ: nc %f from odS %f and dS %f and dz %f success %d';

/** Region.Zone's ZoneGravity (+0x31c) and, for jumpLanding, ZoneVelocity
 * (+0x328) and ZoneFluidFriction (+0x338), required rather than defaulted. */
function jumpZone(services, pawn, reader, gravityOnly = false) {
  const zone = services.regionZone(pawn);
  if (!Array.isArray(zone?.gravity) || (!gravityOnly && (!Array.isArray(zone?.velocity) ||
      typeof zone?.fluidFriction !== 'number')))
    throw new Error(`${reader} requires the Region zone's ZoneGravity${gravityOnly ? '' : ', ZoneVelocity and ZoneFluidFriction'}`);
  return zone;
}

/** A double-rounded x87 value as the binary64 number it stores. */
const x87number = v => {
  if (v.nan !== undefined) return NaN;
  if (v.inf) return v.neg ? -Infinity : Infinity;
  const x = Number(v.sig) * 2 ** v.exp;
  return v.neg ? -x : x;
};

/**
 * APawn::SuggestJumpVelocity 0x103c2c80 (SuggestJumpVelocity(Dest, FVector&
 * Vel)). Vel.Z is the launch speed: step the arc in 0.05 s until it falls
 * back through Dest.Z, correct the overshoot, then aim Vel's XY at Dest at
 * min(XY / flightTime, GroundSpeed) and restore Vel.Z. Mutates `vel`.
 */
export function suggestJumpVelocity(pawn, dest, vel, services) {
  let gravityZ = f32(jumpZone(services, pawn, 'SuggestJumpVelocity', true).gravity[2]);  // zone+0x324
  if (!ltU(ld(gravityZ), ld(0))) gravityZ = -100;          // 0x103c2cc6 (0xc2c80000)
  const loc = services.location(pawn);
  const deltaZ = st(sub(ld(dest[2]), ld(loc[2])));          // [ebp-0x14]
  const jumpZ = vel[2];                                     // [ebp-0x1c], raw bits
  let flightTime = 0;                                       // [ebp+0x14]
  let currentZ = ld(0);                                     // st0, never stored
  let steps = 0;
  while (gtU(currentZ, ld(deltaZ)) || gtU(ld(vel[2]), D0)) {  // 0x103c2cef / 0x103c2cfd
    if (++steps > SUGGEST_JUMP_STEP_LIMIT)
      throw new Error(`SuggestJumpVelocity flight-time loop passed ${SUGGEST_JUMP_STEP_LIMIT} steps (unbounded in the original)`);
    const vz = x87add(x87mul(ld(gravityZ), D005), ld(vel[2]));  // 0x103c2e8d
    vel[2] = st(vz);
    flightTime = st(x87add(ld(flightTime), D005));
    currentZ = x87add(x87mul(vz, D005), currentZ);          // the unstored sum
  }
  const vz = ld(vel[2]);
  if (gtU(ltU(vz, ld(0)) ? x87neg(vz) : vz, D1))            // 0x103c2d23: |Vel.Z| > 1
    flightTime = st(sub(ld(flightTime), x87div(sub(currentZ, ld(deltaZ)), vz)));
  for (let i = 0; i < 3; i++) vel[i] = st(sub(ld(dest[i]), ld(loc[i])));  // 0x103c2d40
  vel[2] = 0;                                               // 0x103c2d80
  let speed;
  if (gtU(ld(flightTime), D0)) {                            // 0x103c2d71
    const xy = appSqrt(x87add(x87mul(ld(vel[1]), ld(vel[1])), x87mul(ld(vel[0]), ld(vel[0]))));
    if (gtU(xy, ld(0))) {                                   // 0x103c2dad
      const inv = x87div(D1, xy);                           // held extended
      for (let i = 0; i < 3; i++) vel[i] = st(x87mul(inv, ld(vel[i])));
    }
    const ratio = x87div(xy, ld(flightTime));               // 0x103c2df0
    const groundSpeed = ld(rd(services, pawn, 'GroundSpeed'));  // +0x378
    speed = gtU(groundSpeed, ratio) ? ratio : groundSpeed;  // 0x103c2dfc
  } else {
    const n = x87safeNormal(vel);                           // 0x103c2e12
    for (let i = 0; i < 3; i++) vel[i] = n[i];
    speed = ld(rd(services, pawn, 'GroundSpeed'));
  }
  for (let i = 0; i < 3; i++) vel[i] = st(x87mul(speed, ld(vel[i])));  // 0x103c2e30
  vel[2] = jumpZ;                                           // 0x103c2e48
}

/**
 * execEAdjustJump 0x103bc110 — native(523) `vector EAdjustJump()`.
 * v = Velocity (+0x144); SuggestJumpVelocity(Destination +0x354, &v)
 * (0x103bc14e); P_FINISH; *Result = v.  Velocity itself is untouched: the
 * script assigns the result (ScriptedPawn FallingState.AdjustJump).
 */
export function execEAdjustJump(pawn, services) {
  const v = services.velocity(pawn).map(f32);
  suggestJumpVelocity(pawn, rd(services, pawn, 'Destination').map(f32), v, services);
  return v;
}

/**
 * APawn::jumpLanding 0x103c2530 (jumpLanding(testvel, FVector& Landing,
 * moveActor)). Up to 36 test-moved 0.1 s ticks of zone gravity, fluid
 * friction and zone velocity until a floor (Normal.Z > 0.7) or water; a
 * wall slides once and a second wall runs TwoWallAdjust. Leaving the world
 * (ZoneNumber 0), a 36th tick or speed² > 2500000 returns to the start.
 * Writes Landing = Location; moveActor 0 restores the start afterwards.
 */
export function jumpLanding(pawn, testvel, landing, moveActorFlag, services) {
  const origin = services.location(pawn).map(f32);         // [ebp-0x58..-0x50]
  const t = ld(JUMP_TICK);                                  // [ebp-0x1c]
  let v = testvel.map(f32), landed = 0, ticks = 0;
  while (!landed) {                                         // 0x103c257f
    const zone = jumpZone(services, pawn, 'jumpLanding');  // [esi+0xc8], read once
    const g = zone.gravity.map(f32), zv = zone.velocity.map(f32);
    const tgz = x87mul(t, ld(g[2]));                        // kept on the stack
    const tgy = st(x87mul(t, ld(g[1]))), tgx = st(x87mul(t, ld(g[0])));
    const k = sub(D1f, x87mul(t, ld(f32(zone.fluidFriction))));  // 1.0f - t*friction
    const vzk = st(x87mul(ld(v[2]), k)), vyk = st(x87mul(ld(v[1]), k)), vxk = st(x87mul(ld(v[0]), k));
    v = [st(x87add(ld(vxk), ld(tgx))), st(x87add(ld(vyk), ld(tgy))), st(x87add(ld(vzk), tgz))];
    const adjusted = [                                      // [ebp-0x34..-0x2c]
      st(x87mul(ld(st(x87add(ld(v[0]), ld(zv[0])))), t)),
      st(x87mul(ld(st(x87add(ld(v[1]), ld(zv[1])))), t)),
      st(x87mul(x87add(ld(v[2]), ld(zv[2])), t))];         // Z's sum unstored
    // FCheckResult Hit(1.f), shared by the three moves; MoveActor's
    // nearly-zero early return leaves it unwritten (as in swimMove).
    let hit = { time: 1, normal: [0, 0, 0], actor: 0, item: -1 };
    const move = delta => {
      const result = moveActor(services, pawn, delta, rd(services, pawn, 'Rotation'));
      if (!nearlyZero(delta)) hit = result;
    };
    move(adjusted);                                         // 0x103c26e4
    if (services.regionZone(pawn).water) landed = 1;        // 0x103c26f0
    else if (ltU(ld(hit.time), D1)) {                       // 0x103c2700
      if (gtU(ld(hit.normal[2]), D07)) landed = 1;          // 0x103c2714
      else {
        const [ax, ay, az] = adjusted.map(ld);
        const n = hit.normal.map(f32), oldNormal = n;       // [ebp-0xa0]
        const dot = x87add(x87add(x87mul(ld(n[1]), ay), x87mul(ld(n[0]), ax)), x87mul(az, ld(n[2])));
        const zS = st(sub(az, ld(st(x87mul(dot, ld(n[2]))))));
        const yS = st(sub(ay, ld(st(x87mul(ld(n[1]), dot)))));
        const xE = sub(ax, x87mul(dot, ld(n[0])));          // unstored
        const rem = sub(D1, ld(hit.time));
        const dz = st(x87mul(ld(zS), rem)), dy = st(x87mul(ld(yS), rem));
        const dxE = x87mul(xE, rem);
        let delta = [st(dxE), dy, dz];                      // [ebp-0x4c..-0x44]
        const along = x87add(x87add(x87mul(az, ld(dz)), x87mul(ay, ld(dy))), x87mul(dxE, ax));
        if (!ltU(along, ld(0))) {                           // 0x103c27c3
          move(delta);                                      // 0x103c281f
          if (ltU(ld(hit.time), D1)) {                      // 0x103c2828
            if (gtU(ld(hit.normal[2]), D07)) landed = 1;    // 0x103c283c
            delta = twoWallAdjust({ desired: x87safeNormal(adjusted), delta,
              normal: hit.normal, oldNormal, time: hit.time });  // 0x103c287c
            move(delta);                                    // 0x103c28c4
            if (gtU(ld(hit.normal[2]), D07)) landed = 1;    // 0x103c28cd
          }
        }
      }
    }
    ticks++;                                                // 0x103c28e1
    const speedSq = x87add(x87add(x87mul(ld(v[0]), ld(v[0])), x87mul(ld(v[1]), ld(v[1]))),
      x87mul(ld(v[2]), ld(v[2])));
    if (!(rd(services, pawn, 'CollideFlag') & 0xff) || ticks > 35 || gtU(speedSq, ld(2500000))) {
      farMove(services, pawn, origin);                      // 0x103c2945
      landed = 1;
    }
  }
  const at = services.location(pawn).map(f32);              // 0x103c2957
  for (let i = 0; i < 3; i++) landing[i] = at[i];
  if (!moveActorFlag) farMove(services, pawn, origin);      // 0x103c299e
}

/**
 * APawn::FindBestJump 0x103c2f50 (FindBestJump(Dest, vel, FVector& Landing,
 * moveActor)). Launch at JumpZ toward Dest, land through jumpLanding (the
 * pawn stays there), and succeed when the jump gained more than 8 units of
 * 3D distance to Dest without dropping 350 or more, landing in a mismatched
 * pain zone, or in water without bCanSwim. Returns 0/1.
 */
export function findBestJump(pawn, dest, vel, landing, moveActorFlag, services) {
  const real = services.location(pawn).map(f32);            // [ebp-0x40..-0x38]
  const v = [f32(vel[0]), f32(vel[1]), f32(rd(services, pawn, 'JumpZ'))];  // vel.Z = +0x388
  suggestJumpVelocity(pawn, dest, v, services);            // 0x103c2fb8
  jumpLanding(pawn, v, landing, 1, services);              // 0x103c2fdb
  const at = services.location(pawn).map(f32);
  const old = [0, 1, 2].map(i => st(sub(ld(dest[i]), ld(real[i]))));
  const dist = [0, 1, 2].map(i => st(sub(ld(dest[i]), ld(at[i]))));
  const sizeSq = d => x87add(x87add(x87mul(ld(d[0]), ld(d[0])), x87mul(ld(d[1]), ld(d[1]))),
    x87mul(ld(d[2]), ld(d[2])));
  let success = 0;
  const foot = services.footZone(pawn);                    // +0x330
  if (foot.pain && foot.damageType !== rd(services, pawn, 'ReducedDamageType')) success = 0;
  else if (!(rd(services, pawn, 'Flags318') & 0x4000) && services.regionZone(pawn).water) success = 0;
  else {
    const oldSize = st(appSqrt(sizeSq(old)));               // [ebp+0x20]
    const netchange = st(sub(ld(oldSize), appSqrt(sizeSq(dist))));
    if (ltU(sub(ld(real[2]), ld(at[2])), ld(350)))          // 0x103c30ce
      success = gtU(ld(netchange), D8) ? 1 : 0;             // 0x103c30de
    else services.logf?.({ source: 'APawn::FindBestJump', format: FBJ_FORMAT,  // 0x103c3156
      args: [netchange, x87number(appSqrt(sizeSq(old))), st(appSqrt(sizeSq(dist))),
        x87number(x87storeDouble(sub(ld(at[2]), ld(real[2])))), 0] });
  }
  if (!moveActorFlag) farMove(services, pawn, real);        // 0x103c3189
  return success;
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
 * Flying (0x103c1190) uses flyReach, swimming (0x103c15a0) swimReach and
 * jumping (0x103c2f50) findBestJump above.
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
      } else if (flags318 & 0x1000) {                      // bCanJump -> FindBestJump 0x103c2f50
        arg18 |= 8;
        if (edi === -1) {
          const u = x87safeNormal(flat);
          const gs = rd(services, pawn, 'GroundSpeed');    // esi+0x378
          const d = [st(x87mul(ld(gs), ld(u[0]))),
                     st(x87mul(ld(gs), ld(u[1]))),
                     st(x87mul(ld(gs), ld(u[2])))];
          // Landing ([ebp-0xcc]) is never read; the jump's moves use their
          // own Hit, not the checkMove buffer behind hitbuf.
          edi = findBestJump(pawn, point, d, [0, 0, 0], 1, services);  // 0x103c1f0a
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
        const r = swimReach(pawn, point, radius, arg18, target, services);  // 0x103c1fb8
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
 * target). Every helper is its recovered body (swimReach for water).
 */
export function physicsReach(pawn, point, radius, target, services) {
  if (services.regionZone(pawn).water)                      // 0x103c102d
    return swimReach(pawn, point, radius, 0, target, services);  // 0x103c1059
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
      const anchor = rd(services, pawn, 'MoveTarget');      // pawn+0x34c Anchor
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

// ---------------------------------------------------------------------------
// AIPickRandomDestination — native 709 (exec 0x103c86f0, thunk 0x103029b9).
// The exec evaluates nine args into 4-byte slots (Dir arrives as two ints,
// not a rotator) and invokes worker 0x103c7fc0, which loops the random
// direction helper 0x1036d030 + band search 0x103c78a0 up to `tries` times.
// ---------------------------------------------------------------------------

/**
 * Range score 0x103c7f80 (cdecl; {min, x, max} f32 args).  `fcomp min`
 * C0 (below or unordered) -> -1; `fcomp max` strictly above -> +1; else 0.
 */
const aiScore = (minSq, x, maxSq) =>
  ltU(ld(x), ld(minSq)) ? -1 : gtU(ld(x), ld(maxSq)) ? 1 : 0;

/**
 * One appFrand draw of direction helper 0x1036d030.  `u = 2*frand-1` stays in
 * 80-bit; the |u| magnitude is remapped through d' = f32((clamp+1)/2):
 *   |u|<=d' (or unordered) -> m = |u|(1-d')/d'
 *   |u|> d'                -> m = (|u|-d')d'/(1-d') + (1-d')
 * The sign comes from the f32 *store* of u (C0 -> negative scale), then
 * m*scale truncates through MSVCRT _ftol (0x10413652) to the int offset.
 */
function aiDraw(frand, d, posScale, negScale) {
  const r = ld64(frand());                               // extended f64 draw
  const u = sub(x87add(r, r), D1f);                      // fadd st0,st0; fsub 1.0f
  const uf = st(u);                                      // fst dword [ebp-0x14]
  const a = x87compare(u, D0).c0 ? x87neg(u) : u;        // fcom 0; fchs -> |u|
  const oneMinusD = sub(D1, ld(d));                      // fsubr qword 1.0
  const m = leU(a, ld(d))                                // test ah,0x41 -> inner
    ? x87div(x87mul(a, oneMinusD), ld(d))
    : x87add(x87div(x87mul(sub(a, ld(d)), ld(d)), oneMinusD), oneMinusD);
  const scale = ltU(ld(uf), D0) ? negScale : posScale;   // fcomp 0 on f32(u)
  return x87ftol(x87mul(m, ld(scale)));
}

/**
 * Direction helper 0x1036d030 (thiscall pawn — unused; out rot*, centralYaw,
 * yawDist, centralPitch, pitchDist).  Distributions clamp to [0,1] (NaN -> 0),
 * fold to d' = f32((clamp+1)*0.5), then two draws offset the centers.
 * Returns [pitch, yaw, 0] int components — the caller's FRotator layout.
 */
export function aiDirection(frand, centralYaw, yawDist, centralPitch, pitchDist) {
  // 0x1036d04b/0x1036d088: fcomp 0 -> C0 -> 0; fcomp 1.0f -> C0 keep, else 1.0.
  const clamp01 = v => ltU(ld(v), D0) ? 0 : ltU(ld(v), D1f) ? f32(v) : 1.0;
  const dy = st(x87mul(x87add(ld(clamp01(yawDist)), D1), D05));   // [ebp+0x10]
  const dp = st(x87mul(x87add(ld(clamp01(pitchDist)), D1), D05)); // [ebp+0x18]
  const yawOff = aiDraw(frand, dy, 32767.0, -32768.0);            // 0x1036d0d8
  const pitchOff = aiDraw(frand, dp, 16383.0, -16384.0);          // 0x1036d14c
  return [(centralPitch + pitchOff) | 0, (centralYaw + yawOff) | 0, 0];
}

/**
 * Band search 0x103c78a0 (thiscall pawn; origin vec3, yaw, pitch, minR, maxR,
 * arg24, out vec3*).  Steps the pawn along dirVec = XAxis(FCoords{pitch,yaw,0})
 * with stride = clamp(CollisionRadius,5,25) through checkMove/flyMove/swimMove,
 * scoring distSq(loc-origin) against [minR²,maxR²] after each step.  The first
 * in-band position (or the band-crossing position) becomes the candidate; the
 * pawn is FarMoveActor-restored and its Velocity saved/restored on exit.
 * arg24 is pushed by callers but never read by the body.
 * Mode: regionZone water -> 3 (swimMove); Physics 1|3 -> 1 (walk);
 * 4 -> 2 (fly); anything else -> 0 early, before any restore/out write.
 */
export function aiPickSearch(pawn, origin, yaw, pitch, minR, maxR, arg24, out, services) {
  const minSq = st(x87mul(ld(minR), ld(minR)));           // [ebp-0x4c]
  const maxSq = st(x87mul(ld(maxR), ld(maxR)));           // [ebp-0x48]
  const startLoc = services.location(pawn).map(f32);      // [ebp-0x64..]
  const startVel = services.velocity(pawn).map(f32);      // [ebp-0x74..]
  let step = rd(services, pawn, 'CollisionRadius');       // [ebp-0x14]
  const best = [...startLoc];                             // [ebp-0x3c..]
  let haveBest = 0, cont = 1, iters = 0x64;               // -0x40, -0x18, -0x44
  if (services.gIsEditor?.())                             // [0x10599c94]
    throw new Error('aiPickSearch asserts !GIsEditor (0x103c7977)');
  // 0x103c798f: step<5|NaN -> 5; else step>25 (ordered) -> 25.
  if (ltU(ld(step), ld(5.0))) step = 5.0;
  else if (!leU(ld(step), ld(25.0))) step = 25.0;
  // prevScore [ebp+0x20] = score(minSq, f32(distSq0), maxSq).  The two native
  // sites associate differently: the initializer at 0x103c79bf computes
  // (dx²+dz²)+dy² while the in-loop site at 0x103c7cc3 computes (dx²+dy²)+dz².
  const dsqInit = (loc, org) => {
    const dz = sub(ld(loc[2]), ld(org[2])), dy = sub(ld(loc[1]), ld(org[1])),
          dx = sub(ld(loc[0]), ld(org[0]));
    return st(x87add(x87add(x87mul(dx, dx), x87mul(dz, dz)), x87mul(dy, dy)));
  };
  const dsqLoop = (loc, org) => {
    const dz = sub(ld(loc[2]), ld(org[2])), dy = sub(ld(loc[1]), ld(org[1])),
          dx = sub(ld(loc[0]), ld(org[0]));
    return st(x87add(x87add(x87mul(dx, dx), x87mul(dy, dy)), x87mul(dz, dz)));
  };
  let prevScore = aiScore(minSq, dsqInit(startLoc, origin), maxSq);
  // Mode select (0x103c7a0a): region-zone water first, then the physics byte.
  let mode;
  if (services.regionZone(pawn).water) mode = 3;
  else {
    const phys = rd(services, pawn, 'Physics');           // pawn+0x30
    if (phys === 1 || phys === 3) mode = 1;
    else if (phys === 4) mode = 2;
    else return 0;                                        // 0x103c7b71 no restore
  }
  // dirVec = FCoords{pitch: mode==1?0:pitch, yaw, roll:0}.XAxis — the mode-1
  // rotator literal has pitch=0 (0x103c7b12 stores edi=0 over the arg).
  const dirVec = fcoordsAxes([mode === 1 ? 0 : pitch, yaw, 0])[1];
  const rdt = rd(services, pawn, 'ReducedDamageType');    // pawn+0x444
  while (cont === 1) {                                    // 0x103c7a89
    const stepVec = [st(x87mul(ld(dirVec[0]), ld(step))),
                     st(x87mul(ld(dirVec[1]), ld(step))),
                     st(x87mul(ld(dirVec[2]), ld(step)))];
    let code;
    if (mode === 1) code = checkMove(pawn, stepVec, 0, 4.1, 0, services);
    else if (mode === 2) code = flyMove(pawn, stepVec, 0, 4.1, 0, services);
    else code = swimMove(pawn, stepVec, 0, 4.1, 0, services); // mode 3, 0x103c7c13
    cont = code;                                          // [ebp-0x18]
    if (code !== 1) {                                     // 0x103c7c25
      if (!rd(services, pawn, 'CollideFlag')) cont = 0;   // pawn+0xd0 byte
      else if (mode === 1 && code === -1 &&
               gtU(ld(step), ld(rd(services, pawn, 'MaxStepHeight')))) {
        cont = 1; step = rd(services, pawn, 'MaxStepHeight'); // retry at maxStep
      }
    }
    const fz = services.footZone(pawn);                   // pawn+0x330 zone
    if (fz.pain && fz.damageType !== rdt) cont = 0;       // 0x103c7c5e
    const rz = services.regionZone(pawn);                 // pawn+0xc8 zone
    if (mode !== 3 ? rz.water : !rz.water) cont = 0;      // 0x103c7c80
    if (--iters < 0) { cont = 0; continue; }              // 0x103c7ca8 skip score
    if (cont === 1) {                                     // 0x103c7cb9
      const loc = services.location(pawn);
      const sc = aiScore(minSq, dsqLoop(loc, origin), maxSq);
      if (sc === 0) {                                     // entered the band
        best[0] = f32(loc[0]); best[1] = f32(loc[1]); best[2] = f32(loc[2]);
        haveBest = 1;
        if (prevScore > 0) cont = 0;                      // fell back into band
      } else if (prevScore !== sc) {
        if (prevScore === 0) cont = 0;                    // left the band: keep best
        else {                                            // jumped over the band
          best[0] = f32(loc[0]); best[1] = f32(loc[1]); best[2] = f32(loc[2]);
          haveBest = 1; cont = 0;
        }
      }
      prevScore = sc;                                     // [ebp+0x20]
    }
  }
  // Exit (0x103c7d7a): restore Location via level->FarMoveActor(test=1,
  // noCheck=1), restore Velocity, write *out = best when the ptr is nonnull.
  farMove(services, pawn, startLoc);
  const vel = services.velocity(pawn);
  vel[0] = startVel[0]; vel[1] = startVel[1]; vel[2] = startVel[2];
  if (out) { out[0] = best[0]; out[1] = best[1]; out[2] = best[2]; }
  return haveBest;
}

/**
 * Worker 0x103c7fc0 (thiscall pawn; minDist, maxDist, centralYaw, yawDist,
 * centralPitch, pitchDist, tries, multiplier, out).  tries clamps to >=1 and
 * multiplier to [9.9999997e-05, 1.0]; each attempt draws a random direction
 * and searches the band [minDist/mult, maxDist/mult].  A hit with mult<1
 * re-searches the same direction for distance d*mult (minR=maxR=f32(d*mult)).
 * *out receives the last search's candidate unconditionally; return = found.
 * usePitch: Physics!=1 && (Physics!=3 || regionZone water) — set at 0x103c8041.
 */
export function aiPickWorker(pawn, minDist, maxDist, centralYaw, yawDist,
                             centralPitch, pitchDist, tries, mult, out, services) {
  tries = (tries | 0) >= 1 ? tries | 0 : 1;               // [ebp+0x20] >= 1
  const EPS = ldBits(0x38d1b717);                         // [ebp+0x24] clamp
  if (ltU(ld(mult), EPS)) mult = st(EPS);                 // 9.9999997e-5
  else if (!ltU(ld(mult), D1f)) mult = 1.0;               // fcomp 1.0f: keep below
  const saved = services.location(pawn).map(f32);         // [ebp-0x34..] = loc
  let usePitch = 0;                                       // [ebp-0x14]
  const phys = rd(services, pawn, 'Physics');
  if (phys !== 1) {
    if (phys !== 3 || services.regionZone(pawn).water) usePitch = 1;
  }
  let found = 0;                                          // ecx across the loop
  for (; tries > 0; tries--) {                            // 0x103c805d jle exit
    const dir = aiDirection(services.frand, centralYaw, yawDist, centralPitch, pitchDist);
    const minR = st(x87div(ld(minDist), ld(mult)));
    const maxR = st(x87div(ld(maxDist), ld(mult)));
    found = aiPickSearch(pawn, services.location(pawn).map(f32), dir[1],
                         usePitch ? dir[0] : 0, minR, maxR, 15.0, saved, services);
    if (found && ltU(ld(mult), D1)) {                     // 0x103c80e2 mult<1
      const loc = services.location(pawn);                // (restored = startLoc)
      const dx = sub(ld(saved[0]), ld(loc[0])), dy = sub(ld(saved[1]), ld(loc[1])),
            dz = sub(ld(saved[2]), ld(loc[2]));
      const d = appSqrt(x87add(x87add(x87mul(dx, dx), x87mul(dy, dy)), x87mul(dz, dz)));
      const band = st(x87mul(d, ld(mult)));               // f32(d*mult) [ebp-0x18]
      found = aiPickSearch(pawn, services.location(pawn).map(f32), dir[1],
                           usePitch ? dir[0] : 0, band, band, 15.0, saved, services);
    }
    if (found) break;                                     // 0x103c8171
  }
  if (out) { out[0] = saved[0]; out[1] = saved[1]; out[2] = saved[2]; }
  return found;
}

/**
 * exec body 0x103c86f0 — native(709) AIPickRandomDestination.  The script
 * signature is (f minDist, f maxDist, int centralYaw, f yawDist,
 * int centralPitch, f pitchDist, int tries, f multiplier, out vector dest):
 * nine 4-byte slots evaluated in order.  `args` are already evaluated; `dest`
 * is the caller's out-vector sink — a {reference,set} local, a plain array,
 * or a non-reference value (the native temp slot: writes are discarded).
 */
export function execAiPickRandomDestination(receiver, args, dest, services) {
  const sink = Array.isArray(dest) ? dest
    : dest && typeof dest.set === 'function' ? [0, 0, 0] : null;
  const found = aiPickWorker(receiver,
    f32(args[0]), f32(args[1]), args[2] | 0, f32(args[3]),
    args[4] | 0, f32(args[5]), args[6] | 0, f32(args[7]), sink, services);
  if (sink && !Array.isArray(dest)) dest.set(sink);
  return found;
}

/**
 * exec body 0x103c8560 — native(708) AIDirectionReachable (thunk 0x103022cf).
 * The exec evaluates six slots in declaration order (vector focus, int yaw,
 * int pitch, float minDist, float maxDist, out vector bestDest), steps over
 * EX_EndFunctionParms and calls APawn::AIDirectionReachable 0x103c78a0 (the
 * band search aiPickSearch) with the literal 15.0f, storing eax in *Result.
 * `dest` is the evaluated out argument: a {reference, set} lvalue receives the
 * body's write (the exec passes GPropAddr); any other value stands for the
 * exec's temp, whose write is dead. The body's mode-0 early return leaves
 * *bestDest untouched, so the lvalue is set only when the body wrote it.
 * No receiver, null or GIsEditor check of its own (the body asserts !GIsEditor).
 * Contract and evidence: docs/script-pawn-nav.md "AIDirectionReachable native 708".
 */
export function execAiDirectionReachable(receiver, focus, yaw, pitch, minDist, maxDist, dest, services) {
  const sink = [undefined, undefined, undefined];         // *bestDest (GPropAddr or temp)
  const found = aiPickSearch(receiver, focus.map(f32), yaw | 0, pitch | 0,
    f32(minDist), f32(maxDist), 15.0, sink, services);
  const written = sink[0] !== undefined;                  // 0x103c7dba, not 0x103c7b71
  if (dest && typeof dest.set === 'function' && written) dest.set(sink);
  return found !== 0;                                     // *(DWORD*)Result = eax
}

// ---------------------------------------------------------------------------
// FindPathToward — native 517 (exec 0x103bc9c0, worker 0x103db3f0).
//
// The worker keeps two sorted 32-slot candidate lists matching the native
// { item[32], key[32], count } (0x108 bytes): the pawn-side list keyed by
// int32 distSq to the pawn and the target-side list keyed by int32 distSq to
// the target.  Path-node search state lives on the NavigationPoint objects:
// visitedWeight +0x420, bestPathWeight +0x428, nextOrdered/prevOrdered
// +0x430/+0x434 (open-list links), startPath +0x438, previousPath +0x43c
// (route chain), cost +0x440, ExtraCost +0x444, and the +0x448 bool pack
// (bPlayerOnly 0x1, bEndPoint 0x2, bEndPointOnly 0x4, bSpecialCost 0x8).
// The route graph is the level ReachSpec table (+0x8c, 28-byte records:
// +0x00 distance, +0x04 start, +0x08 end, +0x0c radius, +0x10 height,
// +0x14 reachFlags, +0x18 pruned) indexed through the nodes' outbound
// Paths +0x360 / PrunedPaths +0x3a0 and inbound upstreamPaths +0x320 arrays.
// ---------------------------------------------------------------------------

const wr = (services, obj, name, v) => services.write(obj, name, v);

/** The native's 32-slot { item, key, count } candidate list. */
const navList = () => ({ items: new Array(32).fill(null), keys: new Int32Array(32), count: 0 });

/** int32 distSq key (0x10413652 __ftol of the 80-bit sum of squared f32 deltas). */
const navDistSq = (a, b) => {
  const dx = sub(ld(a[0]), ld(b[0])), dy = sub(ld(a[1]), ld(b[1])),
        dz = sub(ld(a[2]), ld(b[2]));
  return x87ftol(x87add(x87add(x87mul(dx, dx), x87mul(dy, dy)), x87mul(dz, dz)));
};

/**
 * sortedInsert 0x103dd170 — insert before the first keys[i] >= key, shifting
 * the tail right (keys round-trip through fild/ftol, identity for int32).
 * The index gate at 0x103dd1e7 precedes the capped count increment: a full
 * list still admits a closer/equal key and drops its last entry. The MSVC
 * skip-ahead probes reduce to this linear scan.
 */
function navInsert(list, item, key) {
  const n = list.count;
  let i = 0;
  while (i < n && list.keys[i] < key) i++;
  if (i >= 32) return;
  const count = Math.min(n + 1, 32);
  for (let j = count - 1; j > i; j--) { list.items[j] = list.items[j - 1]; list.keys[j] = list.keys[j - 1]; }
  list.items[i] = item;
  list.keys[i] = key | 0;
  list.count = count;
}

/** listRemove 0x103dd2a0 — shift items/keys left from index i, count--. */
function navRemove(list, i) {
  for (let j = i + 1; j < list.count; j++) { list.items[j - 1] = list.items[j]; list.keys[j - 1] = list.keys[j]; }
  list.count--;
}

/**
 * routeReverse 0x103dd810 — in-place singly-linked reversal of the +0x43c
 * previousPath chain.  After the call the pre-reverse tail is the head and
 * tail.prevPath names the second hop.
 */
function navReverse(node, services) {
  let prev = null, cur = node;
  while (cur) {
    const next = rd(services, cur, 'previousPath') ?? null;
    wr(services, cur, 'previousPath', prev);
    prev = cur;
    cur = next;
  }
  return prev;
}

/**
 * scoutA 0x103da210 — candidate-list builder (thiscall `this`=pawn-side
 * list; args pawn, targetLoc, otherList, bClearPaths, anchorFlag*, seededFlag).
 *
 * The pawn's MoveTarget (+0x34c) seeds this->items[0] with key 0 when it is
 * a NavigationPoint within |dz| < anchorCH + pawnCH and dx²+dy² < CR² (CR
 * doubled for a bIsPlayer pawn whose anchor is an InventorySpot); the out
 * anchor flag is set.  Then, when bClearPaths is set, every node in the
 * level's nav list is reset: nextOrdered/prevOrdered cleared, +0x448 bit1
 * (bEndPoint) cleared, visitedWeight = 10000000, cost = bSpecialCost(bit3)
 * ? SpecialCost(pawn) : ExtraCost.  Finally each node within int32 distSq
 * < 640000 (800²) of the pawn is sorted-inserted into `this` (unless the
 * anchor already seeded it) and each node within 800 of the target into
 * `other` (unless the caller pre-seeded it).
 */
function navScoutA(thisList, pawn, targetLoc, otherList, bClearPaths, state, services) {
  const anchor = rd(services, pawn, 'MoveTarget');          // pawn+0x34c
  if (anchor && services.isA(anchor, 'NavPoint')) {
    const ploc = services.location(pawn), aloc = services.location(anchor);
    const dz = sub(ld(aloc[2]), ld(ploc[2]));
    const zGate = x87add(ld(rd(services, anchor, 'CollisionHeight')),
                         ld(rd(services, pawn, 'CollisionHeight')));
    const dx = sub(ld(aloc[0]), ld(ploc[0])), dy = sub(ld(aloc[1]), ld(ploc[1]));
    const rSq = x87mul(ld(rd(services, pawn, 'CollisionRadius')),
                       ld(rd(services, pawn, 'CollisionRadius')));
    let radiusSq = rSq;                                     // [ebp-0x34]
    const f318 = rd(services, pawn, 'Flags318') >>> 0;
    if ((f318 & 0x2) && services.isA(anchor, 'InventorySpot')) {
      const d = appSqrt(x87mul(rSq, ld(4.0)));              // CR*2 via sqrt(4r²)
      radiusSq = x87mul(d, d);                              // (2*CR)², 80-bit
    }
    if (ltU(ltU(dz, D0) ? x87neg(dz) : dz, zGate) &&
        ltU(x87add(x87mul(dx, dx), x87mul(dy, dy)), radiusSq)) {
      thisList.items[0] = anchor;
      thisList.keys[0] = 0;
      thisList.count = 1;
      state.anchor = 1;                                     // *[ebp+0x20]
    }
  }
  const ploc = services.location(pawn);
  for (let nav = services.navListHead(pawn); nav; nav = services.nextNav(nav)) {
    if (bClearPaths) {                                      // 0x103da2f4 reset
      wr(services, nav, 'nextOrdered', null);               // +0x430
      wr(services, nav, 'prevOrdered', null);               // +0x434
      wr(services, nav, 'bEndPoint', false);                // +0x448 &~ 2
      wr(services, nav, 'visitedWeight', 10000000);         // +0x420
      const cost = rd(services, nav, 'bSpecialCost')        // +0x448 & 8
        ? services.specialCost(nav, pawn) | 0               // 0x10302af9 event
        : rd(services, nav, 'ExtraCost') | 0;               // +0x444
      wr(services, nav, 'cost', cost);                      // +0x440
    }
    if (!state.anchor) {                                    // this: pawn keys
      const key = navDistSq(ploc, services.location(nav));
      if (key < 640000) navInsert(thisList, nav, key);
    }
    if (!state.seeded) {                                    // other: target keys
      const key = navDistSq(targetLoc, services.location(nav));
      if (key < 640000) navInsert(otherList, nav, key);
    }
  }
}

/**
 * scoutB 0x103da610 — head validator (thiscall list; args pawn, outFlag*).
 *
 * While items remain: items[0] must FastLineCheck to the pawn eye
 * (loc.z + BaseEyeHeight) and pass pointWorker(pawn, loc, 1); failures are
 * removed and the scan retries.  On the first passing node keys[0] becomes
 * ftol(sqrt(keys[0])); when it is < max(ftol(CR),48) and |nav.z-pawn.z| < CH
 * the out flag is set (the pawn is at the node), else the node is marked
 * bEndPoint (+0x448|2) with bestPathWeight (+0x428) = keys[0].
 */
function navScoutB(list, pawn, outFlag, services) {
  const model = services.model(services.level(pawn));
  const ploc = services.location(pawn);
  const eye = [ploc[0], ploc[1], st(x87add(ld(ploc[2]), ld(rd(services, pawn, 'BaseEyeHeight'))))];
  while (list.count > 0) {                                  // [ebp-0x14] > 0
    const nav = list.items[0];
    if (!services.fastLineCheck(model, services.location(nav), eye)) { navRemove(list, 0); continue; }
    if (!pointWorker(pawn, services.location(nav), 1, services)) { navRemove(list, 0); continue; }
    list.keys[0] = x87ftol(appSqrt(ld(list.keys[0])));      // sqrt distSq -> dist
    const thresh = Math.max(x87ftol(ld(rd(services, pawn, 'CollisionRadius'))), 48);
    const dz = sub(ld(services.location(nav)[2]), ld(ploc[2]));
    if (list.keys[0] < thresh &&
        ltU(ltU(dz, D0) ? x87neg(dz) : dz, ld(rd(services, pawn, 'CollisionHeight')))) {
      outFlag.v = 1;                                        // *[ebp+0x10]
      return 1;
    }
    wr(services, nav, 'bEndPoint', true);                   // +0x448 |= 2
    wr(services, nav, 'bestPathWeight', list.keys[0]);      // +0x428
    return 1;
  }
  return 0;
}

/**
 * scoutC 0x103da880 — direct-hop test (thiscall list; args pawn, targetLoc).
 *
 * items[0] must sit within distSq < 640000 of the target and FastLineCheck
 * to it; then FarMoveActor(pawn -> items[0], test=1, noCheck=0) is attempted
 * and pointWorker(pawn, targetLoc, 0) decides success.  On success the pawn
 * stays at items[0] (the caller restores it).  Failure collapses the list to
 * count=1; only a pointWorker failure (after the test move landed) restores
 * the pawn's original location first.
 */
function navScoutC(list, pawn, targetLoc, services) {
  const origLoc = services.location(pawn).map(f32);         // [ebp-0x28..]
  const nav = list.items[0];
  const model = services.model(services.level(pawn));
  const nloc = services.location(nav);
  const dx = sub(ld(targetLoc[0]), ld(nloc[0])), dy = sub(ld(targetLoc[1]), ld(nloc[1])),
        dz = sub(ld(targetLoc[2]), ld(nloc[2]));
  const dSq = x87add(x87add(x87mul(dx, dx), x87mul(dy, dy)), x87mul(dz, dz));
  // 0x103da907: distSq/FLC/farMove failures jump straight to count=1.
  if (ltU(dSq, ld(640000.0)) &&                             // 0x103da8f6
      services.fastLineCheck(model, nloc, targetLoc) &&
      services.farMoveActor(pawn, nloc.map(f32), 1, 0)) {   // 0x103da949
    if (pointWorker(pawn, targetLoc, 0, services)) return 1; // 0x103da983
    services.farMoveActor(pawn, origLoc, 1, 1);             // 0x103da9b5-0x103da9d4
  }
  list.count = 1;                                           // [ebx+0x100] = 1
  return 0;                                                 // 0x103da9dd
}

/**
 * scoutD 0x103daaa0 — endpoint marker (thiscall list; arg pawn).
 *
 * items[0].cost is pinned to 1000000, then items[0]'s outbound spec arrays
 * (Paths +0x360, then PrunedPaths +0x3a0) are scanned: specs with
 * radius >= ftol(CR), height >= ftol(CH), and (reachFlags & mask) ==
 * reachFlags are edge-tested by SingleLineCheck(spec.start.loc ->
 * spec.end.loc, flags=6).  A blocking Mover vetoes unless the pawn has
 * bCanOpenDoors (0x10000) and is either bIsPlayer (0x2) or the mover lacks
 * bPlayerOnly (+0x4ec bit3).  Each passing spec.end is flagged bEndPoint
 * (+0x448|2) with bestPathWeight (+0x428) = spec.distance.
 */
function navScoutD(list, pawn, services) {
  const head = list.items[0];
  wr(services, head, 'cost', 1000000);                      // +0x440 = 0xf4240
  const cri = x87ftol(ld(rd(services, pawn, 'CollisionRadius')));
  const chi = x87ftol(ld(rd(services, pawn, 'CollisionHeight')));
  const f318 = rd(services, pawn, 'Flags318') >>> 0;
  const mask = reachMask(pawn, services);
  const table = services.reachSpecTable(pawn);
  for (const arr of [services.paths(head), services.prunedPaths(head)]) {
    for (let i = 0; i < 16; i++) {                          // [ebp-0x14] < 0x10
      const idx = i < arr.length ? (arr[i] | 0) : -1;
      if (idx === -1) break;                                // -1 terminator
      const spec = table[idx];
      if (!spec) continue;
      if ((spec.radius | 0) < cri) continue;                // spec+0x0c
      if ((spec.height | 0) < chi) continue;                // spec+0x10
      if (((spec.reachFlags | 0) & mask) !== (spec.reachFlags | 0)) continue;
      const hit = services.singleLineCheck(pawn, services.location(spec.end),
        services.location(spec.start), 6, [0, 0, 0], 0);    // 0x103dadf2
      if (hit.actor && services.isA(hit.actor, 'Mover')) {
        if (!(f318 & 0x10000)) continue;                    // !bCanOpenDoors
        if (!(f318 & 0x2) && (rd(services, hit.actor, 'Flags4ec') & 8)) continue;
      }
      wr(services, spec.end, 'bEndPoint', true);            // end+0x448 |= 2
      wr(services, spec.end, 'bestPathWeight', spec.distance | 0); // end+0x428
    }
  }
}

/**
 * scoutE 0x103db0e0 — post-BFS candidate refinement (thiscall pawn-side
 * list; args pawn, foundPtr*).
 *
 * routeW = items[0].visitedWeight + keys[0].  Candidates i=1..count whose
 * w = cand.visitedWeight + ftol(sqrt(keys[i])) satisfy w < routeW and
 * |cand.z - pawn.z| < 120 pass unconditionally when the direction dot
 * (cand.loc-pawn.loc)·(found.loc-pawn.loc) < 0; otherwise they need
 * w < max(ftol(routeW*0.85), routeW-150).  Of the passing set, the LAST
 * candidate that FastLineChecks to the pawn eye and passes pointWorker
 * becomes *foundPtr.
 */
function navScoutE(list, pawn, foundPtr, services) {
  const model = services.model(services.level(pawn));
  const ploc = services.location(pawn);
  const floc = services.location(foundPtr.node);            // *[ebp+0x10]
  const routeW = (rd(services, list.items[0], 'visitedWeight') | 0) + (list.keys[0] | 0);
  const eye = [ploc[0], ploc[1], st(x87add(ld(ploc[2]), ld(rd(services, pawn, 'BaseEyeHeight'))))];
  const dirx = sub(ld(floc[0]), ld(ploc[0])), diry = sub(ld(floc[1]), ld(ploc[1])),
        dirz = sub(ld(floc[2]), ld(ploc[2]));
  const capA = x87ftol(x87mul(ld(routeW), ld(0.85)));       // 0x1042ac10-era const
  const capB = (routeW - 150) | 0;
  const cap = Math.max(capA, capB);
  const passing = navList();
  for (let i = 1; i < list.count; i++) {                    // [ebp-0x18] = 1..
    const cand = list.items[i];
    const cloc = services.location(cand);
    const w = (rd(services, cand, 'visitedWeight') | 0) +
             x87ftol(appSqrt(ld(list.keys[i])));
    if (w >= routeW) continue;                              // 0x103db1d4
    const dz = sub(ld(cloc[2]), ld(ploc[2]));
    if (geU(ltU(dz, D0) ? x87neg(dz) : dz, ld(120.0))) continue; // 0x103db203
    const dot = x87add(x87add(x87mul(sub(ld(cloc[0]), ld(ploc[0])), dirx),
                              x87mul(sub(ld(cloc[1]), ld(ploc[1])), diry)),
                              x87mul(sub(ld(cloc[2]), ld(ploc[2])), dirz));
    if (geU(dot, D0) && w >= cap) continue;                 // 0x103db268
    navInsert(passing, cand, w);                            // sub-list
  }
  for (let i = 0; i < passing.count; i++) {                 // last passing wins
    const cand = passing.items[i];
    const cloc = services.location(cand);
    if (!services.fastLineCheck(model, cloc, eye)) continue;
    if (!pointWorker(pawn, cloc, 1, services)) continue;
    foundPtr.node = cand;                                   // *[ebp+0x10]
  }
}

/**
 * BFS 0x103dcd60 — lazy-sorted Dijkstra over upstreamPaths (thiscall pawn;
 * args startNode, foundPtr*, bSinglePath, reachMask).
 *
 * The open list is the nav objects' nextOrdered/prevOrdered chain sorted by
 * visitedWeight; `head` advances lazily at ftol(nIns*0.5) steps.  Each pop
 * relaxes the node's inbound specs (upstreamPaths +0x320): spec.radius >=
 * ftol(CR), spec.height >= ftol(CH), (reachFlags & mask) == reachFlags, and
 * the relaxed candidate spec.start gains
 *   newCost = cur.visitedWeight + spec.distance + cand.cost
 *             + (cand.bEndPoint ? cand.bestPathWeight : 0)
 * only on strict improvement over its current visitedWeight, re-linking it
 * into the sorted open list and pointing cand.previousPath at cur.  A popped
 * bEndPoint node wins: start.previousPath is nulled and *foundPtr = node.
 * Caps: bSinglePath aborts after 4 pops, 1000 pops total, 500 insert steps.
 */
function navSearchBFS(pawn, start, foundPtr, bSinglePath, mask, services) {
  const cri = x87ftol(ld(rd(services, pawn, 'CollisionRadius')));
  const chi = x87ftol(ld(rd(services, pawn, 'CollisionHeight')));
  const f318 = rd(services, pawn, 'Flags318') >>> 0;
  const table = services.reachSpecTable(pawn);
  let head = start;                                         // ebx
  let nIns = 1;                                             // [ebp-0x14]
  let advanced = 0;                                         // [ebp-0x20]
  let pops = 0;                                             // [ebp-0x24]
  for (let cur = start; cur; cur = rd(services, cur, 'nextOrdered') ?? null) {
    if (rd(services, cur, 'bEndPoint')) {                   // +0x448 & 2
      wr(services, start, 'previousPath', null);            // start+0x43c = 0
      foundPtr.node = cur;                                  // *found = endpoint
      return 1;
    }
    const skipNode = rd(services, cur, 'bPlayerOnly') && !(f318 & 0x2) && cur !== start;
    if (!skipNode) {                                        // 0x103dce0a
      const upstream = services.upstreamPaths(cur);         // +0x320 inbound
      for (let i = 0; i < 16; i++) {
        const idx = i < upstream.length ? (upstream[i] | 0) : -1;
        if (idx === -1) break;
        const spec = table[idx];
        if (!spec) continue;
        if ((spec.radius | 0) < cri) continue;
        if ((spec.height | 0) < chi) continue;
        if (((spec.reachFlags | 0) & mask) !== (spec.reachFlags | 0)) continue;
        const cand = spec.start;                            // spec+0x04
        const newCost = ((rd(services, cur, 'visitedWeight') | 0) +
                         (spec.distance | 0) + (rd(services, cand, 'cost') | 0) +
                         (rd(services, cand, 'bEndPoint')
                           ? (rd(services, cand, 'bestPathWeight') | 0) : 0)) | 0;
        if ((rd(services, cand, 'visitedWeight') | 0) <= newCost) continue; // no improvement
        // Unlink the candidate from the open list when it is already linked.
        if (rd(services, cand, 'prevOrdered')) {
          const p = rd(services, cand, 'prevOrdered'), n = rd(services, cand, 'nextOrdered');
          wr(services, p, 'nextOrdered', n);
          if (n) wr(services, n, 'prevOrdered', p);
          if (head === cand) {
            if ((rd(services, p, 'visitedWeight') | 0) > newCost) head = p;
          } else if ((rd(services, cand, 'visitedWeight') | 0) > (rd(services, head, 'visitedWeight') | 0) &&
                     newCost < (rd(services, head, 'visitedWeight') | 0)) {
            nIns--;
          }
        } else if (newCost <= (rd(services, head, 'visitedWeight') | 0)) {
          nIns++;
        }
        wr(services, cand, 'previousPath', cur);            // cand+0x43c = cur
        wr(services, cand, 'visitedWeight', newCost);       // cand+0x420
        // Sorted reinsertion after pos = (head.vW < newCost) ? head : cur.
        let pos = (rd(services, head, 'visitedWeight') | 0) < newCost ? head : cur;
        let walk = 0, nxt;
        while ((nxt = rd(services, pos, 'nextOrdered') ?? null) &&
               (rd(services, nxt, 'visitedWeight') | 0) < newCost) {
          pos = nxt;
          if (++walk > 500) return 0;                       // 0x103dd034 assert
        }
        if (nxt !== cand) {
          const after = rd(services, pos, 'nextOrdered') ?? null;
          wr(services, cand, 'nextOrdered', after);
          wr(services, cand, 'prevOrdered', pos);
          wr(services, pos, 'nextOrdered', cand);
          if (after) wr(services, after, 'prevOrdered', cand);
        }
      }
      // Lazy head advance at ftol(nIns*0.5) steps (0x103dcfd2-0x103dcfff).
      nIns++;
      const capN = x87ftol(x87mul(ld(nIns), D05));
      while (advanced < capN) {
        advanced++;
        const n = rd(services, head, 'nextOrdered') ?? null;
        if (n) head = n;
      }
    }
    pops++;
    if (bSinglePath && pops > 4) return 0;                  // 0x103dd01c
    if (pops > 1000) return 0;                              // 0x103dd02a cap
  }
  return 0;
}

/**
 * Worker 0x103db3f0 — thiscall(pawn; AActor* target, int bSinglePath,
 * ANavigationPoint** found, int bClearPaths).
 *
 * Entry: *found = 0; a null target, missing nav list (LevelInfo+0x548), or
 * an empty ReachSpec table (level+0x90) fails immediately.  A non-falling
 * pawn chasing a falling pawn (target IsA Pawn && target.Physics == 2)
 * lands the target with jumpLanding and delegates to the findPathTo worker —
 * an unported boundary here.
 *
 * The two candidate lists: `this` (pawn-side keys) and `other` (target-side
 * keys).  A NavigationPoint target pre-seeds `other`.  scoutA collects;
 * empty lists fail.  The pawn-side head is validated by scoutB (unless the
 * anchor seeded it); a direct target hop succeeds through directReach
 * (navpoint targets) or scoutC; otherwise scoutD marks the pawn head's
 * outbound neighbors as endpoints and BFS-1 runs from the target anchor
 * (scanned by FastLineCheck + farMove + actorWorker, or bHunting fallback).
 * scoutE may refine the result over pawn-side candidates.  When no target
 * anchor was reachable, pass 2 re-collects, scoutD marks the target head's
 * outbound neighbors, scoutB validates, BFS-2 runs from the pawn anchor,
 * the route chain is reversed, and a second-hop FLC+pointWorker check may
 * return the hop after the pawn's anchor.
 */
export function pathTowardWorker(pawn, target, bSinglePath, found, bClearPaths, services) {
  found.node = null;                                        // *[ebp+0x10] = 0
  if (!target) return 0;
  const level = services.level(pawn);
  if (!services.navListHead(pawn)) return 0;                // LevelInfo+0x548
  if (!(services.reachSpecTable(pawn)?.length > 0)) return 0; // level+0x90

  const pawnPhys = rd(services, pawn, 'Physics') | 0;       // pawn+0x30
  if (pawnPhys !== 4 && services.isA(target, 'Pawn') &&
      (rd(services, target, 'Physics') | 0) === 2) {        // PHYS_Falling
    // 0x103db4ec: Landing = target.Location; target->jumpLanding(
    // target.Velocity, Landing, 0) (0x103db526, thiscall on the target: its
    // zone, collision and test moves), then the findPathTo worker (thunk
    // 0x10303972 -> 0x103dc1d0) toward Landing with this worker's
    // bSinglePath, found and bClearPaths.
    const out = services.location(target).map(f32);
    jumpLanding(target, services.velocity(target), out, 0, services.forActor(target));
    return pathToWorker(pawn, out, bSinglePath, found, bClearPaths, services);
  }

  const origLoc = services.location(pawn).map(f32);         // [ebp-0x20..]
  const targetLoc = services.location(target);              // ebx = &target.loc
  const model = services.model(level);
  const listP = navList();                                  // [ebp-0x24c] pawn side
  const listT = navList();                                  // [ebp-0x144] target side
  const state = { anchor: 0, seeded: 0 };                   // [ebp-0x24]/[ebp-0x14]
  if (services.isA(target, 'NavPoint')) {                   // chain 0x1057a128
    listT.items[0] = target; listT.keys[0] = 0; listT.count = 1;
    state.seeded = 1;
  }
  navScoutA(listP, pawn, targetLoc, listT, bClearPaths, state, services);
  if (listP.count === 0) return 0;                          // [ebp-0x14c]==0
  if (listT.count === 0) return 0;                          // [ebp-0x44]==0

  const fail = () => { services.farMoveActor(pawn, origLoc, 1, 1); return 0; };

  if (!state.anchor) {                                      // [ebp-0x24]==0
    const flag = { v: 0 };
    if (!navScoutB(listP, pawn, flag, services)) return fail();
    state.anchor = flag.v;
  }
  if (state.anchor) {                                       // 0x103db642 else ->0x103db72e
    // Direct-target block (0x103db648): navpoint targets try directReach on
    // the pawn-side head first; scoutC is the hop fallback for every kind.
    if (services.isA(target, 'NavPoint') &&
        directReach(pawn, listP.items[0], target, services)) {
      found.node = target;
      services.farMoveActor(pawn, origLoc, 1, 1);
      return 1;
    }
    if (navScoutC(listP, pawn, targetLoc, services)) {
      found.node = services.isA(target, 'NavPoint') ? target : listP.items[0];
      services.farMoveActor(pawn, origLoc, 1, 1);
      return 1;
    }
    navScoutD(listP, pawn, services);                       // 0x103db722 endpoints
  }

  // Target-anchor scan (0x103db733) over the target-side candidates.
  if (!state.seeded) {
    for (let i = 0; i < listT.count; i++) {
      const item = listT.items[i], iloc = services.location(item);
      if (!services.fastLineCheck(model, iloc, targetLoc)) continue;
      if (!services.farMoveActor(pawn, iloc.map(f32), 1, 0)) continue;
      if (!actorWorker(pawn, target, 1, services)) continue;
      state.seeded = 1;                                     // [ebp-0x14] = 1
      listT.items[0] = item;
      listT.keys[0] = x87ftol(appSqrt(ld(listT.keys[i])));
      break;
    }
    const f318 = rd(services, pawn, 'Flags318') >>> 0;
    if (!state.seeded && (f318 & 0x200000)) state.seeded = 1; // bHunting
  }

  // BFS-1 (0x103db857): from the target-side head back over upstream paths.
  wr(services, listT.items[0], 'visitedWeight', listT.keys[0]);
  const bfsOut = { node: null };                            // [ebp+8]
  const mask = reachMask(pawn, services);
  if (navSearchBFS(pawn, listT.items[0], bfsOut, bSinglePath, mask, services)) {
    found.node = bfsOut.node;
    services.farMoveActor(pawn, origLoc, 1, 1);             // 0x103db892 restore
    if (!state.anchor && !bSinglePath)                      // [ebp-0x24]==0
      navScoutE(listP, pawn, found, services);              // 0x103018cf
    return 1;
  }
  if (state.seeded) return fail();                          // 0x103db8f6

  // Pass 2 (0x103db901): no target anchor — re-collect, mark the target
  // head's outbound neighbors, validate it, and search from the pawn head.
  navScoutA(listP, pawn, targetLoc, listT, bClearPaths, state, services);
  navScoutD(listT, pawn, services);
  if (!state.seeded) {
    const flag = { v: 0 };
    if (!navScoutB(listT, pawn, flag, services)) return fail();
    state.seeded = flag.v;
  }
  wr(services, listP.items[0], 'visitedWeight', listP.keys[0]);
  const bfs2 = { node: null };                              // [ebp+0x14]
  if (!navSearchBFS(pawn, listP.items[0], bfs2, bSinglePath, mask, services)) return fail();
  services.farMoveActor(pawn, origLoc, 1, 1);               // 0x103db9a1 restore

  // 0x103db9ca-0x103dba34: fail when |target->found|² > |target->pawn|² —
  // the route must land closer to the target than the pawn already is.
  const fl = services.location(bfs2.node), pl = services.location(pawn);
  const tfx = sub(ld(targetLoc[0]), ld(fl[0])), tfy = sub(ld(targetLoc[1]), ld(fl[1])),
        tfz = sub(ld(targetLoc[2]), ld(fl[2]));
  const tfSq = x87add(x87add(x87mul(tfx, tfx), x87mul(tfy, tfy)), x87mul(tfz, tfz));
  const tpx = sub(ld(targetLoc[0]), ld(pl[0])), tpy = sub(ld(targetLoc[1]), ld(pl[1])),
        tpz = sub(ld(targetLoc[2]), ld(pl[2]));
  // fst [ebp+0xc]/fmul [ebp+0xc]: the x-delta squares against its f32 store.
  const tpSq = x87add(x87add(x87mul(tpx, ld(st(tpx))), x87mul(tpy, tpy)), x87mul(tpz, tpz));
  if (gtU(tfSq, tpSq)) return 0;                            // 0x103dbc14 no restore

  found.node = bfs2.node;                                   // *found = chain head
  let tail = bfs2.node;
  while (rd(services, tail, 'previousPath')) tail = rd(services, tail, 'previousPath');
  navReverse(bfs2.node, services);                          // 0x10302ffe
  found.node = tail;                                        // pre-reverse tail
  const hop2 = rd(services, tail, 'previousPath') ?? null;  // [ebp+0xc]
  if (hop2) {
    const dz = sub(ld(services.location(tail)[2]), ld(pl[2]));
    const near = ltU(ltU(dz, D0) ? x87neg(dz) : dz, ld(120.0));
    if ((state.anchor && listP.items[0] === tail) || near) {
      const eye = [pl[0], pl[1], st(x87add(ld(pl[2]), ld(rd(services, pawn, 'BaseEyeHeight'))))];
      const hloc = services.location(hop2);
      if (services.fastLineCheck(model, hloc, eye) &&
          pointWorker(pawn, hloc, 1, services)) {
        found.node = hop2;
        services.farMoveActor(pawn, origLoc, 1, 1);         // 0x103dbb56
        return 1;
      }
    }
    return 1;                                               // 0x103dbba3
  }
  if (state.anchor && tail === listP.items[0]) return 0;    // 0x103dbba1
  return 1;                                                 // 0x103dbba3
}

/**
 * Worker 0x103dc1d0 — thiscall(pawn; FVector point, int bSinglePath,
 * ANavigationPoint** found, int bClearPaths), ret 0x18.  The path search
 * toward a point: FindPathTo's (518) worker and pathTowardWorker's
 * falling-target delegation.
 *
 * The findPathToward worker's first pass with a point for the target and
 * no NavigationPoint pre-seed: the same gates, scoutA, scoutB/scoutC/scoutD
 * on the pawn-side head, then the target-side scan (FastLineCheck from the
 * candidate to the point, a test FarMoveActor onto it, pointReachable with
 * arg 1) and BFS from the reached candidate.  Unlike the toward worker it
 * has no bHunting fallback and no second pass: an exhausted scan or a
 * failed BFS restores the pawn and fails.
 */
export function pathToWorker(pawn, point, bSinglePath, found, bClearPaths, services) {
  found.node = null;                                        // *[ebp+0x18] = 0
  const level = services.level(pawn);
  if (!services.navListHead(pawn)) return 0;                // LevelInfo+0x548
  if (!(services.reachSpecTable(pawn)?.length > 0)) return 0; // level+0x90

  const origLoc = services.location(pawn).map(f32);         // [ebp-0x24..-0x1c]
  const model = services.model(level);
  const listP = navList();                                  // [ebp-0x244] pawn side
  const listT = navList();                                  // [ebp-0x13c] point side
  const state = { anchor: 0, seeded: 0 };                   // [ebp-0x14]/[ebp-0x18]
  navScoutA(listP, pawn, point, listT, bClearPaths, state, services);
  if (listP.count === 0) return 0;                          // [ebp-0x144]==0
  if (listT.count === 0) return 0;                          // [ebp-0x3c]==0

  const fail = () => { services.farMoveActor(pawn, origLoc, 1, 1); return 0; };

  if (!state.anchor) {                                      // 0x103dc2f3
    const flag = { v: 0 };
    if (!navScoutB(listP, pawn, flag, services)) return fail();
    state.anchor = flag.v;
  }
  if (state.anchor) {                                       // 0x103dc353
    if (navScoutC(listP, pawn, point, services)) {
      found.node = listP.items[0];                          // 0x103dc383
      services.farMoveActor(pawn, origLoc, 1, 1);           // 0x103dc3a1
      return 1;
    }
    navScoutD(listP, pawn, services);                       // 0x103dc3c6
  }

  // Point-anchor scan (0x103dc3d8) over the point-side candidates.
  if (!state.seeded) {
    for (let i = 0; i < listT.count; i++) {
      const item = listT.items[i], iloc = services.location(item);
      if (!services.fastLineCheck(model, iloc, point)) continue;
      if (!services.farMoveActor(pawn, iloc.map(f32), 1, 0)) continue;
      if (!pointWorker(pawn, point, 1, services)) continue;
      state.seeded = 1;                                     // [ebp-0x18] = 1
      listT.items[0] = item;
      listT.keys[0] = x87ftol(appSqrt(ld(listT.keys[i])));  // 0x103dc4ac fild, sqrt, ftol
      break;
    }
    if (!state.seeded) return fail();                       // 0x103dc4e4
  }

  // BFS (0x103dc4ea) from the point-side head back over upstream paths.
  const bfsOut = { node: null };                            // [ebp+0x1c]
  const mask = reachMask(pawn, services);
  wr(services, listT.items[0], 'visitedWeight', listT.keys[0]);
  if (!navSearchBFS(pawn, listT.items[0], bfsOut, bSinglePath, mask, services)) return fail();
  found.node = bfsOut.node;
  services.farMoveActor(pawn, origLoc, 1, 1);               // 0x103dc550 restore
  if (!state.anchor && !bSinglePath)                        // [ebp-0x14]==0
    navScoutE(listP, pawn, found, services);                // 0x103018cf
  return 1;
}

/**
 * tailSet 0x103c5de0 — SpecialHandling follow-up (thiscall pawn; &result).
 *
 * Dispatches the result node's SpecialHandling event with the pawn as the
 * argument; the returned actor replaces *result.  A null/unchanged goal,
 * a pawn without bCanDoSpecial (0x20000), or an unreachable goal exits.
 * A reachable goal that itself probes SpecialHandling is dispatched once
 * more; a distinct reachable second goal replaces *result.  When the goal
 * is not directly reachable the worker re-paths toward it (bClearPaths=1)
 * and a successful, distinct result replaces *result while the pawn keeps
 * the goal as SpecialGoal (+0x45c).
 */
function navTailSet(pawn, result, services) {
  const origFound = result.node;                            // [ebp+8] save
  let goal = services.specialHandling(result.node, pawn);   // SpecialHandling event
  result.node = goal;                                       // [esi] = goal
  if (!goal || goal === origFound) return;
  const f318 = rd(services, pawn, 'Flags318') >>> 0;
  if (!(f318 & 0x20000)) return;                            // !bCanDoSpecial
  wr(services, pawn, 'SpecialGoal', goal);                  // pawn+0x45c
  if (!actorWorker(pawn, goal, 0, services)) {              // 0x103024be
    const repath = { node: null };
    if (!pathTowardWorker(pawn, goal, 0, repath, 1, services)) return;
    if (repath.node === origFound) return;
    wr(services, pawn, 'SpecialGoal', result.node);         // = goal
    result.node = repath.node;
    return;
  }
  if (!services.isProbing(result.node, 'SpecialHandling')) return; // 0x15a
  const goal2 = services.specialHandling(result.node, pawn);
  if (!goal2 || goal2 === result.node || result.node === origFound) return;
  if (!actorWorker(pawn, goal2, 0, services)) return;
  result.node = goal2;
}

/**
 * execFindPathToward 0x103bc9c0 — native(517).
 *   (AActor* target, optional int bSinglePath /*=0*\/, optional int bClearPaths /*=1*\/)
 *
 * Evaluates the three parameters (bSinglePath default 0, bClearPaths
 * default 1) and calls the worker.  The post-worker tail clears
 * bShootSpecial (+0x318 &~ 0x2000000) and SpecialPause (+0x460 = 0)
 * unconditionally; a nonnull result that probes SpecialHandling (0x15a)
 * runs tailSet, and a result equal to SpecialGoal clears it.
 * Returns the found Actor (or null), matching the native's result slot.
 */
export function execFindPathToward(pawn, target, bSinglePath, bClearPaths, services) {
  if (!target) return null;                                 // 0x103bca3a
  const found = { node: null };                             // [ebp-0x10]
  const result = { node: null };                            // [ebp+8] result slot
  if (pathTowardWorker(pawn, target, bSinglePath | 0, found, bClearPaths | 0, services))
    result.node = found.node;                               // 0x103bca8f
  const f318 = rd(services, pawn, 'Flags318') >>> 0;
  wr(services, pawn, 'Flags318', (f318 & ~0x2000000) >>> 0); // clear bShootSpecial
  wr(services, pawn, 'SpecialPause', 0);                    // pawn+0x460 = 0
  if (result.node && services.isProbing(result.node, 'SpecialHandling'))
    navTailSet(pawn, result, services);                     // 0x1030216c
  if (result.node === rd(services, pawn, 'SpecialGoal'))
    wr(services, pawn, 'SpecialGoal', null);                // pawn+0x45c = 0
  return result.node;
}
