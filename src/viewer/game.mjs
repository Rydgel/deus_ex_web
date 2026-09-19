import { Matrix3, Vector3 } from 'three';
import { ClassDefaults } from '../unreal/classes.mjs';
import { readModel } from '../unreal/model.mjs';
import { pointZone } from '../unreal/lighting.mjs';
import { toView, fromView } from '../unreal/geometry.mjs';
import { CollisionWorld, BspCollider } from '../runtime/collision.mjs';
import { Player, FixedClock } from '../runtime/player.mjs';
import { Doors } from '../runtime/doors.mjs';
import { createScriptDoors } from '../runtime/script-doors.mjs';
import { readFunction } from '../unreal/script.mjs';
import { compileFunction } from '../runtime/script-vm.mjs';
import { brushMatrix } from './transforms.mjs';
import { walkingSurfaceTextures } from '../runtime/walking-surface.mjs';
import { tickWalkingInteraction, traceActors, isHighlighted } from '../runtime/interaction.mjs';
import { bindPlayerScene } from '../runtime/player-scene.mjs';
import { createNativeRng } from '../runtime/rng.mjs';
import { mapActorArray } from '../runtime/script-map-properties.mjs';
import { createPlayHud } from '../runtime/script-play-hud.mjs';

/** Bind decoded resources to the renderer-independent simulation. */
export async function createGame(map, asset, assets, { randomSeed = Math.floor(Date.now()/1000) >>> 0,
  onLightingChanged = null, onDataLinkTransmission = null, presentation = false } = {}) {
  if(onDataLinkTransmission!=null&&typeof onDataLinkTransmission!=='function')
    throw new TypeError('createGame onDataLinkTransmission must be a function');
  const defaults = new ClassDefaults(assets), collision = new CollisionWorld(map.model), notes = [];
  const engine = await assets.get('Engine'), dx = await assets.get('DeusEx');
  const playerDefaults = await defaults.get(dx, dx.exportsByPath.get('jcdentonmale'));
  const zoneDefault = await defaults.get(engine, engine.exportsByPath.get('zoneinfo'));
  const actors = new Map();
  for (const actor of map.actors) actors.set(actor.index, { ...actor, values: await defaults.forActor(asset, actor) });
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
    {eventHasRecipients}), clock = new FixedClock();
  let timeSeconds=0;
  const playerScene=bindPlayerScene(player,collision,{model:map.model,actors:collidable,surfaceTextures,
    zoneActors:map.model.zones.map(z=>actors.get(z.actor)??null),
    levelValues:[...actors.values()].find(a=>a.className==='LevelInfo')?.values??zoneDefault,timeSeconds:()=>timeSeconds});
  playerScene.reset();
  playerScene.level.actors = mapActorArray(map, actors, playerScene.level.actors[0], [player.collisionActor]);
  // Native GetPlayerPawn720 follows XLevel.Engine.Client.Viewports[0].Actor.
  // This local Play session owns one viewport, bound to its controlled JC.
  playerScene.level.engine = {client:{viewports:[{actor:player.collisionActor}]}};
  collision.doorCallbacks.dataLinkTransmission=event=>onDataLinkTransmission?.(event);
  doors.scriptRuntime=await createScriptDoors({assets,asset,movers:collision.movers,
    playerActor:player.collisionActor,level:playerScene.level,callbacks:collision.doorCallbacks,rng:random,
    queries:collision.queries, zoneAt: p => zones[pointZone(map.model, p)] ?? zoneDefault, onLightingChanged});
  // Player start is the viewer's scene reset. Restore the actual startup
  // vitals, so damage/energy script writes cannot survive that reset.
  const playerVitals=['Health','HealthHead','HealthTorso','HealthArmLeft','HealthArmRight',
    'HealthLegLeft','HealthLegRight','Energy','EnergyMax'].map(name=>{
    const ref=doors.scriptRuntime.runtime.namedReference(player.collisionActor,name);
    return {ref,initial:ref.get()};
  });
  const hud=presentation?await createPlayHud({runtime:doors.scriptRuntime.runtime,assets,
    player:player.collisionActor,shell:await doors.scriptRuntime.infoLinkShell(),
    mapNorth:[...actors.values()].find(actor=>actor.className==='DeusExLevelInfo')?.values.TrueNorth??0}):null;
  // Route any unhandled actor scene event (dispatched from player-move/actor-touch,
  // or re-entrant from a VM body) into the door runtime's general VM router, so a
  // player bump runs the real DeusExDecoration.Bump — and other attached actors run
  // their real event bytecode — instead of pausing at the scene adapter.
  playerScene.hooks.dispatchEvent=(target,event,args)=>doors.scriptRuntime.dispatchEvent(target,event,args);
  const interaction = { get position() { return player.position; }, get viewRotation() { return player.viewRotation; },
    get baseEyeHeight() { return player.baseEyeHeight; }, maxFrobDistance: playerDefaults.MaxFrobDistance,
    frobTime: 0, frobTarget: null, carriedDecoration: null, stateName: 'PlayerWalking',
    behindView: Boolean(playerDefaults.bBehindView), npcHighlighting: Boolean(playerDefaults.bNPCHighlighting) };
  const trace = (end,start,extent) => traceActors(collision.queries,player,end,start,extent);
  const describeTarget = actor => !actor ? null : actor.collider ? doors.describe(actor)
    : { actor, label: `${actor.name} · interaction not supported yet` };
  notes.push('First playable subset: movement, translating TriggerToggle doors, pushable-decoration bumps, and frob interactions (a LightSwitch toggles its TriggerLights). Mission-trigger scripts and actor/mesh visuals remain incomplete.');
  if (collision.actors.length) notes.push(`${collision.actors.length} original actor collision cylinders are active; actor mesh coverage remains incomplete.`);
  const game = {
    player, doors, collision, clock, notes, start, interaction, random, hud,
    tick(seconds, input) { clock.advance(seconds, dt => {
      timeSeconds=Math.fround(timeSeconds+Math.fround(dt));
      doors.tick(dt); tickWalkingInteraction(interaction,dt,trace); player.tick(dt, input);hud?.tick(dt);
    }); },
    reset() {
      collision.queries.removeActor(player.collisionActor);player.actorRegistered=false;
      doors.reset();collision.registerActors(collidable);clock.reset();player.reset();timeSeconds=0;playerScene.reset();
      random.seed(randomSeed);
      for(const {ref,initial} of playerVitals)ref.set(initial);
      hud?.reset();
      interaction.frobTime=0;interaction.frobTarget=null;
    },
    target() { return isHighlighted(interaction,interaction.frobTarget) ? describeTarget(interaction.frobTarget) : null; },
    use() {
      const actor = interaction.frobTarget;
      if (!actor) return { ok: false, message: 'Nothing selected' };
      if (actor.lineage?.includes('engine.mover')) {
        const target = describeTarget(actor);
        return target?.mover ? doors.use(target,player.position) : { ok: false, message: target?.label ?? 'Nothing selected' };
      }
      // Non-mover frob: run the actor's real Frob bytecode through the general VM
      // router (docs/scene-events.md). A handled Frob ran the real body; an
      // unhandled one has no Frob override (the empty-event no-op). A prepared body
      // that reaches an unbuilt native/subsystem throws, pausing play honestly
      // (main.mjs surfaces it) — e.g. LightSwitch.Frob's anim/audio until M2 step 2.
      const outcome = doors.scriptRuntime.dispatchEvent(actor, 'Frob', [player.collisionActor, null]);
      return { ok: outcome.handled, message: '' };
    },
    status() { return { player: player.status(), doors: doors.status(), hud:hud?.snapshot()??null, hulls: collision.bsp.hulls.length,
      deferredEffects:[...player.unimplementedPhysicsEffects],
      random:{initialSeed:randomSeed,state:random.state},
      blockingActors: collision.actors.filter(actor => actor.blocking).length, collidableActors: collidable.length }; },
  };
  return game;
}
