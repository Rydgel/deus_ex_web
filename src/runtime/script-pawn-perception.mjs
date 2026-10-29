/**
 * Recovered AActor/APawn perception natives — LineOfSightTo (native 514),
 * CanSee (533), PlayerCanSeeMe (532), PickTarget (531), PickAnyTarget (534),
 * and AICanSee (705), plus Actor.Tick's ShowSelf/CheckEnemyVisible helpers.
 * The three LOS natives and the two target pickers share
 * one worker body at 0x103beb50; AICanSee has its own visibility worker at
 * 0x103c6ab0 reached through exec thunk 0x10301357.
 *
 * Every body was disassembled from the hash-verified GOTY Engine.dll and is
 * reproduced instruction-faithfully: float32 stores round once through the
 * 80-bit x87 model, unordered FCOM flag bits are honored, and the angular
 * math (FVector::Rotation / appAtan) uses the hardware-measured Core exports
 * (docs/script-pawn-perception.md records provenance).
 *
 * The worker reads the pawn's script-declared fields through the field view —
 * Location/Rotation at +0x114/+0x120, the AI fields SightRadius (+0x3a4),
 * PeripheralVision (+0x3a8), Visibility (+0x398 byte), Stimulus (+0x3a0),
 * BaseEyeHeight (+0x3f4), the +0x458 skill divisor, Enemy (+0x3cc), LastSeenPos
 * (+0x3b0)/LastSeeingPos (+0x3bc), and the +0x318 flag word bits bBehindView
 * (0x1), bIsPlayer (0x2), bLOSflag (0x80000) — exactly the native offsets.
 *
 * Line tracing is BSP-only: the worker calls UModel::FastLineCheck on the
 * level's Model (xLevel+0xac -> Model+0x98); AICanSee's LOS gate calls the
 * SingleLineCheck wrapper (0x103c7430) which is the MultiLineCheck boundary.
 * Neither reaches the navigation graph — pathfinding is out of scope.
 */

import { actorVisibilityExtended } from './script-ai-visibility.mjs';
import { fcoordsAxes } from './script-pawn-locomotion.mjs';
import { scriptVmKernel } from './script-vm-kernel.mjs';
import { vectorToRotator } from './script-decoration-primitives.mjs';
import {
  x87load, x87add, x87neg, x87mul, x87div, x87sqrt, x87store,
  x87storeDouble, x87safeNormal, x87width,
} from './script-vm.mjs';

const f32 = Math.fround;

