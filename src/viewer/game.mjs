import { Matrix3, Vector3 } from 'three';
import { ClassDefaults } from '../unreal/classes.mjs';
import { readModel } from '../unreal/model.mjs';
import { pointZone } from '../unreal/lighting.mjs';
import { toView, fromView } from '../unreal/geometry.mjs';
import { CollisionWorld, BspCollider } from '../runtime/collision.mjs';
import { Player } from '../runtime/player.mjs';
import { Doors } from '../runtime/doors.mjs';
import { mapRegistrySeed } from '../runtime/map-registry-seeds.mjs';
import { createScriptDoors } from '../runtime/script-doors.mjs';
import { readFunction } from '../unreal/script.mjs';
import { compileFunction } from '../runtime/script-vm.mjs';
import { actorsEpoch, bumpBaseEpoch } from '../runtime/base-epoch.mjs';
import { RENDER_LIGHT, RENDER_SHIFT } from '../runtime/script-vm-render.mjs';
import { brushMatrix } from './transforms.mjs';
import { walkingSurfaceTextures } from '../runtime/walking-surface.mjs';
import { isHighlighted } from '../runtime/interaction.mjs';
import { bindPlayerScene } from '../runtime/player-scene.mjs';
import { createNativeRng } from '../runtime/rng.mjs';
import { mapActorArray, mapExportAdmitted } from '../runtime/script-map-properties.mjs';
import { createPlayHud } from '../runtime/script-play-hud.mjs';
import { inputKeyForCode } from './input-key-names.mjs';
import { wheelMessage } from './wheel-input.mjs';
import { isMovingLightCandidate } from '../runtime/dynamic-lighting.mjs';
import { loadTraceKernel } from '../runtime/trace-kernel.mjs';
import { lightGlobals } from '../runtime/light-globals.mjs';
import { createTravelStep } from '../runtime/travel.mjs';
import { Furl, DEFAULT_PLAYER_OPTIONS } from '../runtime/furl.mjs';

/** Bind decoded resources to the renderer-independent simulation. */
/** The game left the level (UGameEngine::Tick's client travel to `url`): Browse and LoadMap are Stage 6, so Play stops here. */
export class ClientTravelBoundary extends Error {
  constructor(url) {
    super(`UGameEngine::Tick client travel to ${url}: the level ends here (Browse and LoadMap of the next map are not implemented)`);
    this.name = 'ClientTravelBoundary';
    this.url = url;
  }
}

