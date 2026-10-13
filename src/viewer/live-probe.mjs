import { lightGlobals } from '../runtime/light-globals.mjs';
import { scriptGetStateName } from '../runtime/script-state-queries.mjs';
import { createNavTrace } from '../runtime/nav-trace.mjs';
import { execAICanSee } from '../runtime/script-pawn-perception.mjs';
import { setTouchTrace } from '../runtime/actor-touch.mjs';

/** Validation only (scripts/live-acceptance.mjs, docs/visual-acceptance.md
 * "Live scenes"): the simulation side of the live-scene comparison. It
 * replays the ticks of a trace of the original (tools/dx-live-win.c `trace`)
 * on Play's live level and records the same fields tick for tick.
 *
 * A trace row holds what the original's ULevel::Tick (Engine.dll 0x103a51a0)
 * was called with and the stream it ran on: the input `delta` and the CRT
 * rand state at entry (`rngIn`). Replay is the only intervention: tick i runs
 * with that delta and Play's stream set to that state, as `srand` sets the
 * CRT's word (rng.mjs seed). The original's render draws (256 per frame,
 * URender::PreRender's light noise, and whatever else a map's frame consumes)
 * happen between its ticks; replaying the state makes the script draws of each
 * tick comparable without modelling them.
 *
 * `begin({release})`: the unfreeze, at the entry of tick 1 (the original
 * clears LevelInfo.bPlayersOnly there): the level clock takes the trace's
 * entry clock, so TimeSeconds-driven content starts at the same time.
 * `before()` is called by sim-session begin() ahead of game.tick(); it returns
 * the delta to tick with, or false to skip the tick (the replay is over and
 * the level is held, as the tool's Tick skip holds the original). */
const hex = word => `0x${(word >>> 0).toString(16).padStart(8, '0')}`;
const plain = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return [...value].map(plain);
  if (typeof value === 'object' && typeof value.name === 'string') return value.name;
  return String(value);
};