/** Static address/byte contract for the installed GOTY Engine.dll image. */
export const PAWN_PERCEPTION_CONTRACT = Object.freeze({
  engineSha256: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  imageBase: 0x10300000,
  // exec wrapper -> body (the LOS bodies share the worker at 0x103beb50).
  natives: Object.freeze({
    lineOfSightTo:  Object.freeze({ index: 514, thunk: 0x1030187a, body: 0x103bce10 }),
    playerCanSeeMe: Object.freeze({ index: 532, thunk: 0x1030339b, body: 0x103ba640 }),
    pickTarget:     Object.freeze({ index: 531, thunk: 0x10303689, body: 0x103baca0 }),
    canSee:         Object.freeze({ index: 533, thunk: 0x10303256, body: 0x103ba5d0 }),
    pickAnyTarget:  Object.freeze({ index: 534, thunk: 0x10301195, body: 0x103bb130 }),
    aiCanSee:       Object.freeze({ index: 705, thunk: 0x10301357, body: 0x103c8270 }),
  }),
  // Shared bodies: the LOS worker all five sight natives call, the
  // PlayerCanSeeMe per-viewer test, and the AICanSee visibility worker.
  workers: Object.freeze({
    losWorker:   0x103beb50,  // thiscall(this=pawn, other, bCheckFOV, bIgnoreDistance)
    testCanSeeMe: 0x103ba8a0, // thiscall(this=actor, viewerPawn)
    aiCanSee:    0x103c6ab0,  // thiscall(this=pawn, other, vis, 4 flags)
    singleLineCheck: 0x103037b5, // thunk -> 0x103c7430 (MultiLineCheck wrapper)
  }),
  // Pawn/Actor field offsets the bodies dereference (see module header).
  offsets: Object.freeze({
    location: 0x114, rotation: 0x120, viewRotation: 0x3dc,
    collisionRadius: 0x1d4, collisionHeight: 0x1d8, bProjTargetBit: 0x1dc,
    flags318: 0x318, visibility: 0x398, stimulus: 0x3a0, sightRadius: 0x3a4,
    peripheralVision: 0x3a8, lastSeenPos: 0x3b0, lastSeeingPos: 0x3bc,
    enemy: 0x3cc, baseEyeHeight: 0x3f4, field60c: 0x60c, health: 0x428,
    skill: 0x458, nextPawn: 0x498, pri: 0x558,
    aiAddViewRotation: 0x5c8, aiHorizontalFov: 0x5ac, aspectRatio: 0x5b0,
    minAngularSize: 0x5b8, visibilityThreshold: 0x5bc,
  }),
  flagBits: Object.freeze({
    bBehindView: 0x00000001, bIsPlayer: 0x00000002, bLOSflag: 0x00080000,
  }),
  // float32/double constants read directly from the image (address -> value).
  constants: Object.freeze({
    // Flat-path (bCheckFOV=0) caps.
    flatVisScale:    Object.freeze({ address: 0x10431464, value: 0.015 }),
    flatPawnScaleNpc:    Object.freeze({ address: 0x1043145c, value: 4000 }),
    flatPawnScalePlayer: Object.freeze({ address: 0x1042f548, value: 5000 }),
    flatCapPlayerPawn:   Object.freeze({ address: 0x10431460, value: 25000000 }),
    flatCapNpcPawn:      Object.freeze({ address: 0x10431478, value: 16000000 }),
    flatCapPlayerActor:  Object.freeze({ address: 0x10431478, value: 16000000 }),
    flatCapNpcActor:     Object.freeze({ address: 0x10431458, value: 9000000 }),
    // FOV-path (bCheckFOV=1) caps + stimulus.
    fovVisScale:     Object.freeze({ address: 0x10429c48, value: 0.0078125 }),
    fovCapPlayer:    Object.freeze({ address: 0x10431478, value: 16000000 }),
    fovCapNpc:       Object.freeze({ address: 0x10431474, value: 12000000 }),
    stimHi:          Object.freeze({ address: 0x10431418, value: 0.8 }),  // double
    stimLo:          Object.freeze({ address: 0x10431468, value: 0.17 }), // double
    stimBias:        Object.freeze({ address: 0x1042b8e8, value: 0.2 }),  // double
    // Trace-path gates + geometry.
    nearSplit:       Object.freeze({ address: 0x10430a64, value: 1000000 }),
    cornerGate:      Object.freeze({ address: 0x10431454, value: 250000 }),
    topCenterHeight: Object.freeze({ address: 0x10431418, value: 0.8 }),  // double
    decayCapFactor:  Object.freeze({ address: 0x1042ac10, value: 0.5 }),  // double
    decayRand:       Object.freeze({ address: 0x1042ac10, value: 0.5 }),
    // PickTarget aim gate.
    pickDistCap:     Object.freeze({ address: 0x10430a5c, value: 4000000 }),
    // TestCanSeeMe distance/cone.
    canSeeMeDist:    Object.freeze({ address: 0x10430a90, value: 360.0 }),
    canSeeMeDotSq:   Object.freeze({ address: 0x10429c50, value: 1.0 }),
    canSeeMeCone:    Object.freeze({ address: 0x10429878, value: 0.25 }),
    // AICanSee formula.
    aiAngMul:        Object.freeze({ address: 0x10431650, value: 64 }),
    aiDegScale:      Object.freeze({ address: 0x10431640, value: 114.59155902616465 }),
    aiRotToDeg:      Object.freeze({ address: 0x10431630, value: 1.52587890625e-05 }),
    aiFullCircle:    Object.freeze({ address: 0x10430a90, value: 360 }),
    aiFillRatio:     Object.freeze({ address: 0x10431660, value: 0.0003046792916483 }),
    aiDistFloor:     Object.freeze({ address: 0x104298a0, value: 1 }),
    aiCylDist:       Object.freeze({ address: 0x10431620, value: 22500 }),
    aiCylKeep:       Object.freeze({ address: 0x1042abf8, value: 0.75 }),
    aiCylKeepF32:    Object.freeze({ address: 0x1043161c, value: 0.75 }),
    wrapLo:          Object.freeze({ address: 0x10431674, value: -180 }),
    wrapPeriod:      Object.freeze({ address: 0x10431670, value: 360 }),
    wrapHi:          Object.freeze({ address: 0x1043166c, value: 180 }),
  }),
});

// ---------------------------------------------------------------------------
// x87 plumbing — identical model to script-pawn-locomotion.mjs: intermediates
// stay on the 80-bit stack, every dword store rounds once to float32.
// ---------------------------------------------------------------------------

const ld = x87load;
const st = x87store;
const d64io = new DataView(new ArrayBuffer(8));
const ld64 = v => {
  d64io.setFloat64(0, v, true);
  const lo = d64io.getUint32(0, true), hi = d64io.getUint32(4, true);
  const e = (hi >>> 20) & 0x7ff, m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e === 0x7ff) throw new Error('Pawn perception hit a nonfinite float64 operand');
  return { neg: hi >>> 31, sig: e ? m | (1n << 52n) : m, exp: e ? e - 1075 : -1074 };
};

const ZERO = ld(0), D1 = ld64(1), D05 = ld64(0.5), D08 = ld64(0.8),
  D017 = ld64(0.17), D02 = ld64(0.2);

const sub = (a, b) => x87add(a, x87neg(b));

/** FCOM/FUCOM status flags: C0 below, C3 equal, both when unordered. */
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
const ltU = (a, b) => x87compare(a, b).c0 === 1;       // test ah,1
const leU = (a, b) => { const f = x87compare(a, b); return (f.c0 | f.c3) === 1; };
const gtU = (a, b) => !leU(a, b);                       // test ah,0x41 -> jne

const dot3 = (a, b) => x87add(
  x87add(x87mul(ld(a[0]), ld(b[0])), x87mul(ld(a[1]), ld(b[1]))),
  x87mul(ld(a[2]), ld(b[2])));                          // 80-bit dot, no store
const magsq3 = v => x87add(
  x87add(x87mul(ld(v[0]), ld(v[0])), x87mul(ld(v[1]), ld(v[1]))),
  x87mul(ld(v[2]), ld(v[2])));

