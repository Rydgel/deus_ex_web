import { Matrix3, Vector3 } from 'three';
import { ClassDefaults } from '../unreal/classes.mjs';
import { readModel } from '../unreal/model.mjs';
import { pointZone } from '../unreal/lighting.mjs';
import { toView, fromView } from '../unreal/geometry.mjs';
import { CollisionWorld, BspCollider } from '../runtime/collision.mjs';
import { Player } from '../runtime/player.mjs';
import { levelTickTime } from '../runtime/level-tick.mjs';
import { Doors } from '../runtime/doors.mjs';
import { createScriptDoors } from '../runtime/script-doors.mjs';
import { readFunction } from '../unreal/script.mjs';
import { compileFunction } from '../runtime/script-vm.mjs';
import { brushMatrix } from './transforms.mjs';
import { walkingSurfaceTextures } from '../runtime/walking-surface.mjs';
import { tickWalkingInteraction, traceActors, isHighlighted } from '../runtime/interaction.mjs';
import { bindPlayerScene } from '../runtime/player-scene.mjs';
import { createNativeRng } from '../runtime/rng.mjs';
import { mapActorArray, mapExportAdmitted } from '../runtime/script-map-properties.mjs';
import { createPlayHud } from '../runtime/script-play-hud.mjs';

/** Bind decoded resources to the renderer-independent simulation. */
export async function createGame(map, asset, assets, { randomSeed = Math.floor(Date.now()/1000) >>> 0,
  onLightingChanged = null, onDataLinkTransmission = null, onConversationSpeech = null, presentation = false,
  subtitles = null } = {}) {
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
  const collidable = [];
  for (const actor of actors.values()) {
    const v = actor.values;
    actor.owner = actors.get(v.Owner) ?? null;
    if (!v.bCollideActors || !v.Location) continue;
    actor.lineage = await defaults.lineage(asset, asset.pkg.exports[actor.index - 1].classIndex);
    actor.collisionBits = 1 | (v.bBlockActors ? 4 : 0) | (v.bBlockPlayers ? 8 : 0) | (v.bProjTarget ? 16 : 0);
    actor.flags = actor.collisionBits | (v.bCollideWorld ? 2 : 0);
    actor.actorFlags = (v.bStatic ? 1 : 0) | (v.bDeleteMe ? 0x80 : 0) |
      (v.bCollideWhenPlacing ? 0x20000 : 0) | (v.bMovable ? 0x80000 : 0);
    actor.movingBrush = Boolean(v.Brush) && actor.lineage.includes('engine.brush');
    actor.projectile = actor.lineage.includes('engine.projectile');
    actor.base = actors.get(v.Base) ?? null;
    actor.blocking = Boolean(v.bBlockPlayers);
    collidable.push(actor);
    if (v.bIsMover && v.Brush > 0) {
      const matrix = brushMatrix(v), normal = new Matrix3().getNormalMatrix(matrix);
      const transform = p => fromView(new Vector3(...toView(p)).applyMatrix4(matrix).toArray());
      const transformNormal = n => fromView(new Vector3(...toView(n)).applyMatrix3(normal).toArray());
      actor.model = readModel(asset.pkg, asset.bytes, v.Brush);
      const collider = new BspCollider(actor.model, transform, transformNormal, v);
      if (!collider.hulls.length) throw new Error(`No collision hulls for ${actor.name}`);
      actor.collider = collider;
      actor.position = v.Location.map(Math.fround);
      actor.collisionValues = { ...v, get Location() { return actor.position; } };
      collision.movers.push(actor);
    } else {
      Object.assign(actor, { position: [...v.Location], radius: v.CollisionRadius ?? 0, height: v.CollisionHeight ?? 0 });
      collision.actors.push(actor);
    }
  }
  collision.registerActors(collidable);
  const start = [...actors.values()].find(a => a.className === 'PlayerStart' && a.values.bSinglePlayer && a.values.bEnabled !== false && a.values.Location);
  if (!start) throw new Error('No enabled single-player start in this map');
  const checkBob = compileFunction(readFunction(engine, engine.exportsByPath.get('playerpawn.checkbob')));
  const startYaw = (start.values.Rotation?.[1] ?? 0) * Math.PI / 32768;
  const player = new Player(collision, playerDefaults, start.values.Location, p => zones[pointZone(map.model, p)] ?? zoneDefault, checkBob, startYaw);
  // Original Core startup passes time(NULL) to srand. This scene's shared
  // stream is also injectable for native comparisons and restored by reset.
  const random = createNativeRng(randomSeed);
  player.nativeRandom = random.frand;
  Object.assign(player.collisionActor,{id:'$player',name:'JCDentonMale',
    lineage:await defaults.lineage(dx,dx.exportsByPath.get('jcdentonmale')),
    collisionBits:player.collisionActor.flags,
    values:{...playerDefaults,get Location(){return player.position;},get CollisionRadius(){return player.radius;},get CollisionHeight(){return player.height;},
      // The live pawn velocity, read by scripts such as DeusExDecoration.Bump
      // (the pushed decoration copies Other.Velocity).
      get Velocity(){return player.velocity;}}});
  const surfaceTextures = await walkingSurfaceTextures(assets, asset, map.model);
  player.textureForHit = hit => {
    if (hit.actor !== collision.queries.levelInfo || hit.primitive !== map.model) return null;
    const node = map.model.nodes[hit.item];
    if (!node) throw new Error('Original world ray returned an invalid surface node');
    return surfaceTextures[node.surface] ?? null;
  };
  player.timeDilation = [...actors.values()].find(a => a.className === 'LevelInfo')?.values.TimeDilation ?? 1;
  const eventHasRecipients = event => {
    const wanted = String(event ?? '').toLowerCase();
    return [...actors.values()].some(actor => String(actor.values?.Tag ?? '').toLowerCase() === wanted);
  };
  const doors = new Doors(collision.movers, playerDefaults.MaxFrobDistance, collision,
    {eventHasRecipients});
  let timeSeconds=0;
  const playerScene=bindPlayerScene(player,collision,{model:map.model,actors:collidable,surfaceTextures,
    zoneActors:map.model.zones.map(z=>actors.get(z.actor)??null),
    levelValues:[...actors.values()].find(a=>a.className==='LevelInfo')?.values??zoneDefault,timeSeconds:()=>timeSeconds});
  playerScene.reset();
  playerScene.level.actors = mapActorArray(map, actors, playerScene.level.actors[0], [player.collisionActor]);
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
  // UClient::Decals is a config bool the original defaults to True; pawn
  // startup reaches AttachDecal through SpawnShadow and reads it here.
  playerScene.level.engine = {client:{decals:true,viewports:[{actor:player.collisionActor}]}};
  collision.doorCallbacks.dataLinkTransmission=event=>onDataLinkTransmission?.(event);
  collision.doorCallbacks.conversationSpeech=event=>onConversationSpeech?.(event);
  doors.scriptRuntime=await createScriptDoors({assets,asset,movers:collision.movers,
    playerActor:player.collisionActor,level:playerScene.level,callbacks:collision.doorCallbacks,rng:random,
    nativeHud:presentation,queries:collision.queries, zoneAt: p => zones[pointZone(map.model, p)] ?? zoneDefault, onLightingChanged});
  const levelTime=doors.scriptRuntime.runtime.namedReference(playerScene.level.actors[0],'TimeSeconds');
  const levelDilation=doors.scriptRuntime.runtime.namedReference(playerScene.level.actors[0],'TimeDilation');
  // Player start is the viewer's scene reset. Restore the actual startup
  // vitals, so damage/energy script writes cannot survive that reset.
  const playerVitals=['Health','HealthHead','HealthTorso','HealthArmLeft','HealthArmRight',
    'HealthLegLeft','HealthLegRight','Energy','EnergyMax'].map(name=>{
    const ref=doors.scriptRuntime.runtime.namedReference(player.collisionActor,name);
    return {ref,initial:ref.get()};
  });
  // Conversation subtitles are DeusExPlayer.bSubtitles (globalconfig). The
  // original ConPlay.SetupEventSpeechPost shows the first-person panel when the
  // flag is on and hides it when off with speech audio; the class default is
  // off and the shipped install sets it on in User.ini. The caller passes the
  // installed preference; the viewer exposes a discoverable toggle. Re-applied
  // on reset so Player start keeps the chosen preference.
  const subtitlesRef=doors.scriptRuntime.runtime.namedReference(player.collisionActor,'bSubtitles');
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
  playerScene.hooks.dispatchEvent=(target,event,args)=>doors.scriptRuntime.dispatchEvent(target,event,args);
  playerScene.hooks.moveRider=(actor,delta,rotation)=>doors.scriptRuntime.runtime.moveSpawnedActor(actor,delta,rotation);
  const interaction = { get position() { return player.position; }, get viewRotation() { return player.viewRotation; },
    get baseEyeHeight() { return player.baseEyeHeight; }, maxFrobDistance: playerDefaults.MaxFrobDistance,
    frobTime: 0, frobTarget: null, carriedDecoration: null, stateName: 'PlayerWalking',
    behindView: Boolean(playerDefaults.bBehindView), npcHighlighting: Boolean(playerDefaults.bNPCHighlighting) };
  const trace = (end,start,extent) => traceActors(collision.queries,player,end,start,extent);
  // The frob label reads the object's own original name: inventory items and
  // weapons carry ItemName ("Crowbar", "10mm Ammo"), decorations fall back to
  // their actor name. This is the name only, not a claim that every frob is
  // implemented — item pickup and weapon use remain unbuilt (see notes below).
  const itemLabel = actor => {
    try { const name = doors.scriptRuntime.runtime.namedReference(actor, 'ItemName').get();
      if (name && String(name).toLowerCase() !== 'none') return name; } catch { /* not an item */ }
    return actor.name;
  };
  const describeTarget = actor => !actor ? null : actor.collider ? doors.describe(actor)
    : actor.lineage?.includes('deusex.scriptedpawn')
      ? {actor,label:doors.scriptRuntime.runtime.namedReference(actor,'FamiliarName').get()}
      : { actor, label: itemLabel(actor) };
  notes.push('First playable subset: movement, translating TriggerToggle doors, pushable-decoration bumps, and frob interactions (a LightSwitch toggles its TriggerLights). Item pickup, weapon use, mission-trigger scripts and locked keypad doors remain incomplete.');
  if (collision.actors.length) notes.push(`${collision.actors.length} original actor collision cylinders are active. Their meshes now render texture-only in Play; item pickup and weapon use are not yet supported.`);
  // Original in-hand toggle: PutInHand sets inHandPending, UpdateInHand runs the
  // transition (a weapon draws through SwitchWeapon -> ChangedWeapon -> BringUp).
  // Passing the item selects it; passing it again while it is already
  // in/pending hand puts it away, exactly as a belt slot re-press does.
  const putInHandToggle = item => {
    const runtime = doors.scriptRuntime.runtime, pawn = player.collisionActor;
    const hand = runtime.namedReference(pawn, 'inHand').get();
    const pending = runtime.namedReference(pawn, 'inHandPending').get();
    const already = hand === item || pending === item;
    runtime.processEvent(pawn, 'PutInHand', [already ? null : item]);
    runtime.processEvent(pawn, 'UpdateInHand', []);
    return runtime.namedReference(pawn, 'inHand').get();
  };
  const game = {
    player, doors, collision, notes, start, interaction, random, hud,
    tick(seconds, input) {
      // One browser frame is one level tick, including on slow frames. The
      // original physics routines own their remaining-time subdivisions.
      player.timeDilation=levelDilation.get();
      const frame=levelTickTime(timeSeconds,seconds,player.timeDilation),dt=frame.delta;
      timeSeconds=frame.timeSeconds;
      levelTime.set(frame.infoTimeSeconds);
      // The scripted actors tick first; the player's own route runs at the
      // end of that level tick so the actors it owns (a drawn weapon) follow it
      // through ULevel::Tick's deferred list (docs/script-weapon-fire.md).
      doors.tick(dt, { tickPlayer: () => {
        tickWalkingInteraction(interaction,dt,trace);
        // HighlightCenterObject's result is DeusExPlayer.FrobTarget/FrobTime;
        // original bodies (ParseLeftClick, the HUD frob display) read them.
        const runtime = doors.scriptRuntime?.runtime;
        if (runtime) {
          runtime.namedReference(player.collisionActor, 'FrobTarget').set(interaction.frobTarget ?? null);
          runtime.namedReference(player.collisionActor, 'FrobTime').set(Math.fround(interaction.frobTime));
          // PlayerWalking.PlayerTick -> MultiplayerTick (also single player),
          // before Super.PlayerTick/movement: original per-frame hand transition.
          runtime.processEvent(player.collisionActor,'UpdateInHand',[]);
        }
        player.tick(dt, input);
        // Actor.Tick's pawn tail: FarMoveActor(Weapon, Location, 0, 0).
        const weapon = runtime?.namedReference(player.collisionActor, 'Weapon').get();
        if (weapon) runtime.relocateHeldItem(weapon, player.position);
      } });
      hud?.tick(dt);
    },
    reset() {
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
      for(const {ref,initial} of playerVitals)ref.set(initial);
      applySubtitles();
      hud?.reset();
      interaction.frobTime=0;interaction.frobTarget=null;
    },
    get subtitles(){ return Boolean(subtitlesRef.get()); },
    set subtitles(value){ subtitlePreference=Boolean(value); applySubtitles(); },
    target() { return isHighlighted(interaction,interaction.frobTarget) ? describeTarget(interaction.frobTarget) : null; },
    use() {
      const actor = interaction.frobTarget;
      if (!actor) return { ok: false, message: 'Nothing selected' };
      const runtime = doors.scriptRuntime.runtime;
      // HighlightCenterObject's cache is the host stand-in for DeusExPlayer.FrobTarget.
      // ParseRightClick reads that property. A NanoKey is picked up there, not via Frob.
      if (actor.lineage?.includes('deusex.nanokey')) {
        runtime.namedReference(player.collisionActor, 'FrobTarget').set(actor);
        runtime.processEvent(player.collisionActor, 'ParseRightClick', []);
        const picked = runtime.namedReference(player.collisionActor, 'KeyList').get();
        interaction.frobTarget = runtime.namedReference(player.collisionActor, 'FrobTarget').get();
        return { ok: Boolean(picked), message: picked ? '' : 'Nothing selected' };
      }
      if (actor.lineage?.includes('engine.mover')) {
        const target = describeTarget(actor);
        return target?.mover ? doors.use(target, player.position, null) : { ok: false, message: target?.label ?? 'Nothing selected' };
      }
      // A world inventory pickup (weapon, ammo, tool, food) runs the original
      // right-click frob path: DeusExPlayer.ParseRightClick -> HandleItemPickup
      // (which assigns the inventory-grid slot) -> DoFrob -> the item's real
      // Pickup-state Frob give. This is the same public path the nanokey ring
      // uses above; startup put the item in its auto Pickup state.
      if (actor.lineage?.includes('engine.inventory')) {
        const pawn = player.collisionActor;
        runtime.namedReference(pawn, 'FrobTarget').set(actor);
        runtime.processEvent(pawn, 'ParseRightClick', []);
        interaction.frobTarget = runtime.namedReference(pawn, 'FrobTarget').get();
        const taken = runtime.namedReference(actor, 'Owner').get() === pawn
          || runtime.namedReference(actor, 'bHidden').get()
          || runtime.namedReference(actor, 'bDeleteMe').get();
        return { ok: Boolean(taken), message: taken ? `Picked up ${itemLabel(actor)}` : '' };
      }
      // Non-mover frob: run the actor's real Frob bytecode through the general VM
      // router (docs/scene-events.md). A handled Frob ran the real body; an
      // unhandled one has no Frob override (the empty-event no-op).
      try {
        const outcome = doors.scriptRuntime.dispatchEvent(actor, 'Frob', [player.collisionActor, null]);
        return { ok: outcome.handled, message: '' };
      } catch (error) {
        // A conversation pawn's Frob still pauses honestly on an unbuilt boundary
        // (that path is covered by the instructor checks). A decoration or item
        // whose real Frob reaches an unbuilt subsystem — e.g. a DataCube's text
        // parser, or item pickup's actor iterator — surfaces the boundary as a
        // message instead of halting the scene, so exploring visible props is safe.
        if (actor.lineage?.includes('deusex.scriptedpawn')) throw error;
        return { ok: false, message: `${describeTarget(actor)?.label ?? actor.name} — interaction not yet supported` };
      }
    },
    // Enter is ParseLeftClick. With the nanokey ring in hand this is DoFrob(Self, inHand).
    useHeld() {
      const runtime = doors.scriptRuntime.runtime, pawn = player.collisionActor;
      const actor = interaction.frobTarget;
      const hand = runtime.namedReference(pawn, 'inHand').get();
      const key = hand ? runtime.instance(hand).cls.record.key : '';
      if (!actor?.lineage?.includes('engine.mover') || (key !== 'deusex.nanokeyring' && key !== 'deusex.lockpick'))
        return { ok: false, message: 'Nothing selected' };
      const target = describeTarget(actor);
      return target?.mover ? doors.use(target, player.position, hand) : { ok: false, message: target?.label ?? 'Nothing selected' };
    },
    // LeftMouse and Enter are bound to `ParseLeftClick|Fire` in the installed
    // User.ini, and its Fire alias is `Button bFire | Fire`: a press runs the
    // ParseLeftClick exec, raises the bFire button byte, then runs the Fire
    // exec (DeusExPlayer.Fire -> PlayerPawn.Fire -> Weapon.Fire). Release
    // clears bFire, which DeusExWeapon.Finish reads to swing again while held.
    // A key ring/lockpick used on a targeted door keeps the host door route
    // (the same DoFrob(Self, inHand) branch of ParseLeftClick, plus its door
    // display bookkeeping), then Fire runs as the binding does.
    pressFire() {
      const runtime = doors.scriptRuntime.runtime, pawn = player.collisionActor;
      const actor = interaction.frobTarget;
      const hand = runtime.namedReference(pawn, 'inHand').get();
      const key = hand ? runtime.instance(hand).cls.record.key : '';
      let result = { ok: false, message: '' };
      if (actor?.lineage?.includes('engine.mover') && (key === 'deusex.nanokeyring' || key === 'deusex.lockpick'))
        result = game.useHeld();
      else runtime.processEvent(pawn, 'ParseLeftClick', []);
      runtime.namedReference(pawn, 'bFire').set(1);
      runtime.processEvent(pawn, 'Fire', [0]);
      return result;
    },
    releaseFire() {
      doors.scriptRuntime.runtime.namedReference(player.collisionActor, 'bFire').set(0);
    },
    // Object-belt selection is still the HUD. This calls the original
    // PutInHand/UpdateInHand pair those belt slots use for the key ring.
    selectNanoKeyRing() {
      const runtime = doors.scriptRuntime.runtime, pawn = player.collisionActor;
      const ring = runtime.namedReference(pawn, 'KeyRing').get();
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
      const meshRef = runtime.namedReference(item, 'Mesh').get();
      if (meshRef && ['LodMesh', 'Mesh'].includes(meshRef.kind)) await runtime.prepareMesh(item);
      const now = putInHandToggle(item);
      const selected = now === item;
      return { selected, name: now?.name ?? null,
        label: selected ? String(runtime.namedReference(item, 'ItemName').get() ?? item.name) : null };
    },
    // User.ini binds each digit to original DeusExPlayer.ActivateBelt N.
    async activateBelt(position){
      if(!hud)throw new Error('ActivateBelt requires the original HUD object belt');
      const runtime=doors.scriptRuntime.runtime,pawn=player.collisionActor;
      const belt=hud.read(hud.hud,'belt'),item=hud.invoke(belt,'GetObjectFromBelt',[position]);
      if(item){const mesh=runtime.namedReference(item,'Mesh').get();if(mesh&&['LodMesh','Mesh'].includes(mesh.kind))await runtime.prepareMesh(item);}
      hud.scoped(()=>runtime.dispatchSpawnedEvent(pawn,'ActivateBelt',[position]));
      return {ok:Boolean(item),name:item?.name??null,label:item?runtime.namedReference(item,'ItemName').get():null};
    },
    async selectWeaponGroup(group) {
      const runtime = doors.scriptRuntime.runtime, pawn = player.collisionActor;
      const head = runtime.namedReference(pawn, 'Inventory').get();
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
