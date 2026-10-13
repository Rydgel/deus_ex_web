/** Original AScriptedPawn::Tick, DeusEx.dll 0x100195a0 (vtable slot 25 at 0x10027688), with its helpers 0x10019e30 (agitation) and
 * 0x10019f60 (fear). Evidence and the reference cases: docs/script-scripted-pawn-tick.md; scripts/native-scripted-pawn-tick-oracle.py
 * runs the real bytes. The function is the Tick virtual of every ScriptedPawn: it runs the pawn's native timers and bookkeeping,
 * then calls AActor::Tick (actor-tick.mjs `tickStandaloneActor`), except when it destroys the pawn (bDisappear) and returns 1.
 *
 * Returns true when AActor::Tick is to run next, false when the pawn was destroyed (the caller returns 1).
 *
 * The arithmetic is the original's: float32 fields loaded to the 80-bit stack, each subtraction, multiplication and division in
 * extended precision, a float32 store where the code has an fst/fstp, and the comparisons on the unrounded stack value
 * (an `fst` and then `fcomp` compares the 80-bit result, not the stored float). FCOM flags: `test ah,1` is below or unordered,
 * `test ah,0x41` below-equal or unordered, `test ah,0x40` equal or unordered.
 */
import {
  x87load, x87add, x87neg, x87mul, x87div, x87sqrt, x87store, x87storeDouble, x87width,
} from './script-vm.mjs';

const f32 = Math.fround;
const ld = x87load, st = x87store;
const d64io = new DataView(new ArrayBuffer(8));
const ld64 = v => {
  d64io.setFloat64(0, v, true);
  const lo = d64io.getUint32(0, true), hi = d64io.getUint32(4, true);
  const e = (hi >>> 20) & 0x7ff, m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  return { neg: hi >>> 31, sig: e ? m | (1n << 52n) : m, exp: e ? e - 1075 : -1074 };
};
const sub = (a, b) => x87add(a, x87neg(b));
const ZERO = ld(0), ONE32 = ld(1), D1 = ld64(1), D4 = ld64(4), D5 = ld64(5), D01 = ld64(0.1), D_512 = ld64(0.001953125);
const F1200 = ld(1200), F005 = ld(f32(0.05));

