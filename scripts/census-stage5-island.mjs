/** The 01_NYC_UNATCOIsland drivers of the Stage 5 census (scripts/census-stage5.mjs), added to the session's DRIVERS. Same rules as census-stage5-session.mjs. */
import {Undriven, PI} from './census-stage5-drivers.mjs';
import {DRIVERS, ok} from './census-stage5-session.mjs';

const carcasses = c => c.actors().filter(a => /carcass$/.test(c.runtime.instance(a).cls.record.key));
const stateName = (c, a) => c.state(a).split('.').pop();
const HOSTILE = /attack|alert|flee|seek|search|hunt|react|run|fear|disabled|stunn/i;
/** What a pawn does about the player: its Enemy or a reacting state (not the boot state, nor the one it already stood in). */
const reacting = (c, pawn, before) => Boolean(c.read(pawn, 'Enemy')) || (HOSTILE.test(stateName(c, pawn)) && stateName(c, pawn) !== before);
async function armed(c, cls = 'WeaponPistol') { const w = await c.give(cls); await c.equip(w); return w; }
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
const lockpicking = async (c, door, seconds) => { c.watched.add(door); await c.frob(door, [64, 80, 48]); c.frames(60 * seconds); };

Object.assign(DRIVERS, {
  async 'island-shoot-npc'(c) {
    const t = c.actor('Terrorist0'); if (!t) throw new Undriven('no Terrorist0');
    await armed(c); const where = c.openStand(t, 220), n0 = carcasses(c).length;
    const h0 = c.health(t); let shots = 0;
    const died = await c.guard(async () => { for (; shots < 20 && !c.gone(t) && c.health(t) > 0; shots++) c.shoot(4, 30); c.frames(180); });
    return ok(c.gone(t) || c.health(t) <= 0, {h0, health: c.gone(t) ? null : c.health(t), shots, state: c.gone(t) ? null : stateName(c, t), enemy: !c.gone(t) && c.read(t, 'Enemy') === c.player(), newCarcasses: carcasses(c).length - n0, playerDied: died, bearing: where.bearing});
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
    const t = c.actor('Terrorist0'); if (!t) throw new Undriven('no Terrorist0');
    c.frames(300); const before = stateName(c, t); c.openStand(t, 700); let out;
    const died = await c.guard(async () => { out = c.engage(t, 10); });
    return ok(reacting(c, t, before) || out?.enemy, {before, out, playerDied: died});
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
    const laser = c.actor('LaserTrigger0'); if (!laser) throw new Undriven('no LaserTrigger0');
    const lp = c.pos(laser), [fx, fy] = forward(c, laser);
    c.stand([lp[0] + fx * 120, lp[1] + fy * 120, lp[2] - 40], lp); c.frames(20);
    c.fixture.driveLegacy({forward: 1}); c.frames(100); c.fixture.driveLegacy({forward: 0}); c.frames(120);
    return ok(c.flag('statuealarmtriggered'), {alarmFlag: c.flag('statuealarmtriggered'), lastAlarm: c.read(laser, 'lastAlarmTime'), isOn: c.read(laser, 'bIsOn'), at: c.pos(c.player()).map(Math.round)});
  },
  async 'island-hack-panel'(c) {
    const panel = c.actor('ControlPanel0'), laser = c.actor('LaserTrigger0'); if (!panel || !laser) throw new Undriven('no ControlPanel0');
    const tool = await armed(c, 'Multitool'); const uses0 = c.read(tool, 'NumCopies');
    c.watched.add(panel); await c.frob(panel, [48, 36, 64]); c.frames(60 * 40);
    return ok(!c.read(laser, 'bIsOn') || c.read(tool, 'NumCopies') < uses0, {laserOn: c.read(laser, 'bIsOn'), multitool: [uses0, c.read(tool, 'NumCopies')], hacking: c.read(panel, 'bHacking')});
  },
  async 'island-carcass'(c) {
    const a = c.actor('Terrorist4'), b = c.actor('Terrorist27'); if (!a || !b) throw new Undriven('no Terrorist4/27');
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
    const out = {};
    for (const name of ['ComputerPersonal0', 'ATM0', 'ComputerSecurity1']) {
      const a = c.actor(name); if (!a) { out[name] = 'absent'; continue; }
      try { await c.frob(a, [64, 48, 80]); c.frames(90); out[name] = Boolean(c.topModal()); c.closeModals(); } catch (error) { if (!(error instanceof Undriven)) throw error; out[name] = 'not reachable'; }
    }
    return ok(Object.values(out).filter(v => v === true).length >= 2 && !Object.values(out).includes(false), out);
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
    const f = c.actor('HarleyFilben0'); if (!f) throw new Undriven('no HarleyFilben0');
    const fp = c.pos(f); c.stand([fp[0] - 80, fp[1], fp[2]], fp); c.frames(30);
    await c.frob(f, [60, 80, 48]).catch(() => null);
    // Down then Enter: the second choice ("You can trust me") is the branch that hands over the key.
    for (let i = 0; i < 120 && !c.flag('m01playermetfilben'); i++) { c.game.windowKey('ArrowDown', true); c.game.windowKey('ArrowDown', false); c.frames(3); c.game.windowKey('Enter', true); c.game.windowKey('Enter', false); c.frames(27); }
    return ok(c.flag('m01playermetfilben'), {met: c.flag('m01playermetfilben'), gaveKey: c.flag('filbengavekey'), nanokeys: c.byClass('NanoKey').filter(k => c.read(k, 'Owner') === c.player()).length});
  },
  async 'gunther-rescued'() { throw new Undriven('the cell door DeusExMover10 is reached by no frob approach tried (8 bearings, 3 distances, 2 heights around its Location); the walk to it is not driven'); },
  async 'meet-terrorist'(c) {
    toCommander(c, 40, () => c.flag('meetterrorist_played') || c.flag('statuemissioncomplete'));
    c.advance(40, () => c.flag('statuemissioncomplete'));
    return ok(c.flag('meetterrorist_played') || c.flag('statuemissioncomplete'), {played: c.flag('meetterrorist_played'), complete: c.flag('statuemissioncomplete'), attacked: c.flag('playerattackedstatueterrorist'), commander: stateName(c, commander(c)), at: c.pos(c.player()).map(Math.round)});
  },
  async 'route-front'(c) {
    const door = c.actor('DeusExMover12'); if (!door) throw new Undriven('no DeusExMover12');
    const tool = await armed(c, 'Lockpick'); const died = await c.guard(() => lockpicking(c, door, 30));
    return ok(!c.read(door, 'bLocked'), {locked: c.read(door, 'bLocked'), picks: c.read(tool, 'NumCopies'), at: c.pos(door).map(Math.round), playerDied: died}, died ? 'the player was killed at the door (OPEN DXONLY) before the pick finished' : undefined);
  },
  async 'route-back'(c) {
    const door = c.actor('DeusExMover2'); if (!door) throw new Undriven('no DeusExMover2');
    const tool = await armed(c, 'Lockpick'); const died = await c.guard(() => lockpicking(c, door, 30));
    return ok(!c.read(door, 'bLocked'), {locked: c.read(door, 'bLocked'), picks: c.read(tool, 'NumCopies'), playerDied: died});
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
    await armed(c); c.stand([2887, 38, 2494 + 45], c.pos(cm)); c.frames(10);
    const died = await c.guard(async () => { for (let i = 0; i < 25 && !c.gone(cm) && c.health(cm) > 0; i++) c.shoot(4, 30); c.frames(60 * 8); });
    return ok(c.flag('terroristcommander_dead') && c.flag('statuemissioncomplete'), {dead: c.flag('terroristcommander_dead'), health: c.gone(cm) ? null : c.health(cm), complete: c.flag('statuemissioncomplete'), killedPlayed: c.flag('dl_leaderkilled_played'), playerDied: died});
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
  async 'light-vs-sight'() { throw new Undriven('needs a measured lit/dark pair of poses in an NPC\'s view and the NPC\'s perception fields; no such pose is read from the map yet'); },
  async 'explosion-world'(c) {
    await armed(c); const crate = c.actor('CrateExplosiveSmall10'); if (!crate) throw new Undriven('no CrateExplosiveSmall10');
    c.stand(c.approach(crate, 300, PI), c.pos(crate)); c.frames(10); const h0 = c.health(c.player());
    const died = await c.guard(async () => { for (let i = 0; i < 12 && !c.gone(crate); i++) c.shoot(4, 30); c.frames(180); });
    return ok(c.gone(crate), {gone: c.gone(crate), playerHealth: [h0, c.health(c.player())], died});
  },
  async 'emp-electronics'(c) {
    const bot = c.actor('SecurityBot0'); if (!bot) throw new Undriven('no SecurityBot0');
    await armed(c, 'WeaponEMPGrenade'); const bp = c.pos(bot), before = {state: stateName(c, bot), emp: c.read(bot, 'EMPHitPoints'), health: c.health(bot)};
    c.stand(c.approach(bot, 250, 0), bp); c.frames(10); let thrown = 0;
    const died = await c.guard(async () => { c.game.pressFire(); c.frames(8); c.game.releaseFire(); for (let t = 0; t < 8; t++) { c.frames(60); thrown = Math.max(thrown, c.byClass('EMPGrenade').length); } });
    return ok(stateName(c, bot) !== before.state || c.read(bot, 'EMPHitPoints') < before.emp || c.health(bot) < before.health, {before, state: stateName(c, bot), emp: c.read(bot, 'EMPHitPoints'), health: c.health(bot), grenades: thrown, playerDied: died});
  },
  async 'flags-change-world'() { throw new Undriven('needs GuntherFreed (see gunther-rescued) and the Filben and commander flows; only the conversation flows of meet-filben and meet-terrorist are driven'); },
});
