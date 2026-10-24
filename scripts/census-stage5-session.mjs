/** Session and scenario drivers of the Stage 5 census (scripts/census-stage5.mjs). Fixture rules (docs/stage-5-exit-criteria.md "Judgement chosen"): the player is
 * PLACED (fixture.place) at the approach; items come from the map or `summon`; flags and health change only through the original's own sources (conversation
 * events, triggers, weapons, zones, TakeDamage as a damage source calls it, Trigger as a Trigger actor calls it). Nothing the scenario is about is written. */
import {Undriven, near, PI, simulatedMsAdvance} from './census-stage5-drivers.mjs';

import {actorRenderFeedback} from '../src/viewer/actor-render-feedback.mjs';

export async function openSession(map, assets, {travel = null, saveDirectory = null, frameSeconds = 1 / 60, paintEvery = 1} = {}) {
  const {decodeMap} = await import('../src/unreal/map.mjs');
  const {handleLimit, releaseHandleRange} = await import('../src/runtime/script-object-handles.mjs');
  const handleStart = handleLimit();
  const {createGame} = await import('../src/viewer/game.mjs');
  const {createSimSession} = await import('../src/viewer/sim-session.mjs');
  const {createPlayerInputFixture} = await import('./player-input-fixture.mjs');
  // A level filed in Save\Current is opened from there (travel.mjs `restore`), as the page's worker does
  const restore = travel?.arrival?.restore ?? null;
  const filed = restore ? (await import('../src/viewer/restore-asset.mjs')).restoredLevel(saveDirectory, restore) : null;
  const asset = filed ? filed.asset : await assets.get(map);
  const game = await createGame(filed ? filed.map : decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true, ...(travel ? {travel} : {}),
    ...(saveDirectory ? {saveDirectory} : {}), ...(filed ? {restore: true} : {})});
  const sim = createSimSession(game, {assets});
  const runtime = game.doors.scriptRuntime.runtime;
  const player = () => game.player.collisionActor;
  const level = () => runtime.levelFor(player());
  const fixture = createPlayerInputFixture(game, {});
  const watched = new Set();
  let travelRequest = null, painted = 0;
  const read = (object, name) => runtime.readNamed(object, name);
  const frame = () => {
    simulatedMsAdvance(1000 * frameSeconds);
    game.tick(frameSeconds);
    // UGameEngine::Tick's client travel: an OPEN (the Dying player's OPEN DXONLY) ends the level after the next tick; a session opened with
    // `travel` browses instead and the request for the next level waits in c.takeTravel()
    const request = game.clientTravel();
    if (request) travelRequest = request;
    // `paintEvery` N draws the sprites and the HUD on every Nth frame only (the conversation census: the paint code is checked, not every frame)
    if (paintEvery <= 1 || ++painted % paintEvery === 0) {
      const sprites = sim.sprites();
      const hud = sim.hud({width: 1440, height: 960, view: game.view()});
      const errors = [...sprites.errors, ...hud.errors];
      if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
    }
    // A headless frame draws no actor meshes, so LastRenderTime stays at the LoadMap value and a stasis device (a keypad, a panel, a door) never runs its Timer; the
    // renderer's own feedback stamps what the player is working on, as the Stage 3 route does (docs/script-training-route.md).
    for (const target of watched) actorRenderFeedback(runtime, target)();
    const failures = game.doors.scriptRuntime.npcFailures;
    if (failures?.size) throw new Error([...failures.values()][0]);
  };
  const frames = n => { for (let i = 0; i < n; i++) frame(); };
  const c = {
    game, runtime, fixture, read, frames, player, level, watched,
    takeTravel() { const request = travelRequest; travelRequest = null; return request; },
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
    /** Whether a point lies inside the world (a zone other than 0): a placement outside it makes the player fall out of the world and die. */
    inWorld: p => (level().pointRegion?.(p)?.zoneNumber ?? 0) !== 0,
    /** Place the player at `from` looking at `to` (fixture write; the aim is real once ticks run). */
    stand(from, to) {
      const eye = from[2] + game.player.baseEyeHeight, dx = to[0] - from[0], dy = to[1] - from[1];
      fixture.place(from, {yaw: Math.atan2(dy, dx), pitch: Math.atan2(to[2] - eye, Math.hypot(dx, dy))});
    },
    /** A point `distance` units from `target` along the heading `bearing` (radians), at the target's height. */
    approach: (target, distance, bearing = PI) => { const t = c.pos(target); return [t[0] + Math.cos(bearing) * distance, t[1] + Math.sin(bearing) * distance, t[2]]; },
    /** Frob an actor from the first approach (8 bearings, 3 distances) from which the view trace selects it; the fixture refuses a miss. */
    async frob(target, distances = [48, 70, 36]) { return c.approach_(target, distances, options => fixture.frob(target, options)); },
    /** Use the tool in hand on `target` the way the original does (ParseLeftClick: DoFrob(Self, inHand) for a Lockpick or NanoKeyRing on a DeusExMover and a
     * Multitool on a HackableDevices): aim until the view trace selects it, then press the left mouse button. `c.frob` is the right button (ParseRightClick:
     * DoFrob(Self, None)), which never starts a hack or a pick. */
    async useTool(target, distances = [48, 70, 36], hold = 1) {
      return c.approach_(target, distances, options => {
        fixture.aim(target, options);
        // The placement is a few units off the floor: the player lands (real physics) and is aimed again from where it stands, so the view trace holds the target
        // for the whole work (Timer of the pick or the hack: `frobTarget != Self` stops it and the tool is spent).
        frames(45);
        const aimed = fixture.aim(target, {position: [...game.player.position], maxFrames: 25});
        // A marginal selection (a trace that grazes the brush) flips between ticks: the approach must hold the target for a while standing still.
        for (let i = 0; i < 12; i++) { frames(1); if (game.interaction.frobTarget !== target) throw new Error(`View trace did not select ${target.name} (lost after landing, frame ${i})`); }
        game.inputButton('LeftMouse', true); frames(hold); game.inputButton('LeftMouse', false);
        return aimed;
      });
    },
    /** Try the approaches (lift x distance x 8 bearings) until `act` gets a view trace that selects the target. A place outside the world is skipped: the
     * player's landing there runs physWalking's zone-0 branch (FellOutOfWorld: Health -1, PHYS_None), and every later approach would start dead. */
    async approach_(target, distances, act, lifts = [0, 28]) {
      let last = null;
      const at = read(target, 'Location');
      for (const lift of lifts) for (const distance of distances) for (let k = 0; k < 8; k++) {
        const bearing = k * PI / 4, position = [at[0] + Math.cos(bearing) * distance, at[1] + Math.sin(bearing) * distance, at[2] + lift];
        if (!c.inWorld(position)) continue;
        try { return await act({position, maxFrames: 25}); }
        catch (error) { if (!/View trace did not select/.test(error.message)) throw error; last = error; }
      }
      throw new Undriven(`no approach selects ${target.name} (${last ? String(last.message).slice(0, 90) : 'every place is outside the world'})`);
    },
    async take(item) {
      await c.frob(item); frames(10);
      return read(item, 'Owner') === player();
    },
    async guard(fn) { try { await fn(); return false; } catch (error) { if (/OPEN DXONLY|client travel to DXONLY/i.test(error.message)) return true; throw error; } },
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
    /** Stand `distance` from `target` at the first bearing where the player keeps walking on dry ground (physics 1, zone not 0, unhurt). A place outside
     * the world is skipped before the player stands there (it would fall out of the world and die: physWalking's zone-0 branch). */
    openStand(target, distance, bearings = [PI, PI * 0.75, PI * 1.25, PI / 2, -PI / 2, 0]) {
      for (const bearing of bearings) {
        const from = c.approach(target, distance, bearing), h = c.health(player());
        if (!c.inWorld(from)) continue;
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
    /** The original Player start again inside one scenario (as between scenarios): the map reloaded, so a door, a panel or a flag is back as authored. */
    restart() { watched.clear(); game.reset(); frames(2); frames(30); runtime.writeNamed(player(), 'bCheatsEnabled', true); },
  };
  const peak = {};
  let used = false;
  return {
    c,
    /** The session is replaced and runs no more: what the page's map host does when the next map's host replaces it (sim-host.mjs dispose), so that a process
     * that opens many sessions keeps one: the audio and the simulation session go, its identities leave the process-wide handle table (the range from its start
     * to `end`, the next session's start, else the current limit) and the image arena's listeners, which a process-wide FinalizationRegistry holds, are dropped.
     * Without it every dropped session stays alive (about 425 MB each for 02_NYC_Street). */
    dispose(end = handleLimit()) {
      runtime.audio?.dispose?.(); sim.dispose();
      releaseHandleRange(handleStart, end);
      runtime.arena.listeners.length = 0;
    },
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
    // The Training crate lesson, as far as Play's own inputs take it: GrabDecoration and DropDecoration (the right button and Tab), the dropped crate pushed by walking into it
    // (DeusExDecoration.Bump on a settled decoration: SetPhysics(PHYS_Rolling), AActor::physRolling slides it, the player's physWalking pushes), and the crate used as a step
    // (a jump from the floor lands on it: processLanded, SetPhysics(PHYS_Walking, crate), physWalking with the crate as its Base). Vertical stacking is not driven: a drop
    // from the floor lands on the floor (DropDecoration places the crate at the player's feet), and the harness holds no key to carry one up.
    const crates = c.actors().filter(a => /^CrateUnbreakableSmall$/.test(a.name.replace(/\d+$/, ''))).sort((a, b) => near(c.pos(a), [7063, -1632, 8]) - near(c.pos(b), [7063, -1632, 8]));
    const crate = crates[0];
    if (!crate) throw new Undriven('no CrateUnbreakable in the map');
    await c.frob(crate); c.frames(30);
    const carried = c.read(c.player(), 'CarriedDecoration') === crate;
    c.key('Tab'); c.frames(60);
    const dropped = !c.read(c.player(), 'CarriedDecoration');
    const droppedAt = c.pos(crate).map(Math.round);
    // Push: walk into the dropped crate from 90 units west of it.
    const at = c.pos(crate);
    c.fixture.place([at[0] - 90, at[1], at[2] + 45], {yaw: 0}); c.frames(30);
    c.fixture.driveLegacy({forward: 1});
    let rolled = false;
    for (let i = 0; i < 12; i++) { c.frames(10); rolled ||= c.read(crate, 'Physics') === 7; }
    c.fixture.driveLegacy({forward: 0}); c.frames(30);
    const pushed = rolled && near(c.pos(crate), at) > 20;
    // Climb: a run and a jump from 75 units west of the crate lands the player on it.
    const rest = c.pos(crate);
    c.fixture.place([rest[0] - 75, rest[1], rest[2] + 30], {yaw: 0}); c.frames(40);
    c.fixture.driveLegacy({forward: 1}); c.frames(25);
    c.key('Space', 3);
    c.frames(80);
    c.fixture.driveLegacy({forward: 0}); c.frames(30);
    const climbed = c.read(c.player(), 'Base') === crate && c.read(c.player(), 'Physics') === 1;
    return ok(carried && dropped && pushed && climbed, {crate: crate.name, carried, dropped, droppedAt, rolled, pushedTo: c.pos(crate).map(Math.round), climbed, standingAt: c.pos(c.player()).map(Math.round)});
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
    // The range is a chain the lesson's data builds (docs/stage-5-exit-criteria.md): DataLinkTrigger2 (65,-544) plays DL_TArgetRange, whose conversation event
    // opens the cover shield1 over Switch3; Switch3 (Event guntarget1) slides the target DeusExMover4, which carries BreakableGlass0 and a MoverCollider, from y -3280
    // to y -1216, and the MoverCollider passes the four DirectionalTriggers (ClassProximityType MoverCollider) that open the blast door DeusExMover7 on the way;
    // the glass is the target (Event shootplay -> DataLinkTrigger4 -> DL_TArgetRangeshot1). A shot must reach the glass through the window of the station (the
    // opening spans z -110 to -47 over the sill at y -656; the settled player's eye is at -72) and the old driver's placement missed it three ways: it was
    // placed 36 units above the floor (the eye fell below the aim), at x 65 between the two lanes, and nothing had moved the target.
    const pistol = await c.give('WeaponPistol'); await c.equip(pistol);
    for (let i = 0; i < 2; i++) { c.exec('summon Ammo10mm'); c.frames(5); const box = c.byClass('Ammo10mm').filter(a => !c.read(a, 'Owner')).at(-1); if (box) await c.take(box); }
    const ammoOf = () => c.read(c.read(pistol, 'AmmoType'), 'AmmoAmount'), ammo0 = ammoOf();
    const glass = c.actor('BreakableGlass0'), target = c.actor('DeusExMover4'), door = c.actor('DeusExMover7'), sw = c.actor('Switch3');
    if (!glass || !target || !door || !sw) throw new Undriven('the range targets are not in the map');
    c.fixture.place([65, -440, -112], {yaw: -PI / 2}); c.frames(10);
    c.fixture.driveLegacy({forward: 1}); c.frames(80); c.fixture.driveLegacy({forward: 0});
    for (let t = 0; t < 40 && !c.flag('dl_targetrange_played'); t++) c.frames(60);
    c.frames(60);
    const intro = c.flag('dl_targetrange_played');
    await c.frob(sw, [40, 48, 36, 60]);
    for (let t = 0; t < 30 && (c.read(target, 'bInterpolating') || c.read(target, 'KeyNum') === 0); t++) c.frames(30);
    const slid = {target: c.pos(target).map(Math.round), doorKey: c.read(door, 'KeyNum')};
    let shots = 0;
    for (; shots < 30 && !c.gone(glass) && !c.read(glass, 'bDestroyed') && !c.flag('dl_targetrangeshot1_played'); shots++) {
      c.stand(c.pos(c.player()), c.pos(glass)); c.frames(3); c.shoot(4, 40);
      if (c.read(pistol, 'ClipCount') >= c.read(pistol, 'ReloadCount')) c.frames(150);
    }
    for (let t = 0; t < 40 && !c.flag('dl_targetrangeshot1_played'); t++) c.frames(60);
    return ok(c.flag('dl_targetrangeshot1_played'), {intro, shield1: c.read(c.actor('DeusExMover1'), 'KeyNum'), ...slid, shots, ammo: [ammo0, ammoOf()], glassGone: c.gone(glass), glass: c.pos(glass).map(Math.round), shot1: c.flag('dl_targetrangeshot1_played')});
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
    // The lesson's input (the original's path for a LAM at a Mover): WeaponLAM.Tick runs NearWallCheck (a 32-unit trace from the player at a Level or Mover hit, which
    // BreakableWall1 is: DeusExMover) and WeaponLAM.Fire then places the grenade on the wall (state NormalFire, the 'Place' animation) instead of throwing it. A thrown
    // LAM bounces off the wall and back to the player (ThrownProjectile.Flying.HitWall), which is what the previous driver saw from 250 units. A placed LAM is a
    // proximity mine for NPCs only in single-player (ThrownProjectile.Tick) and ThrownProjectile.TakeDamage explodes it: the player backs off and shoots it.
    const lam = await c.give('WeaponLAM'), pistol = await c.give('WeaponPistol'); await c.equip(lam);
    const wall = c.actor('BreakableWall1'); if (!wall) throw new Undriven('no BreakableWall1');
    const w = c.pos(wall), at = (bearing, d) => [w[0] + Math.cos(bearing) * d, w[1] + Math.sin(bearing) * d, w[2] - 16];
    // BreakableWall1 closes a corridor and one side of it is outside the level: a player placed there falls out of the world and dies (the previous driver's
    // placement did exactly that). The open side is the first of four bearings whose standing place 110 units off lies in the world.
    const bearing = [-PI / 2, PI / 2, 0, PI].find(b => c.inWorld(at(b, 110)));
    if (bearing === undefined) throw new Undriven('no standing place 110 units from BreakableWall1 lies in the world');
    const before = c.byClass('LAM').map(l => l.name);
    c.stand(at(bearing, 110), w); c.frames(10);
    c.fixture.driveLegacy({forward: 1});
    for (let i = 0; i < 240 && !c.read(lam, 'bNearWall'); i++) c.frames(1);
    c.fixture.driveLegacy({forward: 0}); c.frames(10);
    const near = Boolean(c.read(lam, 'bNearWall'));
    c.shoot(4, 90);
    const placed = c.byClass('LAM').filter(l => !before.includes(l.name)).at(-1);
    if (!placed) return ok(false, {near, weaponState: c.state(lam), ammo: c.read(c.read(lam, 'AmmoType'), 'AmmoAmount')}, 'the LAM was not placed or thrown');
    const stuck = Boolean(c.read(placed, 'bStuck')), proximity = Boolean(c.read(placed, 'bProximityTriggered'));
    await c.equip(pistol);
    c.stand(at(bearing, 150), c.pos(placed)); c.frames(10);
    let shots = 0;
    for (; shots < 6 && !c.gone(placed) && !c.read(wall, 'bDestroyed'); shots++) { c.stand(at(bearing, 150), c.pos(placed)); c.shoot(4, 30); }
    // BlowItUp triggers the wall's Event (FinishWall): DataLinkTrigger11 plays DL_FinishWall, whose played flag is set when the transmission ends.
    for (let i = 0; i < 40 && !c.flag('dl_finishwall_played'); i++) c.frames(60);
    const broken = Boolean(c.read(wall, 'bDestroyed')) || c.gone(wall) || Boolean(c.read(wall, 'bHidden'));
    return ok(broken && c.flag('dl_finishwall_played'), {near, placed: placed.name, stuck, proximity, shots, lamGone: c.gone(placed), wallDestroyed: Boolean(c.read(wall, 'bDestroyed')), doorStrength: c.read(wall, 'doorStrength'), playerHealth: c.health(c.player()), finishWall: c.flag('dl_finishwall_played')});
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
    // ElevatorMover1 (Tag ExitDoor) is the course's exit door, a 64-unit slide on y (KeyPos[1] 0,64,0), not a ride. SequenceTrigger0 (Tag OpenDoor, SeqNum 0) and
    // SequenceTrigger1 (Tag CloseDoor, SeqNum 1) call ElevatorMover.SetSeq, which moves only when KeyNum differs (ElevatorMover.uc SetSeq): the door starts at key 0, so
    // OpenDoor alone moves nothing. A soldier who sees the player rings an AlarmUnit (Event AlarmDispatcher: SoldierNeutral, CloseDoor, failmessage) and the door slides
    // to key 1; Switch0 (Event ButtonDispatcher: SoldierHostile, OpenDoor, SoldierPatrol, SpecialEventMsg) slides it back to key 0. Both are the player's inputs.
    const exit = c.actor('ElevatorMover1'), reset = c.actor('Switch0'), soldier = c.actor('Soldier0');
    if (!exit || !reset || !soldier) throw new Undriven('no ElevatorMover1, Switch0 or Soldier0');
    const s0 = c.pos(soldier); c.stand([s0[0] + 180, s0[1], s0[2]], s0); c.watched.add(soldier);
    const exit0 = c.read(exit, 'KeyNum');
    let closedAt = null;
    for (let t = 0; t < 60 && closedAt === null; t++) { c.frames(30); if (c.read(exit, 'KeyNum') === 1) closedAt = t / 2; }
    for (let t = 0; t < 20 && c.read(exit, 'bIsMoving'); t++) c.frames(30);
    const closed = {key: c.read(exit, 'KeyNum'), y: Math.round(c.pos(exit)[1])};
    c.watched.add(reset); await c.frob(reset, [40, 48, 60, 36]);
    for (let t = 0; t < 20 && (c.read(exit, 'KeyNum') !== 0 || c.read(exit, 'bIsMoving')); t++) c.frames(30);
    const reopened = {key: c.read(exit, 'KeyNum'), y: Math.round(c.pos(exit)[1])};
    return ok((after !== before || moving) && exit0 === 0 && closed.key === 1 && reopened.key === 0 && closed.y !== reopened.y,
      {before, after, moving, exitDoor: {start: exit0, closedAt, closed, reopened}}, after === before && !moving ? 'Switch1 did not move FirstStealthDoor' : 'the alarm and Switch0 did not slide ElevatorMover1 closed and open');
  },
  async 'alarm-chain'(c) {
    const unit = c.actor('AlarmUnit1'); if (!unit) throw new Undriven('no AlarmUnit1');
    const soldier = c.actor('Soldier0'), door = c.byTag('ExitDoor')[0];
    const before = {state: c.state(soldier), enemy: c.read(soldier, 'Enemy')?.name ?? null, door: door ? c.read(door, 'KeyNum') : null};
    const up = c.pos(unit); c.stand([up[0] - 200, up[1], up[2] + 20], up);
    c.trigger(unit); // the AlarmUnit is tripped by a Trigger call (a laser, camera or the maze's trigger); it has no use action
    // AlarmUnit.Trigger sets bActive and fires its Event (AlarmDispatcher: SoldierNeutral, CloseDoor, failmessage); AlarmUnit.Tick calls UnTrigger when curTime
    // reaches alarmTimeout (10 s on AlarmUnit1), so the unit is read while it rings and again after the timeout. The previous driver read bActive once at 12 s, after
    // the timeout, and took the original's own deactivation for a failure.
    let rang = false, ringing = 0; for (let t = 0; t < 14; t++) { c.frames(60); if (c.read(unit, 'bActive')) { rang = true; ringing = t + 1; } }
    const after = {state: c.state(soldier), enemy: c.read(soldier, 'Enemy')?.name ?? null, door: door ? c.read(door, 'KeyNum') : null, active: Boolean(c.read(unit, 'bActive'))};
    const failMessage = c.flag('dl_failedstealth_played');
    return ok(rang && failMessage && after.door !== before.door && !after.active, {before, after, rang, ringingSeconds: ringing, alarmTimeout: c.read(unit, 'alarmTimeout'), failMessage, soldierAlliance: c.read(soldier, 'Alliance')},
      !rang ? 'AlarmUnit1.Trigger left bActive false' : 'the AlarmDispatcher chain (failure DataLink, ExitDoor) or the timeout did not follow');
  },
  async 'meet-page-final'(c) {
    // 1. M00MeetPage. ConversationTrigger1 (conversationTag m00meetpage, BindName BobPage, CollisionRadius 96) starts it from its Touch (ConversationTrigger.Touch ->
    //    StartConversationByName, the owner within 800 units): the player must walk INTO the cylinder. The previous driver placed the player 40 units from its centre,
    //    already inside, so no Touch began and nothing played. Walked in from 160 units the Touch fires and the conversation (third person, Enter) plays to its end.
    const trigger = c.byTag('ConversationTrigger').find(t => c.read(t, 'conversationTag') === 'm00meetpage'); if (!trigger) throw new Undriven('no m00meetpage trigger');
    const tp = c.pos(trigger), bob = c.byClass('BobPage').find(b => c.read(b, 'BindName') === c.read(trigger, 'BindName'));
    walkAndTalk(c, [tp[0], tp[1] + 160, tp[2] + 45], tp, 60, () => c.flag('m00meetpage_played'));
    const page = {played: c.flag('m00meetpage_played'), bob: bob?.name ?? null};
    // 2. Holo-Jaime. Switch6 (Event jaime_talks) -> FlagTrigger11 (sets JaimeAppears, then triggers 'convo': ConversationTrigger0, whose conversationTag jaimebarks
    //    names no conversation) -> Mission00.Timer's 00_TRAININGFINAL branch EnterWorld()s the holojaime JaimeReyes -> its radius conversation JaimeBark (160 units)
    //    plays -> JaimeBark_Played -> the Timer LeaveWorld()s it and sets MS_ReyesHidden.
    const sw = c.actor('Switch6'), jaime = c.byClass('JaimeReyes').find(j => c.read(j, 'Tag') === 'holojaime');
    if (!sw || !jaime) throw new Undriven('no Switch6 or holojaime JaimeReyes');
    c.watched.add(sw); c.watched.add(jaime);
    const hidden0 = !c.read(jaime, 'bInWorld');
    await c.frob(sw, [40, 48, 60, 36]);
    let entered = false;
    for (let t = 0; t < 80 && !c.flag('ms_reyeshidden'); t++) { c.frames(30); entered ||= Boolean(c.read(jaime, 'bInWorld')); }
    const holo = {hidden0, appears: c.flag('jaimeappears'), entered, barkPlayed: c.flag('jaimebark_played'), inWorld: Boolean(c.read(jaime, 'bInWorld')), reyesHidden: c.flag('ms_reyeshidden')};
    return ok(page.played && hidden0 && holo.appears && entered && holo.barkPlayed && !holo.inWorld && holo.reyesHidden, {page, holo},
      !page.played ? 'M00MeetPage did not play' : 'the holo-Jaime chain (JaimeAppears, EnterWorld, JaimeBark, LeaveWorld) did not complete');
  },
};