// The sums and products of losWorker and its callers run in the Rust core's callers.rs once the script VM kernel is loaded
// (docs/live-heap.md "Cut: x87 math in Rust"); the BigInt expressions are the reference it is compared with
// (scripts/validate-x87-callers-kernel.mjs), and run where the kernel is not loaded.
/** The BigInt expressions, the reference of callers.rs's los_* (scripts/validate-x87-callers-kernel.mjs). */
export const losReference = {
  /** st(magsq3(v)). */
  magsq3: v => st(magsq3(v)),
  /** st(x87mul(s, s)) with s = x87mul(ld(a), ld(b)) held extended. */
  squareProduct: (a, b) => { const s = x87mul(ld(a), ld(b)); return st(x87mul(s, s)); },
  /** The FOV path's Stimulus (0x103bec11): ((forward . SafeNormal(delta)) - PeripheralVision) * (0.8 above zero, else 0.17) + 0.2. */
  stimulus: (delta, forward, peripheral) => {
    const unit = x87safeNormal(delta);
    const dot = dot3(forward, unit);
    const t = sub(dot, ld(peripheral));
    const tIsPos = !(x87compare(t, ZERO).c0 === 1 || x87compare(t, ZERO).c3 === 1);
    const k = tIsPos ? D08 : D017;
    return st(x87add(x87mul(t, k), D02));
  },
  /** The FOV path's distance: (distSq + (|dz| / divisor)^2) / Stimulus^2 with the quotient stored first. */
  scaled: (distSq, dzAbs, divisor, stimulus) => {
    const dzScaled = st(x87div(ld(dzAbs), ld(divisor)));
    return st(x87div(
      x87add(ld(distSq), x87mul(ld(dzScaled), ld(dzScaled))),
      x87mul(ld(stimulus), ld(stimulus))));
  },
};
const los = () => scriptVmKernel?.los ?? losReference;
const magsqStored = v => los().magsq3(v);
const squareProduct = (a, b) => los().squareProduct(a, b);
/** st(x87mul(ld(a), ld(a))). */
const squareStored = a => scriptVmKernel ? scriptVmKernel.square(a) : st(x87mul(ld(a), ld(a)));
const fovStimulus = (delta, forward, peripheral) => los().stimulus(delta, forward, peripheral);
const fovScaledDistance = (distSq, dzAbs, divisor, stimulus) => los().scaled(distSq, dzAbs, divisor, stimulus);

const subVec = (a, b) => [f32(a[0] - b[0]), f32(a[1] - b[1]), f32(a[2] - b[2])];

/** Numeric value of an x87-double object (53-bit sig fits in a JS double). */
const x87toDouble = v => {
  if (v.nan !== undefined) return NaN;
  if (v.inf) return v.neg ? -Infinity : Infinity;
  if (v.sig === 0n) return v.neg ? -0 : 0;
  const n = Number(v.sig);
  return (v.neg ? -n : n) * 2 ** v.exp;
};

/* appSqrt is a cdecl `double appSqrt(double)` (Core export): the caller stores
 * the operand to a double (fstp qword), the body does `fld qword; fsqrt`, and
 * the 80-bit result is re-stored to a double when it becomes the appAtan arg.
 * Model: double-round the input, FSQRT at 80-bit, double-round the result. */
const appSqrt = v => x87storeDouble(x87sqrt(x87storeDouble(v)));

// ---------------------------------------------------------------------------
// Field access — the bodies read/write the pawn's script-declared fields.  The
// service layer resolves names to the reflected properties (soundField); the
// level-graph names (XLevel/Level/PawnList/NetMode/Model/Engine) map onto the
// level container exactly as the native graph splits them.
// ---------------------------------------------------------------------------

const rd = (services, obj, name) => services.read(obj, name);
const wr = (services, obj, name, value) => services.write(obj, name, value);

/** UModel::FastLineCheck — returns byte, nonzero = clear. */
function fastLine(services, model, end, start) {
  if (!model) throw new Error('Original LOS worker requires the live level model');
  return Boolean(services.fastLineCheck(model, end.map(Math.fround), start.map(Math.fround)) & 0xff);
}

/** The trace-section success that stamps the LastSeen block (0x103bf4c7):
 * LastSeeingPos = this.Location and LastSeenPos = this->Enemy.Location.  Only
 * the dedicated enemy-path traces reach it; the corner/top/far paths return at
 * 0x103bf50d / 0x103bf172 without stamping. */
function stampLastSeen(services, viewer, vLoc, enemy) {
  wr(services, viewer, 'LastSeeingPos', vLoc);
  if (enemy) wr(services, viewer, 'LastSeenPos', rd(services, enemy, 'Location'));
  return 1;
}

/**
 * The shared sight worker (Engine 0x103beb50):
 *   bool losWorker(this=pawn, other, bCheckFOV, bIgnoreDistance)
 * Reach the level model through viewer.xLevel->Model (xLevel+0xac -> +0x98).
 */
