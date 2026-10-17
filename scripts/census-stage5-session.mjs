/** Session and scenario drivers of the Stage 5 census (scripts/census-stage5.mjs). Fixture rules (docs/stage-5-exit-criteria.md "Judgement chosen"): the player is
 * PLACED (fixture.place) at the approach; items come from the map or `summon`; flags and health change only through the original's own sources (conversation
 * events, triggers, weapons, zones, TakeDamage as a damage source calls it, Trigger as a Trigger actor calls it). Nothing the scenario is about is written. */
import {Undriven, near, PI, simulatedMsAdvance} from './census-stage5-drivers.mjs';

import {actorRenderFeedback} from '../src/viewer/actor-render-feedback.mjs';

export async function openSession(map, assets) {
  const {decodeMap} = await import('../src/unreal/map.mjs');
  const {createGame} = await import('../src/viewer/game.mjs');
  const {createSimSession} = await import('../src/viewer/sim-session.mjs');
  const {createPlayerInputFixture} = await import('./player-input-fixture.mjs');
  const asset = await assets.get(map);
  const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
  const sim = createSimSession(game, {assets});
  const runtime = game.doors.scriptRuntime.runtime;
  const player = () => game.player.collisionActor;
  const level = () => runtime.levelFor(player());
  const fixture = createPlayerInputFixture(game, {});
  const watched = new Set();
  const read = (object, name) => runtime.readNamed(object, name);
  const frame = () => {
    simulatedMsAdvance(1000 / 60);
    game.tick(1 / 60);
    const sprites = sim.sprites();
    const hud = sim.hud({width: 1440, height: 960, view: game.view()});
    const errors = [...sprites.errors, ...hud.errors];
    if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
    // A headless frame draws no actor meshes, so LastRenderTime stays at the LoadMap value and a stasis device (a keypad, a panel, a door) never runs its Timer; the
    // renderer's own feedback stamps what the player is working on, as the Stage 3 route does (docs/script-training-route.md).
    for (const target of watched) actorRenderFeedback(runtime, target)();
    const failures = game.doors.scriptRuntime.npcFailures;
    if (failures?.size) throw new Error([...failures.values()][0]);
  };
  const frames = n => { for (let i = 0; i < n; i++) frame(); };
  const c = {
    game, runtime, fixture, read, frames, player, level, watched,
    exec: command => game.hud.scoped(() => runtime.scriptConsoleExec(player(), command)),
    actors: () => level().actors.filter(Boolean),
    actor: name => level().actors.find(a => a?.name === name),
    byClass: cls => c.actors().filter(a => (runtime.instance(a).cls.record.key.split('.').pop()) === cls.toLowerCase()),
    byTag: tag => c.actors().filter(a => { try { return read(a, 'Tag') === tag; } catch { return false; } }),
    isA: (a, key) => { for (let k = runtime.instance(a).cls; k; k = k.base) if (k.record.key === key.toLowerCase()) return true; return false; },
    pos: a => read(a, 'Location'),
    state: a => runtime.instance(a).state?.stateNode?.record?.key ?? 'none',
    gone: a => !level().actors.includes(a) || Boolean(runtime.instance(a).pendingKill) || Boolean(read(a, 'bDeleteMe')),
    flag: name => Boolean(read(player(), 'FlagBase')?.getBool(name)),
    health: a => read(a, 'Health'),
    /** Place the player at `from` looking at `to` (fixture write; the aim is real once ticks run). */
    stand(from, to) {
      const eye = from[2] + game.player.baseEyeHeight, dx = to[0] - from[0], dy = to[1] - from[1];
      fixture.place(from, {yaw: Math.atan2(dy, dx), pitch: Math.atan2(to[2] - eye, Math.hypot(dx, dy))});
    },
    /** A point `distance` units from `target` along the heading `bearing` (radians), at the target's height. */
    approach: (target, distance, bearing = PI) => { const t = c.pos(target); return [t[0] + Math.cos(bearing) * distance, t[1] + Math.sin(bearing) * distance, t[2]]; },
    /** Frob an actor from the first approach (8 bearings, 3 distances) from which the view trace selects it; the fixture refuses a miss. */
    async frob(target, distances = [48, 70, 36]) {
      let last = null;
      const at = read(target, 'Location');
      for (const lift of [0, 28]) for (const distance of distances) for (let k = 0; k < 8; k++) {
        const bearing = k * PI / 4;
        try { return await fixture.frob(target, {position: [at[0] + Math.cos(bearing) * distance, at[1] + Math.sin(bearing) * distance, at[2] + lift], maxFrames: 25}); }
        catch (error) { if (!/View trace did not select/.test(error.message)) throw error; last = error; }
      }
      throw new Undriven(`no approach selects ${target.name} (${String(last.message).slice(0, 90)})`);
    },
    async take(item) {
      await c.frob(item); frames(10);
      return read(item, 'Owner') === player();
    },
    async guard(fn) { try { await fn(); return false; } catch (error) { if (/OPEN DXONLY/.test(error.message)) return true; throw error; } },
    /** One the console cheat summons in front of the player (the alterations census's fallback; a map pickup is reached from placements the world may not hold),
     * else the class's free pickup from the map. */
    async give(cls) {
      c.exec(`summon ${cls}`); frames(5);
      const summoned = c.byClass(cls).at(-1);
      if (summoned && !read(summoned, 'Owner') && await c.take(summoned)) return summoned;
      for (const candidate of c.byClass(cls).filter(a => !read(a, 'Owner') && !read(a, 'bHidden'))) {
        try { if (await c.take(candidate)) return candidate; } catch (error) { if (!(error instanceof Undriven)) throw error; }
      }
      throw new Undriven(`no ${cls} could be picked up`);
    },
    async equip(item) {
      await game.activateBelt(read(item, 'beltPos')); frames(60);
      if (read(player(), 'inHand') !== item) throw new Undriven(`ActivateBelt ${read(item, 'beltPos')} did not select ${item.name}`);
    },
    /** Stand `distance` from `target` at the first bearing where the player keeps walking on dry ground (physics 1, zone not 0, unhurt). */
    openStand(target, distance, bearings = [PI, PI * 0.75, PI * 1.25, PI / 2, -PI / 2, 0]) {
      for (const bearing of bearings) {
        const from = c.approach(target, distance, bearing), h = c.health(player());
        c.stand(from, c.pos(target)); frames(8);
        const zone = read(player(), 'Region')?.['engine.actor.pointregion.zonenumber'];
        if (read(player(), 'Physics') === 1 && zone !== 0 && c.health(player()) >= h) return {bearing, from};
      }
      throw new Undriven(`no dry standing place ${distance} units from ${target.name}`);
    },
    /** Let a scenario run `seconds`, sampling once a second what the NPC does to the player: hostile when its Enemy is the player or a Tracer flies. */
    engage(pawn, seconds) {
      const out = {enemy: false, tracers: 0, minHealth: c.health(player()), states: new Set()};
      for (let t = 0; t < seconds; t++) {
        frames(60);
        if (!c.gone(pawn)) { out.enemy ||= read(pawn, 'Enemy') === player(); out.states.add(c.state(pawn).split('.').pop()); }
        out.tracers = Math.max(out.tracers, c.byClass('Tracer').length); out.minHealth = Math.min(out.minHealth, c.health(player()));
      }
      return {...out, states: [...out.states], physics: read(player(), 'Physics')};
    },
    shoot(hold = 4, wait = 30) { game.pressFire(); frames(hold); game.releaseFire(); frames(wait); },
    key(code, hold = 2) { game.inputKey(code, true); frames(hold); game.inputKey(code, false); frames(2); },
    /** The top modal window of the root (the Stage 3 probe's walk): root +0x140 child list, +0x144 next sibling, +0x28 type byte >= 2. */
    topModal() {
      const W = game.hud?.host?.W, rootWindow = runtime.namedReference(player(), 'rootWindow').get();
      if (!W || !rootWindow) return null;
      let w = W.ptr(rootWindow, 0x140);
      while (w && W.u8(w, 0x28) < 2) w = W.ptr(w, 0x144);
      return w;
    },
    closeModals() { for (let i = 0; i < 3 && c.topModal(); i++) { game.windowKey('Escape', true); game.windowKey('Escape', false); frames(10); } },
    /** Keep pressing Enter (the first choice / the next line) while a conversation plays, for up to `seconds` of Level time or until `until()`. */
    advance(seconds, until) {
      for (let i = 0; i < seconds * 2 && !(until?.()); i++) { game.windowKey('Enter', true); game.windowKey('Enter', false); frames(30); }
    },
    damage(target, amount, type, instigator = null) {
      game.hud.scoped(() => runtime.processEvent(target, 'TakeDamage', [amount, instigator ?? target, read(target, 'Location'), [0, 0, 0], type]));
    },
    /** A Trigger actor's call on `target` (the turret's Tag has no trigger in the map: a camera or computer sends it in the original). */
    trigger(target) { game.hud.scoped(() => runtime.processEvent(target, 'Trigger', [player(), player()])); },
  };
  const peak = {};
  let used = false;
  return {
    c,
    async run(id, driver) {
      watched.clear();
      if (used) { game.reset(); frames(2); }
      used = true;
      frames(30);
      runtime.writeNamed(player(), 'bCheatsEnabled', true);
      try {
        const out = await driver(c);
        return out.ok ? {status: 'plays', effect: out.effect} : {status: 'no-effect', message: out.why ?? 'the effect did not happen', effect: out.effect};
      } catch (error) {
        const frames_ = String(error.stack ?? '').split('\n').slice(1, 5).map(l => l.trim().replace(/^at /, '').replace(/\(?file:\/\/.*\/(src\/[^)]*|scripts\/[^)]*)\)?/, '$1'));
        if (error instanceof Undriven) return {status: 'undriven', message: error.message};
        if (/census-stage5-session/.test(frames_[0] ?? '') && /^(TypeError|ReferenceError|RangeError)/.test(String(error.stack)))
          return {status: 'driver-error', message: `${error.message} @ ${frames_[0]}`};
        return {status: 'pause', message: error.message.split('\n')[0], frames: frames_};
      }
    },
  };
}