/** FCOM status: C0 below, C3 equal, both set when unordered. */
const compare = (a, b) => {
  if (a.nan !== undefined || b.nan !== undefined) return { c0: 1, c3: 1 };
  if (a.inf || b.inf) {
    if (a.inf && b.inf) return { c0: 0, c3: a.neg === b.neg ? 1 : 0 };
    return a.inf ? { c0: a.neg ? 1 : 0, c3: 0 } : { c0: b.neg ? 0 : 1, c3: 0 };
  }
  let m;
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
const lt = (a, b) => compare(a, b).c0 === 1;                                   // test ah,1
const le = (a, b) => { const f = compare(a, b); return (f.c0 | f.c3) === 1; };   // test ah,0x41
const eq = (a, b) => compare(a, b).c3 === 1;                                   // test ah,0x40

/** `if (x <= 0) skip; x -= dt (fst); if (x < 0) x = 0` : the guarded timers. */
function countDown(get, set, name, dt) {
  const value = ld(get(name));
  if (le(value, ZERO)) return;
  const result = sub(value, ld(dt));
  set(name, st(result));
  if (lt(result, ZERO)) set(name, 0);
}

/** 0x10019e30: AgitationCheckTimer, AgitationTimer, and the alliances' AgitationLevel decay. */
function updateAgitation(actor, dt, services) {
  const { read, write } = services;
  const get = n => read(actor, n), set = (n, v) => write(actor, n, v);
  countDown(get, set, 'AgitationCheckTimer', dt);
  let decay;                                                     // st0 after 0x10019e6a..0x10019edc
  const timer = ld(get('AgitationTimer'));
  if (le(timer, ZERO)) decay = x87mul(ld(dt), ld(get('AgitationDecayRate')));
  else if (lt(timer, ld(dt))) {
    const ratio = x87div(timer, ld(dt));
    set('AgitationTimer', 0);
    decay = x87mul(sub(D1, ratio), x87mul(ld(dt), ld(get('AgitationDecayRate'))));
  } else {
    set('AgitationTimer', st(sub(timer, ld(dt))));
    decay = ZERO;
  }
  const flag = 0x08;                                             // bAlliancesChanged, bit 3 of the dword at 0x650
  if (!get('bAlliancesChanged') || le(decay, ZERO)) return;
  set('bAlliancesChanged', false);
  const alliances = get('AlliancesEx');
  const key = field => `deusex.scriptedpawn.allianceinfoex.${field}`;
  let changed = false;
  for (let i = 15; i >= 0; i--) {                                // edx walks from the last entry down
    const entry = alliances[i], name = entry[key('alliancename')];
    if (!name || name === 'None' || entry[key('bpermanent')]) continue;
    const level = ld(entry[key('agitationlevel')]);
    if (le(level, ZERO)) continue;
    set('bAlliancesChanged', true);
    changed = true;
    const result = sub(level, decay);
    entry[key('agitationlevel')] = st(result);
    if (lt(result, ZERO)) entry[key('agitationlevel')] = 0;
  }
  if (changed) set('AlliancesEx', alliances);
  void flag;
}

/** 0x10019f60: FearTimer and the FearLevel decay. */
function updateFear(actor, dt, services) {
  const { read, write } = services;
  const get = n => read(actor, n), set = n_v => write(actor, ...n_v);
  const timer = ld(get('FearTimer'));
  let decay;
  if (le(timer, ZERO)) decay = x87mul(ld(dt), ld(get('FearDecayRate')));
  else if (lt(timer, ld(dt))) {
    const ratio = x87div(timer, ld(dt));
    set(['FearTimer', 0]);
    decay = x87mul(sub(D1, ratio), x87mul(ld(dt), ld(get('FearDecayRate'))));
  } else {
    set(['FearTimer', st(sub(timer, ld(dt)))]);
    return;
  }
  if (le(decay, ZERO)) return;
  const level = ld(get('FearLevel'));
  if (le(level, ZERO)) return;
  const result = sub(level, decay);
  set(['FearLevel', st(result)]);
  if (lt(result, ZERO)) set(['FearLevel', 0]);
}

/** FindFunctionChecked on the pawn, then ProcessEvent: an event the class does not declare gets the original's NULL no-op. */
function event(actor, name, args, services) {
  if (services.findFunction && !services.findFunction(actor, name)) return;
  services.processEvent(actor, name, args);
}

export function scriptedPawnTick(actor, seconds, tickType, services) {
  const { read, write } = services;
  const get = n => read(actor, n), set = (n, v) => write(actor, n, v);
  const dt = f32(seconds);
  // 0x100195c5: a simulated or autonomous proxy, a pawn below ROLE_SimulatedProxy, or a time-only tick skips the work unless
  // bSimulatedPawn is set (the check passes the Super tick through in the other case).
  if (get('RemoteRole') === 3 || get('Role') < 2 || tickType === 1) {
    if (!get('bSimulatedPawn')) return true;
  }
  // 0x100195e8: seconds since the last render, as a float32, floored at 0 by a stored +0.
  const elapsed = sub(ld64(services.level.timeSeconds), ld(get('LastRenderTime')));
  let age = st(elapsed);
  if (lt(elapsed, ZERO)) age = 0;
  // 0x1001964e: bDisappear pawns leave when out of the world's stasis rules or unseen for over 5 seconds.
  if (get('bDisappear')) {
    if (services.inStasis(actor) || !le(ld(age), D5)) {
      services.destroyActor(actor, 0);
      return false;
    }
  }
  // 0x1001969b: PrePivot easing toward DesiredPrePivot over PrePivotTime.
  const prePivotTime = ld(get('PrePivotTime'));
  if (!le(prePivotTime, ZERO)) {
    const desired = get('DesiredPrePivot'), pivot = get('PrePivot');
    if (lt(ld(dt), prePivotTime)) {
      let dz = sub(ld(desired[2]), ld(pivot[2]));
      const dy = st(sub(ld(desired[1]), ld(pivot[1])));
      const dx = st(sub(ld(desired[0]), ld(pivot[0])));
      dz = x87mul(dz, ld(dt));
      const dy2 = st(x87mul(ld(dy), ld(dt)));
      const dx2 = st(x87mul(ld(dx), ld(dt)));
      const inverse = st(x87div(D1, prePivotTime));
      dz = x87mul(dz, ld(inverse));
      const dy3 = st(x87mul(ld(dy2), ld(inverse)));
      const dx3 = st(x87mul(ld(dx2), ld(inverse)));
      const z = st(x87add(dz, ld(pivot[2])));
      const y = st(x87add(ld(dy3), ld(pivot[1])));
      const x = st(x87add(ld(dx3), ld(pivot[0])));
      set('PrePivot', [x, y, z]);
      set('PrePivotTime', st(sub(prePivotTime, ld(dt))));
    } else {
      set('PrePivot', desired.slice());
      set('PrePivotTime', 0);
    }
  }
  // 0x10019798: the bleeding block below runs unless bTickVisibleOnly and the player is over 1200 units away.
  let bleed = true;
  if (get('bTickVisibleOnly') && !le(ld(get('DistanceFromPlayer')), F1200)) bleed = false;
  updateAgitation(actor, dt, services);
  updateFear(actor, dt, services);
  // AlarmTimer is not guarded: it always subtracts and floors at 0.
  {
    const result = sub(ld(get('AlarmTimer')), ld(dt));
    set('AlarmTimer', st(result));
    if (lt(result, ZERO)) set('AlarmTimer', 0);
  }
  if (get('Weapon')) set('WeaponTimer', st(x87add(ld(dt), ld(get('WeaponTimer')))));
  else if (!eq(ld(get('WeaponTimer')), ZERO)) set('WeaponTimer', 0);
  countDown(get, set, 'FireTimer', dt);
  countDown(get, set, 'SpecialTimer', dt);
  {
    const reload = ld(get('ReloadTimer'));
    if (!le(reload, ZERO) && get('Weapon')) set('ReloadTimer', st(sub(reload, ld(dt))));
    else set('ReloadTimer', 0);
  }
  countDown(get, set, 'AvoidWallTimer', dt);
  countDown(get, set, 'AvoidBumpTimer', dt);
  countDown(get, set, 'ObstacleTimer', dt);
  countDown(get, set, 'CloakEMPTimer', dt);
  countDown(get, set, 'TakeHitTimer', dt);
  countDown(get, set, 'CarcassCheckTimer', dt);
  {
    const timer = ld(get('PotentialEnemyTimer'));
    if (!le(timer, ZERO)) {
      const result = sub(timer, ld(dt));
      set('PotentialEnemyTimer', st(result));
      if (le(result, ZERO)) {
        set('PotentialEnemyTimer', 0);
        set('PotentialEnemyAlliance', services.noName ?? 'None');
      }
    }
  }
  countDown(get, set, 'BeamCheckTimer', dt);
  countDown(get, set, 'FutzTimer', dt);
  countDown(get, set, 'PlayerAgitationTimer', dt);
  {
    const timer = ld(get('DistressTimer'));
    if (!lt(timer, ZERO)) {
      const sum = x87add(ld(dt), timer);
      set('DistressTimer', st(sum));
      if (le(sum, ld(get('FearSustainTime')))) { /* keep counting */ } else set('DistressTimer', -1);
    }
  }
  // 0x10019b11: a pawn with a cloak reports its health against CloakThreshold every tick (the parameter's low bit).
  if (get('bHasCloak')) event(actor, 'EnableCloak', [get('Health') <= get('CloakThreshold')], services);
  // 0x10019b75: leaving the walking, accelerating, turning state clears the avoidance (and Bump's +4 on MoveTimer).
  if (get('bAdvancedTactics')) {
    const acceleration = get('Acceleration');
    const moving = !(eq(ld(acceleration[0]), ZERO) && eq(ld(acceleration[1]), ZERO) && eq(ld(acceleration[2]), ZERO));
    if (!(moving && get('Physics') === 1 && get('TurnDirection') !== 0)) {
      set('bAdvancedTactics', false);
      if (get('TurnDirection') !== 0) set('MoveTimer', st(sub(ld(get('MoveTimer')), D4)));
      set('ActorAvoiding', null);
      set('NextDirection', 0);
      set('TurnDirection', 0);
      set('bClearedObstacle', true);
      set('ObstacleTimer', 0);
    }
  }
  // 0x10019c20: a burning pawn is put out after BurnPeriod.
  if (get('bOnFire')) {
    const burn = x87add(ld(dt), ld(get('burnTimer')));
    set('burnTimer', st(burn));
    if (!lt(burn, ld(get('BurnPeriod')))) event(actor, 'ExtinguishFire', [], services);
  }
  if (!bleed) return true;
  // 0x10019c6a: bleeding drops at a rate that follows the pawn's speed.
  const rate = ld(get('BleedRate'));
  if (!le(rate, ZERO) && get('bCanBleed')) {
    let x = rate;
    if (lt(x, ZERO)) x = ZERO;
    else if (!lt(x, ONE32)) x = ONE32;
    const period = st(x87add(sub(D1, x), D01));
    const velocity = get('Velocity');
    const speed = x87sqrt(x87storeDouble(x87add(
      x87add(x87mul(ld(velocity[0]), ld(velocity[0])), x87mul(ld(velocity[1]), ld(velocity[1]))),
      x87mul(ld(velocity[2]), ld(velocity[2])))));
    let scaled = x87mul(speed, D_512);
    if (lt(scaled, F005)) scaled = F005;
    else if (!lt(scaled, ONE32)) scaled = ONE32;
    const threshold = st(x87div(ld(period), scaled));
    set('DropCounter', st(x87add(ld(dt), ld(get('DropCounter')))));
    while (!lt(ld(get('DropCounter')), ld(threshold))) {
      event(actor, 'SpurtBlood', [], services);
      set('DropCounter', st(sub(ld(get('DropCounter')), ld(threshold))));
    }
    set('BleedRate', st(sub(ld(get('BleedRate')), x87div(ld(dt), ld(get('ClotPeriod'))))));
  }
  if (le(ld(get('BleedRate')), ZERO)) {
    set('DropCounter', 0);
    set('BleedRate', 0);
  }
  return true;
}