function losWorker(viewer, other, bCheckFOV, bIgnoreDistance, services, level) {
  if (!other) return 0;
  // other == this->Enemy forces bCheckFOV=0 before the flag is touched.
  const enemy = rd(services, viewer, 'Enemy');
  const isEnemy = other === enemy;
  const checkFOV = bCheckFOV && !isEnemy;
  const vLoc = rd(services, viewer, 'Location');
  const oLoc = rd(services, other, 'Location');
  let bLOSflag = Boolean(rd(services, viewer, 'bLOSflag'));
  if (checkFOV) {                       // toggle +0x318 bit 0x80000
    bLOSflag = !bLOSflag;
    wr(services, viewer, 'bLOSflag', bLOSflag);
  }
  const delta = subVec(oLoc, vLoc);
  const distSq = magsqStored(delta);
  const isPawn = services.isA(other, 'Pawn');
  const isPlayer = Boolean(rd(services, viewer, 'bIsPlayer'));
  const model = services.model(level);

  let cap, scaledOrDist;
  if (!checkFOV) {
    // Flat path 0x103bef60: (vis+16)*0.015 clamped to 1, scaled 5000/4000.
    if (isPawn) {
      const vis = Number(rd(services, other, 'Visibility')) & 0xff;
      const visScale = Math.min((vis + 16) * 0.015, 1);
      cap = Math.min(squareProduct(visScale, isPlayer ? 5000 : 4000), isPlayer ? 25000000 : 16000000);
    } else {
      cap = 9000000;                    // non-pawn target: fixed 0x10431458
    }
    if (distSq > cap && !bIgnoreDistance) return 0;
    scaledOrDist = distSq;
  } else {
    // FOV path 0x103bec11: vis*(1/128) clamped to 1, scaled by SightRadius.
    if (isPawn) {
      const vis = Number(rd(services, other, 'Visibility')) & 0xff;
      const visScale = Math.min(vis * 0.0078125, 1);
      cap = Math.min(squareProduct(visScale, rd(services, viewer, 'SightRadius')), isPlayer ? 16000000 : 12000000);
    } else {
      const sr = rd(services, viewer, 'SightRadius');
      cap = squareStored(sr);
    }
    // First gate is unconditional: distSq > cap -> return 0 (no bIgnore here).
    if (distSq > cap) return 0;
    // Stimulus: dot = forward(Rotation) . unit(delta); Stimulus=(dot-PV)*k+0.2.
    const fwd = fcoordsAxes(rd(services, viewer, 'Rotation'))[1];
    const stimulus = fovStimulus(delta, fwd, rd(services, viewer, 'PeripheralVision'));
    wr(services, viewer, 'Stimulus', stimulus);
    if (!(stimulus > 0)) return 0;
    // dz-scaled distance: (distSq + (|dz|/max(Skill+1,1))^2) / Stimulus^2.
    const dzAbs = Math.abs(oLoc[2] - vLoc[2]);
    const divisor = Math.max(Number(rd(services, viewer, 'Skill')) + 1, 1);
    scaledOrDist = fovScaledDistance(distSq, dzAbs, divisor, stimulus);
    if (scaledOrDist > cap && !bIgnoreDistance) return 0;
    wr(services, viewer, 'Stimulus', 1);          // 0x103bee56 reseeds it to 1.0
    // The trace section reads [ebp+8] = scaled (overwritten for checkFOV=1).
  }
  const scaledOrDistFinal = scaledOrDist;
  const baseEye = rd(services, viewer, 'BaseEyeHeight');
  const eye = [vLoc[0], vLoc[1], f32(vLoc[2] + baseEye)];

  if (isEnemy) {
    // Enemy: eye->loc then feet->loc (0x103beed6/0x103bef1f); both stamp.
    if (fastLine(services, model, oLoc, eye)) return stampLastSeen(services, viewer, vLoc, enemy);
    if (fastLine(services, model, oLoc, vLoc)) return stampLastSeen(services, viewer, vLoc, enemy);
    // Blocked enemy falls to the near/far split (0x103bef2c); far -> return 0.
    if (!(scaledOrDistFinal <= 1000000 || bIgnoreDistance)) return 0;
    return nearPath(viewer, other, oLoc, eye, distSq, scaledOrDistFinal,
      checkFOV, bIgnoreDistance, bLOSflag, isPawn, services, model);
  }

  // Non-enemy near/far split (0x103bf08c).
  if (scaledOrDistFinal <= 1000000 || bIgnoreDistance) {
    return nearPath(viewer, other, oLoc, eye, distSq, scaledOrDistFinal,
      checkFOV, bIgnoreDistance, bLOSflag, isPawn, services, model);
  }
  // Far path (0x103bf0ab): pawn decay then a direct eye->loc trace.
  if (isPawn) {
    if (!bLOSflag && scaledOrDistFinal > cap * 0.5) return 0;
    // NPC rand gate 0x103bf10b: fcomp rand vs 0.5, CF=1 (rand<0.5) -> return 0,
    // CF=0 (rand>=0.5) -> 0x103bf138 direct eye->loc trace.
    if (!isPlayer && services.rand() < 0.5) return 0;
  }
  return fastLine(services, model, oLoc, eye) ? 1 : 0;
}

/** The near path (0x103bf191): gated top-center trace then the corner loop.
 * Returns 1 on the first clear FastLineCheck (0x103bf50d — no stamp). */
