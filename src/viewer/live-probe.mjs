import { lightGlobals } from '../runtime/light-globals.mjs';
import { scriptGetStateName } from '../runtime/script-state-queries.mjs';
import { createNavTrace } from '../runtime/nav-trace.mjs';
import { execAICanSee } from '../runtime/script-pawn-perception.mjs';
import { setTouchTrace } from '../runtime/actor-touch.mjs';
import { hudLogClock } from './view-probe.mjs';
import { renameRegisteredObjects } from '../runtime/script-object-construction.mjs';
import { typedCharacters, keyOfCode } from './typed-characters.mjs';


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
// The event manager's objects: a pre-free of one is released after the manager's Tick (UEventManager::CleanupEvents ends it).
const AI_EVENT_CLASS = /^AI(SenderEvent|ReceiverEvent|EventType)$/;
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
  // FName comparison is case-insensitive in Unreal; the text a name shows is the spelling its table registered first, which differs between the two
  // programs for some map actors (the original's `mib1` and `Light1` are Play's `MIB1` and `light1`). A name given in the original's spelling finds Play's actor.
  const byName = name => {
    if (name === '@player') return player;
    // the player's held Weapon by reference (a spawned weapon's name can repeat a map actor's in Play: scripts/weapon-view-probe.js)
    if (name === '@weapon') return runtime.readNamed(player, 'Weapon') ?? null;
    // `~Stem`: the live actor named Stem and digits, the last of them (an actor whose number follows each process's session history, Skill's
    // SkillWeaponRifle2 in the original and SkillWeaponRifle0 in Play: live-acceptance.mjs --device-watch Stem#:Class)
    if (String(name).startsWith('~')) {
      const stem = new RegExp(`^${String(name).slice(1)}\\d+$`, 'i');
      return level.actors.filter(actor => actor && stem.test(actor.name)).at(-1) ?? null;
    }
    // `Owner.field`: the actor an owner's object field holds (a turret's gun: live-acceptance.mjs --device-watch Name:Class@Owner.field)
    if (String(name).includes('.')) { const [owner, field] = String(name).split('.'); const actor = byName(owner); return actor ? runtime.readNamed(actor, field) ?? null : null; }
    const exact = level.actors.find(actor => actor?.name === name);
    if (exact) return exact;
    const lower = String(name).toLowerCase();
    return level.actors.find(actor => actor?.name && actor.name.toLowerCase() === lower) ?? null;
  };
  const out = {};
  // classCounters {Class: n}: the original's class counters as its traced AddObject names show them (script-runtime.mjs applyClassCounterSeed)
  if (args.classCounters) runtime.classCounterSeeds = new Map(Object.entries(args.classCounters).map(([cls, n]) => [cls.toLowerCase(), n | 0]));
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
  // read: {names, props}: those properties of those actors (plain values; an actor reads as its name), the same read the replay's rows make
  // (`node scripts/live-acceptance.mjs read --names A,B --props P,Q` looks at an actor in Play's frozen start).
  if (args.read) {
    out.read = {};
    for (const name of args.read.names) {
      const actor = byName(name);
      out.read[name] = actor ? Object.fromEntries(args.read.props.map(prop => { try { return [prop, plain(runtime.readNamed(actor, prop))]; } catch (error) { return [prop, `error: ${error.message}`]; } })) : null;
    }
  }
  // The Region (zone, leaf, zone number) PointRegion gives at a point: what the original's
  // `set ... Region (...)` is given after `set Location` (visual-acceptance.md "Placing the player's Region").
  if (args.pointRegion) {
    const region = level.pointRegion(args.pointRegion);
    out.pointRegion = { zone: region.zone?.name ?? null, iLeaf: region.leaf, zoneNumber: region.zoneNumber };
  }
  // engineLog N: the last N lines of the engine log (the original's Log: / ScriptLog: lines Play models), from the whole log with `engineLog: -1`
  if (args.engineLog) { const log = game.doors.scriptRuntime.engineLog; out.engineLog = args.engineLog < 0 ? [...log] : log.slice(-args.engineLog); }
  if (args.actors) {
    // A class list: names, class and state of the level's actors of that class (or its subclasses).
    out.actors = [];
    const isOf = actor => { for (let cls = runtime.instance(actor).cls; cls; cls = cls.base) if (cls.record?.key === args.actors.toLowerCase()) return true; return false; };
    // pendingDeleted: the names of the actors of that class destroyed but not yet purged (ULevel's pending-deletion chain through `Deleted`,
    // newest first). A pre-placed actor that destroys itself at load (PickupDistributor) is out of `level.actors` but still registered, in
    // the original as here, until the first CleanupDestroyed.
    out.pendingDeleted = [];
    for (let actor = level.pendingDeleted ?? null; actor; actor = runtime.readNamed(actor, 'Deleted') ?? null) if (isOf(actor)) out.pendingDeleted.push(actor.name);
    for (const actor of level.actors) {
      if (!actor || !isOf(actor)) continue;
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
  // `strobe: {}` only reads it.
  if (args.strobe) {
    const strobe = lightGlobals(runtime).strobe;
    if (args.strobe.flag !== undefined) { strobe.flag = args.strobe.flag & 1; strobe.time = Math.fround(args.strobe.time); }
    out.strobe = { ...strobe };
    // The Strobe-lit surfaces each frame (the main frame, then the child frames) drew at the last light-map Strobe call.
    out.strobeScan = lightGlobals(runtime).strobeScan ?? null;
  }
  // moveTest: {pawn, at, delta}: the pick worker's test move for that pawn from that place (FarMoveActor there with test and noCheck, ULevel::MoveActor
  // with bTest=1 and bIgnorePawns=1 as checkMove makes it, FarMoveActor back), and the hit it made: what an original capture's MoveActor record
  // (location after, Hit.Time, Hit.Normal, Hit.Actor) is compared with.
  if (args.moveTest) {
    const pawn = byName(args.moveTest.pawn);
    if (!pawn) throw new Error(`liveProbe: no actor ${args.moveTest.pawn}`);
    const services = runtime.pawnNavServices(pawn), home = [...services.location(pawn)];
    const tests = Array.isArray(args.moveTest.tests) ? args.moveTest.tests : [args.moveTest];
    out.moveTest = [];
    for (const test of tests) {
      services.farMoveActor(pawn, test.at.map(Math.fround), 1, 1);
      const rotation = runtime.readNamed(pawn, 'Rotation');
      const hit = services.moveActor(pawn, test.delta.map(Math.fround), rotation, { test: 1, ignorePawns: 1, ignoreBalls: 0, noFail: 0 });
      out.moveTest.push({ at: test.at, delta: test.delta, after: plain(services.location(pawn)), time: hit?.time ?? null, actor: hit?.actor?.name ?? null, normal: plain(hit?.normal) });
    }
    services.farMoveActor(pawn, home, 1, 1);
  }
  // lineHits: {start, end, extent}: the collision hash's ordered hits of that swept cylinder (MultiLineCheck with actors): which actors a move would meet,
  // with the collision flags the host holds for each.
  if (args.lineHits) {
    const hits = level.hash.multiLineCheck({ end: args.lineHits.end.map(Math.fround), start: args.lineHits.start.map(Math.fround), extent: args.lineHits.extent.map(Math.fround),
      checkActors: 1, worldActor: level.hash.levelInfo, extra: 0 });
    out.lineHits = hits.map(hit => ({ actor: hit.actor?.name ?? null, flags: hit.actor?.flags ?? null, actorFlags: hit.actor?.actorFlags ?? null, time: hit.time, location: plain(hit.location), normal: plain(hit.normal),
      lineage: (hit.actor?.lineage ?? []).slice(0, 4) }));
  }
  // flags: the player's FlagBase as Play holds it, after `delete` (names): the original's DeleteFlag(Name, FLAG_Bool) native on each. The start state
  // of a directly opened map: the original's `open` leaves the player's FlagBase empty (tools/dump-flags-win.c: 0 flags at the frozen start, defaultExpiration
  // 0, and 0 flags after the mission script's first Timer, which sets defaultExpiration to mission + 1 and finds no PlayerTraveling), where Play's login
  // supplies the fresh-mission marker PlayerTraveling (script-mission-live.mjs beginFreshMission) and the first Timer runs FirstFrame.
  if (args.flags) {
    const base = runtime.readNamed(player, 'FlagBase');
    for (const name of args.flags.delete ?? []) {
      const call = [name, 0];
      runtime.callFunction(runtime.lookup(base, 'DeleteFlag'), base, call.length, index => call[index]);
    }
    out.flags = { defaultExpiration: base.defaultExpiration, entries: [...base.entries.values()].map(entry => ({ name: entry.name, ...(entry.type ? { type: entry.type, value: entry.value } : { value: entry.value ? 1 : 0 }), expiration: entry.expiration })) };
  }
  // loadFlyGenerators [{name, loc}]: the chance FlyGenerators the original's load made where Play's seeded load drew none
  // (DeusExDecoration.PreBeginPlay: `if (bGenerateFlies && (FRand() < 0.1)) flyGen = Spawn(Class'FlyGenerator', , , Location, Rotation)`),
  // from the original's generators-load<tag>.json: a measured host input, the load's draws. A replay whose frozen phase kills them
  // (`KillAll FlyGenerator`) needs them: each Destroy links its actor into ULevel's Deleted chain, and CleanupDestroyed purges only when
  // the chain holds 128 (alm2: Play two links short, no purge at the original's 895). Each is spawned as its decoration's branch spawns it
  // (the bGenerateFlies decoration standing at the generator's Location: its Instigator and Rotation, and its flyGen written), in name
  // order so Play's name counter gives the original's names. None is made when Play's load holds a FlyGenerator of its own (`own`): the
  // KillAll chains that one too, and no destroy leaves the chain, so the two chains still differ (open: 04_NYC_Street's seed-1 load has
  // ten; docs/stage-5-exit-criteria.md "The Deleted chain at the first purge" and work item 12).
  if (args.loadFlyGenerators) {
    const isA = (actor, key) => { for (let cls = runtime.instance(actor)?.cls; cls; cls = cls.base) if (cls.record?.key === key) return true; return false; };
    const own = level.actors.filter(actor => actor && isA(actor, 'deusex.flygenerator')).map(actor => actor.name);
    out.loadFlyGenerators = { own, made: [] };
    const cls = [...runtime.linkedClasses].find(entry => entry.record?.key === 'deusex.flygenerator');
    if (!own.length && !cls) throw new Error('liveProbe: DeusEx.FlyGenerator is not linked');
    const decorations = own.length ? [] : level.actors.filter(actor => actor && isA(actor, 'deusex.deusexdecoration') && runtime.readNamed(actor, 'bGenerateFlies'));
    const number = name => Number(/(\d+)$/.exec(name)?.[1] ?? NaN);
    for (const { name, loc } of own.length ? [] : [...args.loadFlyGenerators].sort((a, b) => number(a.name) - number(b.name))) {
      const at = loc.map(Math.fround);
      const makers = decorations.filter(actor => runtime.readNamed(actor, 'Location').every((value, axis) => Math.abs(value - at[axis]) < 0.01));
      if (makers.length !== 1) throw new Error(`liveProbe: ${makers.length} bGenerateFlies decorations stand at ${name}'s (${at.join(',')})`);
      const [decoration] = makers;
      if (runtime.readNamed(decoration, 'flyGen')) throw new Error(`liveProbe: ${decoration.name} already holds a flyGen`);
      const actor = runtime.spawnActor({ cls: cls.record, level, name: 'None', owner: null, instigator: runtime.readNamed(decoration, 'Instigator'),
        location: [...runtime.readNamed(decoration, 'Location')], rotation: [...runtime.readNamed(decoration, 'Rotation')] });
      if (!actor) throw new Error(`liveProbe: SpawnActor refused ${name} at ${decoration.name}`);
      runtime.writeNamed(decoration, 'flyGen', actor);
      out.loadFlyGenerators.made.push({ name: actor.name, original: name, decoration: decoration.name });
    }
  }
  if (args.population) {
    const spawned = /^(Skill|Aug|NanoKey|ColorTheme|Shadow|ParticleProxy|Laser|Flare|Cigarettes|Candybar|Weapon|Mission|GameReplicationInfo|PlayerReplicationInfo|JCDenton|Mutator|DeusExGameInfo|PickupDistributor|AutoTurretGun|BarkManager|ParticleGenerator|DataVault|Credits|Ammo|BioelectricCell|Medkit|Binoculars|Lockpick|Multitool|LAM|Liquor|Soda|Sodacan|Fruit|Vice)/;
    // names compare as FNames do, ignoring case (see byName): destroying Play's `MIB1` because the original spells it `mib1` removed a live
    // pawn that the original ticks (its four tick-1 draws and the stream shift after them: the sweep's StartUp group in the MJ12 labs)
    const have = new Set(args.population.map(entry => entry.name.toLowerCase())), extra = [];
    for (const actor of level.actors) if (actor && actor !== player && actor.name && !have.has(actor.name.toLowerCase()) && !spawned.test(actor.name)) extra.push(actor);
    out.population = { removed: extra.map(actor => actor.name) };
    for (const actor of extra) runtime.destroyActor(actor, false);
    const names = new Set(level.actors.filter(Boolean).map(actor => actor.name.toLowerCase()));
    out.population.missing = args.population.filter(entry => !names.has(entry.name.toLowerCase()) && !spawned.test(entry.name)).map(entry => entry.name);
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
  // objectTrace: {seed: {count, freeIndices}, first, last}: the original's slot model (original-object-index.mjs) started from the
  // registry the original had at the frozen start (a measured host input: tools/dump-gobjects-win.c --available), then every
  // object the registry takes or gives back and every Galaxy PlaySound call, with the unfrozen tick (u), returned by `take` as `objects`
  // and `sounds`; compared with the original's AddObject / UnhashObject / UAudioSubsystem::PlaySound breakpoints
  // (scripts/live-sound-compare.mjs, docs/object-index-captures.md "Runtime spawns").
  if (args.objectTrace) {
    const registry = runtime.actorLifecycle.construction.registry;
    if (args.objectTrace.seed) {
      const { count, freeIndices, measured = {}, classRows = {}, player: live = null, preFrees = [], packages = null, classSlots = null } = args.objectTrace.seed;
      runtime.seedOriginalObjectIndex({ count, freeIndices, exact: true, packages, classSlots, source: 'the original registry at the frozen start' });
      // The run's own measured indices for the pre-placed actors and the player (a host input, like the tables of the other sessions), the
      // pending-deleted ones included: an actor that destroyed itself at load is released by Play's first purge under the index it holds
      // (script-level-collection.mjs `release`), and the map table's (map-object-indices.mjs) is another capture's.
      const held = new Set(), exportNames = new Set(), made = new Map();
      const give = (actor, pending = false) => {
        const instance = runtime.instance(actor), cls = instance.cls.record.name, object = instance.nativeObject;
        if (object && Number.isInteger(object.index)) { (made.get(cls) ?? made.set(cls, []).get(cls)).push({ actor, pending }); return false; }
        exportNames.add(actor.name);
        const key = `${cls}.${actor.name}`;
        if (!Number.isInteger(measured[key])) return false;
        instance.globalIndex = measured[key];
        held.add(measured[key]);
        return true;
      };
      let given = 0, givenPending = 0;
      for (const actor of level.actors) if (actor && actor !== player && give(actor)) given++;
      for (let actor = level.pendingDeleted ?? null; actor; actor = runtime.readNamed(actor, 'Deleted') ?? null) if (actor !== player && give(actor, true)) givenPending++;
      if (live) { runtime.instance(player).globalIndex = live.index; held.add(live.index); }
      // An actor the runtime created before the seed (a load's spawn: a pawn's Shadow, a LaserTrigger's LaserProxy, the original load's chance
      // FlyGenerators made for the frozen phase's KillAll, loadFlyGenerators above), live or pending deletion. Its name is its class's session
      // counter (MakeUniqueObjectName: ClassUnique++ per name made), and Play's boot leaves the counters elsewhere than the original's (Island:
      // Play's Shadows are Shadow53..105, the original's Shadow20..72), so the name does not name the original's object. Within a class the
      // counter orders creation in both programs, and both make the class's load actors in the same order (the same map, the same load code):
      // the k-th of Play's is the original's k-th, among the dump's rows of that class that are not a pre-placed actor's. Paired only when
      // both programs hold as many; a class that differs keeps no index (the original's frees of its slots are pre-frees). A paired actor
      // holds a slot the seeded model did not hand out (the boot's model gave it one, or none): its measured index is the slot its ~UObject
      // appends to GObjAvailable when a purge releases it, as a pre-placed actor's measured index is (script-level-collection.mjs `release`).
      const number = name => Number(/\d+$/.exec(name)?.[0] ?? NaN), byNumber = (a, b) => a.n - b.n;
      const paired = [], unpaired = [], madePending = [];
      // The names, too (Stage 5 work item 13): a load-made actor's name is its class's session counter, so Play's differ from the original's (Play's
      // Candybar3 is the original's Candybar2), and a name made after the seed would then differ as well: MakeUniqueObjectName (Core 0x101575b0) starts
      // at the class counter the trace measures (classCounters) and skips a name an object holds, and Play's Candybar3 held the original's next name.
      // Each paired actor takes the dump's name of the original's actor it stands for (script-object-construction.mjs renameRegisteredObjects).
      const originalNames = args.objectTrace.seed.originalNames !== false, renames = [];
      for (const [cls, list] of made) {
        const ours = list.map(entry => ({ ...entry, n: number(entry.actor.name) })).sort(byNumber);
        const theirs = (classRows[cls] ?? []).filter(([name]) => !exportNames.has(name)).map(([name, index]) => ({ name, index, n: number(name) })).sort(byNumber);
        if (ours.length !== theirs.length || ours.some(entry => !Number.isInteger(entry.n))) { unpaired.push({ cls, play: ours.length, original: theirs.length }); continue; }
        ours.forEach(({ actor, pending }, k) => {
          const instance = runtime.instance(actor), index = theirs[k].index;
          instance.globalIndex = index; held.add(index);
          instance.nativeObject.originalIndex = index; instance.nativeObject.originalModel = registry.original;
          if (pending) madePending.push(`${actor.name}=${theirs[k].name}`);
          if (originalNames && actor.name !== theirs[k].name) renames.push({ actor, object: instance.nativeObject, name: theirs[k].name });
        });
        paired.push({ cls, count: ours.length, play: `${ours[0].n}..${ours.at(-1).n}`, original: `${theirs[0].n}..${theirs.at(-1).n}` });
      }
      let renamedCount = 0, keptNames = [];
      if (renames.length) {
        const construction = runtime.actorLifecycle.construction;
        const outerIndexOf = object => !object.outer ? 0 : Number.isInteger(object.outer.index) ? object.outer.index : object.outer.hashIndex;
        const { renamed, kept } = renameRegisteredObjects(registry, renames.map(entry => ({ ...entry, outerIndex: outerIndexOf(entry.object) })),
          { internName: construction.internName, findObject: construction.findObject });
        const done = new Set(renamed);
        for (const entry of renames) if (done.has(entry.object)) entry.actor.name = entry.object.name;
        renamedCount = renamed.length; keptNames = kept.map(entry => `${entry.actor.name}->${entry.name}`);
      }
      // Frees of objects that existed at the frozen start (see live-acceptance.mjs registrySeed). An object Play holds under the same index is
      // freed by Play itself: no pre-free for it. Of the others, one with an anchor (the original's registry event before it in the same tick)
      // is released right after Play's model takes or gives back that slot at that tick (the log hook below): its place in a purge. The rest run
      // before the tick they happened in, an AI event object after the event manager's Tick (the replay).
      const own = preFrees.filter(entry => held.has(entry.index)), rest = preFrees.filter(entry => !held.has(entry.index));
      const anchoredHere = entry => entry.anchor && !AI_EVENT_CLASS.test(entry.cls ?? '');
      args.objectTrace.pending = rest.filter(entry => !anchoredHere(entry)).map(entry => ({ ...entry }));
      args.objectTrace.anchored = rest.filter(anchoredHere).map(entry => ({ ...entry }));
      args.objectTrace.stats = { anchored: 0, late: 0, rejected: 0 };
      out.objectTrace = { measured: given, pendingDeleted: givenPending, paired, unpaired, madePending, renamed: renamedCount, keptNames, player: live?.key ?? null, preFrees: rest.length,
        anchored: args.objectTrace.anchored.length, own: own.map(entry => `${entry.cls}.${entry.name}`) };
    }
    const objects = runtime.objectLog ??= [], sounds = runtime.soundLog ??= [];
    // The tracer's u counts level ticks: a window frame (RootTick) between level ticks k and k+1 is u = k. Play ticks those frames inside replayed tick
    // k+1 (game.tick: the windows, then the level), so an object a window frame creates or frees (a bark subtitle's windows), or a sound it plays, takes
    // k there, as the original's records do; frames run before a held command (state.current unset) take the hold's own index.
    const tick = () => { const replay = game.liveReplay; return replay?.current ? replay.current.n - (replay.windowPhase ? 1 : 0) : replay?.index ?? 0; };
    if (game.hud && !game.hud.replayLabelled) {
      const hudTick = game.hud.tick;
      game.hud.tick = delta => {
        const replay = game.liveReplay;
        if (replay) replay.windowPhase = true;
        try { return hudTick.call(game.hud, delta); } finally { if (replay) replay.windowPhase = false; }
      };
      game.hud.replayLabelled = true;
    }
    const inRange = n => n >= args.objectTrace.first && n <= args.objectTrace.last;
    const model = registry.original;
    if (model) {
      model.clock = tick;
      // the model's own log, filtered to the window of ticks the comparison covers
      const anchored = args.objectTrace.anchored ?? [], stats = args.objectTrace.stats;
      model.log = { push: entry => {
        if (inRange(entry.u)) objects.push(entry);
        // the pre-free the original made right after this registry event (its release is logged in turn: the anchor of the next one)
        const head = anchored[0];
        if (head && head.u === entry.u && head.anchor.ev === entry.ev && head.anchor.index === entry.index) {
          anchored.shift();
          if (model.release(head.index)) stats.anchored++; else stats.rejected++;
        }
      } };
    }
    const audio = level.engine.audio;
    if (audio && !audio.traced) {
      audio.traced = true;
      const playSound = audio.playSound;
      const nameOf = value => value?.key ?? value?.name ?? null;
      audio.playSound = (actor, id, sound, location, volume, radius, pitch) => {
        const result = playSound(actor, id, sound, location, volume, radius, pitch);
        if (inRange(tick())) sounds.push({ u: tick(), actor: actor?.name ?? null, id, sound: nameOf(sound), volume, radius, pitch, result });
        return result;
      };
    }
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
  if (args.gcTrace) globalThis.__gcAllocLog = [];
  if (args.replay) {
    const { watch = [], ticks, hold = true, warm = 3, commands = [] } = args.replay;
    // A `late` group (live-acceptance.mjs --carcass-watch) names actors the scene spawns: each is looked up at every row until the level holds
    // it, and its rows start there (the original's tracer binds the same name at the tick exit after its AddObject, tools/dx-live-win.c late-watch).
    // `via` {name: 'Owner.field'}: an actor watched under the original's name and found in Play through its owner's object field (a turret's gun,
    // spawned by AutoTurret.PreBeginPlay: its name follows each process's session history, live-acceptance.mjs --device-watch Name:Class@Owner.field)
    // (a group that watches bDeleteMe, live-acceptance.mjs --device-watch and --stop-destroyed: a destroyed actor whose object a purge released has no more
    // rows, its memory is not its own)
    const actors = watch.map(({ names, props, late = false, via = {} }) => ({ props, late, released: props.includes('bDeleteMe'),
      items: names.map(name => [name, byName(via[name] ?? name)]) }));
    for (const group of actors) for (const [name, actor] of group.items) if (!actor && !group.late) throw new Error(`liveProbe: no actor ${name}`);
    // the AI event manager's process ring as the replay begins (aievent.rs ai_dump), for live-acceptance.mjs to compare with the original's at its release
    out.aiRing = runtime.scriptVm?.aiEvents?.ring?.() ?? null;
    // The frozen phase's window hold (view-probe.mjs windowHold, live-acceptance.mjs --frozen-frames) ends here: the replayed ticks bring
    // their own window frames (windowSeconds), the first one the frames the original ran after its last frozen-phase line.
    game.windowHold = false;
    // (a diagnostic: the HUD message log's clock as the frozen phase left it, HUDLogDisplay.lastLogMsg against its logTimeout: a line logged in the
    // frozen phase, a `ghost`'s, is still waiting while lastLogMsg is under the timeout)
    out.hudLog = hudLogClock(game);
    const state = game.liveReplay = {
      ticks, hold, warm, index: 0, rows: [], cursor: 0, current: null, preFrees: args.objectTrace?.pending ?? null,
      // the level's end: {tick, url, ...} when UGameEngine::Tick's client travel (game.mjs clientTravel) left the level after that many replayed ticks
      levelEnd: null,
      anchoredFrees: args.objectTrace?.anchored ?? null, preFreeStats: args.objectTrace?.stats ?? { anchored: 0, late: 0, rejected: 0 },
      // console commands typed into the original between two ticks ({after, text}: after that many ticks), run here the same way through the
      // recovered console command chain (APlayerPawn::execConsoleCommand) before the next tick; their results are returned by `take` as `commands`
      commands: commands.map(command => ({ ...command })), commandLog: [], canSee: args.replay.canSeeProbe ?? null,
      // measured speech ({n, name, letter}, sorted by n): the letter Galaxy's audio update wrote into a speaker's nextPhoneme before tick n. The update
      // analyses the audio the host plays in real time (docs/lip-sync.md "Inputs that only the host can supply"), which a replay does not run, so the
      // original's letters are a measured input like the stream state; Pawn.LipSynch (script) maps them to the mouth animations as it does in Play.
      phonemes: (args.replay.phonemes ?? []).map(entry => ({ ...entry })).sort((a, b) => a.n - b.n),
      measuredSpeech: Boolean(args.replay.phonemes),
      snapshot() {
        const result = {};
        for (const group of actors) for (const item of group.items) {
          if (!item[1] && group.late) item[1] = byName(item[0]);
          const [name, actor] = item;
          // (a late-watched actor the scene destroyed and the purge released: no row; live-acceptance.mjs compare ends it at the original's free)
          if (!actor || runtime.isReleased?.(actor)) continue;
          const row = {};
          for (const prop of group.props) {
            if (prop === '$inventoryChain') {
              // the Inventory linked list (Actor.Inventory, then each item's own), names in order, as the tracer's `chain` field (at most 32, no repeat)
              const chain = [];
              for (let held = runtime.readNamed(actor, 'Inventory'); held && chain.length < 32 && !chain.includes(held.name); held = runtime.readNamed(held, 'Inventory')) chain.push(held.name);
              row[prop] = chain;
            } else if (prop === '$state') {
              const instance = runtime.instance(actor), node = instance?.state ? (instance.state.stateNode ?? instance.cls) : null;
              row.State = scriptGetStateName(node);
            } else if (prop.startsWith('$atmBalance')) {
              // an ATM's userList[n].balance ($atmBalance0, ...): the sUserInfo struct's last field
              const entry = runtime.readNamed(actor, 'userList')[Number(prop.slice('$atmBalance'.length))];
              row[prop] = plain(Object.entries(entry).find(([k]) => k.split('.').pop() === 'balance')?.[1]);
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
        this.noPaint = false;
        if (this.warm > 0) { this.warm--; return false; }
        // After the last row the original paused before any command of that hold was typed, unless its level ended there (`levelEnded`: the trace
        // stopped at the client travel, e.g. an OPEN typed in that hold): then the hold's commands run, and the client travel follows (game.mjs).
        const typedAtEnd = args.replay.levelEnded && this.commands.length && this.commands[0].after <= this.index;
        if (this.index >= this.ticks.length && !typedAtEnd) return this.hold ? false : dt;
        const tick = this.ticks[this.index];
        let typed = false;
        // One command per call: the frames after it render before the next command of the hold runs (below), as the original drew frames while
        // the next line was typed (a placement's `set Location` before its `set ViewRotation`: the frame between them stamped what the old view
        // showed at the new place, Stage 5 oV's HarleyFilben0 at tick 481).
        if (this.commands.length && this.commands[0].after <= this.index) {
          typed = true;
          const command = this.commands.shift(), { windowSeconds: framesBefore, ...entry } = command;
          // The window frames the original ran in this hold before the command's InputEvent (live-acceptance.mjs commandsWithStream): a window the
          // command creates (a bark's subtitle) gets only the frames after it, as in the original; the hold's later frames tick the windows before the next tick.
          if (Array.isArray(framesBefore)) { for (const delta of framesBefore) game.hud?.tick(delta); entry.windowFrames = framesBefore.length; }
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
            // `@down CODE` / `@up CODE`: a key edge (KeyboardEvent.code) through the binding path, as the original's WM_KEYDOWN/WM_KEYUP;
            // `@hold CODE` / `@release CODE` the same edges of a key held across ticks (the original's through its input queue: live-acceptance.mjs keyEdge)
            const edge = /^@(down|up|hold|release) (\S+)$/.exec(command.text)?.map(part => part === 'hold' ? 'down' : part === 'release' ? 'up' : part), typed = /^@type (.+)$/.exec(command.text);
            // `@type TEXT`: WM_CHAR units without key edges (live-acceptance.mjs keyEdge), each through the window system's typed-character route (Client->Engine->Key)
            if (typed) { entry.output = []; for (const char of typed[1]) entry.output.push(plain(game.inputChar(char.charCodeAt(0)))); }
            else if (edge) {
              entry.output = plain(game.inputKey(edge[2], edge[1] === 'down'));
              // --typed-chars: TranslateMessage's WM_CHAR after the WM_KEYDOWN of the keys it translates (Tab 0x09, Escape 0x1b, Enter 0x0d (WinDrv drops it), Space, a letter)
              const key = args.replay.typedChars && edge[1] === 'down' ? keyOfCode(edge[2]) : null;
              if (key !== null) for (const unit of typedCharacters({ key })) game.inputChar(unit);
            }
            // The original types a line as keys (ad/tools/dxinput.c consoleLine: T, ten Backspaces, the characters as WM_CHAR, Enter), and
            // XInputExt::Process (0x1002d0b0) offers every key to the root window before any binding. A window that takes the keys (a third-person
            // conversation's ConWindowActive: VirtualKeyPressed returns True for every key and plays the next event on Enter) gets T, so the
            // console never opens and the line never runs: its Backspaces and Enter reach that window, and its characters no typing line (Stage 5
            // fN: the frob fan's lines typed during MeetFilben2, whose releases the original's InputEvent returned as handled).
            else if (game.windowKey('KeyT', true)) {
              game.windowKey('KeyT', false);
              for (let i = 0; i < 10; i++) { game.windowKey('Backspace', true); game.windowKey('Backspace', false); }
              game.windowKey('Enter', true); game.windowKey('Enter', false);
              entry.output = 'the keys went to the window that holds them';
            } else {
              game.windowKey('KeyT', false);
              const consoleCommands = game.doors.scriptRuntime.windowHost?.consoleCommands;
              if (!consoleCommands) throw new Error('no console command chain');
              entry.output = consoleCommands.consoleCommand(player, command.text);
            }
          } catch (error) { entry.error = String(error?.message ?? error); }
          finally { restore?.(); }
          this.commandLog.push(entry);
        }
        // The original draws frames while a command is typed and the level is held (a view change stamps the LastRenderTime of what it now
        // shows): a few frames pass here after each command, before the hold's next command or the next tick, as in the warm-up.
        if (typed || this.index >= this.ticks.length) {
          this.warm = 3;
          // --typed-chars (a window scene): a frame paints only if the original's did. The original's frame is the input pump (the command's InputEvent), the window tick
          // (`roottick`) and, when the level is held, the draw; the frame that finds the tracer released runs the level tick and draws after it. The roottick frames after a command
          // before the next command (or the next level tick) therefore hold `frames - 1` complete frames when the last of them runs the tick, else all of them: a key edge pair
          // typed within one frame (med1's Enter, 0.441 s long: press, release, one roottick, then tick 201) has no held frame, and the 43 GCs of the Health screen's new region
          // windows (the layout of a window that was just created, UGC creation per DrawWindow-time QueryPreferredSize) come after tick 201's AI process, not in the hold.
          // A console line's hold (med1's ParseRightClick at 60: roottick 0.592, the 144 GCs, roottick 0.275, tick 61) has a held frame and paints, as Play's warm frames do.
          if (typed && args.replay.typedChars) {
            const next = this.commands[0], pending = next && next.after <= this.index;
            const frames = pending ? (Array.isArray(next.windowSeconds) ? next.windowSeconds.length : null) : (Array.isArray(tick?.windowSeconds) ? tick.windowSeconds.length - 1 : null);
            if (frames === 0) { this.warm = 0; this.noPaint = true; }
          }
          return false;
        }
        if (runtime.navTrace) runtime.navTrace.tick = this.index + 1;
        if (runtime.scriptTrace) runtime.scriptTrace.tick = this.index + 1;
        if (this.preFrees?.length) while (this.preFrees.length && this.preFrees[0].u <= this.index + 1) {
          const entry = this.preFrees.shift();
          // An AI event object (the sender the player's landing left in the original's manager) is freed by UEventManager::CleanupEvents,
          // at the end of the manager's Tick after the actors (ULevel::Tick 0x103a5a2b): after the objects this tick's actors create.
          if (AI_EVENT_CLASS.test(entry.cls ?? '') && runtime.scriptVm?.aiEvents) { (this.preFreesAfterAi ??= []).push(entry); continue; }
          if (!runtime.actorLifecycle.construction.registry.original?.release(entry.index)) this.preFreeStats.rejected++;
        }
        if (this.preFreesAfterAi?.length && runtime.scriptVm?.aiEvents) {
          const manager = runtime.scriptVm.aiEvents, pending = this.preFreesAfterAi;
          manager.afterTick = () => {
            manager.afterTick = null;
            for (const entry of pending.splice(0))
              if (!runtime.actorLifecycle.construction.registry.original?.release(entry.index)) this.preFreeStats.rejected++;
          };
        }
        // An anchored pre-free whose anchor never came in its tick (Play's slots already differ there): released once that tick's window
        // frames have run too (they run inside the next replayed tick), and counted.
        while (this.anchoredFrees?.length && this.anchoredFrees[0].u < this.index) {
          const entry = this.anchoredFrees.shift();
          this.preFreeStats.late++;
          if (!runtime.actorLifecycle.construction.registry.original?.release(entry.index)) this.preFreeStats.rejected++;
        }
        game.random.seed(parseInt(tick.rngIn, 16) >>> 0);
        // The window system's wall-clock deltas (RootTick 0x1003be90, tools/dx-live-win.c `roottick`): every frame the original ran since
        // the previous level tick, held frames included, ticks the windows before this level tick (game.mjs tick). Without them the windows
        // take the level's delta.
        this.windowSeconds = Array.isArray(tick.windowSeconds) ? tick.windowSeconds : null;
        // AIProcess's 2 ms rdtsc budget (aievent.rs PROCESS_STOP): the receiver the original's firstProcess was left at after this
        // tick (tools/dx-live-win.c `aiFirst`, actor|event), a measured host input like the stream state. The player's runtime
        // number differs between the programs (JCDentonMale2 there, JCDentonMale1 here).
        const aiManager = runtime.scriptVm?.aiEvents;
        this.aiStop = null;
        // (`aiStop`, AIProcess's own firstProcess at its return, when the capture has it: the exact receiver the loop stopped before; else `aiFirst`)
        if ((tick.aiStop ?? tick.aiFirst) !== undefined && aiManager?.setProcessStop) {
          const raw = tick.aiStop !== undefined, [who, event] = String(raw ? tick.aiStop : tick.aiFirst).split('|'), actor = who === 'None' ? null : /^JCDenton/i.test(who) ? player : byName(who);
          aiManager.setProcessStop(actor, event, raw);
          this.aiStop = { misses: aiManager.processStopMisses(), unresolved: who !== 'None' && !actor };
        }
        globalThis.__liveTick = this.index + 1;   // (the tick about to run: script-gc-push-gc.mjs labels a traced GC allocation with it)
        while (this.phonemes.length && this.phonemes[0].n <= this.index + 1) {
          const { name, letter } = this.phonemes.shift(), speaker = byName(name);
          if (speaker) runtime.writeNamed(speaker, 'nextPhoneme', letter);
        }
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
        if (this.aiStop) {
          // the stop named an actor Play does not have, or a receiver its ring did not reach this tick
          if (this.aiStop.unresolved) row.aiStopUnresolved = true;
          if (runtime.scriptVm.aiEvents.processStopMisses() > this.aiStop.misses) row.aiStopMissed = true;
          this.aiStop = null;
        }
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
        game.random[name] = (...rest) => {
          draws.push(current?.name ?? '-');
          // drawStackActor: where that actor's draws come from (the script call stack's last frames), by replayed tick (rows' index)
          if (args.replay.drawStackActor && current?.name === args.replay.drawStackActor)
            (state.stackLog ??= []).push(`${name} @${state.index} ${new Error().stack.split('\n').slice(2, 12).map(l => l.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ')}`);
          return original(...rest);
        };
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
      // ULevel::TickTag (+0x10c, docs/script-actor-tick.md) flips at every level tick since the load, so its parity at the release counts the original's
      // frozen ticks: a measured input (live-acceptance.mjs: the player's bTicked in the trace). An actor whose Owner never ticks (a decal on LevelInfo) is
      // deferred and skipped on every other tick, so its timers run on the ticks of one parity.
      if (args.replay.tickTag === 0 || args.replay.tickTag === 1) level.tickTag = args.replay.tickTag;
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
    if (replay.stackLog?.length) out.stackLog = replay.stackLog.splice(0);
    out.rows = replay.rows.slice(replay.cursor); replay.cursor = replay.rows.length;
    out.index = replay.index;
    if (replay.levelEnd) out.levelEnd = replay.levelEnd;
    if (runtime.navTrace) out.nav = runtime.navTrace.events.splice(0);
    if (runtime.scriptTrace) out.script = runtime.scriptTrace.events.splice(0);
    if (runtime.touchEvents) out.touch = runtime.touchEvents.splice(0);
    if (runtime.aiEventLog) out.events = runtime.aiEventLog.splice(0);
    if (runtime.objectLog) out.objects = runtime.objectLog.splice(0);
    if (globalThis.__gcAllocLog?.length) out.gcAllocs = globalThis.__gcAllocLog.splice(0);   // (live-acceptance.mjs play --gc-trace: UGC::PushGC's allocations)
    // the slot model's inputs so far: pre-frees released at their anchor, late or refused, those still waiting, and the model's own
    // releases of a slot it cannot name (`unattributed`) or could not take back (`rejected`)
    const model = runtime.actorLifecycle?.construction?.registry?.original;
    if (model && replay.preFreeStats) out.preFrees = { ...replay.preFreeStats, waiting: (replay.preFrees?.length ?? 0) + (replay.anchoredFrees?.length ?? 0),
      unattributed: model.unattributed, modelRejected: model.rejected };
    if (runtime.soundLog) out.sounds = runtime.soundLog.splice(0);
  }
  if (args.status && replay) out.status = { index: replay.index, of: replay.ticks.length, levelEnd: replay.levelEnd };
  // deferred: the boundaries Play recorded instead of running (player.unimplementedPhysicsEffects: sounds of emitters without a measured
  // object index, trigger scripts that reached an unsupported native, ...); the record-only audit's dynamic side.
  if (args.deferred) out.deferred = [...game.player.unimplementedPhysicsEffects];
  if (args.stop) game.liveReplay = null;
  return out;
}
