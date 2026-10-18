/** The 01_NYC_UNATCOIsland drivers of the Stage 5 census (scripts/census-stage5.mjs), added to the session's DRIVERS. Same rules as census-stage5-session.mjs. */
import {Undriven, PI, near} from './census-stage5-drivers.mjs';
import {DRIVERS, ok} from './census-stage5-session.mjs';

const carcasses = c => c.actors().filter(a => /carcass$/.test(c.runtime.instance(a).cls.record.key));
const stateName = (c, a) => c.state(a).split('.').pop();
const HOSTILE = /attack|alert|flee|seek|search|hunt|react|run|fear|disabled|stunn/i;
/** What a pawn does about the player: its Enemy or a reacting state (not the boot state, nor the one it already stood in). */
const reacting = (c, pawn, before) => Boolean(c.read(pawn, 'Enemy')) || (HOSTILE.test(stateName(c, pawn)) && stateName(c, pawn) !== before);
async function armed(c, cls = 'WeaponPistol') { const w = await c.give(cls); await c.equip(w); return w; }
const ammoOf = (c, weapon) => c.read(c.read(weapon, 'AmmoType'), 'AmmoAmount');
/** `count` free packs of an ammo class (`summon`, then the public frob path: the pickup merges into the carried ammo). */
async function pack(c, cls, count) {
  for (let i = 0; i < count; i++) { c.exec(`summon ${cls}`); c.frames(5); const box = c.byClass(cls).filter(a => !c.read(a, 'Owner')).at(-1); if (!box) throw new Undriven(`no ${cls} summoned`); await c.take(box); }
}
/** Walk toward `to` from `from` (a real movement: Touches and conversations follow it), pressing Enter for conversations, until `until()` or `seconds`. */
function walkAndTalk(c, from, to, seconds, until) {
  c.stand(from, to); c.frames(20);
  c.fixture.driveLegacy({forward: 1});
  for (let i = 0; i < seconds * 2 && !until?.(); i++) {
    c.frames(30);
    if (i % 2) { c.game.windowKey('Enter', true); c.game.windowKey('Enter', false); }
  }
  c.fixture.driveLegacy({forward: 0});
}
const commander = c => c.actor('TerroristCommander0');
/** The commander's room: DL_LeaderNotKilled sits inside it (2887,38,2494); the player walks in from there. */
const toCommander = (c, seconds, until) => walkAndTalk(c, [2887, 38, 2494 + 45], c.pos(commander(c)), seconds, until);
const forward = (c, a) => { const yaw = c.read(a, 'Rotation')[1] / 65536 * 2 * PI; return [Math.cos(yaw), Math.sin(yaw)]; };
/** The player's NanoKey ring: the key IDs on `KeyList` (NanoKeyRing.HasKey walks the same list). */
function keyIds(c) { const ids = []; for (let k = c.read(c.player(), 'KeyList'); k && ids.length < 64; k = c.read(k, 'NextKey')) ids.push(String(c.read(k, 'KeyID'))); return ids; }
/** Let a tool in hand work on a device until its own timer stops it (`busy` names the bPicking/bHacking field), at most `seconds` of Level time; returns the frames it took. */
function untilDone(c, device, busy, seconds) { let n = 0; for (; n < 60 * seconds && c.read(device, busy); n++) c.frames(1); return n; }
/** A door opened with the right button (ParseRightClick: DoFrob(Self, None)) has left KeyNum 0 or is moving. */
const opened = (c, door) => c.read(door, 'KeyNum') !== 0 || Boolean(c.read(door, 'bInterpolating'));
/** MeetFilben to its end through the conversation window's keys. Its Choice: the first button "You can trust me." (Enter) jumps to GetKeyB (TransferObject of Filben's
 * `ruin_key` NanoKey, FilbenGaveKey), the second "I can't promise..." (Down, Enter) to NoKeyB (no key). The conversation sets M01PlayerMetFilben at its first event, so the
 * flag is no sign of the end: the end is the player's ConPlay going away. */
async function meetFilben(c, choice) {
  const f = c.actor('HarleyFilben0'); if (!f) throw new Undriven('no HarleyFilben0');
  const fp = c.pos(f); c.stand([fp[0] - 80, fp[1], fp[2]], fp); c.frames(30);
  await c.frob(f, [60, 80, 48]).catch(() => null);
  let started = false, i = 0;
  for (; i < 240; i++) {
    const playing = Boolean(c.read(c.player(), 'conPlay'));
    started ||= playing; if (started && !playing) break;
    if (choice) { c.game.windowKey('ArrowDown', true); c.game.windowKey('ArrowDown', false); c.frames(3); }
    c.game.windowKey('Enter', true); c.game.windowKey('Enter', false); c.frames(27);
  }
  return {met: c.flag('m01playermetfilben'), ended: started && !c.read(c.player(), 'conPlay'), gaveKey: c.flag('filbengavekey'), keys: keyIds(c), seconds: i / 2};
}

/** Free Gunther the way the cell is built (01_NYC_UNATCOIsland): the wall button DeusExMover8 (unlocked, TriggerOpenTimed, Event temp_celldoor) slides 8 units and
 * its FinishedOpening triggers temp_celldoor, the cell door DeusExMover10 (TriggerToggle: DeusExMover.Trigger has no lock test), which turns a quarter (KeyRot[1]
 * yaw 16384); its Event guntherdoor reaches FlagTrigger4 (bTrigger on StatueMissionComplete false) -> guntherfreedflag -> FlagTrigger2 sets GuntherFreed. The walk
 * in crosses AllianceTrigger0 (touch, Event GuntherHermann: Alliance UNATCO) and enters GuntherRescued's radius (70; it needs GuntherFreed). The conversation adds
 * 150 skill points, then CheckObject walks the player's weapons (WeaponAssaultGun, WeaponStealthPistol, WeaponPistol, WeaponCombatKnife, else nothing): with
 * `weapon` in hand the first choice is "As you wish. Take my ..." -> TransferObject to Gunther -> GuntherRespectsPlayer and the trigger GuntherAttacks
 * (OrdersTrigger0: RunningTo GuntherSpot). The old census aimed at DeusExMover10's Location, its hinge pivot 170 units above the floor (PrePivot -48,0,96). */