function nearPath(viewer, other, oLoc, eye, distSq, scaledOrDist,
                  checkFOV, bIgnoreDistance, bLOSflag, isPawn, services, model) {
  // Top-center runs when checkFOV==0 OR bLOSflag==0 (0x103bf1a9 gate).
  if (!(checkFOV && bLOSflag)) {
    const ch = rd(services, other, 'CollisionHeight');
    const top = [oLoc[0], oLoc[1], f32(oLoc[2] + 0.8 * ch)];
    if (fastLine(services, model, top, eye)) return 1;
  }
  // Corner gate: scaledOrDist<=250000 || bIgnoreDistance, and target is a Pawn.
  if (!((scaledOrDist <= 250000 || bIgnoreDistance) && isPawn)) return 0;
  const cr = rd(services, other, 'CollisionRadius');
  const cp = [
    [f32(oLoc[0] - cr), f32(oLoc[1] + cr), oLoc[2]],
    [f32(oLoc[0] + cr), f32(oLoc[1] + cr), oLoc[2]],
    [f32(oLoc[0] - cr), f32(oLoc[1] - cr), oLoc[2]],
    [f32(oLoc[0] + cr), f32(oLoc[1] - cr), oLoc[2]],
  ];
  // Skip the argmin/argmax |cp|^2 corners (squared distance from world origin).
  const mag = cp.map(c => magsqStored(c));
  let iMax = 0, iMin = 0, bMax = mag[0], bMin = mag[0];
  for (let i = 1; i < 4; i++) {
    if (gtU(ld(mag[i]), ld(bMax))) { bMax = mag[i]; iMax = i; }
    else if (ltU(ld(mag[i]), ld(bMin))) { bMin = mag[i]; iMin = i; }
  }
  // Per-frame corner budget (ebx = post-toggle bLOSflag): when checkFOV, a set
  // flag skips one eligible corner then clears; a clear flag traces then sets.
  let budget = bLOSflag;
  for (let i = 0; i < 4; i++) {
    if (i === iMin || i === iMax) continue;
    if (checkFOV && budget) { budget = false; continue; }
    if (fastLine(services, model, cp[i], eye)) return 1;
    budget = true;
  }
  return 0;
}

/** APawn.ShowSelf103c0410: walk the live PawnList and use the original LOS
 * worker before checked SeePlayer dispatch. The caller owns bIsPlayer/hidden
 * admission; this helper neither adds filters nor resets SightCounter.
 * Evidence: docs/script-pawn-tick-visibility.md. */
export function showPawnSelf(pawn,services) {
  const level=services.level(pawn),info=services.levelInfo(level);
  if(!info||!services.isA(info,'LevelInfo'))throw new Error('ShowSelf requires the original LevelInfo');
  let listener=services.pawnList(level);
  while(listener) {
    if(listener!==pawn) {
      const counter=rd(services,listener,'SightCounter');
      if((counter<0||Number.isNaN(counter))&&services.isProbing(listener,'SeePlayer')&&
        losWorker(listener,pawn,1,0,services,services.level(listener))) {
        const fn=services.findFunctionChecked(listener,'SeePlayer');
        services.processEvent(listener,fn,[pawn]);
      }
    }
    listener=services.nextPawn(listener);
  }
}

/** APawn.CheckEnemyVisible103c0280. UObject validity and checked event lookup
 * remain explicit services; a missing validity binding cannot admit an enemy.
 * The LOS worker owns position/Stimulus writes, this helper owns the timestamp. */
export function checkPawnEnemyVisible(pawn,services) {
  const enemy=rd(services,pawn,'Enemy');
  if(!enemy)return;
  if(typeof services.isValid!=='function')throw new Error('CheckEnemyVisible requires original UObject validity');
  if(!services.isValid(enemy))services.failAssert(0x6b4);
  if(!losWorker(pawn,rd(services,pawn,'Enemy'),0,0,services,services.level(pawn))) {
    const fn=services.findFunctionChecked(pawn,'EnemyNotVisible');
    services.processEvent(pawn,fn,[]);
  } else {
    const seconds=services.timeSeconds(services.level(pawn));
    if(typeof seconds!=='number')throw new Error('CheckEnemyVisible requires the native double level clock');
    wr(services,pawn,'LastSeenTime',f32(seconds));
  }
}

// ---------------------------------------------------------------------------
// Exec wrappers — argument evaluation order is preserved; outs are written
// through their references only where the body writes them.
// ---------------------------------------------------------------------------

function args(call) {
  const out = [];
  for (let i = 0; i < call.argumentCount; i++) out.push(call.evaluateArgument(i));
  return out;
}
const val = a => (a && a.reference ? a.get() : a);
const out = (a, value) => { if (a && a.reference) a.set(value); };

/** native(514) final function bool LineOfSightTo(actor Other, optional bool bIgnoreDistance) */
export function execLineOfSightTo(call, services) {
  const a = args(call);
  const other = val(a[0]);
  // The exec reads arg2 and computes bIgnoreDistance = (arg == 1) via sete.
  const bIgnoreDistance = call.argumentCount > 1 ? Number(val(a[1])) === 1 : false;
  const level = services.level(call.receiver);
  return losWorker(call.receiver, other, 0, bIgnoreDistance ? 1 : 0, services, level);
}

/** native(533) final function bool CanSee(actor Other) */
export function execCanSee(call, services) {
  const a = args(call);
  const other = val(a[0]);
  const level = services.level(call.receiver);
  return losWorker(call.receiver, other, 1, 0, services, level);
}

/** The PlayerCanSeeMe per-viewer test (0x103ba8a0): called on the target actor
 * with the candidate viewer pawn.  Returns nonzero when the viewer can see it. */