export function liveProbe(game, args = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const level = runtime.levelFor(player), info = level.actors[0];
  const byName = name => name === '@player' ? player : level.actors.find(actor => actor?.name === name) ?? null;
  const out = {};
  // slotOf offsets of named properties, to write the original's watch config.
  if (args.offsets) {
    const { slotOf } = runtime.classLoader.graph;
    out.offsets = {};
    for (const [actorName, names] of Object.entries(args.offsets)) {
      const actor = byName(actorName);
      if (!actor) { out.offsets[actorName] = null; continue; }
      out.offsets[actorName] = Object.fromEntries(names.map(name => {
        const member = runtime.lookupMember(runtime.instance(actor).cls, 'fields', name);
        // bool properties also give their UBoolProperty::BitMask (+0x5c)
        return [name, member ? (args.offsetMasks ? [slotOf(member.loadRecord, 0x48), (v => typeof v === 'number' ? v : null)(slotOf(member.loadRecord, 0x5c))] : slotOf(member.loadRecord, 0x48)) : null];
      }));
    }
  }
  // The Region (zone, leaf, zone number) PointRegion gives at a point: what the original's
  // `set ... Region (...)` is given after `set Location` (visual-acceptance.md "Placing the player's Region").
  if (args.pointRegion) {
    const region = level.pointRegion(args.pointRegion);
    out.pointRegion = { zone: region.zone?.name ?? null, iLeaf: region.leaf, zoneNumber: region.zoneNumber };
  }
  if (args.actors) {
    // A class list: names, class and state of the level's actors of that class (or its subclasses).
    out.actors = [];
    for (const actor of level.actors) {
      if (!actor) continue;
      let match = false;
      for (let cls = runtime.instance(actor).cls; cls && !match; cls = cls.base) match = cls.record?.key === args.actors.toLowerCase();
      if (!match) continue;
      const instance = runtime.instance(actor), node = instance?.state ? (instance.state.stateNode ?? instance.cls) : null;
      const row = { name: actor.name, cls: instance.cls.record?.key ?? null, location: [...runtime.readNamed(actor, 'Location')], state: scriptGetStateName(node),
        timer: runtime.readNamed(actor, 'TimerRate') > 0 };
      // actorProps: more properties by name (a census of NPCs' alliance and orders)
      for (const prop of args.actorProps ?? []) { try { row[prop] = plain(runtime.readNamed(actor, prop)); } catch { row[prop] = undefined; } }
      // alliances: AlliancesEx as [name, AllianceLevel, AgitationLevel] for the entries that have a name
      if (args.alliances) row.alliances = [...runtime.readNamed(actor, 'AlliancesEx')].map(entry => Object.entries(entry).map(([k, v]) => [k.split('.').pop(), plain(v)]))
        .map(fields => Object.fromEntries(fields)).filter(entry => entry.alliancename && entry.alliancename !== 'None').map(entry => [entry.alliancename, entry.alliancelevel, entry.agitationlevel]);
      out.actors.push(row);
    }
  }
  // lights: the level's actors with a LightType other than None (a light's live state: scripts change it, Light.uc and subclasses).
  if (args.lights) {
    const names = ['LightType', 'LightEffect', 'LightBrightness', 'LightHue', 'LightSaturation', 'LightRadius', 'bStatic', 'bNoDelete', 'bDynamicLight', 'bIsOn'];
    out.lights = [];
    for (const actor of level.actors) {
      if (!actor) continue;
      const instance = runtime.instance(actor);
      if (!instance) continue;
      const type = runtime.readNamed(actor, 'LightType') & 255;
      if (args.lights.type != null && type !== args.lights.type) continue;
      const row = { name: actor.name, cls: instance.cls.record?.key ?? null, state: scriptGetStateName(instance.state ? (instance.state.stateNode ?? instance.cls) : null) };
      for (const n of names) { try { row[n] = plain(runtime.readNamed(actor, n)); } catch { /* not a property of this class */ } }
      row.mapLightType = actor.values?.LightType ?? null;
      out.lights.push(row);
    }
  }
  // write: {actorName: {Property: value}}, plain host writes (the player's animation state at the trace's start).
  if (args.write) for (const [name, fields] of Object.entries(args.write)) {
    const actor = byName(name);
    if (!actor) throw new Error(`liveProbe: no actor ${name}`);
    for (const [prop, value] of Object.entries(fields)) runtime.writeNamed(actor, prop, typeof value === 'number' ? Math.fround(value) : value);
  }
  // census: every pawn but the player, with what a rendered view changes (LastRenderTime, bStasis) and its animation: the
  // screening of which maps' start views have animating NPCs in view (scripts/live-acceptance.mjs screen).
  if (args.census) {
    const read = (actor, name) => { try { return runtime.readNamed(actor, name); } catch { return null; } };
    out.census = { time: read(info, 'TimeSeconds'), pawns: [] };
    for (const actor of level.actors) {
      if (!actor || actor === player || !read(actor, 'bIsPawn') || read(actor, 'bDeleteMe')) continue;
      const instance = runtime.instance(actor), node = instance?.state ? (instance.state.stateNode ?? instance.cls) : null;
      out.census.pawns.push({ name: actor.name, cls: instance?.cls?.record?.key ?? null, state: scriptGetStateName(node), lrt: read(actor, 'LastRenderTime'),
        stasis: Boolean(read(actor, 'bStasis')), force: Boolean(read(actor, 'bForceStasis')), physics: read(actor, 'Physics'), anim: read(actor, 'AnimSequence'),
        rate: read(actor, 'AnimRate'), frame: read(actor, 'AnimFrame'), dist: read(actor, 'DistanceFromPlayer'), hidden: Boolean(read(actor, 'bHidden')),
        // Model.Zones[Region.ZoneNumber].LastRenderTime as AActor::InStasis reads it
        zoneLrt: level.zoneLastRenderTimes?.[read(actor, 'Region')?.['engine.actor.pointregion.zonenumber']] ?? null });
    }
  }
  // population: the names of the actors the original's level holds. A load decides some map actors by chance
  // (OddsOfAppearing, scripts' own FRand in PostBeginPlay, drawn from a stream the two sides do not share): an actor
  // only Play holds is destroyed here (Actor.Destroy, as the script's own would); one only the original holds cannot be
  // created and is reported (the load must be repeated). Actors the game spawns at load (player, inventory, shadows,
  // managers) are numbered by spawn order and are not compared by name.
  // strobe: {flag, time}: Render.dll's Strobe state as the original's held frame left it (a host input, light-globals.mjs).
  if (args.strobe) { const strobe = lightGlobals(runtime).strobe; strobe.flag = args.strobe.flag & 1; strobe.time = Math.fround(args.strobe.time); out.strobe = { ...strobe }; }
  if (args.population) {
    const spawned = /^(Skill|Aug|NanoKey|ColorTheme|Shadow|ParticleProxy|Laser|Flare|Cigarettes|Candybar|Weapon|Mission|GameReplicationInfo|PlayerReplicationInfo|JCDenton|Mutator|DeusExGameInfo|PickupDistributor|AutoTurretGun|BarkManager|ParticleGenerator|DataVault|Credits|Ammo|BioelectricCell|Medkit|Binoculars|Lockpick|Multitool|LAM|Liquor|Soda|Sodacan|Fruit|Vice)/;
    const have = new Set(args.population.map(entry => entry.name)), extra = [];
    for (const actor of level.actors) if (actor && actor !== player && actor.name && !have.has(actor.name) && !spawned.test(actor.name)) extra.push(actor);
    out.population = { removed: extra.map(actor => actor.name) };
    for (const actor of extra) runtime.destroyActor(actor, false);
    const names = new Set(level.actors.filter(Boolean).map(actor => actor.name));
    out.population.missing = args.population.filter(entry => !names.has(entry.name) && !spawned.test(entry.name)).map(entry => entry.name);
  }
  // navTrace: {pawns, first, last}: the boundary calls of those pawns' reach and path natives in those ticks
  // (nav-trace.mjs), returned by `take` as `nav`; compared with tools/dx-live-win.c `call` on the original.
  if (args.navTrace) {
    runtime.navTrace ??= createNavTrace();
    Object.assign(runtime.navTrace, { pawns: new Set(args.navTrace.pawns), first: args.navTrace.first, last: args.navTrace.last });
  }
  // scriptTrace: {pawns, first, last}: those pawns' script calls (events, functions, natives, GotoState) in those ticks, with
  // the pawn's MoveTimer/Destination/state before and after each; returned by `take` as `script`. A validation aid: it
  // names the first call whose effect differs from the original's (tools/dx-live-win.c `call` on the same natives).
  if (args.scriptTrace && !runtime.scriptTrace) {
    const trace = runtime.scriptTrace = { pawns: new Set(), tick: 0, first: 0, last: -1, events: [], depth: 0 };
    // a name ending in '*' matches every actor with that prefix (spawned actors are not known by name in advance)
    const named = name => trace.pawns.has(name) || [...trace.pawns].some(entry => entry.endsWith('*') && name?.startsWith(entry.slice(0, -1)));
    const on = receiver => receiver && named(receiver.name) && trace.tick >= trace.first && trace.tick <= trace.last;
    const pawnState = receiver => { try { return { mt: runtime.readNamed(receiver, 'MoveTimer'), dest: plain(runtime.readNamed(receiver, 'Destination')),
      td: runtime.readNamed(receiver, 'TurnDirection'), acc: runtime.readNamed(receiver, 'bAcceptBump'), phys: runtime.readNamed(receiver, 'Physics'),
      touching: (() => { try { return [...runtime.readNamed(receiver, 'Touching')].map(t => t?.name ?? null); } catch { return undefined; } })() }; } catch { return {}; } };
    const wrapCall = (name, fn, describe) => {
      const original = runtime[name].bind(runtime);
      runtime[name] = (...rest) => {
        const receiver = describe.receiver(...rest);
        if (!on(receiver)) return original(...rest);
        const depth = trace.depth++, before = pawnState(receiver);
        trace.events.push({ u: trace.tick, d: depth, ev: 'enter', pawn: receiver.name, fn: describe.label(...rest), ...before });
        try { return original(...rest); }
        finally { trace.depth--; trace.events.push({ u: trace.tick, d: depth, ev: 'leave', fn: describe.label(...rest), ...pawnState(receiver) }); }
      };
    };
    const nameOf = value => (value && typeof value === 'object' ? (value.name ?? '?') : value);
    wrapCall('processEvent', null, { receiver: receiver => receiver, label: (receiver, name, a = []) => `event ${name}(${a.map(nameOf).join(',')})` });
    wrapCall('callFunction', null, { receiver: (record, receiver) => receiver, label: record => `fn ${record.key}` });
    wrapCall('invokeNative', null, { receiver: call => call.receiver, label: call => `native ${call.index} ${call.record?.key ?? ''}` });
    wrapCall('gotoState', null, { receiver: receiver => receiver, label: (receiver, name, label) => `gotoState ${name} ${label ?? ''}` });
  }
  // touchTrace: {first, last}: every EndTouch / AddTouch / BeginTouch the replayed ticks make (actor-touch.mjs), with the Touching slots after each;
  // returned by `take` as `touch`, compared with the original's breakpoints at the same bodies (docs/visual-acceptance.md).
  if (args.touchTrace) {
    const events = runtime.touchEvents ??= [];
    setTouchTrace(event => {
      const n = game.liveReplay?.current?.n;
      if (n >= args.touchTrace.first && n <= args.touchTrace.last) events.push({ u: n, ...event });
    });
  }
  // eventTrace: every AI event manager call (send, start, end, clear) and delivered callback of the replayed ticks and of the console commands
  // between them (u: the unfrozen tick count at the call), returned by `take` as `events`; compared with the original's AISendEvent/AIEvent
  // breakpoints (tools/dx-live-win.c `call ... fname`).
  if (args.eventTrace) {
    const events = runtime.aiEventLog ??= [], manager = runtime.scriptVm?.aiEvents;
    if (!manager) throw new Error('liveProbe: no AI event manager');
    manager.trace = event => {
      const replay = game.liveReplay, n = replay?.current?.n ?? replay?.index ?? 0;
      if (n >= args.eventTrace.first && n <= args.eventTrace.last) events.push({ u: n, rng: hex(game.random.state), ...event });
    };
  }
  if (args.scriptTrace) Object.assign(runtime.scriptTrace, { pawns: new Set(args.scriptTrace.pawns), first: args.scriptTrace.first, last: args.scriptTrace.last });
  // canSeeProbe: {pawn, first, last}: after those replayed ticks, what `Enemy.AICanSee(destPoint, 1, false, false, false, true)` (the
  // test ScriptedPawn's Fleeing state makes when a move ends) gives for that pawn, with the collision hash's hits along the line
  // (rows' `canSee`). A validation aid for a pawn whose next path choice differs from the original's.
  const canSeeProbe = pawn => {
    const actor = byName(pawn), enemy = runtime.readNamed(actor, 'Enemy'), point = runtime.readNamed(actor, 'destPoint');
    if (!enemy || !point) return { enemy: enemy?.name ?? null, destPoint: point?.name ?? null };
    const services = runtime.perceptionServices({ receiver: enemy }), level = runtime.levelFor(enemy);
    const eye = [...runtime.readNamed(enemy, 'Location')], end = [...runtime.readNamed(point, 'Location')];
    eye[2] = Math.fround(eye[2] + runtime.readNamed(enemy, 'BaseEyeHeight'));
    const worldActor = level.actors?.[0] ?? null;
    const hits = level.hash.multiLineCheck({ end, start: eye, extent: [0, 0, 0], checkActors: 1, worldActor, extra: 4 })
      .map(hit => ({ actor: hit.actor?.name ?? null, cls: hit.actor ? runtime.instance(hit.actor)?.cls?.record?.key : null, time: hit.time,
        blocks: hit.actor ? plain(runtime.readNamed(hit.actor, 'bBlockSight')) : null, hidden: hit.actor ? plain(runtime.readNamed(hit.actor, 'bHidden')) : null }));
    const args6 = [point, 1, false, false, false, true];
    const call = { receiver: enemy, argumentCount: 6, evaluateArgument: i => args6[i] };
    return { enemy: enemy.name, destPoint: point.name, from: eye, to: end, value: execAICanSee(call, services), bDetectable: plain(runtime.readNamed(enemy, 'bDetectable')), hits };
  };
  if (args.replay) {
    const { watch = [], ticks, hold = true, warm = 3, commands = [] } = args.replay;
    const actors = watch.map(({ names, props }) => ({ props, items: names.map(name => [name, byName(name)]) }));
    for (const group of actors) for (const [name, actor] of group.items) if (!actor) throw new Error(`liveProbe: no actor ${name}`);
    const state = game.liveReplay = {
      ticks, hold, warm, index: 0, rows: [], cursor: 0, current: null,
      // console commands typed into the original between two ticks ({after, text}: after that many ticks), run here the same way through the
      // recovered console command chain (APlayerPawn::execConsoleCommand) before the next tick; their results are returned by `take` as `commands`
      commands: commands.map(command => ({ ...command })), commandLog: [], canSee: args.replay.canSeeProbe ?? null,
      snapshot() {
        const result = {};
        for (const group of actors) for (const [name, actor] of group.items) {
          const row = {};
          for (const prop of group.props) {
            if (prop === '$state') {
              const instance = runtime.instance(actor), node = instance?.state ? (instance.state.stateNode ?? instance.cls) : null;
              row.State = scriptGetStateName(node);
            } else if (prop.startsWith('$Al')) {
              // an AlliancesEx entry's name / AllianceLevel / AgitationLevel ($AlName0, $AlLvl0, $AlAgit0, ...)
              const [, part, index] = /^\$Al(Name|Lvl|Agit)(\d)$/.exec(prop);
              const entry = runtime.readNamed(actor, 'AlliancesEx')[Number(index)];
              const key = part === 'Name' ? 'alliancename' : part === 'Lvl' ? 'alliancelevel' : 'agitationlevel';
              row[prop] = plain(Object.entries(entry).find(([k]) => k.split('.').pop() === key)?.[1]);
            } else if (prop.startsWith('$region')) {
              const region = runtime.readNamed(actor, 'Region');
              row[prop] = prop === '$regionZone' ? plain(region['engine.actor.pointregion.zone'])
                : region[`engine.actor.pointregion.${prop === '$regionLeaf' ? 'ileaf' : 'zonenumber'}`];
            } else row[prop] = plain(runtime.readNamed(actor, prop));
          }
          result[name] = row;
        }
        return result;
      },
      before(dt) {
        // Warm-up: the level's clock stands at the trace's start while the page draws a few frames,
        // so the actors drawn stamp LastRenderTime with that time (the original's frames before the
        // release did); the first tick then finds the stamps current, as the original's did.
        if (this.warm > 0) { this.warm--; return false; }
        if (this.index >= this.ticks.length) return this.hold ? false : dt;
        const tick = this.ticks[this.index];
        while (this.commands.length && this.commands[0].after <= this.index) {
          const command = this.commands.shift(), entry = { ...command };
          // the stream state the original's command ran on (a measured input, see live-acceptance.mjs commandsWithStream)
          if (command.rng) game.random.seed(parseInt(command.rng, 16) >>> 0);
          // drawStacks: where each draw of the stream the command makes comes from (the script call stack's last frames)
          let restore = null;
          if (args.replay.drawStacks) {
            const draws = entry.draws = [], originals = {};
            for (const name of ['frand', 'rand']) {
              originals[name] = game.random[name];
              game.random[name] = (...rest) => { draws.push(`${name} ${new Error().stack.split('\n').slice(2, 9).map(l => l.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ')}`); return originals[name](...rest); };
            }
            restore = () => { for (const name of Object.keys(originals)) game.random[name] = originals[name]; };
          }
          try {
            // `@down CODE` / `@up CODE`: a key edge (KeyboardEvent.code) through the binding path, as the original's WM_KEYDOWN/WM_KEYUP
            const edge = /^@(down|up) (\S+)$/.exec(command.text);
            if (edge) entry.output = plain(game.inputKey(edge[2], edge[1] === 'down'));
            else {
              const consoleCommands = game.doors.scriptRuntime.windowHost?.consoleCommands;
              if (!consoleCommands) throw new Error('no console command chain');
              entry.output = consoleCommands.consoleCommand(player, command.text);
            }
          } catch (error) { entry.error = String(error?.message ?? error); }
          finally { restore?.(); }
          this.commandLog.push(entry);
        }
        if (runtime.navTrace) runtime.navTrace.tick = this.index + 1;
        if (runtime.scriptTrace) runtime.scriptTrace.tick = this.index + 1;
        game.random.seed(parseInt(tick.rngIn, 16) >>> 0);
        const strobe = lightGlobals(runtime).strobe;
        this.current = { n: this.index + 1, delta: tick.delta, rngIn: hex(game.random.state), clockIn: level.timeSeconds, tsIn: runtime.readNamed(info, 'TimeSeconds'),
          strobeIn: [strobe.flag, strobe.time] };
        return Math.fround(tick.delta);
      },
      after() {
        if (!this.current) return;
        const row = this.current; this.current = null;
        row.rngOut = hex(game.random.state); row.clockOut = level.timeSeconds; row.tsOut = runtime.readNamed(info, 'TimeSeconds');
        row.strobeOut = [lightGlobals(runtime).strobe.flag, lightGlobals(runtime).strobe.time];
        row.actors = this.snapshot();
        if (this.canSee && row.n >= this.canSee.first && row.n <= this.canSee.last) row.canSee = canSeeProbe(this.canSee.pawn);
        if (this.draws) { row.draws = {}; for (const name of this.draws) row.draws[name] = (row.draws[name] ?? 0) + 1; this.draws.length = 0; }
        this.rows.push(row); this.index++;
      },
    };
    // drawTrace: which actor's tick consumed each draw of the stream (rows' `draws`: name -> count;
    // '-' outside any actor's tick), to find where Play and the original draw a different number.
    if (args.replay.drawTrace) {
      let current = null;
      const draws = state.draws = [];
      for (const name of ['frand', 'rand']) {
        const original = game.random[name];
        game.random[name] = (...rest) => { draws.push(current?.name ?? '-'); return original(...rest); };
      }
      if (game.player.nativeRandom) game.player.nativeRandom = game.random.frand;   // the player's landing recovery captured the original
      const tickActor = runtime.processActorTick.bind(runtime);
      runtime.processActorTick = (actor, ...rest) => { const previous = current; current = actor; try { return tickActor(actor, ...rest); } finally { current = previous; } };
    }
    if (args.replay.release) {
      const first = ticks[0];
      runtime.writeNamed(info, 'bPlayersOnly', false);
      level.timeSeconds = first.clockIn;
      runtime.writeNamed(info, 'TimeSeconds', Math.fround(first.tsIn));
    }
    // (while the warm-up holds the level, nothing else moves the clock: the tick is skipped)
    out.initial = state.snapshot();
  }
  // setupProbe: {names, first, last}: FDynamicSprite::Setup's result and the main frame's Frame->Sprite membership for those
  // actors in the frames after those ticks (sim-session.mjs occludeMain), returned by `take` as `setup`.
  // renderSize: [width, height]: the original's viewport (the trace rows' `viewport`); the frames Play's simulation side builds use it.
  if (args.renderSize && game.liveReplay) game.liveReplay.renderSize = args.renderSize;
  if (args.setupProbe && game.liveReplay) game.liveReplay.setupProbe = { names: new Set(args.setupProbe.names), first: args.setupProbe.first, last: args.setupProbe.last, rows: [] };
  const replay = game.liveReplay;
  if (args.take && replay) {
    if (replay.setupProbe) out.setup = replay.setupProbe.rows.splice(0);
    if (replay.commandLog.length) out.commands = replay.commandLog.splice(0);
    out.rows = replay.rows.slice(replay.cursor); replay.cursor = replay.rows.length;
    out.index = replay.index;
    if (runtime.navTrace) out.nav = runtime.navTrace.events.splice(0);
    if (runtime.scriptTrace) out.script = runtime.scriptTrace.events.splice(0);
    if (runtime.touchEvents) out.touch = runtime.touchEvents.splice(0);
    if (runtime.aiEventLog) out.events = runtime.aiEventLog.splice(0);
  }
  if (args.status && replay) out.status = { index: replay.index, of: replay.ticks.length };
  // deferred: the boundaries Play recorded instead of running (player.unimplementedPhysicsEffects: sounds of emitters without a measured
  // object index, trigger scripts that reached an unsupported native, ...); the record-only audit's dynamic side.
  if (args.deferred) out.deferred = [...game.player.unimplementedPhysicsEffects];
  if (args.stop) game.liveReplay = null;
  return out;
}