async function freeGunther(c, weapon) {
  const button = c.actor('DeusExMover8'), door = c.actor('DeusExMover10'), g = c.actor('GuntherHermann0');
  if (!button || !door || !g) throw new Undriven('no DeusExMover8, DeusExMover10 or GuntherHermann0');
  for (let i = 0; i < 240 && !c.flag('m1missionstart'); i++) c.frames(5);
  const item = weapon ? await armed(c, weapon) : null;
  const before = {alliance: c.read(g, 'Alliance'), orders: c.read(g, 'Orders')}, sp0 = c.read(c.player(), 'SkillPointsAvail');
  c.watched.add(button); c.watched.add(door); c.watched.add(g);
  await c.frob(button, [40, 48, 60, 36]);
  for (let t = 0; t < 20 && (c.read(door, 'KeyNum') !== 1 || c.read(door, 'bInterpolating')); t++) c.frames(30);
  const doorState = {key: c.read(door, 'KeyNum'), yaw: c.read(door, 'Rotation')[1]}, freed = c.flag('guntherfreed');
  c.stand(c.pos(c.player()), c.pos(g)); c.frames(5);
  c.fixture.driveLegacy({forward: 1});
  for (let i = 0; i < 600 && !c.read(c.player(), 'conPlay'); i++) { c.frames(1); if (i % 30 === 29) c.stand(c.pos(c.player()), c.pos(g)); }
  c.fixture.driveLegacy({forward: 0});
  const conPlay = c.read(c.player(), 'conPlay'), con = conPlay ? String(c.read(c.read(conPlay, 'con'), 'conName')) : null;
  for (let s = 0; s < 120 && c.read(c.player(), 'conPlay'); s++) { c.game.windowKey('Enter', true); c.game.windowKey('Enter', false); c.frames(30); }
  c.frames(60);
  return {door: doorState, freed, con, played: c.flag('guntherrescued_played'), respects: c.flag('guntherrespectsplayer'), weapon: item?.name ?? null,
    gave: item ? c.read(item, 'Owner') === g : null, skillPoints: [sp0, c.read(c.player(), 'SkillPointsAvail')], before,
    after: {alliance: c.read(g, 'Alliance'), orders: c.read(g, 'Orders'), state: stateName(c, g)}};
}