function testCanSeeMe(actor, viewer, services, level) {
  // viewer+0x60c == actor -> the viewer's tracked target is us. +0x60c is the
  // PlayerPawn ViewTarget field; a non-player pawn has another field there, so
  // the early-out only applies to players (the native reads the dword raw —
  // for an NPC it is some unrelated field that never equals the target).
  if (services.isA(viewer, 'PlayerPawn') && rd(services, viewer, 'ViewTarget') === actor) return 1;
  const aLoc = rd(services, actor, 'Location'), pLoc = rd(services, viewer, 'Location');
  const delta = subVec(aLoc, pLoc);
  const distSq = magsqStored(delta);
  const aCR = rd(services, actor, 'CollisionRadius');
  const cap = st(x87mul(x87add(ld(aCR), ld64(3.6)), ld64(100000)));
  if (!(distSq < cap)) return 0;
  if (!rd(services, viewer, 'bBehindView')) {
    // +/-60 deg biconal cone: (forward . delta)^2 >= distSq*0.25.  The dot is
    // unnormalized so dot^2 = cos^2*distSq and the test reduces to cos>=0.5.
    const fwd = fcoordsAxes(rd(services, viewer, 'ViewRotation'))[1];
    const dot = dot3(fwd, delta);
    if (!(st(x87mul(dot, dot)) >= st(x87mul(ld(distSq), ld(0.25))))) return 0;
  }
  return losWorker(viewer, actor, 0, 0, services, level);
}

/** native(532) final function bool PlayerCanSeeMe() */
export function execPlayerCanSeeMe(call, services) {
  const level = services.level(call.receiver);
  const actor = call.receiver;
  const levelInfo = services.levelInfo(level);
  const netMode = Number(rd(services, levelInfo, 'NetMode')) & 0xff;
  // netMode==0 -> net player list; netMode==3 && (bNetTemporary||RemoteRole==4)
  // -> net player list; otherwise the pawn list.
  let useNetList;
  if (netMode === 0) useNetList = true;
  else if (netMode === 3) {
    useNetList = Boolean(rd(services, actor, 'bNetTemporary'))
      || (Number(rd(services, actor, 'RemoteRole')) & 0xff) === 4;
  } else useNetList = false;
  if (useNetList) {
    for (const viewer of services.netPlayers(level) || []) {
      if (viewer && testCanSeeMe(actor, viewer, services, level)) return 1;
    }
    return 0;
  }
  for (let viewer = services.pawnList(level); viewer; viewer = services.nextPawn(viewer)) {
    if (testCanSeeMe(actor, viewer, services, level)) return 1;
  }
  return 0;
}

/**
 * PickTarget/PickAnyTarget candidate loop (0x103baca0 / 0x103bb130):
 * score = (FireDir . delta)/sqrt(distSq), winner iff score>*bestAim && worker.
 * PickTarget walks the pawn list (self/health/bProjTarget/team filters);
 * PickAnyTarget walks the level Actors[] and excludes pawns (non-pawn targets).
 */
function pickTarget(call, services, anyTarget) {
  const a = args(call);
  const aimRef = a[0], distRef = a[1];
  const fireDir = val(a[2]), projStart = val(a[3]);
  const viewer = call.receiver;
  const level = services.level(viewer);
  const levelInfo = services.levelInfo(level);
  let best = Number(val(aimRef)) || 0, winner = null, winnerDist = 0;

  const candidates = anyTarget
    ? (services.levelActors(level) || []).slice(1)    // skip Actors[0]=LevelInfo
    : iterPawnList(services, level);
  for (const cand of candidates) {
    if (!cand) continue;
    if (anyTarget) {
      // PickAnyTarget: bProjTarget + NOT a Pawn (isA(Pawn) skips the candidate).
      if (!truthy(rd(services, cand, 'bProjTarget'))) continue;
      if (services.isA(cand, 'Pawn')) continue;
    } else {
      // PickTarget filters (0x103badf8..0x103baf0e), in native order.
      if (cand === viewer) continue;
      if (!(Number(rd(services, cand, 'Health')) > 0)) continue;
      if (!truthy(rd(services, cand, 'bProjTarget'))) continue;
      // Candidates require Level->GameInfo; a team game then skips same-team.
      if (!rd(services, levelInfo, 'Game')) continue;
      if (services.sameTeam(viewer, cand, levelInfo)) continue;
    }
    const cLoc = rd(services, cand, 'Location');
    const delta = subVec(cLoc, projStart);
    const distSq = magsqStored(delta);
    const dot = dot3(fireDir, delta);
    if (x87compare(dot, ZERO).c0 === 1 || x87compare(dot, ZERO).c3 === 1) continue; // dot<=0
    if (!(distSq < 4000000)) continue;
    const score = st(x87div(dot, x87sqrt(x87storeDouble(ld(distSq)))));
    if (!(score > best)) continue;
    if (!losWorker(viewer, cand, 0, 0, services, level)) continue;
    best = score; winner = cand; winnerDist = st(x87sqrt(x87storeDouble(ld(distSq))));
  }
  if (winner) {
    out(aimRef, best);
    out(distRef, winnerDist);
  }
  return winner;
}
function* iterPawnList(services, level) {
  for (let p = services.pawnList(level); p; p = services.nextPawn(p)) yield p;
}
const truthy = v => v === true || (typeof v === 'number' && v !== 0);

/** native(531) final function pawn PickTarget(out float bestAim, out float bestDist, vector FireDir, vector projStart) */
export function execPickTarget(call, services) {
  return pickTarget(call, services, false);
}

/** native(534) final function actor PickAnyTarget(out float bestAim, out float bestDist, vector FireDir, vector projStart) */
export function execPickAnyTarget(call, services) {
  return pickTarget(call, services, true);
}