// --- drivers -------------------------------------------------------------------------------------------------------------------------------
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
export const ok = (condition, effect, why) => ({ok: Boolean(condition), effect, why});
export const DRIVERS = {
  // 00_Training --------------------------------------------------------------------------------------------------------------------
  async 'dark-room-aug'(c) {
    let aug = c.read(c.read(c.player(), 'AugmentationSystem'), 'FirstAug');
    while (aug && !c.isA(aug, 'deusex.auglight')) aug = c.read(aug, 'next');
    if (!aug) throw new Undriven('the player has no AugLight at the start');
    const energy0 = c.read(c.player(), 'Energy');
    c.key('F12'); c.frames(180);
    const active = Boolean(c.read(aug, 'bIsActive')), energy = c.read(c.player(), 'Energy');
    return ok(active && energy < energy0, {active, energy0, energy, beams: c.byClass('Beam').length});
  },
  async 'bots'(c) {
    const out = {};
    for (const cls of ['RepairBot', 'MedicalBot']) {
      const bot = c.byClass(cls)[0];
      if (!bot) throw new Undriven(`no ${cls} in the map`);
      await c.frob(bot); c.frames(60);
      out[cls] = Boolean(c.topModal()); c.closeModals();
    }
    return ok(out.RepairBot && out.MedicalBot, out);
  },
  async 'obstacle-jump'(c) {
    c.fixture.place([6991, -55, 50], {yaw: -PI / 2}); c.frames(30);
    const z0 = c.pos(c.player())[2]; let airborne = false, zMax = z0;
    c.fixture.driveLegacy({forward: 1});
    for (let i = 0; i < 12; i++) { c.key('Space', 3); for (let j = 0; j < 20; j++) { c.frames(1); const p = c.pos(c.player()); zMax = Math.max(zMax, p[2]); airborne ||= c.read(c.player(), 'Physics') === 2; } }
    c.fixture.driveLegacy({forward: 0}); c.frames(60);
    return ok(airborne && zMax > z0 + 10, {z0, zMax, end: c.pos(c.player()).map(Math.round), physics: c.read(c.player(), 'Physics')});
  },
  async 'crate-stack'(c) {
    const crates = c.actors().filter(a => /^CrateUnbreakableSmall$/.test(a.name.replace(/\d+$/, ''))).sort((a, b) => near(c.pos(a), [7063, -1632, 8]) - near(c.pos(b), [7063, -1632, 8]));
    const crate = crates[0];
    if (!crate) throw new Undriven('no CrateUnbreakable in the map');
    await c.frob(crate); c.frames(30);
    const carried = c.read(c.player(), 'CarriedDecoration') === crate;
    c.key('Tab'); c.frames(60);
    const dropped = !c.read(c.player(), 'CarriedDecoration');
    return ok(carried && dropped, {crate: crate.name, carried, dropped, at: c.pos(crate).map(Math.round)});
  },
  async 'hazmat-swim'(c) {
    const water = c.actor('WaterZone0'), p = c.pos(water);
    const h0 = c.health(c.player());
    c.fixture.place([p[0], p[1], p[2] + 20], {yaw: 0}); c.frames(600);
    const bare = h0 - c.health(c.player()), swimming = c.read(c.player(), 'Physics') === 3;
    const suit = c.actor('HazMatSuit2');
    c.fixture.place([6538, -3980, 50], {yaw: 0}); c.frames(10);
    if (!(await c.take(suit))) throw new Undriven('the HazMat suit could not be taken');
    await c.equip(suit); c.game.inputButton('LeftMouse', true); c.frames(3); c.game.inputButton('LeftMouse', false); c.frames(30);
    const active = Boolean(c.read(suit, 'bActive'));
    const h1 = c.health(c.player());
    c.fixture.place([p[0], p[1], p[2] + 20], {yaw: 0}); c.frames(600);
    const suited = h1 - c.health(c.player());
    return ok(swimming && bare > 0 && active && suited < bare, {bare, suited, swimming, active});
  },
  async 'zone-debug'(c) {
    const water = c.actor('WaterZone0'), p = c.pos(water);
    c.fixture.place([p[0], p[1], p[2] + 20], {yaw: 0}); c.frames(60);
    const series = [];
    for (let i = 0; i < 10; i++) { c.frames(120); series.push([c.health(c.player()), Math.round(c.read(c.player(), "Energy")), c.read(c.player(), "PainTime")]); }
    const pl = c.player(), reg = n => { const r = c.read(pl, n); return r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k.split('.').pop(), v && typeof v === 'object' && 'name' in v ? v.name : v])) : null; };
    const zone = c.read(pl, 'HeadRegion')?.['engine.actor.pointregion.zone'];
    return ok(true, {head: reg('HeadRegion'), foot: reg('FootRegion'), zone: zone ? {bPain: c.read(zone, 'bPainZone'), dmg: c.read(zone, 'DamagePerSec'), type: c.read(zone, 'DamageType'), water: c.read(zone, 'bWaterZone')} : null,
      series, phys: c.read(pl, 'Physics'), pos: c.pos(pl), health: c.health(pl), painTime: c.read(pl, 'PainTime'), swimTimer: c.read(pl, 'swimTimer')});
  },
  async 'training-datalinks'(c) {
    // The swim and medbot triggers sit by the radioactive pool: they come last. A Touch follows the player's own movement, not a placement: each is placed inside its radius and walked a few steps.
    const pool = t => /swim|medbot/i.test(String(c.read(t, 'datalinkTag')));
    const triggers = c.byClass('DataLinkTrigger').sort((a, b) => pool(a) - pool(b) || c.pos(a)[0] - c.pos(b)[0]), names = [];
    let died = false; const trace = [];
    try {
      for (const t of triggers) {
        names.push(String(c.read(t, 'datalinkTag')));
        const need = c.read(t, 'CheckFlag'); // a conditional trigger (dl_lockstr after dl_crate): the player takes the time the earlier line needs
        for (let i = 0; need && i < 90 && !c.flag(String(need)); i++) c.frames(60);
        const at = c.pos(t); c.fixture.place([at[0] - 20, at[1], at[2] + 45], {yaw: 0}); c.frames(10);
        c.fixture.driveLegacy({forward: 1}); c.frames(40); c.fixture.driveLegacy({forward: 0}); c.frames(10);
        trace.push([names.at(-1), c.health(c.player()), c.pos(c.player()).map(Math.round).join(',')]);
      }
      c.fixture.place([-1149, 826, -20], {yaw: 0}); c.frames(60 * 260);
    } catch (error) { if (!/OPEN DXONLY/.test(error.message)) throw error; died = true; }
    const played = names.filter(n => c.flag(n.toLowerCase() + '_played'));
    // dl_bodyexit has no collision (bCollideActors false): the opening of the body doors triggers it, not a walk (the route probe covers it).
    const missing = names.filter(n => !played.includes(n) && !/bodyexit/i.test(n));
    return ok(!missing.length, {triggers: names.length, played: played.length, died, missing});
  },
  // 00_TrainingCombat --------------------------------------------------------------------------------------------------------------
  async 'pistol-range'(c) {
    const pistol = await c.give('WeaponPistol'); await c.equip(pistol);
    const ammo0 = c.read(pistol, 'AmmoType') ? c.read(c.read(pistol, 'AmmoType'), 'AmmoAmount') : null;
    c.stand([65, -543, -76], [65, -3280, -84]); c.frames(10);
    for (let i = 0; i < 6; i++) c.shoot(4, 40);
    const ammo = c.read(pistol, 'AmmoType') ? c.read(c.read(pistol, 'AmmoType'), 'AmmoAmount') : null;
    return ok(ammo !== null && ammo < ammo0, {ammo0, ammo, glass: c.byClass('BreakableGlass').map(g => c.gone(g) ? 'broken' : 'whole'), shot1: c.flag('dl_targetrangeshot1_played')});
  },
  async 'rifle-scope'(c) {
    const rifle = await c.give('WeaponRifle'); await c.equip(rifle);
    c.key('BracketLeft'); c.frames(30);
    const scoped = Boolean(c.read(rifle, 'bZoomed'));
    c.stand([1060, -543, -76], [1060, -3280, -84]); c.frames(10);
    for (let i = 0; i < 3; i++) c.shoot(4, 60);
    const ammo = c.read(c.read(rifle, 'AmmoType'), 'AmmoAmount');
    return ok(scoped, {scoped, ammo, fov: c.read(c.player(), 'DesiredFOV'), skill: 'SkillWeaponRifle'});
  },
  async 'lam-wall'(c) {
    const lam = await c.give('WeaponLAM'); await c.equip(lam);
    const wall = c.actor('BreakableWall1'); if (!wall) throw new Undriven('no BreakableWall1');
    const w = c.pos(wall); c.stand([w[0] - 250, w[1], w[2] + 20], w);
    const n0 = c.byClass('LAM').length, st0 = c.state(lam);
    c.frames(10); c.shoot(10, 600);
    return ok(c.gone(wall) || c.read(wall, 'bHidden'), {wall: wall.name, gone: c.gone(wall), lams: [n0, c.byClass('LAM').length], weaponState: [st0, c.state(lam)], inHand: c.read(c.player(), 'inHand')?.name});
  },
  // 00_TrainingFinal ---------------------------------------------------------------------------------------------------------------
  async 'stealth-maze'(c) {
    const soldier = c.actor('Soldier0'); if (!soldier) throw new Undriven('no Soldier0');
    const s0 = c.pos(soldier); c.stand([s0[0] + 180, s0[1], s0[2]], s0); c.frames(1200);
    const enemy = c.read(soldier, 'Enemy');
    return ok(enemy === c.player() || c.flag('dl_failedstealth_played'), {state: c.state(soldier), enemy: enemy?.name ?? null, failed: c.flag('dl_failedstealth_played')});
  },
  async 'elevator'(c) {
    const door = c.actor('DeusExMover0'), sw = c.byClass('Switch1').find(s => c.read(s, 'Event') === 'FirstStealthDoor');
    if (!door || !sw) throw new Undriven('no FirstStealthDoor switch');
    const before = c.read(door, 'KeyNum'); await c.frob(sw); c.frames(240);
    const after = c.read(door, 'KeyNum'), moving = Boolean(c.read(door, 'bInterpolating'));
    return ok(after !== before || moving, {before, after, moving, note: 'ElevatorMover1 (ExitDoor) is moved by mission triggers only: not driven'});
  },
  async 'alarm-chain'(c) {
    const unit = c.actor('AlarmUnit1'); if (!unit) throw new Undriven('no AlarmUnit1');
    const soldier = c.actor('Soldier0');
    const before = {state: c.state(soldier), enemy: c.read(soldier, 'Enemy')?.name ?? null};
    const up = c.pos(unit); c.stand([up[0] - 200, up[1], up[2] + 20], up);
    c.trigger(unit); // the AlarmUnit is tripped by a Trigger call (a laser, camera or the maze's trigger); it has no use action
    c.frames(60 * 12);
    const after = {state: c.state(soldier), enemy: c.read(soldier, 'Enemy')?.name ?? null, active: Boolean(c.read(unit, 'bActive'))};
    return ok(after.active, {before, after, soldierAlliance: c.read(soldier, 'Alliance')}, 'AlarmUnit1.Trigger left bActive false');
  },
  async 'meet-page-final'(c) {
    const trigger = c.byTag('ConversationTrigger').find(t => c.read(t, 'conversationTag') === 'm00meetpage'); if (!trigger) throw new Undriven('no m00meetpage trigger');
    const tp = c.pos(trigger), bob = c.byClass('BobPage')[0];
    walkAndTalk(c, [tp[0] - 40, tp[1], tp[2] + 45], bob ? c.pos(bob) : [tp[0] + 200, tp[1], tp[2]], 60, () => c.flag('m00meetpage_played'));
    return ok(c.flag('m00meetpage_played'), {played: c.flag('m00meetpage_played'), bobInWorld: bob ? c.read(bob, 'bInWorld') : null});
  },
};