Object.assign(DRIVERS, {
  async 'island-shoot-npc'(c) {
    const t = c.actor('Terrorist0'); if (!t) throw new Undriven('no Terrorist0');
    // The summoned Pistol carries PickupAmmoCount 6 rounds and no reserve, and a hit Terrorist runs (Fleeing from the third hit): a player picks up a second pack
    // and keeps the sights on the target. Each shot is aimed at the target's current place (a fixture write of the player's own position and view), reload waits.
    const w = await armed(c); await pack(c, 'Ammo10mm', 2); const where = c.openStand(t, 220), n0 = carcasses(c).length;
    const h0 = c.health(t), ammo0 = ammoOf(c, w); let shots = 0;
    const died = await c.guard(async () => {
      for (; shots < 40 && !c.gone(t) && c.health(t) > 0; shots++) {
        c.stand(c.pos(c.player()), c.pos(t)); c.shoot(4, 30);
        if (c.read(w, 'ClipCount') >= c.read(w, 'ReloadCount')) c.frames(150);
      }
      c.frames(180);
    });
    return ok(c.gone(t) || c.health(t) <= 0, {h0, health: c.gone(t) ? null : c.health(t), shots, ammo: [ammo0, ammoOf(c, w)], state: c.gone(t) ? null : stateName(c, t), enemy: !c.gone(t) && c.read(t, 'Enemy') === c.player(), newCarcasses: carcasses(c).length - n0, playerDied: died, bearing: where.bearing});
  },
  async 'island-npc-shoots-player'(c) {
    const t = c.actor('Terrorist0'); if (!t) throw new Undriven('no Terrorist0');
    c.openStand(t, 350); let out;
    const died = await c.guard(async () => { out = c.engage(t, 20); });
    out ??= {}; const hurt = died || out.minHealth < 100;
    return ok(hurt && (out.enemy || out.tracers > 0 || died), {...out, died, h: c.health(c.player())}, 'the player lost no health to the pawn, or the pawn never engaged');
  },
  async 'island-melee-ko'(c) {
    const t = c.actor('Terrorist0'); if (!t) throw new Undriven('no Terrorist0');
    await armed(c, 'WeaponBaton'); const n0 = carcasses(c).length; c.openStand(t, 50);
    const died = await c.guard(async () => { for (let i = 0; i < 30 && !c.gone(t); i++) c.shoot(3, 25); c.frames(120); });
    const fresh = carcasses(c).slice(n0).map(k => ({name: k.name, itemName: c.read(k, 'itemName')}));
    return ok(fresh.length > 0, {gone: c.gone(t), fresh, playerDied: died});
  },
  async 'island-death'(c) {
    const died = await c.guard(async () => { c.damage(c.player(), 500, 'Shot'); c.frames(300); });
    return ok(c.health(c.player()) <= 0, {health: c.health(c.player()), state: c.state(c.player()), reachedOpenDxOnly: died});
  },
  async 'island-turret'(c) {
    const turret = c.actor('AutoTurret0'); if (!turret) throw new Undriven('no AutoTurret0');
    const tp = c.pos(turret), h0 = c.health(c.player()); c.trigger(turret); const tried = [];
    for (const bearing of [0, PI / 2, PI, -PI / 2, PI / 4, -PI / 4, 3 * PI / 4, -3 * PI / 4]) {
      c.stand([tp[0] + Math.cos(bearing) * 260, tp[1] + Math.sin(bearing) * 260, tp[2] - 30], tp);
      const died = await c.guard(async () => c.frames(60 * 3));
      const target = c.read(turret, 'curTarget'), hit = died || c.health(c.player()) < h0;
      tried.push([Math.round(bearing * 100) / 100, target?.name ?? null, hit]);
      if (hit || target === c.player()) return ok(true, {tried, h: [h0, c.health(c.player())], died});
    }
    return ok(false, {tried, active: c.read(turret, 'bActive'), state: stateName(c, turret)}, 'the active turret never targeted or hurt the player from 8 bearings at 260 units');
  },
  async 'island-sight'(c) {
    // The original's two captures of this pose set (docs/stage-5-exit-criteria.md, scenes cmb2 and cmb1 of validate-stage5-live.mjs): 700 units behind Terrorist0
    // (bearing PI, 133 degrees off its facing) no Terrorist notices the player in 600 ticks; 700 units in front (the bearing of its facing, Rotation.Yaw 8624)
    // Terrorist0 and ThugMale7 seek the player from tick 41 and attack from tick 178. The driver stood only behind it before, and read the original's
    // "not seen" as no effect. The player looks at Terrorist0 from both poses, so a rendered frame stamps it (LastRenderTime): a headless frame does not,
    // and after 5 s in stasis (AActor::InStasis) it stopped ticking its perception at all; the driver stamps it as the renderer's feedback would.
    const t = c.actor('Terrorist0'); if (!t) throw new Undriven('no Terrorist0');
    c.watched.add(t);
    c.frames(300); const before = stateName(c, t);
    c.openStand(t, 700, [PI]); let hidden;
    const diedHidden = await c.guard(async () => { hidden = c.engage(t, 10); });
    const unseen = !reacting(c, t, before) && !hidden?.enemy;
    const facing = c.read(t, 'Rotation')[1] * PI / 32768;
    c.openStand(t, 700, [facing, facing + PI / 8, facing - PI / 8]); let out;
    const died = await c.guard(async () => { out = c.engage(t, 10); });
    return ok(unseen && (reacting(c, t, before) || out?.enemy), {before, behind: {unseen, out: hidden, playerDied: diedHidden}, inView: {out, state: stateName(c, t), playerDied: died}});
  },
  async 'island-hearing'(c) {
    const t = c.actor('Terrorist0'); if (!t) throw new Undriven('no Terrorist0');
    await armed(c); c.frames(300); const before = stateName(c, t); c.openStand(t, 700);
    c.frames(120); const quiet = !reacting(c, t, before);
    const died = await c.guard(async () => { for (let i = 0; i < 3; i++) c.shoot(4, 40); c.frames(60 * 6); });
    return ok(quiet && reacting(c, t, before), {before, quietBeforeShots: quiet, state: stateName(c, t), enemy: Boolean(c.read(t, 'Enemy')), playerDied: died, note: 'sight and hearing cannot be told apart in the open'});
  },
  async 'island-camera'(c) {
    const cam = c.actor('SecurityCamera5'); if (!cam) throw new Undriven('no SecurityCamera5');
    const cp = c.pos(cam), [fx, fy] = forward(c, cam), seen = [];
    for (const dist of [200, 350, 500]) {
      c.stand([cp[0] + fx * dist, cp[1] + fy * dist, cp[2] - 55], cp); c.frames(60 * 3);
      seen.push([dist, Boolean(c.read(cam, 'bPlayerSeen')), Boolean(c.read(cam, 'bTrackPlayer'))]);
    }
    return ok(seen.some(s => s[1] || s[2]), {seen, alarm: c.flag('statuealarmtriggered'), state: stateName(c, cam)});
  },
  async 'island-laser'(c) {
    const laser = c.actor('LaserTrigger0'), unit = c.actor('AlarmUnit0'), t18 = c.actor('Terrorist18'); if (!laser || !unit || !t18) throw new Undriven('no LaserTrigger0, AlarmUnit0 or Terrorist18');
    for (let i = 0; i < 240 && !c.flag('m1missionstart'); i++) c.frames(5);
    // 1. The beam. LaserTrigger.BeginAlarm rings Klaxon2, sets lastAlarmTime and starts an 'Alarm' AI event (the laser has no Event). A guard that handles it
    //    (ScriptedPawn.HandleAlarm) sets AlarmTimer = 120 before HandleEnemy; state Alerting then skips the alarm box while AlarmTimer > 0 (Alert: Goto('Done') ->
    //    Attacking), so no guard who heard the laser rings AlarmUnit0 for two minutes. Terrorist18 (RaiseAlarm BeforeAttacking) passes through Alerting for one frame.
    const guards = ['Terrorist18', 'Terrorist30', 'Terrorist14', 'Terrorist2'].map(n => c.actor(n)).filter(Boolean);
    const lp = c.pos(laser), [fx, fy] = forward(c, laser), seen = {};
    c.stand([lp[0] + fx * 120, lp[1] + fy * 120, lp[2] - 40], lp); c.frames(20);
    c.fixture.driveLegacy({forward: 1});
    const beamDied = await c.guard(async () => {
      for (let f = 0; f < 480; f++) {
        c.frames(1); if (f === 100) c.fixture.driveLegacy({forward: 0});
        for (const g of guards) { const s = stateName(c, g); (seen[g.name] ??= new Set()).add(s); }
      }
    });
    c.fixture.driveLegacy({forward: 0});
    const beam = {lastAlarm: c.read(laser, 'lastAlarmTime'), klaxon: c.read(laser, 'AmbientSound')?.name ?? null, alarmTimers: guards.map(g => Math.round(c.read(g, 'AlarmTimer'))),
      t18: [...seen.Terrorist18 ?? []], hostile: guards.filter(g => c.read(g, 'Enemy') === c.player()).length, unitRang: Boolean(c.read(unit, 'bActive')), flag: c.flag('statuealarmtriggered'), playerDied: beamDied};
    const beamOk = beam.lastAlarm > 0 && beam.alarmTimers.every(t => t > 100) && beam.hostile > 0 && beam.t18.includes('alerting') && !beam.unitRang && !beam.flag;
    // 2. The alarm box (the map reloaded). A RaiseAlarm BeforeAttacking guard that takes the player as its enemy with AlarmTimer 0 (it saw him; it heard no alarm)
    //    goes Alerting, FindTarget picks AlarmUnit0 (within 2400, not hostile), runs to it and TriggerAlarm()s it: SetAlarmFlag -> FlagTrigger3 -> StatueAlarmTriggered.
    c.restart();
    for (let i = 0; i < 240 && !c.flag('m1missionstart'); i++) c.frames(5);
    const t = c.actor('Terrorist18'), box = c.actor('AlarmUnit0'); c.watched.add(t);
    for (let i = 0; i < 10 && (i < 6 || stateName(c, t) !== 'sitting'); i++) c.frames(60);
    const yaw = c.read(t, 'Rotation')[1] / 65536 * 2 * PI, states = new Set();
    c.openStand(t, 260, [yaw, yaw + 0.4, yaw - 0.4, yaw + 0.8, yaw - 0.8]);
    let ranTo = null;
    const boxDied = await c.guard(async () => {
      for (let s = 0; s < 60 && !c.flag('statuealarmtriggered'); s++) {
        c.stand(c.pos(c.player()), c.pos(t)); c.frames(30); states.add(stateName(c, t)); ranTo ??= c.read(t, 'AlarmActor')?.name ?? null;
      }
    });
    const alarmBox = {states: [...states], alarmActor: ranTo, unitRang: Boolean(c.read(box, 'bActive')), flag: c.flag('statuealarmtriggered'), playerDied: boxDied};
    return ok(beamOk && alarmBox.flag && ranTo === 'AlarmUnit0', {beam, alarmBox},
      !beamOk ? 'the beam did not ring the klaxon and send the guards that heard it to attack with AlarmTimer 120' : 'Terrorist18, seeing the player with AlarmTimer 0, did not ring AlarmUnit0');
  },
  async 'island-hack-panel'(c) {
    const panel = c.actor('ControlPanel0'), lasers = c.byTag('statue_lasertrap'); if (!panel || !lasers.length) throw new Undriven('no ControlPanel0 or statue_lasertrap lasers');
    const tool = await armed(c, 'Multitool'); const copies0 = c.read(tool, 'NumCopies'), on0 = lasers.map(l => Boolean(c.read(l, 'bIsOn')));
    // The Multitool is used with the LEFT button (ParseLeftClick: DoFrob(Self, inHand) on a HackableDevices); the right button frobs with nothing in hand and never starts a hack.
    c.watched.add(panel);
    const died = await c.guard(async () => { await c.useTool(panel, [48, 36, 64]); });
    const started = Boolean(c.read(panel, 'bHacking')), frames = untilDone(c, panel, 'bHacking', 40);
    return ok(started && c.read(panel, 'hackStrength') === 0 && lasers.every(l => !c.read(l, 'bIsOn')) && (c.gone(tool) || c.read(tool, 'NumCopies') < copies0),
      {started, frames, hackStrength: c.read(panel, 'hackStrength'), lasersOn: [on0, lasers.map(l => Boolean(c.read(l, 'bIsOn')))], multitool: [copies0, c.gone(tool) ? 0 : c.read(tool, 'NumCopies')], playerDied: died});
  },
  async 'island-carcass'(c) {
    const a = c.actor('Terrorist4'), b = c.actor('Terrorist27'); if (!a || !b) throw new Undriven('no Terrorist4/27');
    // MissionScript.Timer's first call runs FirstFrame (ResetGoals and ResetConversationHistory behind the M1MissionStart flag) about a second into the
    // level, long before a player can walk to a Terrorist; the placement below must not run ahead of it (a conversation started in that first second
    // would have its history deleted by FirstFrame, an order the original's inputs cannot produce).
    for (let i = 0; i < 240 && !c.flag('m1missionstart'); i++) c.frames(5);
    const ap = c.pos(a), before = stateName(c, b);
    c.stand([ap[0] - 200, ap[1], ap[2]], ap); c.frames(10);
    c.damage(a, 1000, 'Shot', c.player());
    const died = await c.guard(async () => c.frames(60 * 12));
    return ok(c.read(b, 'NumCarcasses') > 0 || reacting(c, b, before), {killed: c.gone(a) || c.health(a) <= 0, numCarcasses: c.read(b, 'NumCarcasses'), state: stateName(c, b), playerDied: died});
  },
  async 'island-swim'(c) {
    const water = c.actor('WaterZone1'), p = c.pos(water);
    c.fixture.place([p[0], p[1], p[2] + 30], {yaw: 0}); c.frames(30);
    const t0 = c.read(c.player(), 'swimTimer'), h0 = c.health(c.player()); let min = t0;
    const died = await c.guard(async () => { for (let i = 0; i < 45; i++) { c.frames(60); min = Math.min(min, c.read(c.player(), 'swimTimer')); } });
    return ok(c.read(c.player(), 'Physics') === 3 && (min < t0 || died), {physics: c.read(c.player(), 'Physics'), swimTimer: [t0, min], health: [h0, c.health(c.player())], drowned: died});
  },
  async 'island-terminal'(c) {
    const out = {}, names = ['ComputerPersonal0', 'ATM0', 'ComputerSecurity1'];
    for (const name of names) {
      const a = c.actor(name); if (!a) { out[name] = 'absent'; continue; }
      // A terminal is a state machine (Computers.uc, auto state Off): the map's saved bOn runs the Deactivate animation (FinishAnim) when the level starts, and Frob
      // refuses while bAnimating. A device nobody has drawn sits in stasis, so the driver stamps it as the renderer's feedback would (watched) and gives it the
      // seconds a player spends walking up to it before pressing use (Computers.Frob returns without opening while bAnimating).
      c.watched.clear(); c.watched.add(a); c.frames(180);
      try {
        await c.frob(a, [64, 48, 80]); c.frames(120); out[name] = Boolean(c.topModal());
        const window = (() => { try { const t = c.read(a, 'termwindow'); return t ? c.runtime.instance(t).cls.record.key.split('.').pop() : null; } catch { return null; } })();
        if (window) out[`${name}.window`] = window;
        c.closeModals(); c.frames(60);
      } catch (error) { if (!(error instanceof Undriven)) throw error; out[name] = 'not reachable'; }
    }
    c.watched.clear();
    return ok(names.every(name => out[name] === true), out);
  },
  async 'island-doors'(c) {
    const out = {};
    const key = c.actor('NanoKey0'), hatch = c.actor('DeusExMover7');
    try { out.keyTaken = await c.take(key); } catch (error) { if (!(error instanceof Undriven)) throw error; out.keyTaken = 'not reachable'; }
    if (out.keyTaken === true) { c.watched.add(hatch); await c.frob(hatch, [60, 80, 40]); c.frames(240); out.hatchOpened = Boolean(c.read(hatch, 'bInterpolating')) || c.read(hatch, 'KeyNum') !== 0; }
    const pad = c.actor('Keypad0'), door = c.actor('DeusExMover21');
    c.watched.add(pad); await c.frob(pad, [40, 32, 56]); c.frames(30);
    for (const d of '0451') { c.game.windowKey(`Digit${d}`, true); c.game.windowKey(`Digit${d}`, false); c.frames(10); }
    c.frames(60 * 4);
    out.keypadDoor = Boolean(c.read(door, 'bInterpolating')) || c.read(door, 'KeyNum') !== 0;
    return ok(out.keypadDoor && out.hatchOpened !== false, out);
  },
  async 'island-items'(c) {
    const out = {};
    c.damage(c.player(), 40, 'Shot'); c.frames(30); out.hurt = c.health(c.player());
    const med = await c.give('MedKit'); await c.equip(med); c.game.inputButton('LeftMouse', true); c.frames(4); c.game.inputButton('LeftMouse', false); c.frames(180);
    out.healed = c.health(c.player());
    const points0 = c.read(c.player(), 'SkillPointsAvail');
    const ap = c.pos(c.actor('SkillAwardTrigger1'));
    c.fixture.place([ap[0] - 20, ap[1], ap[2] + 45], {yaw: 0}); c.frames(5); c.fixture.driveLegacy({forward: 1}); c.frames(40); c.fixture.driveLegacy({forward: 0}); c.frames(30);
    out.points = [points0, c.read(c.player(), 'SkillPointsAvail')];
    return ok(out.healed > out.hurt && out.points[1] > out.points[0], out);
  },
  async 'island-movables-fall'(c) {
    const out = {};
    const light = c.byClass('Trashbag')[0] ?? c.byClass('FireExtinguisher')[0]; if (!light) throw new Undriven('no light decoration');
    await c.frob(light); c.frames(30); out.carried = c.read(c.player(), 'CarriedDecoration') === light; out.item = light.name; c.key('Tab'); c.frames(60);
    c.fixture.place([-4761, 10431, -281 + 380], {yaw: 0}); const h0 = c.health(c.player());
    c.frames(180); out.fall = h0 - c.health(c.player());
    return ok(out.carried && out.fall > 0, {...out, h0, h: c.health(c.player())});
  },
  async 'meet-filben'(c) {
    // Both branches of the Choice, the map reloaded between them: "You can trust me." (Enter) hands over the `ruin_key`, "I can't promise..." (Down, Enter) does not.
    // (The first version of this driver stopped at the M01PlayerMetFilben flag, which the conversation sets at its first event: it never reached the Choice.)
    const trust = await meetFilben(c, 0); c.restart();
    const refuse = await meetFilben(c, 1);
    return ok(trust.ended && trust.gaveKey && trust.keys.includes('ruin_key') && refuse.ended && !refuse.gaveKey && !refuse.keys.includes('ruin_key'), {trust, refuse});
  },
  async 'gunther-rescued'(c) {
    const out = await freeGunther(c, 'WeaponPistol');
    return ok(out.door.key === 1 && out.freed && out.con === 'GuntherRescued' && out.played && out.respects && out.gave && out.skillPoints[1] - out.skillPoints[0] === 150
      && out.after.alliance === 'UNATCO' && out.after.orders === 'RunningTo', out);
  },
  async 'meet-terrorist'(c) {
    toCommander(c, 40, () => c.flag('meetterrorist_played') || c.flag('statuemissioncomplete'));
    c.advance(40, () => c.flag('statuemissioncomplete'));
    return ok(c.flag('meetterrorist_played') || c.flag('statuemissioncomplete'), {played: c.flag('meetterrorist_played'), complete: c.flag('statuemissioncomplete'), attacked: c.flag('playerattackedstatueterrorist'), commander: stateName(c, commander(c)), at: c.pos(c.player()).map(Math.round)});
  },
  async 'route-front'(c) {
    const doors = c.byTag('StatueRuinDoors'), door = c.actor('DeusExMover12'); if (!door || doors.length !== 4) throw new Undriven('the StatueRuinDoors are not the four movers led by DeusExMover12');
    const state = () => doors.map(d => `${c.read(d, 'bLocked') ? 'locked' : 'unlocked'}${opened(c, d) ? '+open' : ''}`);
    const out = {authored: {breakable: doors.map(d => Boolean(c.read(d, 'bBreakable'))), lockStrength: c.read(door, 'lockStrength')}};
    // 1. The Lockpick (no key). The bare right button on the locked door leaves it locked (DeusExMover.Frob: msgLocked); the Lockpick, used with the LEFT button
    //    (ParseLeftClick: DoFrob(Self, inHand) for a Lockpick or NanoKeyRing on a DeusExMover), picks all four; the right button then opens them.
    const tool = await armed(c, 'Lockpick'); c.watched.add(door);
    out.pickDied = await c.guard(async () => {
      await c.frob(door, [64, 80, 48]); c.frames(60); out.bareRightClick = state();
      await c.useTool(door, [64, 80, 48]); out.picking = Boolean(c.read(door, 'bPicking')); out.pickFrames = untilDone(c, door, 'bPicking', 40);
      out.afterPick = state(); await c.frob(door, [64, 80, 48]); c.frames(60 * 4); out.afterOpen = state();
    });
    out.picks = c.gone(tool) ? 0 : c.read(tool, 'NumCopies');
    const pickOk = out.picking && out.afterPick?.every(s => s === 'unlocked') && out.afterOpen?.every(s => s.endsWith('+open'));
    // 2. The key from Filben (the map reloaded): the first choice of MeetFilben gives the ruin_key; the key ring in hand (belt 0) toggles the lock of all four.
    c.restart();
    const meet = await meetFilben(c, 0); out.meet = {gaveKey: meet.gaveKey, keys: meet.keys, ended: meet.ended};
    out.keyDied = await c.guard(async () => {
      await c.equip(c.read(c.player(), 'KeyRing')); c.watched.add(door);
      await c.useTool(door, [64, 80, 48]); c.frames(30); out.keyUnlocked = state();
      await c.frob(door, [64, 80, 48]); c.frames(60 * 4); out.keyOpened = state();
    });
    const keyOk = meet.keys.includes('ruin_key') && out.keyUnlocked?.every(s => s === 'unlocked') && out.keyOpened?.every(s => s.endsWith('+open'));
    return ok(pickOk && keyOk, out, !pickOk ? 'the Lockpick did not unlock and open the StatueRuinDoors' : 'the key from Filben did not unlock and open the StatueRuinDoors');
  },
  async 'route-back'(c) {
    const door = c.actor('DeusExMover2'); if (!door) throw new Undriven('no DeusExMover2');
    const tool = await armed(c, 'Lockpick'); c.watched.add(door); const out = {lockStrength: c.read(door, 'lockStrength')};
    out.died = await c.guard(async () => {
      await c.frob(door, [48, 70, 36]); c.frames(60); out.bareRightClick = {locked: c.read(door, 'bLocked'), open: opened(c, door)};
      await c.useTool(door, [48, 70, 36]); out.picking = Boolean(c.read(door, 'bPicking')); out.pickFrames = untilDone(c, door, 'bPicking', 40);
      out.unlocked = !c.read(door, 'bLocked'); await c.frob(door, [48, 70, 36]); c.frames(60 * 4); out.open = opened(c, door);
    });
    out.picks = c.gone(tool) ? 0 : c.read(tool, 'NumCopies');
    return ok(out.picking && out.unlocked && out.open && out.picks === 0, out);
  },
  async 'route-airshaft'(c) {
    const shafts = c.byClass('DataLinkTrigger').filter(t => /airshaft/i.test(String(c.read(t, 'datalinkTag'))));
    if (shafts.length !== 3) throw new Undriven(`${shafts.length} airshaft triggers`);
    for (const t of shafts) { const at = c.pos(t); c.fixture.place([at[0] - 20, at[1], at[2] + 45], {yaw: 0}); c.frames(10); c.fixture.driveLegacy({forward: 1}); c.frames(40); c.fixture.driveLegacy({forward: 0}); c.frames(60 * 12); }
    return ok(c.flag('dl_libertyruinsairshaft_played'), {played: c.flag('dl_libertyruinsairshaft_played')});
  },
  async 'route-water'(c) {
    const dmg = c.actor('DamageTrigger1'); if (!dmg) throw new Undriven('no DamageTrigger1');
    const dp = c.pos(dmg), e0 = c.read(c.player(), 'Energy'), h0 = c.health(c.player());
    c.fixture.place([dp[0] - 20, dp[1], dp[2] + 45], {yaw: 0}); c.frames(5);
    c.fixture.driveLegacy({forward: 1}); const died = await c.guard(async () => c.frames(60 * 6)); c.fixture.driveLegacy({forward: 0});
    return ok(c.read(c.player(), 'Energy') < e0 || c.health(c.player()) < h0 || died, {energy: [e0, c.read(c.player(), 'Energy')], health: [h0, c.health(c.player())], died});
  },
  async 'objective-kill'(c) {
    const cm = commander(c); if (!cm) throw new Undriven('no commander');
    // MeetTerrorist is the commander's radius conversation (bInvokeRadius, radiusDistance 140; DeusExPlayer.CheckConversationInvokeRadius: Max(16, radiusDistance)).
    // The previous driver placed the player 45 units from him: the conversation started on his first low-priority tick, state Conversation put the pistol away
    // (conPlay.SetInHand(InHand); PutInHand(None)) and the clicks went to the conversation window, so no shot was fired. A player who means to kill him shoots from
    // outside the radius: 300 units in front of him, inside his room. He is stamped as a rendered pawn (headless frames draw no mesh).
    for (let i = 0; i < 240 && !c.flag('m1missionstart'); i++) c.frames(5);
    const w = await armed(c); await pack(c, 'Ammo10mm', 2);
    const yaw = c.read(cm, 'Rotation')[1] / 65536 * 2 * PI, from = c.approach(cm, 300, yaw);
    if (!c.inWorld(from)) throw new Undriven('the place 300 units in front of the commander is outside the world');
    c.watched.add(cm); c.stand(from, c.pos(cm)); c.frames(45);
    const h0 = c.health(cm), at = Math.round(near(c.pos(c.player()), c.pos(cm)));
    let shots = 0;
    const died = await c.guard(async () => {
      for (; shots < 25 && !c.gone(cm) && c.health(cm) > 0; shots++) {
        c.stand(c.pos(c.player()), c.pos(cm)); c.frames(3); c.shoot(4, 30);
        if (c.read(w, 'ClipCount') >= c.read(w, 'ReloadCount')) c.frames(150);
      }
      // Mission01.Timer: TerroristCommander_Dead -> DL_LeaderKilled (MS_DL_Played); the DataLink's own event sets StatueMissionComplete; its Played flag follows its end.
      for (let t = 0; t < 60 && !c.flag('dl_leaderkilled_played'); t++) c.frames(60);
    });
    const out = {h0, distance: at, shots, dead: c.flag('terroristcommander_dead'), health: c.gone(cm) ? null : c.health(cm), complete: c.flag('statuemissioncomplete'),
      killedPlayed: c.flag('dl_leaderkilled_played'), meetTerroristPlayed: c.flag('meetterrorist_played'), playerDied: died};
    return ok(out.dead && out.complete && out.killedPlayed && !out.meetTerroristPlayed, out);
  },
  async 'objective-spare'(c) {
    toCommander(c, 40, () => c.flag('statuemissioncomplete')); c.advance(40, () => c.flag('statuemissioncomplete')); c.frames(60 * 6);
    return ok(c.flag('statuemissioncomplete') && !c.flag('terroristcommander_dead'), {complete: c.flag('statuemissioncomplete'), notKilledPlayed: c.flag('dl_leadernotkilled_played')});
  },
  async 'mission-complete'(c) {
    toCommander(c, 40, () => c.flag('statuemissioncomplete')); c.advance(40, () => c.flag('statuemissioncomplete')); c.frames(60 * 8);
    const doors = c.byTag('UN_maindoor'), paul = c.actor('PaulDenton0');
    return ok(c.flag('statuemissioncomplete') && !c.byClass('ThugMale2').length, {complete: c.flag('statuemissioncomplete'), thugsLeft: c.byClass('ThugMale2').length, unMainDoorLocked: doors.map(d => c.read(d, 'bLocked')), paul: paul ? c.pos(paul).map(Math.round) : null});
  },
  async 'noise-wakes-guards'(c) {
    const t = c.actor('Terrorist0'); if (!t) throw new Undriven('no Terrorist0');
    await armed(c); c.frames(300); c.openStand(t, 600); let out;
    const died = await c.guard(async () => { for (let i = 0; i < 3; i++) c.shoot(4, 40); out = c.engage(t, 20); });
    return ok(died || (out && out.minHealth < 100 && (out.enemy || out.tracers > 0)), {out, died, h: c.health(c.player())});
  },
  async 'light-vs-sight'(c) {
    // The Island has no LightSwitch or TriggerLight, and AugLight also starts a 'Beam' AI event that ScriptedPawn.CheckBeamPresence answers with HandleSighting
    // (any player Beam within 1200 units in view), a second path that would not isolate the light. So the pair is the map's own lighting: two poses 500 units in
    // front of Terrorist4 (Orders Standing), 15 degrees apart, both with a clear line of sight (AICanSee's SingleLineCheck). The dark one is in shadow (AIGetLightLevel
    // 0.0043, ambient only: every static light's trace is blocked), the lit one 0.055. AICanSee's acc = 64 (r^2+h^2)/dist^2 * AIVisibility - VisibilityThreshold
    // (0.01) is below zero in the dark and above it in the light; any acc > 0 brings EnemyReadiness to 1 within 4.5 s (CheckCycle).
    const {actorLightLevelExtended} = await import('../src/runtime/script-ai-visibility.mjs');
    const {x87store} = await import('../src/runtime/script-vm.mjs');
    const out = {};
    for (const [label, degrees] of [['dark', -5], ['lit', 10]]) {
      if (label === 'lit') c.restart();
      for (let i = 0; i < 240 && !c.flag('m1missionstart'); i++) c.frames(5);
      const n = c.actor('Terrorist4'), other = c.actor('Terrorist27'); if (!n) throw new Undriven('no Terrorist4');
      const np = c.pos(n), yaw = c.read(n, 'Rotation')[1] / 65536 * 2 * PI;
      c.watched.add(n); if (other) c.watched.add(other);
      c.stand(c.approach(n, 500, yaw + degrees * PI / 180), np); c.frames(10);
      const pl = c.player(), at = c.pos(pl);
      const los = c.runtime.perceptionServices({receiver: n}).singleLineCheck(c.level(), n, pl, at, [np[0], np[1], np[2] + c.read(n, 'BaseEyeHeight')]);
      const light = x87store(actorLightLevelExtended(pl, at, c.runtime.perceptionServices({receiver: pl})));
      let readiness = 0, seenAt = null;
      const died = await c.guard(async () => {
        for (let s = 0; s < 10; s++) { c.frames(60); readiness = Math.max(readiness, c.read(n, 'EnemyReadiness')); if (seenAt === null && c.read(n, 'Enemy') === pl) seenAt = s + 1; }
      });
      out[label] = {at: at.map(Math.round), distance: Math.round(near(at, np)), physics: c.read(pl, 'Physics'), los, light: Math.round(light * 1e4) / 1e4,
        visibility: Math.round(c.read(pl, 'CurrentVisibility') * 1e4) / 1e4, readiness: Math.round(readiness * 1000) / 1000, seenAt, state: stateName(c, n), playerDied: died};
    }
    const {dark, lit} = out;
    return ok(dark.los && lit.los && dark.physics === 1 && lit.physics === 1 && dark.light < lit.light && dark.readiness === 0 && dark.seenAt === null && lit.seenAt !== null, out);
  },
  async 'explosion-world'(c) {
    await armed(c); const crate = c.actor('CrateExplosiveSmall10'); if (!crate) throw new Undriven('no CrateExplosiveSmall10');
    c.stand(c.approach(crate, 300, PI), c.pos(crate)); c.frames(10); const h0 = c.health(c.player());
    const died = await c.guard(async () => { for (let i = 0; i < 12 && !c.gone(crate); i++) c.shoot(4, 30); c.frames(180); });
    return ok(c.gone(crate), {gone: c.gone(crate), playerHealth: [h0, c.health(c.player())], died});
  },
  async 'emp-electronics'(c) {
    const bot = c.actor('SecurityBot0'); if (!bot) throw new Undriven('no SecurityBot0');
    // SecurityBot0 patrols (95 units/s) before it stops at its last point: the grenade's fuse (about 3.5 s) and flight (about 550 units, ThrownProjectile bounces on)
    // decide where it explodes, so a thrower aims at a bot that is standing. The previous driver threw at the bot's start while it walked away: the blast (EMP,
    // HurtRadius rings to 512 units) went off 590 units from it.
    let bp = c.pos(bot), still = 0;
    for (let i = 0; i < 40 && still < 2; i++) { c.frames(60); const p = c.pos(bot); still = near(p, bp) < 1 ? still + 1 : 0; bp = p; }
    if (still < 2) throw new Undriven('SecurityBot0 never stood still');
    const before = {state: stateName(c, bot), emp: c.read(bot, 'EMPHitPoints'), health: c.health(bot)}, attempts = [];
    let thrown = 0, died = false;
    // From 550 units the throw lands within the blast radius on the bearings that look over level ground; the first bearing whose place is in the world is tried, then the next.
    for (const bearing of [PI / 2, 0, PI, -PI / 2, PI / 4, -PI / 4, 3 * PI / 4, -3 * PI / 4]) {
      const spot = c.approach(bot, 550, bearing); spot[2] = bp[2] - 11;
      if (!c.inWorld(spot)) continue;
      const w = await armed(c, 'WeaponEMPGrenade'); c.stand(spot, bp); c.frames(10);
      died = await c.guard(async () => { c.game.pressFire(); c.frames(8); c.game.releaseFire(); for (let t = 0; t < 8; t++) { c.frames(60); thrown = Math.max(thrown, c.byClass('EMPGrenade').length); } });
      attempts.push([Math.round(bearing * 100) / 100, c.read(bot, 'EMPHitPoints')]);
      if (died || c.read(bot, 'EMPHitPoints') < before.emp || attempts.length >= 4) break;
    }
    return ok(stateName(c, bot) !== before.state || c.read(bot, 'EMPHitPoints') < before.emp || c.health(bot) < before.health, {before, attempts, state: stateName(c, bot), emp: c.read(bot, 'EMPHitPoints'), health: c.health(bot), grenades: thrown, playerDied: died});
  },
  async 'flags-change-world'(c) {
    // Each flag from its original source, in one map each (c.restart between); Gunther's alliance (AllianceTrigger0's touch on the walk in) and orders are checked.
    // FilbenGaveKey, M01PlayerAggressive and KnowsShipment are read here only by conversation branches (ConEventCheckFlag in FilbenSecondBark/FilbenFinalBark/MeetFilben2;
    // PaulCongratulations, MeetKaplan, TrooperCongratulation, postmissiontroopsssecure; MoleConvos), which this driver does not play. Three of those conversations fire
    // OrdersTriggers (PaulWandering, HarleyStartsToWander, BumFemaleWanders); which branches carry them was not traced.
    // 1. GuntherFreed (the cell button chain, unarmed: NothingChoice -> GiveNothingNicely) -> Gunther's alliance (AllianceTrigger0) and orders (GuntherAttacks).
    const gunther = await freeGunther(c, null);
    // 2. FilbenGaveKey: MeetFilben's first choice (TransferObject of ruin_key).
    c.restart(); for (let i = 0; i < 240 && !c.flag('m1missionstart'); i++) c.frames(5);
    const filben = await meetFilben(c, 0);
    // 3. KnowsShipment: DL_NearTop (DataLinkTrigger5) sets it from its conversation.
    c.restart(); for (let i = 0; i < 240 && !c.flag('m1missionstart'); i++) c.frames(5);
    const nearTop = c.byClass('DataLinkTrigger').find(t => /^dl_neartop$/i.test(String(c.read(t, 'datalinkTag'))));
    if (!nearTop) throw new Undriven('no DL_NearTop trigger');
    const np = c.pos(nearTop); c.fixture.place([np[0] - 20, np[1], np[2] + 45], {yaw: 0}); c.frames(10);
    c.fixture.driveLegacy({forward: 1}); c.frames(40); c.fixture.driveLegacy({forward: 0});
    for (let t = 0; t < 40 && !c.flag('knowsshipment'); t++) c.frames(60);
    const shipment = c.flag('knowsshipment');
    // 4. M01PlayerAggressive: Mission01.Timer counts the living Terrorists plus the carcasses JC did not kill (or only knocked out) and sets it below 23. The map holds
    //    29 Terrorists and one placed TerroristCarcass, so eight kills by the player set it; each kill is TakeDamage with the player as instigator (as island-carcass).
    const victims = c.byClass('Terrorist').filter(t => !c.gone(t)).slice(0, 8);
    for (const t of victims) c.damage(t, 1000, 'Shot', c.player());
    for (let t = 0; t < 5 && !c.flag('m01playeraggressive'); t++) c.frames(60);
    const aggressive = {killed: victims.length, flag: c.flag('m01playeraggressive')};
    const out = {gunther: {freed: gunther.freed, before: gunther.before, after: gunther.after, respects: gunther.respects}, filben: {gaveKey: filben.gaveKey, keys: filben.keys},
      shipment, aggressive};
    return ok(gunther.freed && gunther.before.alliance !== 'UNATCO' && gunther.after.alliance === 'UNATCO' && gunther.after.orders === 'RunningTo'
      && filben.gaveKey && filben.keys.includes('ruin_key') && shipment && aggressive.flag, out);
  },
});