/** The angular trapezoid (0x103c7360), returned as the x87 value it leaves in ST0 (not stored): the delta is wrapped to +/-180 in
 * extended precision (fadd/fsub 360, no store between), made absolute, and the plateau (halfwidth - extent) * 0.5 is kept both in
 * extended (the edge, plateau + extent) and as the float32 stored copy the plateau compare and the ramp use. Inside the plateau
 * 1.0, beyond the edge 0.0, between 1 - (|delta| - plateau) / extent. */
function trapezoid(delta, halfwidth, extent) {
  let d = ld(delta);
  const low = ld(-180), high = ld(180), period = ld(360);
  if (d.nan !== undefined) throw new Error('AICanSee trapezoid with an unordered angle never ends in the original');
  while (leU(d, low)) d = x87add(d, period);
  while (gtU(d, high)) d = sub(d, period);
  if (ltU(d, ZERO)) d = x87neg(d);
  const plateau = x87mul(sub(ld(halfwidth), ld(extent)), D05);
  const stored = ld(st(plateau));
  const edge = x87add(plateau, ld(extent));
  if (!leU(d, edge)) return ZERO;
  if (leU(d, stored)) return ld(1);
  return sub(D1, x87div(sub(d, stored), ld(extent)));
}

/** appAtan is a cdecl `double appAtan(double)` (Core export, FPATAN on real
 * hardware). The atan value is a transcendental — the service seam lets the
 * validator inject the CrossOver-measured oracle; production falls back to the
 * host Math.atan (a documented last-ULP residual, docs/script-pawn-perception.md). */
function appAtan(services, x87double) {
  // Core appAtan is `fld qword; fld1; fpatan; ret`: its result stays in ST0 at 80 bits. A host that has the hardware's unrounded
  // value gives it as services.atanExt; the default is the host's double atan.
  if (typeof services.atanExt === 'function') return services.atanExt(x87toDouble(x87double));
  const atan = typeof services.atan === 'function' ? services.atan : Math.atan;
  return ld64(atan(x87toDouble(x87double)));
}

/** native(705) final function float AICanSee(actor other, optional float visibility,
 * optional bool bCheckVisibility, optional bool bCheckDir, optional bool bCheckCylinder,
 * optional bool bCheckLOS) — visibility worker 0x103c6ab0. */