export async function createGame(map, asset, assets, { randomSeed = Math.floor(Date.now()/1000) >>> 0,
  onLightingChanged = null, onDataLinkTransmission = null, onConversationSpeech = null, onAudioVoice = null, presentation = false,
  subtitles = null, musicLibrary = null, travel = null, saveDirectory = null, fullscreen = null, restore = null } = {}) {
  if(onDataLinkTransmission!=null&&typeof onDataLinkTransmission!=='function')
    throw new TypeError('createGame onDataLinkTransmission must be a function');
  const defaults = new ClassDefaults(assets), collision = new CollisionWorld(map.model), notes = [];
  const engine = await assets.get('Engine'), dx = await assets.get('DeusEx');
  const playerDefaults = await defaults.get(dx, dx.exportsByPath.get('jcdentonmale'));
  const zoneDefault = await defaults.get(engine, engine.exportsByPath.get('zoneinfo'));
  const actors = new Map();
  // The standalone map linker refuses to construct exports its CreateExport
  // gates reject — Training's Brush and Camera exports carry only
  // RF_LoadForEdit flags and never become objects. Serialized references to
  // them (Level.Actors slots, Owner/Base fields) resolve to null, so they are
  // never built here: they cannot collide, join PawnList, run startup or tick.
  for (const actor of map.actors)
    if (mapExportAdmitted(map.pkg, actor.index))
      actors.set(actor.index, { ...actor, values: await defaults.forActor(asset, actor) });
  const zones = map.model.zones.map(z => actors.get(z.actor)?.values ?? zoneDefault);
  const collidable = [], nonColliding = [];
  // A saved level (docs/travel.md "Restoring a level"): GameInfo.Login reuses the unoccupied PlayerPawn of Level.PawnList, so the saved pawn
  // is the player and takes no part in the generic actor registration below (the Player facade registers it).
  const savedPlayer = restore ? await findSavedPlayer(map, actors, defaults, asset) : null;
  for (const actor of actors.values()) {
    if (actor === savedPlayer) continue;
    const v = actor.values;
    actor.owner = actors.get(v.Owner) ?? null;
    if (!v.Location) continue;
    if (!v.bCollideActors) {
      // Every AActor has the +0x1dc collision word; bCollideActors only
      // decides hash registration. A non-colliding export (a hidden pawn or
      // button a script later reveals with SetCollision) gets the same native
      // host surface, outside the hash. Brushes keep the mover route.
      if (v.bIsMover && v.Brush > 0) continue;
      actor.lineage = await defaults.lineage(asset, asset.pkg.exports[actor.index - 1].classIndex);
      actor.actorFlags = (v.bStatic ? 1 : 0) | (v.bDeleteMe ? 0x80 : 0) |
        (v.bCollideWhenPlacing ? 0x20000 : 0) | (v.bMovable ? 0x80000 : 0);
      actor.movingBrush = false;
      actor.projectile = actor.lineage.includes('engine.projectile');
      actor.base = actors.get(v.Base) ?? null; bumpBaseEpoch();
      Object.assign(actor, { position: [...v.Location], radius: v.CollisionRadius ?? 0, height: v.CollisionHeight ?? 0 });
      nonColliding.push(actor);
      continue;
    }
    actor.lineage = await defaults.lineage(asset, asset.pkg.exports[actor.index - 1].classIndex);
    actor.collisionBits = 1 | (v.bBlockActors ? 4 : 0) | (v.bBlockPlayers ? 8 : 0) | (v.bProjTarget ? 16 : 0);
    actor.flags = actor.collisionBits | (v.bCollideWorld ? 2 : 0);
    actor.actorFlags = (v.bStatic ? 1 : 0) | (v.bDeleteMe ? 0x80 : 0) |
      (v.bCollideWhenPlacing ? 0x20000 : 0) | (v.bMovable ? 0x80000 : 0);
    actor.movingBrush = Boolean(v.Brush) && actor.lineage.includes('engine.brush');
    actor.projectile = actor.lineage.includes('engine.projectile');
    actor.base = actors.get(v.Base) ?? null; bumpBaseEpoch();
    actor.blocking = Boolean(v.bBlockPlayers);
    collidable.push(actor);
    if (v.bIsMover && v.Brush > 0) {
      const matrix = brushMatrix(v), normal = new Matrix3().getNormalMatrix(matrix);
      const transform = p => fromView(new Vector3(...toView(p)).applyMatrix4(matrix).toArray());
      const transformNormal = n => fromView(new Vector3(...toView(n)).applyMatrix3(normal).toArray());
      actor.model = readModel(asset.pkg, asset.bytes, v.Brush);
      const collider = new BspCollider(actor.model, transform, transformNormal, v);
      // A NotSolid sheet brush (e.g. PF_NotSolid|PF_TwoSided|PF_Masked, one
      // node) compiles no solid leaves, so it has no collision hulls: the
      // original model checks never hit it. Hash bounds come from the model
      // box (brushCollisionBounds), not from hulls.
      actor.collider = collider;
      actor.position = v.Location.map(Math.fround);
      actor.collisionValues = { ...v, get Location() { return actor.position; }, get Rotation() { return actor.rotation ?? v.Rotation; } };
      collision.movers.push(actor);
    } else {
      Object.assign(actor, { position: [...v.Location], radius: v.CollisionRadius ?? 0, height: v.CollisionHeight ?? 0 });
      collision.actors.push(actor);
    }
  }
  // The level queries keep their collision hash in the Rust kernel when it is
  // loaded as they are created (docs/rust-core.md R3-b).
  await loadTraceKernel();
  collision.registerActors(collidable);
  const start = [...actors.values()].find(a => a.className === 'PlayerStart' && a.values.bSinglePlayer && a.values.bEnabled !== false && a.values.Location);
  if (!start) throw new Error('No enabled single-player start in this map');
  // A restored level starts the player where the saved pawn stands (its saved Location and ViewRotation).
  const playerStart = savedPlayer ?? start;
  const checkBob = compileFunction(readFunction(engine, engine.exportsByPath.get('playerpawn.checkbob')));
  const startYaw = ((savedPlayer ? savedPlayer.values.ViewRotation : start.values.Rotation)?.[1] ?? 0) * Math.PI / 32768;
  const player = new Player(collision, playerDefaults, playerStart.values.Location, p => zones[pointZone(map.model, p)] ?? zoneDefault, checkBob, startYaw);
  if (savedPlayer) {
    // The saved pawn's export is the player's identity: the movement port binds it with its saved values, and every reference in the file
    // to the pawn resolves to it.
    const identity = player.bindCollisionIdentity(Object.assign(Object.create(null), savedPlayer, { controlledPlayer: true }),
      { ...savedPlayer.values, Base: null });   // the base is the level, resolved once its identity exists (below)
    actors.set(savedPlayer.index, identity);
  }
  // Original Core startup passes time(NULL) to srand. This scene's shared
  // stream is also injectable for native comparisons and restored by reset.
  const random = createNativeRng(randomSeed);
  player.nativeRandom = random.frand;
  Object.assign(player.collisionActor,{id:'$player',name:savedPlayer?savedPlayer.name:'JCDentonMale',
    lineage:await defaults.lineage(dx,dx.exportsByPath.get('jcdentonmale')),
    collisionBits:player.collisionActor.flags,
    values:{...(savedPlayer?savedPlayer.values:playerDefaults),get Location(){return player.position;},get CollisionRadius(){return player.radius;},get CollisionHeight(){return player.height;},
      // The live pawn velocity, read by scripts such as DeusExDecoration.Bump
      // (the pushed decoration copies Other.Velocity).
      get Velocity(){return player.velocity;}}});
  const surfaceTextures = await walkingSurfaceTextures(assets, asset, map.model);
  player.textureForHit = hit => {
    // Level->Model as the query traced it (level-queries.mjs worldModel: the moving brush tracker's while it lives).
    const model = collision.queries.worldModel?.() ?? map.model;
    if (hit.actor !== collision.queries.levelInfo || hit.primitive !== model) return null;
    const node = model.nodes[hit.item];
    if (!node) throw new Error('Original world ray returned an invalid surface node');
    return (model.surfaceTexture ?? surfaceTextures)[node.surface] ?? null;
  };
  player.timeDilation = [...actors.values()].find(a => a.className === 'LevelInfo')?.values.TimeDilation ?? 1;
  const eventHasRecipients = event => {
    const wanted = String(event ?? '').toLowerCase();
    return [...actors.values()].some(actor => String(actor.values?.Tag ?? '').toLowerCase() === wanted);
  };
  const doors = new Doors(collision.movers, playerDefaults.MaxFrobDistance, collision,
    {eventHasRecipients});
  let timeSeconds=0;
  const playerScene=bindPlayerScene(player,collision,{model:map.model,actors:collidable,nonColliding,surfaceTextures,
    zoneActors:map.model.zones.map(z=>actors.get(z.actor)??null),
    levelValues:[...actors.values()].find(a=>a.className==='LevelInfo')?.values??zoneDefault,timeSeconds:()=>timeSeconds});
  playerScene.reset();
  if (savedPlayer) playerScene.bindPlayerIdentity(player.collisionActor, savedPlayer.values);
  Object.defineProperty(playerScene.level,'timeSeconds',{configurable:true,
    get:()=>timeSeconds,set:value=>{timeSeconds=value;}});
  bumpBaseEpoch();
  const savedLevelInfo = savedPlayer ? actors.get(map.level.actors[0]).values : null;
  playerScene.level.actors = mapActorArray(map, actors, playerScene.level.actors[0], savedPlayer ? [] : [player.collisionActor]);
  if (savedPlayer) {
    // Level.PawnList and each Pawn.NextPawn are the file's, not the order the host registered the pawns in (docs/pawn-list.md: preserve the
    // decoded list when restoring existing state); Login walks this chain to find the unoccupied player.
    // An actor based on the world was saved with Base = LevelInfo: the host member is the scene's LevelInfo, which replaced the decoded entry.
    for (const actor of actors.values()) if (actor.values?.Base !== undefined) actor.base = actors.get(actor.values.Base) ?? null;
    bumpBaseEpoch();
    playerScene.level.pawnList = actors.get(savedLevelInfo.PawnList) ?? null;
    for (const actor of actors.values()) if (actor.values && 'nextPawn' in actor.values || actor.isPawn) actor.nextPawn = actors.get(actor.values?.nextPawn) ?? null;
  }
  // ULevel ReachSpec table (+0x8c, 28-byte records): serialized start/end are
  // map-export refs; the nav natives walk them as live actors. readLevel's
  // decode order already matches the native layout (distance,start,end,
  // radius,height,flags,pruned).
  playerScene.level.reachSpecs = map.level.reachSpecs.map(s => ({
    distance: s.distance, start: actors.get(s.start) ?? null, end: actors.get(s.end) ?? null,
    radius: s.radius, height: s.height, reachFlags: s.flags, pruned: s.pruned,
  }));
  // Native GetPlayerPawn720 follows XLevel.Engine.Client.Viewports[0].Actor.
  // This local Play session owns one viewport, bound to its controlled JC.
  // createScriptDoors attaches its original Player script prefix and Console
  // before constructing the HUD (docs/script-viewport-console.md).
  // UClient::Decals is a config bool the original defaults to True; pawn
  // startup reaches AttachDecal through SpawnShadow and reads it here.
  playerScene.level.engine = {client:{decals:true,viewports:[{actor:savedPlayer?null:player.collisionActor}]}};
  collision.doorCallbacks.dataLinkTransmission=event=>onDataLinkTransmission?.(event);
  collision.doorCallbacks.conversationSpeech=event=>onConversationSpeech?.(event);
  collision.doorCallbacks.audioVoice=event=>onAudioVoice?.(event);
  doors.scriptRuntime=await createScriptDoors({assets,asset,movers:collision.movers,
    playerActor:player.collisionActor,playerScene,playerController:player,level:playerScene.level,callbacks:collision.doorCallbacks,rng:random,
    nativeHud:presentation,queries:collision.queries, zoneAt: p => zones[pointZone(map.model, p)] ?? zoneDefault, onLightingChanged,
    musicLibrary,travel,saveDirectory,modelIndex:map.level.model,restore:savedPlayer?{...restore,player:savedPlayer}:null});
  const levelTime=doors.scriptRuntime.runtime.namedReference(playerScene.level.actors[0],'TimeSeconds');
  // LoadMap 0x1038dc59: a saved level continues its clock, ULevel.TimeSeconds (a double) = LevelInfo.TimeSeconds (a float).
  if (savedPlayer) timeSeconds = levelTime.get();
  // Flicker's host key for every GlobalLighting caller (light-globals.mjs):
  // a map-placed actor's export index, else its Level.Actors slot (low byte).
  {
    const exportIndexByName=new Map();
    asset.pkg.exports.forEach((entry,i)=>{if(!exportIndexByName.has(entry.name))exportIndexByName.set(entry.name,i+1);});
    const runtime=doors.scriptRuntime.runtime;
    lightGlobals(runtime).flickerKeyOf=actor=>{
      const ref=exportIndexByName.get(actor.name);
      return (Number.isInteger(ref)?ref:runtime.levelFor(player.collisionActor).actors.indexOf(actor))&0xff;
    };
  }
  const levelDilation=doors.scriptRuntime.runtime.namedReference(playerScene.level.actors[0],'TimeDilation');
  // Conversation subtitles are DeusExPlayer.bSubtitles (globalconfig). The
  // original ConPlay.SetupEventSpeechPost shows the first-person panel when the
  // flag is on and hides it when off with speech audio; the class default is
  // off and the shipped install sets it on in User.ini. The caller passes the
  // installed preference; the viewer exposes a discoverable toggle. Re-applied
  // on reset so Player start keeps the chosen preference.
  // Player start logs in a new player, so resolve the field on the current one.
  const subtitlesRef={get:()=>doors.scriptRuntime.runtime.readNamed(player.collisionActor,'bSubtitles'),
    set:value=>doors.scriptRuntime.runtime.writeNamed(player.collisionActor,'bSubtitles',value)};
  let subtitlePreference=typeof subtitles==='boolean'?subtitles:null;
  const applySubtitles=()=>{ if(subtitlePreference!==null)subtitlesRef.set(subtitlePreference); };
  applySubtitles();
  const hud=presentation?await createPlayHud({runtime:doors.scriptRuntime.runtime,assets,
    player:player.collisionActor,shell:await doors.scriptRuntime.infoLinkShell(),host:doors.scriptRuntime.windowHost,
    mapNorth:[...actors.values()].find(actor=>actor.className==='DeusExLevelInfo')?.values.TrueNorth??0}):null;
  // Route any unhandled actor scene event (dispatched from player-move/actor-touch,
  // or re-entrant from a VM body) into the door runtime's general VM router, so a
  // player bump runs the real DeusExDecoration.Bump — and other attached actors run
  // their real event bytecode — instead of pausing at the scene adapter.
  // createScriptDoors binds playerScene.hooks (event, rider, map rotation)
  // before its original Login moves the player.
  const runtime = doors.scriptRuntime.runtime;
  player.scriptRuntime = runtime;
  const readPlayer = name => runtime.readNamed(player.collisionActor, name);
  const inputHost = doors.scriptRuntime.windowHost;
  // Whether the page is fullscreen: SetRes saves the Fullscreen* or the Windowed* viewport keys by it (docs/config-persistence.md).
  if (typeof fullscreen === 'boolean') inputHost.display.fullscreen = fullscreen;
  // Rendering observes the original trace's cache; it cannot inject a target.
  const interaction = Object.freeze({
    get position() { return readPlayer('Location'); },
    get viewRotation() { return readPlayer('ViewRotation'); },
    get baseEyeHeight() { return readPlayer('BaseEyeHeight'); },
    get maxFrobDistance() { return readPlayer('MaxFrobDistance'); },
    get frobTime() { return readPlayer('FrobTime'); },
    get frobTarget() { return readPlayer('FrobTarget'); },
    get carriedDecoration() { return readPlayer('CarriedDecoration'); },
    get stateName() { return runtime.instance(player.collisionActor).state.stateNode?.record.name ?? ''; },
    get behindView() { return readPlayer('bBehindView'); },
    get npcHighlighting() { return readPlayer('bNPCHighlighting'); },
  });
  const inputEvent = (key, action, delta = 0) => doors.scriptRuntime.liveConPlay.withLifecycle(
    () => inputHost.inputEvent(key, action, {delta}));
  const namedInput = (name, action, delta = 0) => {
    const key = inputHost.inputKeyNames.findIndex(key => key?.toLowerCase() === `ik_${name}`.toLowerCase());
    if (key < 0) throw new Error(`Original input key is unavailable: ${name}`);
    return inputEvent(key, action, delta);
  };
  // The frob label reads the object's own original name: inventory items and
  // weapons carry ItemName ("Crowbar", "10mm Ammo"), decorations fall back to
  // their actor name. This label does not imply that every object
  // interaction path is supported.
  const itemLabel = actor => {
    try { const name = doors.scriptRuntime.runtime.readNamed(actor, 'ItemName');
      if (name && String(name).toLowerCase() !== 'none') return name; } catch { /* not an item */ }
    return actor.name;
  };
  const describeTarget = actor => !actor ? null : actor.collider ? doors.describe(actor)
    : actor.lineage?.includes('deusex.scriptedpawn')
      ? {actor,label:doors.scriptRuntime.runtime.readNamed(actor,'FamiliarName')}
      : { actor, label: itemLabel(actor) };
  notes.push('Training Play supports movement, translating doors, decoration physics, frob interactions, item pickup and weapon use. Mission progression remains incomplete.');
  if (collision.actors.length) notes.push(`${collision.actors.length} original actor collision cylinders are active. Mesh fog, volumetric lights and distance LOD remain incomplete.`);
  // Legacy research helper: choose item/None before original PutInHand and
  // UpdateInHand. Its toggle is host policy, not the original belt-key path;
  // user digits below call ActivateBelt without changing its argument.
  const putInHandToggle = item => {
    const runtime = doors.scriptRuntime.runtime, pawn = player.collisionActor;
    const hand = runtime.readNamed(pawn, 'inHand');
    const pending = runtime.readNamed(pawn, 'inHandPending');
    const already = hand === item || pending === item;
    runtime.processEvent(pawn, 'PutInHand', [already ? null : item]);
    runtime.processEvent(pawn, 'UpdateInHand', []);
    return runtime.readNamed(pawn, 'inHand');
  };
  // UGameEngine::Draw updates the audio subsystem after drawing the frame
  // (0x1038f638): Galaxy's Update follows each HUD frame for that view.
  // audioMs is host timing for main.mjs's frame phases (measurement only).
  let audioMs = 0;
  if (hud) {
    const draw = hud.commands.bind(hud);
    hud.commands = (width, height, view) => {
      const out = draw(width, height, view), start = performance.now();
      doors.scriptRuntime?.runtime?.audio?.update(view);
      audioMs += performance.now() - start;
      return out;
    };
  }
  // The boot is over: the registry's slot model starts from the map's
  // measured state, so a runtime spawn takes the slot AddObject would give it
  // (docs/object-index-captures.md "Runtime spawns"). A harness with the
  // original's own dump at its start replaces this seed (live-probe.mjs).
  {
    const seed = mapRegistrySeed(asset?.name);
    if (seed) doors.scriptRuntime.runtime.seedOriginalObjectIndex({count: seed.count, freeIndices: seed.freeIndices, exact: seed.exact,
      source: `${asset.name} open capture (${seed.holes} holes)`});
  }
  let zoneNames = null;
  // Map travel (docs/travel.md): a session created with `travel` runs ClientTravel as recovered and the tick's travel step browses to the
  // next level; one without keeps the named stop (ClientTravelBoundary). `travel.arrival` is the travel that brought the player here,
  // `travel.lastURL` the engine's LastURL (docs/travel.md "Unresolved" 7).
  playerScene.level.travelInfo = new Map(travel?.arrival?.travelInfo ?? []);
  const travelStep = travel ? createTravelStep({ runtime: doors.scriptRuntime.runtime, level: playerScene.level,
    viewport: () => playerScene.level.engine.client.viewports[0], exporter: doors.scriptRuntime.travelExporter,
    store: doors.scriptRuntime.saveStore, log: doors.scriptRuntime.logLine, levelSaver: doors.scriptRuntime.levelSaver,
    lastURL: new Furl(travel.lastURL ?? { map: asset.name, op: DEFAULT_PLAYER_OPTIONS.map(([name, value]) => `${name}=${value}`) }),
    levelUrlMap: () => travel.arrival?.map ?? asset.name }) : null;
  const game = {
    takeAudioMs() { const ms = audioMs; audioMs = 0; return ms; },
    player, doors, collision, notes, start, interaction, random, hud,
    /** One engine frame's ticks: the windows, then the level. `windowSeconds`, an array (a live replay's measured input), lists the
     * original's RootTick deltas since the previous level tick, which then replace this frame's own time for the windows; older callers'
     * second argument (an input object) is ignored. */
    tick(seconds, windowSeconds = null) {
      // Actor.Tick owns ReadInput, PlayerInput/PlayerTick, ProcessState, timers,
      // Pawn physics and UpdateEyeHeight. No host player simulation follows it.
      player.timeDilation = levelDilation.get();
      // The window system ticks on wall-clock time, not the level's, and before it: UExtensionEngine::Tick (Extension.dll 0x100266a0) calls
      // TickWindows (0x1003a4a0, at 0x100266ce), which overwrites its argument with GetWindowsTickOffset(1) = f32(appSeconds() - last) and ticks
      // every root with it (RootTick 0x1003be90), then runs UGameEngine::Tick (0x100266d9). So a held or slowed level (TimeDilation 0.001, a
      // menu's pause) does not slow the log's timeout, the mission text or a button's delay, the level's [0.005, 0.4] delta clamp does not
      // apply (docs/interface-frames.md "Window ticks are real time"), and a window the level creates first ticks in the next frame.
      // (validation: `windowHold`, set by viewProbe while a live replay's frozen phase ticks the windows with the original's measured frames
      // instead, live-acceptance.mjs --frozen-frames; the replay clears it when it arms)
      if (Array.isArray(windowSeconds)) for (const delta of windowSeconds) hud?.tick(delta);
      else if (!game.windowHold) hud?.tick(seconds);
      doors.tick(seconds);
    },
    /** UGameEngine::Tick's client travel (body 0x1038fe90): after the levels' Ticks (0x10390154..0x103901a3) it tests
     * Client->Viewports(0)->TravelURL (+0xa0, 0x1039088e) and, when it is not empty, browses to it (vtable +0xa8 at 0x10390c01: the
     * DeusEx and Extension Browse overrides, then LoadMap) before the client's render (UClient::Tick, vtable +0x64 at 0x1039117b). An OPEN
     * stores the URL (SetClientTravel, script-console-command.mjs), so the level the OPEN came from ticks once more and ends at this
     * step. Browse and LoadMap are not modelled (the next map, DXONLY's menu after a death, is Stage 6): the step is the boundary where
     * Play stops, thrown as ClientTravelBoundary. A live replay records the tick it happened after (live-probe.mjs levelEnd).
     * A session created with `travel` browses instead (travel.mjs) and returns the request for the next level.
     * Callers run it after each tick and before the view, as the original's order is. */
    clientTravel() {
      const viewport = playerScene.level.engine?.client?.viewports?.[0];
      const url = viewport?.travelURL;
      if (!url) return null;
      // A live replay (validation: the original's trace played back, live-probe.mjs) compares Play with the original up to the level's end and
      // stops there, whatever the session could do next: it records the tick and keeps the named stop.
      const replay = game.liveReplay;
      if (replay && !replay.levelEnd) replay.levelEnd = { tick: replay.index, url, travelType: viewport.travelType, items: viewport.bTravelItems };
      // A session that travels: the travel step (travel.mjs) returns the next level's request, or throws a TravelStop that names the
      // original body it does not implement.
      if (travelStep && !replay) return travelStep.run();
      throw new ClientTravelBoundary(url);
    },
    /** Render.dll's auto-pan inputs (docs/texture-animation.md): the
     * LevelInfo's TimeSeconds and a zone actor's live TexUPanSpeed and
     * TexVPanSpeed, by name (zone actors are pre-placed). */
    surfacePan() {
      const level = runtime.levelFor(player.collisionActor);
      // The first Level.Actors entry of each name, rebuilt when the array's
      // membership changes (actorsEpoch).
      if (zoneNames?.actors !== level.actors || zoneNames.epoch !== actorsEpoch()) {
        const byName = new Map();
        for (const actor of level.actors) if (actor && !byName.has(actor.name)) byName.set(actor.name, actor);
        zoneNames = { actors: level.actors, epoch: actorsEpoch(), byName };
      }
      const { byName } = zoneNames;
      return { timeSeconds: levelTime.get(), zoneSpeeds: name => {
        const actor = byName.get(name);
        return actor ? [runtime.readNamed(actor, 'TexUPanSpeed'), runtime.readNamed(actor, 'TexVPanSpeed')] : null;
      } };
    },
    // Render.dll SetupDynamics' per-frame scan of the level actor array
    // (docs/dynamic-lighting.md): live light fields of every moving-light
    // candidate, e.g. AugLight's Beams, for the world's lightmap pass and
    // the mesh lighting's leaf lists (mesh-lighting-view.mjs beginFrame).
    movingLights() {
      const lights = [], actors = runtime.levelFor(player.collisionActor).actors;
      const isPawn = actor => { for (let c = runtime.instance(actor).cls; c; c = c.base) if (c.record?.key === 'engine.pawn') return true; return false; };
      // The render scan (script-vm-render.mjs) leaves only the actors that
      // pass the gate or that it hands back; each takes the same reads.
      const entries = runtime.scriptVm?.render?.scan(actors, { kinds: RENDER_LIGHT }) ?? null;
      const count = entries ? entries.length : actors.length;
      for (let i = 0; i < count; i++) {
        const actor = entries ? actors[entries[i] >>> RENDER_SHIFT] : actors[i];
        if (!actor) continue;
        const read = name => runtime.readNamed(actor, name), LightType = read('LightType');
        if (!LightType || read('bDeleteMe')) continue;
        const values = { LightType, bStatic: read('bStatic'), bNoDelete: read('bNoDelete'), bDynamicLight: read('bDynamicLight'),
          LightBrightness: read('LightBrightness'), LightRadius: read('LightRadius') };
        if (!isMovingLightCandidate(values)) continue;
        Object.assign(values, { LightEffect: read('LightEffect'), LightHue: read('LightHue'), LightSaturation: read('LightSaturation'),
          bSpecialLit: read('bSpecialLit'),
          // SetupDynamics' ViewPlanes test takes the larger of WorldLightRadius and 25 * (VolumeRadius + 1).
          VolumeRadius: read('VolumeRadius') });
        // GlobalLighting's type functions read LightPeriod and LightPhase
        // (Pulse, Blink, SubtlePulse).
        if ([2, 3, 7].includes(LightType & 255)) Object.assign(values, { LightPeriod: read('LightPeriod'), LightPhase: read('LightPhase') });
        // Only the spot effects read the cone and direction (a swivelling
        // SecurityCamera's normal light does not change with its Rotation);
        // the spot body takes a Pawn's ViewRotation (0x10b04f89-0x10b04fa9).
        if (values.LightEffect === 8 || values.LightEffect === 12)
          Object.assign(values, { LightCone: read('LightCone'),
            Rotation: [...read(isPawn(actor) ? 'ViewRotation' : 'Rotation')] });
        // Flicker indexes the noise by the low byte of the actor's address
        // (0x10b05af0); the host's stand-in (light-globals.mjs flickerKeyOf).
        lights.push({ actor, name: actor.name, location: [...read('Location')], values,
          flickerKey: (values.LightType & 255) === 4 ? lightGlobals(runtime).flickerKeyOf(actor) : 0,
          levelBrightness: runtime.readNamed(read('Level'), 'Brightness') });
      }
      return lights;
    },
    view() {
      // ProcessEvent copies its typed parameter block back to this array;
      // script callFunction's lvalue references are a different interface.
      // UGameEngine::Draw (Engine 0x1038f155-0x1038f1ac) starts the event
      // from Viewport->Actor's Location (+0x114) and Rotation (+0x120), not
      // its ViewRotation: a branch that leaves CameraRotation alone (the
      // Dying state's death camera) views along the body's Rotation.
      const params = [player.collisionActor, readPlayer('Location'), readPlayer('Rotation')];
      runtime.processEvent(player.collisionActor, 'PlayerCalcView', params);
      return {actor: params[0], location: params[1], rotation: params[2], fov: readPlayer('FOVAngle')};
    },
    reset() {
      // Player start cold-reloads the map's exports and runs their begin-play pass again: for a level restored from its saved file that would
      // run begin play over the saved state (docs/travel.md "Play, step 3": a named stop; the original has no such step, a saved level is only
      // ever restored by travel or by a loaded game).
      if (savedPlayer) throw new Error('Player start does not reload a level restored from a saved file: its begin-play pass would run over the saved state (travel step 3 stop)');
      // LoadMap's first step, in the old world: the viewport's player is
      // dissociated and destroyed before anything reloads.
      doors.scriptRuntime?.retirePlayer();
      // Reseed before doors.reset() replays NPC startup: SpawnShadow/AttachDecal
      // and startup natives draw from the shared stream, so the seed must be
      // restored first for reset runs to replay one identical stream.
      random.seed(randomSeed);
      collision.queries.removeActor(player.collisionActor);player.actorRegistered=false;
      collision.registerActors(collidable);player.reset();timeSeconds=0;playerScene.reset();
      // doors.reset() re-adds map pawns to the pawn list that playerScene.reset
      // just rebuilt from the collidable set, so it must run after it.
      doors.reset();
      levelTime.set(0);
      // The reload's Login spawned a fresh player (its own vitals and HUD).
      applySubtitles();
      hud?.bindPlayer(player.collisionActor);
    },
    get subtitles(){ return Boolean(subtitlesRef.get()); },
    set subtitles(value){ subtitlePreference=Boolean(value); applySubtitles(); },
    set viewportFullscreen(value){ inputHost.display.fullscreen = Boolean(value); },
    target() { return isHighlighted(interaction,interaction.frobTarget) ? describeTarget(interaction.frobTarget) : null; },
    // XInputExt::Process 0x1002d0b0 offers every key to the player's root window
    // (XRootWindow::Process) before any binding; true means the root consumed it.
    windowKey(code, pressed) {
      if (!hud) return false;
      const key = inputKeyForCode(hud.host.inputKeyNames, code);
      if (key < 0) return false;
      return Boolean(hud.key(key, pressed ? 1 : 3));
    },
    // Platform key/axis samples enter the installed binding through InputEvent.
    inputKey(code, pressed) {
      const key = inputKeyForCode(inputHost.inputKeyNames, code);
      if (key < 0) return {handled: false};
      return inputEvent(key, pressed ? 1 : 3);
    },
    // A WM_CHAR/WM_SYSCHAR character unit (the browser's TranslateMessage
    // stand-in, src/viewer/typed-characters.mjs) after its key's press.
    inputChar(char) {
      return doors.scriptRuntime.liveConPlay.withLifecycle(() => inputHost.typedKey(char));
    },
    inputAxis(name, delta) { return namedInput(name, 4, delta); },
    mouseMotion(dx, dy) { return inputHost.mouseMotion(dx, dy); },
    inputButton(name, pressed) { return namedInput(name, pressed ? 1 : 3); },
    // One WM_MOUSEWHEEL (WinDrv ViewportWndProc 0x1110b29e, docs/input-bindings.md): IK_MouseW's axis with the raw delta, then
    // the press and release of IK_MouseWheelUp/Down; `delta` is the message's HIWORD(wParam), +-120 per notch.
    inputWheel(delta) { for (const event of wheelMessage(delta)) namedInput(event.name, event.action, event.delta); },
    resetInput(options) { inputHost.resetInput(options); },
    // The browser supplies drawing-buffer coordinates (or scaled relative
    // motion under pointer lock). The root accepts them only while a modal
    // owns the original mouse-event grab counter.
    windowPointer(sample) { return Boolean(hud?.pointer(sample)); },
    windowMouseGrabbed() { return Boolean(hud?.mouseGrabbed?.()); },
    /** The page's 16-bit decode of a speech sound (`sound` its key) for
     * Galaxy's speech voices and lip sync (script-audio-live.mjs
     * attachDecoded; docs/galaxy-audio.md "Speech through Galaxy's voices"). */
    attachSpeech(sound, pcm) { return doors.scriptRuntime?.runtime?.audio?.attachDecoded(sound, pcm) ?? false; },
    /** The pawn fields Galaxy's lip-sync update reads and writes
     * (galaxy-lipsync-channels.mjs): IsA Pawn, bIsSpeaking, nextPhoneme. A
     * destroyed actor counts as none (UGalaxyAudioSubsystem::NoteDestroy
     * clears the channel's Actor). */
    lipSyncServices() {
      const runtime = () => doors.scriptRuntime.runtime;
      const pawn = actor => {
        let instance;
        try { instance = runtime().instance(actor); if (runtime().readNamed(actor, 'bDeleteMe')) return false; } catch { return false; }
        for (let cls = instance.cls; cls; cls = cls.base) if (cls.record.key === 'engine.pawn') return true;
        return false;
      };
      return {
        isPawn: pawn,
        speaking: actor => Boolean(runtime().readNamed(actor, 'bIsSpeaking')),
        setPhoneme: (actor, letter) => runtime().writeNamed(actor, 'nextPhoneme', letter),
      };
    },
    /** Where the 3D view draws in a width x height drawing buffer: the root
     * window's render viewport (letterboxed conversations clip it). */
    renderViewport(width, height) { return hud?.renderViewport(width, height) ?? { render: true, x: 0, y: 0, width, height }; },
    use() {
      const actor = readPlayer('FrobTarget');
      game.inputButton('RightMouse', true);
      game.inputButton('RightMouse', false);
      const taken = actor && actor.lineage?.includes('engine.inventory') &&
        (runtime.readNamed(actor, 'Owner') === player.collisionActor ||
         runtime.readNamed(actor, 'bHidden') || runtime.readNamed(actor, 'bDeleteMe'));
      return {ok: true, message: taken ? `Picked up ${itemLabel(actor)}` : ''};
    },
    pressFire() { game.inputButton('LeftMouse', true); return {ok: true, message: ''}; },
    releaseFire() { return game.inputButton('LeftMouse', false); },
    // Legacy research helper for headless checks; Play uses ActivateBelt(0).
    selectNanoKeyRing() {
      const runtime = doors.scriptRuntime.runtime, pawn = player.collisionActor;
      const ring = runtime.readNamed(pawn, 'KeyRing');
      if (!ring) return false;
      return putInHandToggle(ring) === ring;
    },
    // General in-hand selection through the original bytecode. A weapon draws
    // its first-person (player-view) mesh the moment it enters the hand — the
    // bring-up runs PlayAnim('Select') on it — so its Mesh resource is decoded
    // before the synchronous PutInHand/UpdateInHand pair runs (the pickup path
    // itself only prepares the class chain). docs/script-weapon-equip.md.
    async selectItem(item) {
      if (!item) return { selected: false, name: null, label: null };
      const runtime = doors.scriptRuntime.runtime;
      const meshRef = runtime.readNamed(item, 'Mesh');
      if (meshRef && ['LodMesh', 'Mesh'].includes(meshRef.kind)) await runtime.prepareMesh(item);
      const now = putInHandToggle(item);
      const selected = now === item;
      return { selected, name: now?.name ?? null,
        label: selected ? String(runtime.readNamed(item, 'ItemName') ?? item.name) : null };
    },
    // User.ini binds each digit to original DeusExPlayer.ActivateBelt N.
    async activateBelt(position){
      if(!hud)throw new Error('ActivateBelt requires the original HUD object belt');
      const runtime=doors.scriptRuntime.runtime,pawn=player.collisionActor;
      const belt=hud.read(hud.hud,'belt'),item=hud.invoke(belt,'GetObjectFromBelt',[position]);
      if(item){const mesh=runtime.readNamed(item,'Mesh');if(mesh&&['LodMesh','Mesh'].includes(mesh.kind))await runtime.prepareMesh(item);}
      game.inputKey(`Digit${position}`, true);
      game.inputKey(`Digit${position}`, false);
      return {ok:Boolean(item),name:item?.name??null,label:item?runtime.readNamed(item,'ItemName'):null};
    },
    async selectWeaponGroup(group) {
      const runtime = doors.scriptRuntime.runtime, pawn = player.collisionActor;
      const head = runtime.readNamed(pawn, 'Inventory');
      if (!head) return { ok: false, name: null };
      const weapon = runtime.dispatchSpawnedEvent(head, 'WeaponChange', [group]);
      if (!weapon) return { ok: false, name: null, label: null };
      const result = await game.selectItem(weapon);
      return { ok: result.selected, name: result.name, label: result.label };
    },
    status() { return { player: player.status(), doors: doors.status(), hud:hud?.snapshot()??null, hulls: collision.bsp.hulls.length,
      deferredEffects:[...player.unimplementedPhysicsEffects],
      random:{initialSeed:randomSeed,state:random.state},
      blockingActors: collision.actors.filter(actor => actor.blocking).length, collidableActors: collidable.length }; },
  };
  return game;
}

/** GameInfo.Login's pick among the saved pawns (Engine/GameInfo.uc:801): the first PlayerPawn of Level.PawnList whose Player is None, with a
 * PlayerReplicationInfo and bIsPlayer, whose PRI.PlayerName is not the PRI class default (standalone takes it without the name and password
 * match). Walks LevelInfo.PawnList / Pawn.NextPawn as the file saved them. Returns the decoded actor entry, or throws: a saved level with no such
 * pawn would make Login spawn a new one at the player start, which a restore does not model yet. */
async function findSavedPlayer(map, actors, defaults, asset) {
  const levelInfo = actors.get(map.level.actors[0]);
  const engine = await defaults.assets.get('Engine');
  const priDefault = await defaults.get(engine, engine.exportsByPath.get('playerreplicationinfo'));
  const seen = new Set();
  for (let ref = levelInfo?.values.PawnList; ref && !seen.has(ref); ) {
    seen.add(ref);
    const pawn = actors.get(ref);
    if (!pawn) break;
    const lineage = await defaults.lineage(asset, asset.pkg.exports[pawn.index - 1].classIndex);
    const pri = pawn.values.PlayerReplicationInfo ? actors.get(pawn.values.PlayerReplicationInfo) : null;
    if (lineage.includes('engine.playerpawn') && !pawn.values.Player && pri && pawn.values.bIsPlayer !== false
        && (pri.values.PlayerName ?? priDefault.PlayerName) !== priDefault.PlayerName) return pawn;
    ref = pawn.values.nextPawn;
  }
  throw new Error('A saved level without an unoccupied saved player is not supported: GameInfo.Login would spawn a new pawn');
}