export function execAICanSee(call, services) {
  const a = args(call);
  const other = val(a[0]);
  if (!other) return 0;
  // execAICanSee (Engine.dll 0x103c8270) pre-stores each slot before stepping its token: visibility 1.0f (0x3f800000), then the flags 1, 1, 0, 1.
  // EX_Nothing (undefined here) leaves the slot, as an omitted tail does: FindBestEnemy's CheckEnemyParams (AICanSee(checkPawn, , false, false,
  // true, true)), the order, beam and food tests skip the visibility and see with 1.0.
  const opt = (i, fallback) => { const v = i < call.argumentCount ? val(a[i]) : undefined; return v === undefined ? fallback : v; };
  const visibility = Number(opt(1, 1));
  const bCheckVisibility = Boolean(opt(2, true));
  const bCheckDir = Boolean(opt(3, true));
  const bCheckCylinder = Boolean(opt(4, false));
  const bCheckLOS = Boolean(opt(5, true));
  const viewer = call.receiver;
  const level = services.level(viewer);
  if (!(visibility > 0)) return 0;
  if (!truthy(rd(services, other, 'bDetectable'))) return 0;   // other+0x2c bit0

  const vLoc = rd(services, viewer, 'Location');
  const oLoc = rd(services, other, 'Location');
  const baseEye = rd(services, viewer, 'BaseEyeHeight');
  // eye = this.Location with z + BaseEyeHeight stored float32 (0x103c6b1f..28). The deltas other - eye stay extended (fsub dword
  // from each coordinate); their float32 stores (fst/fstp [ebp-0x28..0x20]) are the vector the rotation and the LOS traces use,
  // while the squared distance sums the extended squares and is stored as a DOUBLE (fstp qword [ebp-0x44]).
  const eye = [vLoc[0], vLoc[1], f32(vLoc[2] + baseEye)];
  const deltaX = [sub(ld(oLoc[0]), ld(eye[0])), sub(ld(oLoc[1]), ld(eye[1])), sub(ld(oLoc[2]), ld(eye[2]))];
  const delta = deltaX.map(st);
  let distSq = x87storeDouble(x87add(x87add(x87mul(deltaX[0], deltaX[0]), x87mul(deltaX[1], deltaX[1])), x87mul(deltaX[2], deltaX[2])));
  if (ltU(distSq, D1)) distSq = D1;                          // fcomp qword [1.0]: below (or unordered) -> exactly 1.0

  // (cr^2 + ch^2) / distSq: cr^2 stays extended, ch^2 is stored as a double (fstp qword [ebp-0x7c]); the ratio is not stored.
  const cr = rd(services, other, 'CollisionRadius'), ch = rd(services, other, 'CollisionHeight');
  const cr2 = x87mul(ld(cr), ld(cr));
  const ch2 = x87storeDouble(x87mul(ld(ch), ld(ch)));
  const ratio = x87div(x87add(ch2, cr2), distSq);
  if (!gtU(ratio, ld(rd(services, viewer, 'MinAngularSize')))) return 0;
  // bCheckCylinder is forced off unless the target fills the view (ratio vs the double 0.0003046792916483).
  const cyl = bCheckCylinder && !ltU(ratio, ld64(0.0003046792916483));

  // acc = f32(visibility * ratio * 64)
  let acc = st(x87mul(x87mul(ld(visibility), ratio), ld64(64)));

  if (bCheckDir && acc > 0) {
    const aspect = Number(rd(services, viewer, 'AspectRatio'));
    const halfFovV = aspect > 0
      ? st(x87div(ld(rd(services, viewer, 'AIHorizontalFOV')), ld(aspect))) : 0;
    // appAtan(appSqrt(extent^2 / distSq)) * 114.59...: appSqrt stores its operand and its result as doubles; appAtan's extended
    // result is multiplied unrounded and the product is stored float32.
    const hExt = st(x87mul(appAtan(services, appSqrt(x87div(cr2, distSq))), ld64(114.59155902616465)));
    const vExt = st(x87mul(appAtan(services, appSqrt(x87div(ch2, distSq))), ld64(114.59155902616465)));
    // viewRot = (player?ViewRotation:Rotation) + AIAddViewRotation
    const isPlayer = services.isA(viewer, 'PlayerPawn');
    const base = isPlayer ? rd(services, viewer, 'ViewRotation') : rd(services, viewer, 'Rotation');
    const add = rd(services, viewer, 'AIAddViewRotation');
    const viewRot = [f32(base[0] + add[0]), f32(base[1] + add[1]), f32(base[2] + add[2])];
    const axes = fcoordsAxes(viewRot);
    // transform the world delta into view space and get its rotator.
    const dirView = [st(dot3(axes[1], delta)), st(dot3(axes[2], delta)), st(dot3(axes[3], delta))];
    // FVector::Rotation is transcendental (fpatan) — a service seam lets the
    // validator inject the hardware rotator; production falls back to host atan2.
    const toRot = typeof services.vectorToRotator === 'function' ? services.vectorToRotator : vectorToRotator;
    const rot = toRot(dirView);                            // [pitch,yaw,roll]
    const yawDeg = st(x87mul(ld(rot[1] * 360), ld(1.52587890625e-05)));
    const pitchDeg = st(x87mul(ld(rot[0] * 360), ld(1.52587890625e-05)));
    const yawTrap = trapezoid(yawDeg, Number(rd(services, viewer, 'AIHorizontalFOV')), hExt);
    acc = st(x87mul(yawTrap, ld(acc)));
    let pitchTrap = trapezoid(pitchDeg, halfFovV, vExt);
    // Near-target pitch floor (0x103c6e38): distSq < 22500 keeps at least 0.75 (the double compare, the float32 constant stored).
    if (ltU(distSq, ld64(22500)) && ltU(pitchTrap, ld64(0.75))) pitchTrap = ld(0.75);
    acc = st(x87mul(pitchTrap, ld(acc)));
  }

  if (bCheckVisibility && acc > 0) {
    acc = st(x87mul(actorVisibilityExtended(other,1,services),ld(acc))); // FST retains ST0 at 103c6e8a.
  }

  // clamp(acc - visibilityThreshold, 0, 1)
  acc = st(sub(ld(acc), ld(rd(services, viewer, 'VisibilityThreshold'))));
  if (!(acc >= 0)) acc = 0;
  else if (!(acc < 1)) acc = 1;

  if (bCheckLOS && acc > 0) {
    if (!losCheckAICanSee(viewer, other, cyl, services, level, oLoc, eye, delta)) acc = 0;
  }
  return acc;
}

/** The AICanSee LOS gate: SingleLineCheck (MultiLineCheck boundary) traces.
 * cyl==0 -> one point trace; cyl && PlayerPawn -> three vertical traces;
 * cyl && non-player -> top, bottom, then +/-perp*CR side traces. */
function losCheckAICanSee(viewer, other, cyl, services, level, oLoc, eye, delta) {
  const sl = (end) => services.singleLineCheck(level, viewer, other, end.map(Math.fround), eye.map(Math.fround));
  const isPlayer = services.isA(other, 'PlayerPawn');
  const cr = rd(services, other, 'CollisionRadius'), ch = rd(services, other, 'CollisionHeight');
  if (!cyl) {
    return sl(oLoc);
  }
  if (isPlayer) {
    // Cylindrical player: eye-height, top, bottom (three vertical traces).
    const beh = rd(services, other, 'BaseEyeHeight');
    if (sl([oLoc[0], oLoc[1], f32(oLoc[2] + beh)])) return true;
    if (sl([oLoc[0], oLoc[1], f32(oLoc[2] + ch)])) return true;
    if (sl([oLoc[0], oLoc[1], f32(oLoc[2] - ch)])) return true;
    return false;
  }
  // Non-player cylindrical fan: top, bottom, then loc +/- perp*CR where
  // perp = (dir.y, -dir.x, 0) on the eye->target direction.
  if (sl([oLoc[0], oLoc[1], f32(oLoc[2] + ch)])) return true;
  if (sl([oLoc[0], oLoc[1], f32(oLoc[2] - ch)])) return true;
  const dir = x87safeNormal([delta[0], delta[1], 0]);
  const px = f32(dir[1] * cr), py = f32(-dir[0] * cr);
  if (sl([f32(oLoc[0] + px), f32(oLoc[1] + py), oLoc[2]])) return true;
  if (sl([f32(oLoc[0] - px), f32(oLoc[1] - py), oLoc[2]])) return true;
  return false;
}
