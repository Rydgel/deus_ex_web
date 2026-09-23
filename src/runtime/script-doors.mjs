import { ScriptRuntime } from './script-runtime.mjs';
import { refValue } from './script-vm.mjs';
import { tickMoverInterpolation } from './mover-interpolation.mjs';
import { moverFinishBounds } from './mover-finish.mjs';
import { prepareMapProperties } from './script-map-properties.mjs';
import { updateActorTimer } from './script-timers.mjs';
import { runDecorationPhysics, linkDecorationCollision, PHYS_FALLING, PHYS_ROLLING, PHYS_NONE } from './decoration-physics.mjs';
import { processDecorationHitWall } from './walking-callbacks.mjs';
import { createScriptLights } from './script-lights.mjs';
import { createScriptTriggers, prepareTriggerFunctions } from './script-triggers.mjs';
import { createInfoLinkShellPreview } from './script-infolink-shell.mjs';
import { createLiveDataLinkRuntime, prepareLiveActorSpawnWorld } from './script-datalink-live.mjs';
import { createPlayerAugmentationStartup } from './script-player-startup.mjs';
import { preparePlayerLogStore } from './script-player-log.mjs';
import { createWorldDestroyServices, createDestroyedActorLedger, mapActorNativeObject } from './script-world-destroy.mjs';
import { WINDOW_DESTROY_OFFSETS } from './script-window-destroy.mjs';
import { setActorCollisionSize, findActorBase } from './script-actor-collision.mjs';
import { setBase } from './walking-callbacks.mjs';
import { setActorZone } from './zone.mjs';
import { pawnPhysicsView } from './script-pawn-physics.mjs';
import { forEachLiveActor, partitionActorArray } from './script-loadmap-startup.mjs';
import { addPawn, removePawn } from './pawn-list.mjs';
import { prepareShadowStartup } from './script-decal.mjs';
import { prepareConversationBinding } from './script-conversation-startup.mjs';
import { createLiveConPlayRuntime } from './script-conplay-live.mjs';
import { createLiveMissionRuntime } from './script-mission-live.mjs';
import { prepareFaceConversations } from './script-conversation-face-live.mjs';
import { performActorPhysics } from './actor-physics.mjs';
import { playerDistance } from './level-tick.mjs';
import { prepareCrateLifecycle } from './script-crate-lifecycle.mjs';
import { runSpawnedActorFalling, runActorRotation } from './script-actor-physics.mjs';

const f = Math.fround;
const lower = value => String(value ?? '').toLowerCase();
const ZERO_VECTOR = Object.freeze([0, 0, 0]);
const MOVER_SOUNDS = Object.freeze({
  doopen: 'OpeningSound',
  doclose: 'ClosingSound',
  finishedopening: 'OpenedSound',
  finishedclosing: 'ClosedSound',
});

const vector = (value, integer = false) => {
  const source = Array.isArray(value) ? value : ZERO_VECTOR;
  return [0, 1, 2].map(index => integer ? Number(source[index] ?? 0) | 0 : f(source[index] ?? 0));
};

const isZeroVector = value => vector(value).every(component => component === 0);
const hasNamedValue = value => Boolean(value) && lower(value) !== 'none';

function packageIndex(packageAsset, path, description) {
  const index = packageAsset?.exportsByPath?.get(lower(path));
  if (!index) throw new Error(`Original ${description ?? path} is not exported: ${path}`);
  return index;
}

function classFields(cls) {
  const fields = new Map();
  for (let node = cls; node; node = node.base) {
    for (const field of node.fields?.values() ?? []) if (!fields.has(field.key)) fields.set(field.key, field);
  }
  return [...fields.values()];
}

function ensureArray(value, dimension, fallback) {
  if (!Array.isArray(value) || value.length !== dimension) return Array.from({ length: dimension }, fallback);
  return value.map(item => item);
}

function moverKeyPairs(mover) {
  const values = mover.values ?? {};
  return {
    positions: [values.KeyPos, values['KeyPos[1]']].map(item => vector(item)),
    rotations: [values.KeyRot, values['KeyRot[1]']].map(item => vector(item, true)),
  };
}

/*
 * The map adapter's historical test used `KeyPos[1]` as the only nonzero
 * endpoint and `KeyPos` as the implicit zero endpoint. Keep that exact
 * selected predicate here instead of broadening it to arbitrary Mover states.
 */
function levelHasTaggedActor(level, tag) {
  if (!Array.isArray(level?.actors)) return null;
  const wanted = lower(tag);
  return level.actors.some(actor => actor && lower(actor.values?.Tag) === wanted);
}

function selectedMover(mover, level) {
  const values = mover?.values ?? {};
  const { positions, rotations } = moverKeyPairs(mover);
  return values.InitialState === 'TriggerToggle' && values.NumKeys === 2 &&
    !isZeroVector(positions[1]) && isZeroVector(positions[0]) &&
    isZeroVector(rotations[0]) && isZeroVector(rotations[1]) &&
    !values.bSlave && !values.bTriggerOnceOnly && !(values.DelayTime ?? 0) &&
    !(values.KeyNum ?? 0) && (!hasNamedValue(values.Event) || levelHasTaggedActor(level, values.Event) === false);
}

/**
 * Link the host's live actor state to one original UProperty identity. The
 * binding is intentionally keyed by the runtime's field export key; same-name
 * properties from unrelated classes therefore cannot alias.
 */
function makeBinding(record, field) {
  const host = record.object;
  const name = field.name;
  const key = lower(name);
  const values = host.values ?? {};
  const interpolation = () => host.interpolation;
  if (field.key === 'core.object.class') return {
    get: () => record.cls.record,
    set: () => { throw new Error('Changing a native actor Class requires object reconstruction'); },
  };
  if (field.key === 'core.object.name' && Number.isInteger(host.index)) return {
    get: () => host.name,
    set: () => { throw new Error('Changing a native actor Name requires object rename support'); },
  };

  const dynamic = {
    level: {
      get: () => record.levelInfo,
      set: value => { record.levelInfo = value; },
    },
    pawnlist: {
      get: () => record.level?.pawnList ?? null,
      set: value => { if (record.level) record.level.pawnList = value; },
    },
    nextpawn: {
      get: () => host.nextPawn ?? null,
      set: value => { host.nextPawn = value; },
    },
    specialgoal: {
      get: () => host.specialGoal ?? null,
      set: value => { host.specialGoal = value; },
    },
    base: {
      get: () => host.base ?? null,
      set: value => { host.base = value; },
    },
    // The live four `Touching` slots (Actor.uc:186) are kept on the host actor
    // by the recovered BeginTouch/EndTouch pair (actor-touch.mjs). Script reads
    // of `Touching` — the ULevel::DestroyActor scan among them — must see that
    // live state. An actor the scene never prepared for contact has no live
    // slots, and its serialized startup value stays authoritative.
    touching: {
      get: () => Array.isArray(host.touching) && host.touching.length === 4 ? [...host.touching]
        : record.store.has(field.key) ? record.store.get(field.key) : record.initialProperty(field),
      set: value => {
        if (!Array.isArray(value) || value.length !== 4) throw new Error('Original Touching requires four explicit slots');
        if (Array.isArray(host.touching) && host.touching.length === 4) host.touching = [...value];
        else record.store.set(field.key, [...value]);
      },
    },
    waitingpawn: {
      get: () => host.waitingPawn ?? null,
      set: value => { host.waitingPawn = value; },
    },
    mymarker: {
      get: () => host.marker ?? null,
      set: value => { host.marker = value; },
    },
    standingcount: {
      get: () => host.standingCount ?? values.StandingCount ?? 0,
      set: value => { host.standingCount = Number(value) | 0; },
    },
    location: {
      get: () => host.position ?? interpolation()?.position ?? values.Location ?? ZERO_VECTOR,
      set: value => {
        if (interpolation()) interpolation().position = vector(value);
        host.position = vector(value);
      },
    },
    rotation: {
      get: () => host.rotation ?? interpolation()?.rotation ?? values.Rotation ?? ZERO_VECTOR,
      set: value => {
        if (interpolation()) interpolation().rotation = vector(value, true);
        host.rotation = vector(value, true);
      },
    },
    collisionradius: {
      get: () => host.radius ?? values.CollisionRadius ?? 0,
      set: value => { host.radius = f(value); },
    },
    collisionheight: {
      get: () => host.height ?? values.CollisionHeight ?? 0,
      set: value => { host.height = f(value); },
    },
    keynum: {
      get: () => interpolation()?.key ?? values.KeyNum ?? 0,
      set: value => { if (interpolation()) interpolation().key = Number(value) & 0xff; },
    },
    prevkeynum: {
      get: () => interpolation()?.previousKey ?? values.PrevKeyNum ?? 0,
      set: value => { if (interpolation()) interpolation().previousKey = Number(value) & 0xff; },
    },
    physalpha: {
      get: () => interpolation()?.alpha ?? 0,
      set: value => { if (interpolation()) interpolation().alpha = f(value); },
    },
    physrate: {
      get: () => interpolation()?.rate ?? 0,
      set: value => { if (interpolation()) interpolation().rate = f(value); },
    },
    binterpolating: {
      get: () => Boolean(interpolation()?.interpolating),
      set: value => { if (interpolation()) interpolation().interpolating = Boolean(value); },
    },
    oldpos: {
      get: () => interpolation()?.oldPosition ?? values.OldPos ?? ZERO_VECTOR,
      set: value => { if (interpolation()) interpolation().oldPosition = vector(value); },
    },
    oldrot: {
      get: () => interpolation()?.oldRotation ?? values.OldRot ?? ZERO_VECTOR,
      set: value => { if (interpolation()) interpolation().oldRotation = vector(value, true); },
    },
    basepos: {
      get: () => interpolation()?.basePosition ?? values.BasePos ?? values.Location ?? ZERO_VECTOR,
      set: value => { if (interpolation()) interpolation().basePosition = vector(value); },
    },
    baserot: {
      get: () => interpolation()?.baseRotation ?? values.BaseRot ?? values.Rotation ?? ZERO_VECTOR,
      set: value => { if (interpolation()) interpolation().baseRotation = vector(value, true); },
    },
    keypos: {
      get: () => {
        const state = interpolation();
        const dimension = field.metadata.arrayDim || 8;
        const pairs = ensureArray(state?.keyPositions, 2, () => ZERO_VECTOR);
        return Array.from({ length: dimension }, (_, index) => vector(pairs[index] ?? values[`KeyPos[${index}]`]));
      },
      set: value => {
        const state = interpolation();
        if (state && Array.isArray(value)) state.keyPositions = value.slice(0, 2).map(item => vector(item));
      },
    },
    keyrot: {
      get: () => {
        const state = interpolation();
        const dimension = field.metadata.arrayDim || 8;
        const pairs = ensureArray(state?.keyRotations, 2, () => ZERO_VECTOR);
        return Array.from({ length: dimension }, (_, index) => vector(pairs[index] ?? values[`KeyRot[${index}]`], true));
      },
      set: value => {
        const state = interpolation();
        if (state && Array.isArray(value)) state.keyRotations = value.slice(0, 2).map(item => vector(item, true));
      },
    },
    physics: {
      get: () => host.physics ?? values.Physics ?? 0,
      set: value => { host.physics = Number(value) & 0xff; },
    },
    // The live pawn velocity for the player (its values.Velocity getter), and
    // stored on the object for a pushed decoration whose Bump writes it.
    velocity: {
      get: () => vector(host.velocity ?? values.Velocity ?? ZERO_VECTOR),
      set: value => { host.velocity = vector(value); },
    },
    clientupdate: {
      get: () => host.clientUpdate ?? values.ClientUpdate ?? 0,
      set: value => { host.clientUpdate = Number(value) | 0; },
    },
    simoldpos: {
      get: () => host.simOldPosition ?? values.SimOldPos ?? ZERO_VECTOR,
      set: value => { host.simOldPosition = vector(value); },
    },
    simoldrotyaw: {
      get: () => host.simOldRotYaw ?? values.SimOldRotYaw ?? 0,
      set: value => { host.simOldRotYaw = Number(value) | 0; },
    },
    simoldrotpitch: {
      get: () => host.simOldRotPitch ?? values.SimOldRotPitch ?? 0,
      set: value => { host.simOldRotPitch = Number(value) | 0; },
    },
    simoldrotroll: {
      get: () => host.simOldRotRoll ?? values.SimOldRotRoll ?? 0,
      set: value => { host.simOldRotRoll = Number(value) | 0; },
    },
    siminterpolate: {
      get: () => host.simInterpolate ?? values.SimInterpolate ?? ZERO_VECTOR,
      set: value => { host.simInterpolate = vector(value); },
    },
    realposition: {
      get: () => host.realPosition ?? values.RealPosition ?? ZERO_VECTOR,
      set: value => { host.realPosition = vector(value); },
    },
    realrotation: {
      get: () => host.realRotation ?? values.RealRotation ?? ZERO_VECTOR,
      set: value => { host.realRotation = vector(value, true); },
    },
    ambientsound: {
      get: () => record.store.has(key) ? record.store.get(key) : record.initialProperty(field),
      set: value => { host.ambientSound = value; record.store.set(key, value); },
    },
    netmode: {
      get: () => record.level?.netMode ?? 0,
      set: value => { if (record.level) record.level.netMode = Number(value) | 0; },
    },
  };
  if (dynamic[key]) return dynamic[key];
  // The controlled player's view state lives on the viewer's movement port:
  // the camera integrates look input instead of PlayerPawn.UpdateRotation, so
  // original bodies (DeusExWeapon.TraceFire's GetAxes(ViewRotation),
  // CalcDrawOffset's EyeHeight/WalkBob, HighlightCenterObject) read it live.
  // UpdateRotation stores `ViewRotation.Pitch & 65535` (PlayerPawn.uc:3342)
  // and leaves Yaw unmasked; the read applies the same representation.
  if (host.controlledPlayer) {
    const view = {
      viewrotation: {
        get: () => { const r = host.viewRotation ?? ZERO_VECTOR; return [(r[0] | 0) & 65535, r[1] | 0, r[2] | 0]; },
        set: value => { host.viewRotation = vector(value, true); },
      },
      eyeheight: { get: () => f(host.eyeHeight ?? 0), set: value => { host.eyeHeight = f(value); } },
      baseeyeheight: {
        get: () => f(host.baseEyeHeight ?? values.BaseEyeHeight ?? 0),
        set: () => { throw new Error('Player BaseEyeHeight is owned by the viewer movement port'); },
      },
      walkbob: {
        get: () => vector(host.walkBob ?? ZERO_VECTOR),
        set: () => { throw new Error('Player WalkBob is owned by the recovered CheckBob port'); },
      },
      biscrouching: {
        get: () => Boolean(host.isCrouching),
        set: () => { throw new Error('Player bIsCrouching is owned by the recovered stance port'); },
      },
    };
    if (view[key]) return view[key];
  }

  return {
    get: () => {
      if (record.store.has(field.key)) return record.store.get(field.key);
      return record.initialProperty(field);
    },
    set: value => { record.store.set(field.key, value); },
  };
}

function stateLabelForTarget(mover) {
  const state = mover.interpolation;
  return state.key === 0 || state.key < state.previousKey ? 'open' : 'close';
}

/**
 * Prepare the original Engine/DeusEx functions used by the selected
 * TriggerToggle state. This adapter never rewrites their script bodies.
 */
export async function createScriptDoors({
  assets, asset, movers = [], playerActor, level, callbacks = {}, rng, queries, zoneAt, onLightingChanged = null,
  nativeHud = false,
} = {}) {
  if (!assets?.get) throw new TypeError('createScriptDoors requires an AssetStore');
  if (!level || typeof level !== 'object') throw new TypeError('createScriptDoors requires the linked Level object');
  if (!playerActor || typeof playerActor !== 'object') throw new TypeError('createScriptDoors requires the existing player actor');
  if (onLightingChanged != null && typeof onLightingChanged !== 'function') throw new TypeError('createScriptDoors onLightingChanged must be a function');

  // Keep the authored slot order before player subsystems append or LoadMap
  // partitions the live array. Public reset emulates reloading that map.
  const initialActorArray = [...level.actors];
  const initialActorSet = new Set(initialActorArray.filter(Boolean));

  const engine = await assets.get('Engine');
  const deusEx = await assets.get('DeusEx');
  // PlaySound (264) is a recorded mover-sound boundary in the live game and
  // the explicit stopping boundary for the Training damage response's Human
  // pain sound (soundBoundary -> callbacks.playSound for the supported mover
  // names; no audible playback until Stage 4). Declaring it a host boundary
  // keeps invokeNative routing it here instead of running the full
  // execActorPlaySound native, whose channel id needs the measured index. A
  // focused validation with the live capture (scripts/validate-script-lights.mjs)
  // opts 264 back out to exercise the real native.
  let liveConPlay=null;
  let liveMission=null;
  // GLog output device: Object.Log (native 231) is a synchronous side channel
  // with no gameplay effect. MissionScript.InitStateMachine logs its startup
  // line, so supply the host sink the original always has, recording a bounded
  // ring for diagnostics rather than leaving it an explicit boundary throw.
  const scriptLog=[];
  const runtime = new ScriptRuntime(assets, { native: nativeCall, rng, levelFor: () => level, nativeClassLoading: true,
    conversationObjects:()=>level.actors.filter(Boolean),boundaryNatives: [264],
    logDevice:event=>{scriptLog.push(event);if(scriptLog.length>512)scriptLog.shift();} });
  const triggerActions=createScriptTriggers({player:playerActor,getPlayerPawnServices:{read(object,name){
    if(name==='XLevel')return runtime.levelFor(object);
    const field={Engine:'engine',Client:'client',Viewports:'viewports',Actor:'actor'}[name];
    if(!field)throw new Error(`Unbound trigger native graph field: ${name}`);
    return object[field];
  }}});
  const identities = new WeakMap();
  const moversByObject = new WeakMap();
  const actorByIndex = new Map((level.actors ?? []).filter(actor => Number.isInteger(actor?.index))
    .map(actor => [actor.index, actor]));
  // Publish host identities before a class/function/default can resolve a
  // pointer to a map export. Metadata and bytecode then share those objects.
  for (const actor of actorByIndex.values()) await runtime.objects.bindIdentity(asset, actor.index, actor);

  const levelInfo = level.levelInfo ?? level.worldActor ?? level.actors?.find(actor =>
    lower(actor?.className) === 'levelinfo') ?? level.actors?.[0];
  if (!levelInfo || typeof levelInfo !== 'object') throw new Error('Original LevelInfo identity is unavailable');

  const engineIndex = (path, description) => packageIndex(engine, path, description);
  const deusExIndex = (path, description) => packageIndex(deusEx, path, description);
  const loadClass = (packageAsset, path, description) => runtime.loadClass(packageAsset, packageIndex(packageAsset, path, description));
  const prepare = (packageAsset, path, description) => runtime.prepareFunction(packageAsset, packageIndex(packageAsset, path, description));

  const levelClass = await loadClass(engine, 'levelinfo', 'LevelInfo class');
  const deusExMoverClass = await loadClass(deusEx, 'deusexmover', 'DeusExMover class');
  const playerClass = await loadClass(deusEx, 'jcdentonmale', 'JCDentonMale class');

  const functions = {
    initEventManager: await prepare(engine, 'levelinfo.initeventmanager', 'LevelInfo.InitEventManager'),
    actorBeginEvent: await prepare(engine, 'actor.beginevent', 'Actor.BeginEvent'),
    actorEndEvent: await prepare(engine, 'actor.endevent', 'Actor.EndEvent'),
    actorHitWall: await prepare(engine, 'actor.hitwall', 'Actor.HitWall'),
    actorLanded: await prepare(engine, 'actor.landed', 'Actor.Landed'),
    pawnStopWaiting: await prepare(engine, 'pawn.stopwaiting', 'Pawn.StopWaiting'),
    pawnEncroachedByMover: await prepare(engine, 'pawn.encroachedbymover', 'Pawn.EncroachedByMover'),
    moverTrigger: await prepare(engine, 'mover.triggertoggle.trigger', 'Mover.TriggerToggle.Trigger'),
    deusExMoverTrigger: await prepare(deusEx, 'deusexmover.triggertoggle.trigger', 'DeusExMover.TriggerToggle.Trigger'),
    interpolateTo: await prepare(engine, 'mover.interpolateto', 'Mover.InterpolateTo'),
    interpolateEnd: await prepare(engine, 'mover.interpolateend', 'Mover.InterpolateEnd'),
    moverDoOpen: await prepare(engine, 'mover.doopen', 'Mover.DoOpen'),
    deusExMoverDoOpen: await prepare(deusEx, 'deusexmover.doopen', 'DeusExMover.DoOpen'),
    moverDoClose: await prepare(engine, 'mover.doclose', 'Mover.DoClose'),
    moverFinishedOpening: await prepare(engine, 'mover.finishedopening', 'Mover.FinishedOpening'),
    moverFinishedClosing: await prepare(engine, 'mover.finishedclosing', 'Mover.FinishedClosing'),
    moverFinishNotify: await prepare(engine, 'mover.finishnotify', 'Mover.FinishNotify'),
    deusExMoverFinishNotify: await prepare(deusEx, 'deusexmover.finishnotify', 'DeusExMover.FinishNotify'),
    // Inherited pushable-decoration contact (e.g. Plant2/Plant7). The bodies are
    // validated in scripts/validate-script-decoration.mjs; preparing them here
    // lets a live player bump run the real script instead of pausing at the
    // scene adapter (docs/script-plant-contact.md).
    decorationBump: await prepare(deusEx, 'deusexdecoration.bump', 'DeusExDecoration.Bump'),
    decorationTimer: await prepare(deusEx, 'deusexdecoration.timer', 'DeusExDecoration.Timer'),
    decorationLanded: await prepare(deusEx, 'deusexdecoration.landed', 'DeusExDecoration.Landed'),
    // DeusExDecoration.Bump:425-442 scales its push by the pushing player's
    // Microfibral Muscle level, through AugmentationManager.GetClassLevel. That
    // body is a plain FirstAug/next walk reading Class, bHasIt, bIsActive and
    // CurrentLevel with no natives (AugmentationManager.uc:225-244); the manager
    // itself is the live AugmentationManager1 built by the player startup below.
    // Before this was prepared, a live bump on a pushable decoration paused Play
    // as soon as the player owned an augmentation system.
    augmentationGetClassLevel: await prepare(deusEx, 'augmentationmanager.getclasslevel', 'AugmentationManager.GetClassLevel'),
    // General Frob chain (docs/script-light-switch.md): a frobbed decoration runs
    // the empty Actor.Frob base, DeusExPlayer.StartConversation (which returns
    // early-false while ConListItems is null — the training case), then
    // DeusExDecoration.Frob's Event/AllActors trigger fanout. Preparing these lets
    // game.use() route a non-mover frob through the real bytecode.
    actorFrob: await prepare(engine, 'actor.frob', 'Actor.Frob'),
    startConversation: await prepare(deusEx, 'deusexplayer.startconversation', 'DeusExPlayer.StartConversation'),
    decorationFrob: await prepare(deusEx, 'deusexdecoration.frob', 'DeusExDecoration.Frob'),
    // DeusExMover.Frob. Using a door is the original body's decision, not the
    // viewer's: bFrobbable/bDestroyed/bSlave, the bPicking and KeyNum/PrevKeyNum
    // tests, the bOneWay GetAxes dot product, the lock branches, the localized
    // ClientMessage and the Tag fanout through native AllActors all live here.
    // Its Super.Frob is the empty Actor.Frob above. The lockpick and NanoKeyRing
    // branches are only reached with a non-null frobWith, which needs Stage-5
    // inventory; Play frobs with None and never enters them.
    // docs/script-mover-frob.md.
    deusExMoverFrob: await prepare(deusEx, 'deusexmover.frob', 'DeusExMover.Frob'),
    // LightSwitch.Frob (roadmap item #3): Super.Frob's AllActors(Event) fanout calls
    // Actor.Trigger on each tagged actor; with the TriggerLights advanced into their
    // TriggerToggle state (createScriptLights below) that virtual call dispatches to
    // the state Trigger. Native PlayAnim state is recovered; audible playback
    // and final mesh rendering remain Stage-4 presentation boundaries.
    // Evidence: docs/script-light-switch.md and docs/script-play-anim.md.
    actorTrigger: await prepare(engine, 'actor.trigger', 'Actor.Trigger'),
    lightSwitchFrob: await prepare(deusEx, 'lightswitch.frob', 'LightSwitch.Frob'),
    // DataLinkTrigger Touch/UnTouch: Touch runs its original gating and the
    // supported DL_Start call continues through the live DataLink runtime wired
    // below. UnTouch chains to the inherited Trigger.UnTouch.
    dataLinkTouch: await prepare(deusEx, 'datalinktrigger.touch', 'DataLinkTrigger.Touch'),
    dataLinkUnTouch: await prepare(deusEx, 'datalinktrigger.untouch', 'DataLinkTrigger.UnTouch'),
    dataLinkEvaluateFlag: await prepare(deusEx, 'datalinktrigger.evaluateflag', 'DataLinkTrigger.EvaluateFlag'),
    // Base Trigger Touch/UnTouch (item #2 M3): the real IsRelevant gate (TriggerType
    // switch + ClassIsChildOf) and the Event/AllActors -> Actor.Trigger fanout. A
    // proximity trigger fires its Event to the tagged actors (e.g. a corpse-detection
    // Trigger opening its body doors). docs/scene-events.md.
    triggerTouch: await prepare(engine, 'trigger.touch', 'Trigger.Touch'),
    triggerIsRelevant: await prepare(engine, 'trigger.isrelevant', 'Trigger.IsRelevant'),
    triggerUnTouch: await prepare(engine, 'trigger.untouch', 'Trigger.UnTouch'),
    // FlagTrigger.Touch/UnTouch override the base and set/clear a flag on the
    // player's FlagBase (via GetPlayerPawn 720 and FlagBase.SetBool, both routed
    // through nativeCall/triggerActions). Training's MunitionsTrooperReady
    // FlagTriggers use bSetFlag/flagValue=true/bWhileStandingOnly: standing
    // within 300u sets it true, leaving sets it false — the authored gate that
    // makes the instructor's Take conversation selectable.
    // docs/script-instructor-conversation.md.
    flagTriggerTouch: await prepare(deusEx, 'flagtrigger.touch', 'FlagTrigger.Touch'),
    flagTriggerUnTouch: await prepare(deusEx, 'flagtrigger.untouch', 'FlagTrigger.UnTouch'),
    // Training's standalone Radiation10 body reaches this exact inherited
    // chain after TakeDamage writes the body-part health fields.  Keep the
    // original script bodies intact: PlayDXTakeDamageHit calls the JC override
    // PlayHit, which calls Human.PlayTakeHitSound.  The latter's first
    // PlaySound(264) is the next intentionally unsupported audio boundary.
    // Evidence: DeusExPlayer.uc:10011-10061 and Human.uc:336-377;
    // installed exports 17174, 17166, and 16845.
    playerPlayDXTakeDamageHit: await prepare(deusEx, 'deusexplayer.playdxtakedamagehit', 'DeusExPlayer.PlayDXTakeDamageHit'),
    playerPlayHit: await prepare(deusEx, 'deusexplayer.playhit', 'DeusExPlayer.PlayHit'),
    humanPlayTakeHitSound: await prepare(deusEx, 'human.playtakehitsound', 'Human.PlayTakeHitSound'),
  };
  const triggerState = await runtime.prepareState(deusEx, deusExIndex('deusexmover.triggertoggle', 'DeusExMover.TriggerToggle state'));

  function nativePath(call) {
    return lower(call.script?.entry?.path ?? call.record?.entry?.path ?? '');
  }

  function callbackView(receiver) {
    const record = identities.get(receiver);
    return record?.callbackView ?? { actor: receiver, mover: receiver, name: receiver?.name, values: receiver?.values };
  }

  function dispatch(receiver, event, args = []) {
    if (typeof callbacks.dispatch !== 'function') throw new Error(`Original event boundary is not linked: ${event}`);
    return callbacks.dispatch(receiver, event, args);
  }

  function boundingBox(receiver, exact, position, rotation) {
    if (typeof callbacks.getBoundingBox === 'function') {
      const result = callbacks.getBoundingBox(receiver, exact, position, rotation);
      if (!result?.min || !result?.max) throw new Error('GetBoundingBox callback returned invalid bounds');
      return { min: vector(result.min), max: vector(result.max) };
    }
    if (!receiver?.model) throw new Error('Original GetBoundingBox requires a mover model callback');
    return moverFinishBounds(receiver.model, receiver.collisionValues ?? receiver.values ?? {}, position, rotation);
  }

  function soundBoundary(call) {
    const path = nativePath(call);
    const method = Object.keys(MOVER_SOUNDS).find(name => path.endsWith(`.${name}`));
    // Scene-event dispatch recognizes this error as a recordable boundary;
    // retain the exact caller path so focused validators can name the first
    // unsupported operation after the recovered damage state writes.
    if (!method) throw new Error(`Unsupported original door native 264 PlaySound from ${path}`);
    const args = Array.from({ length: call.argumentCount }, (_, index) => refValue(call.evaluateArgument(index)));
    const details = {
      sound: args[0] ?? null,
      slot: args[1],
      volume: args[2],
      noOverride: args[3],
      radius: args[4],
      pitch: args[5],
      args,
    };
    if (typeof callbacks.playSound !== 'function') throw new Error('Original PlaySound native boundary is not linked');
    callbacks.playSound(callbackView(call.receiver), MOVER_SOUNDS[method], details);
    return 0;
  }

  // Pushable decorations (DeusExDecoration.Bump/Timer) record their push sound
  // and AI loud-noise events as deferred boundaries; audible playback and AI
  // propagation are later stages. The Bump stores PlaySound's return as
  // pushSoundId and its Timer passes it to StopSound, so a boundary channel id of
  // 0 round-trips that lifetime without a measured global index.
  function decorationEffect(call, label) {
    const args = Array.from({ length: call.argumentCount }, (_, index) => refValue(call.evaluateArgument(index)));
    if (typeof callbacks.playSound !== 'function') throw new Error('Original decoration sound/AI boundary is not linked');
    callbacks.playSound(callbackView(call.receiver), label, { args });
    return args;
  }

  function nativeCall(call) {
    const faceNative=liveConPlay?.handleNative(call);
    if(faceNative?.handled)return faceNative.value;
    const triggerNative=triggerActions.handleNative(call);
    if(triggerNative.handled)return triggerNative.value;
    const path = nativePath(call);
    const decoration = path.startsWith('deusexdecoration.');
    const lightSwitch = path.startsWith('lightswitch.');
    if (call.index === 264) {
      if (decoration) { decorationEffect(call, path.endsWith('.bump') ? 'PushSound' : 'LandedSound'); return 0; }
      // LightSwitch.Frob's Switch4ClickOn/Off is a Stage-4 audio boundary (recorded,
      // no audible playback until ClientHearSound). Channel id 0 (docs/script-light-switch.md).
      // PlayAnim(259) is not a boundary: the runtime runs the real execPlayAnim
      // native, so the switch's animation state is applied (only rendering is Stage-4).
      if (lightSwitch) { decorationEffect(call, 'SwitchSound'); return 0; }
      // ScriptedPawn's direct PlaySound sites are ambient effect audio
      // (PlayFootStep, idle/scan/alert sounds) whose returns the scripts
      // discard; their gameplay propagation rides on the separately recorded
      // AI event natives (713-716). Record and return boundary channel id 0 —
      // same lifetime contract as the decoration PushSound above — so a pawn
      // keeps ticking through the audio gap instead of freezing mid-walk.
      if (path.startsWith('scriptedpawn.')) { decorationEffect(call, 'PawnSound'); return 0; }
      // An inventory item plays a one-shot pickup sound from its Pickup-state
      // Frob when it is taken. Record it as a deferred audio boundary (channel
      // id 0), the same lifetime contract as the decoration/pawn sounds above,
      // so the pickup completes instead of freezing at the audio gap.
      if (/\.pickup\.frob$/.test(path)) { decorationEffect(call, 'PickupSound'); return 0; }
      if (path === 'deusexpickup.playlandingsound') { decorationEffect(call, 'PickupLandedSound'); return 0; }
      // A weapon's select/idle/fire effect sounds (Weapon.PlaySelect ->
      // Owner.PlaySound(SelectSound), and the DeusExWeapon firing sites) are
      // one-shot effect audio whose return the scripts discard or use only as a
      // channel id later stopped through StopSound. Record them as a deferred
      // audio boundary (channel id 0), the same lifetime contract as the
      // decoration/pawn/pickup sounds above, so weapon selection and fire run
      // to completion instead of freezing at the Stage-4 audio gap.
      if (path.startsWith('weapon.') || path.startsWith('deusexweapon.')) { decorationEffect(call, 'WeaponSound'); return 0; }
      // A carried tool's use sound (NanoKeyRing/SkilledTool UseIt state code,
      // now reached because carried items tick) and a crate fragment's
      // ImpactSound/MiscSound on HitWall are the same one-shot effect audio.
      if (path.startsWith('nanokeyring.') || path.startsWith('skilledtool.')) { decorationEffect(call, 'ToolSound'); return 0; }
      if (path.startsWith('deusexfragment.') || path.startsWith('fragment.')) { decorationEffect(call, 'FragmentSound'); return 0; }
      return soundBoundary(call);
    }
    if (call.index === 713) { decorationEffect(call, 'AISendEvent'); return undefined; }
    if (call.index === 265) {
      if (decoration) decorationEffect(call, 'StopSound');
      // DataLinkPlay/ConPlayBase stop the player speech channel at termination.
      // Browser audio is driven by the same recovered duration and has already
      // ended on the supported path; there is no native channel id to stop here.
      return undefined;
    }
    if (call.index === 714) { decorationEffect(call, 'AIStartEvent'); return null; }
    if (call.index === 715) { decorationEffect(call, 'AIEndEvent'); return undefined; }
    if (call.index === 716) { decorationEffect(call, 'AIClearEvent'); return undefined; }
    if (call.index === 301) {
      runtime.instance(call.receiver).state.latent = 302;
      return undefined;
    }
    if (call.index === 302) {
      if (call.receiver?.interpolation?.interpolating) return undefined;
      runtime.instance(call.receiver).state.latent = 0;
      return undefined;
    }
    if (call.index === 529 || call.index === 530) {
      if(call.argumentCount!==0)throw new Error('AddPawn/RemovePawn accept no arguments');
      if(!identities.has(call.receiver)||!call.receiver.lineage?.includes('engine.pawn'))
        throw new Error('AddPawn/RemovePawn require a linked scene Pawn');
      // These recovered natives deliberately do not deduplicate the list.
      // Reflected NextPawn/PawnList already bind to these same host slots.
      (call.index===529?addPawn:removePawn)(level,call.receiver);
      return undefined;
    }
    // Existing map identities already expose position/radius/height and the
    // collision flags through the scene host. Use the same recovered native
    // as spawned actors: remove from the hash, write both f32 sizes, re-add.
    // Pawn.PreBeginPlay reaches this through Actor.PreBeginPlay before shadow
    // construction. Do not run that lifecycle on an already populated list.
    if (call.index === 283 && identities.has(call.receiver)) {
      if(call.argumentCount!==2)throw new Error('SetCollisionSize requires radius and height');
      return setActorCollisionSize(call.receiver,refValue(call.evaluateArgument(0)),
        refValue(call.evaluateArgument(1)),{level});
    }
    if (call.index === 3970) {
      const value = refValue(call.evaluateArgument(0));
      // DeusExDecoration.Bump calls SetPhysics(PHYS_Rolling) when a settled
      // decoration is pushed. The recovered native (0x103c95f0) writes Physics
      // and only touches Base/velocity for the Falling/Walking/None transitions;
      // Rolling changes nothing else. The separately validated physRolling phase
      // (src/runtime/rolling.mjs) then advances the decoration.
      if (decoration) { call.receiver.physics = Number(value) & 0xff; return undefined; }
      if ((Number(value) | 0) !== 9) throw new Error(`Unsupported mover SetPhysics value: ${value}`);
      const current = Number(call.receiver.physics ?? call.receiver.values?.Physics ?? 0) | 0;
      if (current !== 9) throw new Error(`Mover SetPhysics requires already-moving-brush physics: ${current}`);
      call.receiver.physics = 9;
      return undefined;
    }
    if (call.index === 724) {
      const minimum = call.evaluateArgument(0), maximum = call.evaluateArgument(1);
      const exact = refValue(call.evaluateArgument(2));
      const position = refValue(call.evaluateArgument(3));
      const rotation = refValue(call.evaluateArgument(4));
      const bounds = boundingBox(call.receiver, exact, position, rotation);
      if (!minimum?.reference || !maximum?.reference) throw new Error('GetBoundingBox requires out references');
      minimum.set(vector(bounds.min)); maximum.set(vector(bounds.max));
      return undefined;
    }
    if (call.index === 262) {
      if(call.argumentCount>3)throw new Error('SetCollision accepts at most three boolean arguments');
      const collide=call.argumentCount>0?Boolean(refValue(call.evaluateArgument(0))):false;
      const blockActors=call.argumentCount>1?Boolean(refValue(call.evaluateArgument(1))):false;
      const blockPlayers=call.argumentCount>2?Boolean(refValue(call.evaluateArgument(2))):false;
      if(call.receiver.collideActors&&!collide&&queries)queries.removeActor(call.receiver);
      runtime.namedReference(call.receiver,'bCollideActors').set(collide);
      runtime.namedReference(call.receiver,'bBlockActors').set(blockActors);
      runtime.namedReference(call.receiver,'bBlockPlayers').set(blockPlayers);
      call.receiver.collideActors=collide;call.receiver.blockActors=blockActors;
      call.receiver.blockPlayers=blockPlayers;call.receiver.blocking=blockPlayers;
      call.receiver.collisionBits=((call.receiver.collisionBits??0)&~13)|
        (collide?1:0)|(blockActors?4:0)|(blockPlayers?8:0);
      call.receiver.flags=((call.receiver.flags??0)&~13)|call.receiver.collisionBits;
      return true;
    }
    // Extension window-layout natives (Window.ConfigureChild 1461,
    // AskParentForReconfigure 1460, QueryPreferredSize/Width/Height
    // 1465/1463/1464, QueryGranularity 1466). The live DataLink host wires a
    // real attached HUDReceivedDisplay onto hud.receivedItems, which makes the
    // installed DeusExHUD.ConfigurationChanged body run its received-display
    // layout branch against these. They are bounded zero/no-op boundaries
    // until the Stage-4 window-layout natives are recovered; every other
    // ConfigurationChanged window field is still None in the preview shell.
    if (call.index === 1460 || call.index === 1461) return undefined;
    if (call.index === 1463 || call.index === 1464 || call.index === 1465 || call.index === 1466) {
      for (let index = 0; index < call.argumentCount; index++) {
        const value = call.evaluateArgument(index);
        if (value?.reference && typeof value.set === 'function') value.set(0);
      }
      return 0;
    }
    if (call.index === 256) throw new Error(`Unsupported Sleep in selected door script: ${path}`);
    if (path.endsWith('.stopwaiting')) return dispatch(call.receiver, 'StopWaiting', []);
    throw new Error(`Unsupported original door native ${call.index} in ${path}`);
  }

  runtime.pollLatent = ({ index, receiver, state }) => {
    if (index !== 302) throw new Error(`Unsupported original latent action ${index}`);
    if (!receiver?.interpolation?.interpolating) state.latent = 0;
  };

  async function attach(identity, cls, role) {
    if (!identity || typeof identity !== 'object') return null;
    const existing = identities.get(identity);
    if (existing) return existing;
    const state = runtime.attach(identity, cls);
    const record = { object: identity, cls, state, role, store: new Map(), level, levelInfo, callbackView: null };
    identities.set(identity, record);
    if (role === 'mover') moversByObject.set(identity, record);
    record.callbackView = { actor: identity, mover: identity, name: identity.name, values: identity.values };
    const fields = classFields(cls);
    await Promise.all(fields.map(field => runtime.field(field)));
    record.initialProperty = await prepareMapProperties(runtime, asset, identity, cls, actorByIndex);
    for (const field of fields) runtime.bindProperty(identity, field, makeBinding(record, field));
    // Core UObject identity for a pre-placed map export. Actor.Destroy's
    // ConditionalDestroy -> AActor::Destroy -> UObject::Destroy chain reads this
    // record, and the export table supplies its measured Name/ObjectFlags
    // (docs/script-world-destroy.md).
    const entry = Number.isInteger(identity.index) ? asset?.pkg.exports[identity.index - 1] : null;
    if (entry && entry.name === identity.name) runtime.bindNativeObject(identity,
      mapActorNativeObject(identity, entry, {
        index: runtime.resolveOriginalObjectIndex?.(identity, runtime.instance(identity)) ?? null,
        destroy: receiver => runtime.destroyActorBase(receiver),
      }));
    // The selected LightSwitch Frob path reaches native PlayAnim synchronously.
    // Complete its native mesh/resource preparation before any event can run.
    for(let current=cls;current;current=current.base)if(current.record.key==='deusex.lightswitch'){
      await runtime.prepareResource(cls.record);
      await runtime.prepareMesh(identity);
      const fn=functions.lightSwitchFrob.function;
      for(const node of fn.compiled.decoded.expressions.values())if(node.op===0x20){
        const object=runtime.objects.operand(fn.script,node);
        if(object?.kind==='Sound')await runtime.prepareResource(object);
      }
      break;
    }
    return record;
  }

  await attach(levelInfo, levelClass, 'level');
  // LevelInfo.PreBeginPlay's InitEventManager (native 650) lazily creates the
  // +0x550 UEventManager during the original LoadMap startup pass; once it
  // exists the AI event natives (713-716) reach their propagation boundary
  // instead of silently returning. Run that real init here so decoration
  // AIStartEvent/AISendEvent reach the recorded deferred boundary until the
  // full actor-startup pass owns this call.
  runtime.callFunction(functions.initEventManager, levelInfo, 0);
  await attach(playerActor, playerClass, 'player');
  // The browser creates JCDentonMale before the script level is attached.
  // ULevel::SpawnActor would have written this inherited Actor.Level slot
  // during construction; restore that source-required identity before any
  // PostBeginPlay subsystem code reads Player.Level.NetMode.
  runtime.namedReference(playerActor, 'Level').set(levelInfo);
  // Player startup may synchronously reach mesh-dependent inherited code after
  // the subsystem objects are constructed. Prepare the canonical player mesh
  // while the attached package identity is still in the setup phase, matching
  // the existing LightSwitch resource-prepared contract.
  await runtime.prepareMesh(playerActor);
  triggerActions.bindPlayerFlagBase(runtime,playerActor);
  await prepareTriggerFunctions(runtime,assets);

  async function attachPawnList() {
    const seen = new Set();
    for (let pawn = level.pawnList; pawn && !seen.has(pawn); pawn = pawn.nextPawn) {
      seen.add(pawn);
      if (pawn === playerActor) continue;
      const entry=asset?.pkg.exports[pawn.index-1];
      if(!entry)throw new Error(`Original pawn class is unavailable: ${pawn.name}`);
      await attach(pawn, await runtime.loadClass(asset,entry.classIndex), 'pawn');
    }
  }
  await attachPawnList();

  // AllActors reads class ancestry before Tag. Every non-null live map actor
  // therefore needs an identity even when no selected behavior runs on it yet.
  for (const actor of level.actors ?? []) {
    if (!actor || identities.has(actor)) continue;
    const entry = asset?.pkg.exports[actor.index - 1];
    if (!entry) throw new Error(`Original scene actor class is unavailable: ${actor.name}`);
    await attach(actor, await runtime.loadClass(asset, entry.classIndex), 'scene');
  }

  // Every live decoration advances its recovered non-Pawn physics each actor
  // phase: physFalling settles it onto the floor at load and physRolling slides
  // a pushed decoration. Other Physics values are no-ops (docs/rolling.md,
  // docs/script-plant-contact.md). Collision-hash cylinders are linked to the
  // live position before the first move.
  const decorations = [];
  for (const actor of level.actors ?? []) {
    if (!actor?.lineage) continue;
    if (!actor.lineage.includes('deusex.deusexdecoration') && !actor.lineage.includes('engine.decoration')) continue;
    if (queries) linkDecorationCollision(queries, actor);
    decorations.push(actor);
  }

  // ---- Original map-pawn startup and per-tick scheduling ----
  // Attached pawn-ancestry map actors in serialized actor-array order,
  // excluding the player (it runs its own recovered PlayerTick route). Map
  // startup runs the recovered UGameEngine::LoadMap shared passes — one
  // InitExecution pass, then the shared event/native passes below — over the
  // live actor array each load/reset (see the LoadMap block under resetNpcs);
  // pawns are then ticked through the recovered standalone Actor.Tick
  // (animation -> ProcessState -> physics -> pawn tail) each frame. Every
  // scripted method and state on the class chain is prepared BEFORE startup:
  // the VM advances a state cursor before dispatch, so a prepare-on-demand
  // throw inside a state body would permanently skip that statement on retry
  // (the original links all script code at load).
  const npcPawns = [];
  const npcPawnSet = new Set();
  const npcFailures = new Map();
  for (const actor of level.actors ?? []) {
    const record = actor && actor !== playerActor ? identities.get(actor) : null;
    if (!record) continue;
    for (let cls = record.cls; cls; cls = cls.base)
      if (cls.record.key === 'engine.pawn') { npcPawns.push(actor); npcPawnSet.add(actor); break; }
  }

  // The original runs the LoadMap event chain for every map actor, not just
  // pawns. PatrolPoint ancestry is the non-pawn subset the live ScriptedPawn
  // Patrolling path demonstrates: PatrolPoint.PreBeginPlay resolves the
  // serialized Nextpatrol name into NextPatrolPoint through the AllActors
  // iterator and seeds lookDir = 200*vector(Rotation). Without that chain the
  // link stays None and a patrolling pawn ends its route in Standing after the
  // first leg instead of continuing. Other non-pawn classes stay unadmitted
  // until a live original body reaches them.
  const npcPatrolPoints = [];
  const npcPatrolPointSet = new Set();
  for (const actor of level.actors ?? []) {
    const record = actor && actor !== playerActor ? identities.get(actor) : null;
    if (!record) continue;
    for (let cls = record.cls; cls; cls = cls.base)
      if (cls.record.key === 'engine.patrolpoint') { npcPatrolPoints.push(actor); npcPatrolPointSet.add(actor); break; }
  }

  // World inventory pickups: Engine.Inventory-ancestry items placed in the map
  // and not yet carried (no Owner, not hidden, positioned). Admitting them to
  // the LoadMap startup runs SetInitialState -> GotoState('Auto'), the auto
  // Pickup state (STATE_Auto) every Inventory class declares, so a frobbed item
  // dispatches the real Inventory.Pickup.Frob give path instead of the empty
  // base Actor.Frob. The spawned nanokey ring is Owner-carried, so it is
  // excluded (docs/script-item-pickup.md).
  const npcPickups = [];
  const npcPickupSet = new Set();
  for (const actor of level.actors ?? []) {
    const record = actor && actor !== playerActor ? identities.get(actor) : null;
    if (!record) continue;
    if (runtime.namedReference(actor, 'Owner').get() || runtime.namedReference(actor, 'bHidden').get()
      || !runtime.namedReference(actor, 'Location').get()) continue;
    for (let cls = record.cls; cls; cls = cls.base)
      if (cls.record.key === 'engine.inventory') { npcPickups.push(actor); npcPickupSet.add(actor); break; }
  }

  // Map decorations: Engine.Decoration-ancestry actors. The LoadMap startup
  // dispatches its event passes to every live actor; admitting them runs their
  // PreBeginPlay..PostPostBeginPlay chain, and SetInitialState's
  // GotoState('Auto') enters DeusExDecoration's `auto state Active`, whose
  // TakeDamage owns the HitPoints/ResetScaleGlow/Frag destruction path a
  // crowbar swing reaches (docs/script-weapon-fire.md). Their startup bodies
  // draw no random numbers in Training (bGenerateFlies is false, so
  // PreBeginPlay's `bGenerateFlies && FRand() < 0.1` short-circuits).
  const npcDecorations = [];
  const npcDecorationSet = new Set();
  for (const actor of level.actors ?? []) {
    const record = actor && actor !== playerActor ? identities.get(actor) : null;
    if (!record) continue;
    for (let cls = record.cls; cls; cls = cls.base)
      if (cls.record.key === 'engine.decoration') { npcDecorations.push(actor); npcDecorationSet.add(actor); break; }
  }

  // A carried item's Actor.Tick advances its animation over its CURRENT Mesh —
  // the player-view mesh once BecomeItem swaps it in — through the synchronous
  // meshPayload boundary, which cannot await. Decode every view mesh a
  // carriable item can switch to at load (its own values and class defaults).
  async function prepareItemViewMeshes(cls, actor = null) {
    for (const name of ['Mesh', 'PlayerViewMesh', 'PickupViewMesh', 'ThirdPersonMesh']) {
      const field = runtime.lookupMember(cls, 'fields', name);
      if (!field) continue;
      for (const reference of [actor ? runtime.namedReference(actor, name).get() : null, runtime.defaultValue(cls, field)]) {
        if (!reference || !['LodMesh', 'Mesh'].includes(reference.kind)) continue;
        const resource = await runtime.prepareResource(reference);
        if (resource.payloadStatus !== 'decoded-lodmesh')
          throw new Error(`Original item view mesh payload is unsupported: ${reference.key}`);
      }
    }
  }

  const preparedNpcClasses = new Set();
  const prepareNpcMember = async member => {
    if (member.kind === 'State' || member.function) return;
    const index = member.asset?.exportsByPath?.get(member.key.slice(member.key.indexOf('.') + 1));
    if (index != null) await runtime.prepareFunction(member.asset, index);
  };
  async function prepareNpcClass(cls) {
    for (let node = cls; node && node.record.key !== 'core.object'; node = node.base) {
      if (preparedNpcClasses.has(node)) continue;
      preparedNpcClasses.add(node);
      for (const member of node.methods?.values() ?? []) await prepareNpcMember(member);
      for (const state of node.states?.values() ?? []) {
        if (state.kind !== 'State') continue;
        const index = state.asset?.exportsByPath?.get(state.key.slice(state.key.indexOf('.') + 1));
        const prepared = index != null ? await runtime.prepareState(state.asset, index) : null;
        for (const member of prepared?.methods?.values() ?? []) await prepareNpcMember(member);
      }
    }
  }
  async function prepareNpcs() {
    // Pawn bodies also invoke virtuals on attached non-pawn objects — the
    // player's SeePlayer/CanStartConversation path and LevelInfo services —
    // so those class chains link at load too, same as each NPC's own.
    await prepareNpcClass(playerClass);
    await prepareNpcClass(levelClass);
    // ScriptedPawn idle/bark calls reach the player's spawned BarkManager
    // (player.barkManager.StartBark/BuildBarkName). Its subsystem class chain
    // links at load as well so the bodies reach their real boundaries.
    const barkManager = runtime.namedReference(playerActor, 'barkManager')?.get?.();
    if (barkManager) await prepareNpcClass(runtime.instance(barkManager).cls);
    // ScriptedPawn conversation checks reach into the player's UI:
    // DeusExPlayer.CanStartConversation calls
    // DeusExRootWindow(rootWindow).CanStartConversation — link that class
    // chain at load for the same reason as barkManager.
    const rootWindow = runtime.namedReference(playerActor, 'rootWindow')?.get?.();
    if (rootWindow) await prepareNpcClass(runtime.instance(rootWindow).cls);
    // A carried DeusExWeapon's per-frame Tick and fire path reach the player's
    // subsystems — CalculateAccuracy/GetWeaponSkill -> SkillSystem and its
    // skill objects, GetShotTime/ProcessTraceHit -> AugmentationSystem's
    // GetAugLevelValue over the augmentation chain — so those class chains
    // link at load for the same reason (docs/script-weapon-fire.md).
    // The player-startup NanoKeyRing is carried from the first frame; its
    // view meshes join the same load-time preparation as the map pickups.
    await prepareItemViewMeshes(await runtime.loadClass(deusEx, deusEx.exportsByPath.get('nanokeyring')));
    const skills = runtime.namedReference(playerActor, 'SkillSystem')?.get?.();
    const augmentations = runtime.namedReference(playerActor, 'AugmentationSystem')?.get?.();
    for (const [manager, head] of [[skills, 'FirstSkill'], [augmentations, 'FirstAug']]) {
      if (!manager) continue;
      await prepareNpcClass(runtime.instance(manager).cls);
      for (let node = runtime.namedReference(manager, head).get(), guard = 0; node && guard < 64;
        node = runtime.namedReference(node, 'next').get(), guard++)
        await prepareNpcClass(runtime.instance(node).cls);
    }
    for (const actor of npcPawns) {
      try {
        await prepareNpcClass(identities.get(actor).cls);
        await runtime.prepareMesh(actor);
        // ScriptedPawn.InitializeInventory's Spawn calls run on the pawn's
        // first ProcessState tick against the serialized InitialInventory
        // slots. Link and prepare every referenced item class — plus its own
        // class-valued defaults (Weapon.AmmoName reaches the body's
        // Class<Ammo> cast) — now, at load: the VM advances a state cursor
        // before dispatch, so a prepare-on-demand failure would permanently
        // skip an already-consumed statement.
        const initialInventory = runtime.namedReference(actor, 'InitialInventory')?.get?.() ?? [];
        for (const slot of initialInventory) {
          for (const [key, value] of Object.entries(slot ?? {})) {
            if (!key.toLowerCase().endsWith('.inventory') || !value) continue;
            const itemClass = await runtime.loadClass(value.asset, value.index);
            await prepareNpcClass(itemClass);
            // Only classes that declare/inherit AmmoName (Weapon ancestry)
            // reference a second class through it — Ammo subclasses do not.
            const ammoField = runtime.lookupMember(itemClass, 'fields', 'AmmoName');
            const ammoRef = ammoField ? runtime.defaultValue(itemClass, ammoField) : null;
            if (ammoRef) {
              const ammoClass = await runtime.loadClass(ammoRef.asset, ammoRef.index);
              await prepareNpcClass(ammoClass);
              if (ammoClass.nameCounter === 0) ammoClass.nameCounter = 1;
            }
            // Fresh-object naming continues each class's original counter;
            // the player-startup subsystem spawn applies the same convention
            // (script-player-startup.mjs).
            if (itemClass.nameCounter === 0) itemClass.nameCounter = 1;
          }
        }
      } catch (error) {
        npcFailures.set(actor, String(error?.message ?? error));
      }
    }
    // PatrolPoint class chains link at load for the same reason: their
    // PreBeginPlay bodies run in resetNpcs on every load/reset.
    for (const actor of npcPatrolPoints) {
      try {
        await prepareNpcClass(identities.get(actor).cls);
      } catch (error) {
        npcFailures.set(actor, String(error?.message ?? error));
      }
    }
    // World inventory pickups reach their give path when frobbed: link the
    // Level.Game GameInfo (PickupQuery) and, for weapons, the default ammo class
    // their GiveTo spawns. The item class chains themselves link in the
    // Decoration/Inventory base-fixup pass below.
    const gameInfo = runtime.namedReference(playerActor, 'Level').get();
    const gameObject = gameInfo && runtime.namedReference(gameInfo, 'Game').get();
    if (gameObject) { try { await prepareNpcClass(runtime.instance(gameObject).cls); }
      catch (error) { npcFailures.set(gameObject, String(error?.message ?? error)); } }
    for (const actor of npcPickups) {
      try {
        const cls = identities.get(actor).cls;
        await prepareNpcClass(cls);
        await prepareItemViewMeshes(cls, actor);
        const ammoField = runtime.lookupMember(cls, 'fields', 'AmmoName');
        const ammoRef = ammoField ? runtime.defaultValue(cls, ammoField) : null;
        if (ammoRef) {
          const ammoClass = await runtime.loadClass(ammoRef.asset, ammoRef.index);
          await prepareNpcClass(ammoClass);
          if (ammoClass.nameCounter === 0) ammoClass.nameCounter = 1;
        }
        if (cls.nameCounter === 0) cls.nameCounter = 1;
      } catch (error) {
        npcFailures.set(actor, String(error?.message ?? error));
      }
    }
    // The LoadMap base-fixup pass (0x1038daad-0x1038dbe0) runs AttachTag
    // SetBase and FindBase on Decoration/Inventory/Pawn ancestry actors; the
    // SupportActor/Attach/Detach/BaseChange dispatches resolve through each
    // hit actor's own chain — e.g. DeusExDecoration overrides BaseChange — so
    // those class chains link at load like the admitted event classes.
    for (const actor of level.actors ?? []) {
      if (!actor || actor === playerActor) continue;
      const record = identities.get(actor);
      if (!record || npcPawnSet.has(actor) || npcPatrolPointSet.has(actor)) continue;
      let gated = false;
      for (let cls = record.cls; cls; cls = cls.base)
        if (cls.record.key === 'engine.decoration' || cls.record.key === 'engine.inventory') { gated = true; break; }
      if (!gated) continue;
      // A class whose methods cannot link is a load-time boundary, not a
      // per-actor startup failure: the dispatch would throw later anyway.
      await prepareNpcClass(record.cls);
    }
  }

  // The ULevel::Tick actor-view over the scene level: ULevel::TimeSeconds is
  // the original double the game clock owns; TickTag and the deferred list are
  // the level tick's persistent parity state.
  const npcTickLevel = Object.create(level);
  Object.assign(npcTickLevel, { netMode: 0, demoRecDriver: null, tickTag: 0, deferredHead: null, inTick: 0 });
  Object.defineProperty(npcTickLevel, 'timeSeconds', { get: () => level.timeSeconds() });
  // UModel.Zones[Actor.Region.ZoneNumber].LastRenderTime, reached only after
  // LastRenderTime and bStasis/bForceStasis admit the actor.
  npcTickLevel.zoneLastRenderTime = actor => {
    const region = runtime.namedReference(actor, 'Region').get();
    // InStasis reads UModel.Zones[Region.ZoneNumber], not ZoneInfo+0x34.
    const number = region?.['engine.actor.pointregion.zonenumber'];
    return level.zoneLastRenderTimes?.[number];
  };
  const npcTickOptions = {
    level: npcTickLevel, tickType: 2,
    allocateDeferredActor: () => ({}),
    readInput: () => { throw new Error('Actor.Tick player input is not linked'); },
    // The Actor.Tick pawn tail runs FarMoveActor(Weapon, Location, 0, 0) once
    // a pawn carries a weapon. Training's NPCs keep Weapon = None, so this is
    // linked but unexercised by them (docs/script-npc-weapon-startup.md).
    farMoveActor: (actor, destination, test, noCheck) =>
      runtime.relocateSpawnedActor(actor, destination, test, noCheck),
  };

  // Non-Pawn AActor::performPhysics (actor-physics.mjs), reached from the
  // recovered Actor.Tick of every admitted non-Pawn actor. A linked map
  // decoration's Falling/Rolling run the recovered, oracle-validated routines
  // (runDecorationPhysics: physFalling/processLanded/physRolling and the
  // non-Pawn processHitWall 0x103cecc0) against the LIVE level hash (the
  // creation-time `queries` closure is replaced by a rebuilt hash on every
  // reset). Spawned collision actors use live field-backed falling and landing;
  // physicsRotation (0x103ca1e0) is shared by map and spawned actors.
  const linkedDecorations = new Set(decorations);
  function decorationMovement(actor, delta) {
    if (!linkedDecorations.has(actor) || !level.hash)
      throw new Error(`Non-Pawn physFalling/physRolling for ${runtime.instance(actor).cls.record.key} is not linked`);
    runDecorationPhysics(actor, delta, {
      queries: level.hash,
      zone: zoneAt?.(actor.position ?? actor.values?.Location) ?? {},
      landedEvent: normal => runtime.processEvent(actor, 'Landed', [normal]),
      // Non-Pawn processHitWall (0x103cecc0), recovered and oracle-validated as
      // processDecorationHitWall (docs/walking-callbacks.md): return for a Pawn
      // wall, else dispatch the unmodified HitWall(normal,wall) only while the
      // decoration probes HitWall. No Pawn direction/MinHitWall/MoveTimer path.
      onHitWall: hit => processDecorationHitWall(actor, hit?.normal ?? [0, 0, 0], hit?.actor ?? null, {
        isProbing: (source, name) => runtime.isProbing(source, name),
        dispatch: (source, event, args) => runtime.processEvent(source, event, args),
      }),
      // physRolling calls eventHitWall directly for any hit (no processHitWall).
      onHitWallEvent: (normal, wall) => runtime.processEvent(actor, 'HitWall', [normal, wall ?? null]),
    });
  }
  runtime.actorPhysics = (actor, delta) => performActorPhysics(actor, delta, {
    read: (target, name) => runtime.namedReference(target, name).get(),
    write: (target, name, value) => runtime.namedReference(target, name).set(value),
    physFalling: (actor,delta)=>runtime.collisionViewActors.has(actor)
      ?runSpawnedActorFalling(runtime,actor,delta,zoneAt?.(actor.position)??{})
      :decorationMovement(actor,delta),
    physRolling: decorationMovement,
    physicsRotation: (target,delta)=>runActorRotation(runtime,target,delta),
    processEvent: (target, name, args) => runtime.processEvent(target, name, args),
    unsupported: (target, what) => {
      throw new Error(`Non-Pawn performPhysics ${what} is not linked for ${runtime.instance(target).cls.record.key}`);
    },
  });

  runtime.relocation={actorFor:actor=>actor,
    farMoveActor:(_level,actor,destination,test,noCheck)=>runtime.collisionViewActors.has(actor)
      ?runtime.relocateSpawnedActor(actor,destination,test,noCheck)
      :runtime.relocateHeldItem(actor,destination)};

  // Runtime-spawned actors (NPC inventory items, spawned Shadows) live at the
  // tail of Level.Actors. Track them separately from the serialized map set:
  // the reset path destroys them through the recovered ULevel::DestroyActor
  // instead of restoring them, and the destroyed-actor ledger must never
  // reintroduce them (docs/script-npc-weapon-startup.md "Reset lifecycle").
  const npcSpawned = new Set();
  const npcSpawnedOwner = new Map();
  function collectSpawned(from) {
    for (let index = from; index < level.actors.length; index++) {
      const actor = level.actors[index];
      if (!actor || npcSpawned.has(actor)) continue;
      npcSpawned.add(actor);
      npcSpawnedOwner.set(actor, runtime.namedReference(actor, 'Owner')?.get?.() ?? null);
    }
  }

  // ---- UGameEngine::LoadMap shared startup passes (Engine.dll 0x1038c1f0) ----
  // The original does not run InitExecution + all five startup events per actor.
  // It runs one dedicated pass per step over the live Level.Actors array, with
  // native operations between the event passes. Each pass loop rereads the
  // array data pointer and Num per iteration and skips null slots, so actors
  // appended during a pass are reached by it and destroyed actors drop out.
  // Admission stays the supported class scope — map pawns and map PatrolPoints
  // plus nothing else; the original dispatches to every non-null slot, so an
  // actor appended mid-startup of a class outside that scope would be
  // re-dispatched there while this host leaves it to its SpawnActor chain.
  const startupAdmitted = actor => npcPawnSet.has(actor) || npcPatrolPointSet.has(actor) || npcPickupSet.has(actor)
    || npcDecorationSet.has(actor);
  // Native passes (Touching clear, SetActorZone, LastRenderTime, base fixup)
  // apply to every actor the original would have had in the array at LoadMap:
  // the serialized map actors and actors these same passes spawn. The player
  // and its post-load subsystems are excluded exactly like the original, whose
  // SpawnPlayActor runs after LoadMap.
  const startupNative = actor => actor !== playerActor && (identities.has(actor) || npcSpawned.has(actor));
  const startupField = (actor, name) => runtime.namedReference(actor, name);
  const startupRead = (actor, name) => { try { return startupField(actor, name).get(); } catch { return undefined; } };
  function runStartupEvent(event) {
    forEachLiveActor(level, actor => {
      if (!startupAdmitted(actor) || npcFailures.has(actor)) return;
      const spawnedFrom = level.actors.length;
      try { runtime.processEvent(actor, event); }
      catch (error) { npcFailures.set(actor, String(error?.message ?? error)); }
      finally {
        // Pawn startup spawns (each NPC's Shadow) join the tracked set even
        // when the chain reaches a boundary partway through.
        collectSpawned(spawnedFrom);
      }
    });
  }
  function runStartupInitExecution() {
    // 0x1038d869-0x1038d885: UObject::InitExecution (vtable +0x38) pass.
    forEachLiveActor(level, actor => {
      if (!startupAdmitted(actor) || npcFailures.has(actor)) return;
      try { runtime.initExecution(actor); }
      catch (error) { npcFailures.set(actor, String(error?.message ?? error)); }
    });
  }
  const POINTREGION_KEYS = Object.freeze({ zone: 'engine.actor.pointregion.zone',
    leaf: 'engine.actor.pointregion.ileaf', zoneNumber: 'engine.actor.pointregion.zonenumber' });
  const regionField = (actor, name) => ({
    get: () => {
      const value = startupField(actor, name).get();
      return { zone: value?.[POINTREGION_KEYS.zone] ?? null,
        leaf: value?.[POINTREGION_KEYS.leaf] ?? -1, zoneNumber: value?.[POINTREGION_KEYS.zoneNumber] ?? 0 };
    },
    set: value => startupField(actor, name).set({ [POINTREGION_KEYS.zone]: value.zone ?? null,
      [POINTREGION_KEYS.leaf]: value.leaf ?? -1, [POINTREGION_KEYS.zoneNumber]: value.zoneNumber ?? 0 }),
  });
  // The world argument for the recovered ULevel::SetActorZone body. The event
  // callbacks dispatch the real script events when a caller passes test=0; the
  // LoadMap pass uses test=1, which suppresses them like the original.
  const startupZoneWorld = {
    levelInfo, netMode: 0,
    pointRegion: position => level.pointRegion(position),
    actorLeaving: (zone, actor) => runtime.processEvent(zone, 'ActorLeaving', [actor]),
    zoneChange: (actor, zone) => runtime.processEvent(actor, 'ZoneChange', [zone]),
    actorEntered: (zone, actor) => runtime.processEvent(zone, 'ActorEntered', [actor]),
    footZoneChange: (pawn, zone) => runtime.processEvent(pawn, 'FootZoneChange', [zone]),
    headZoneChange: (pawn, zone) => runtime.processEvent(pawn, 'HeadZoneChange', [zone]),
  };
  function setStartupActorZone(actor) {
    // Pawns reuse the cached pawnPhysicsView so the Region/Foot/Head writes
    // land on the same field bindings the physics path reads. Other actors
    // only carry the ordinary Actor region triple the non-pawn route writes.
    const view = actor.isPawn
      ? (actor._pawnPhysics ?? pawnPhysicsView(actor, runtime.pawnPhysicsServices(actor)))
      : { isPawn: false,
        get deleted() { return Boolean(startupRead(actor, 'bDeleteMe')); },
        get position() { return startupField(actor, 'Location').get(); },
        get region() { return regionField(actor, 'Region').get(); },
        set region(value) { regionField(actor, 'Region').set(value); } };
    setActorZone(view, startupZoneWorld, true, true);
  }
  // Base-fixup gate at 0x1038db2c-0x1038dba2: IsA against Engine.Decoration
  // (0x10578d48), Engine.Inventory (0x10576f70) and Engine.Pawn (0x1058c660).
  const STARTUP_BASE_ANCESTRY = Object.freeze(['engine.decoration', 'engine.inventory', 'engine.pawn']);
  function startupBaseEligible(actor) {
    if (Array.isArray(actor?.lineage)) return STARTUP_BASE_ANCESTRY.some(key => actor.lineage.includes(key));
    try {
      for (let cls = runtime.instance(actor).cls; cls; cls = cls.base)
        if (STARTUP_BASE_ANCESTRY.includes(cls.record.key)) return true;
    } catch { /* unattached identity */ }
    return false;
  }
  // SetBase/SupportActor dispatch with the same levelInfo identity mapping the
  // spawned-actor services use (a BSP trace hits the collision worldActor,
  // which is the script LevelInfo).
  const startupBaseDispatch = (target, name, args = []) => runtime.dispatchSpawnedEvent(
    target === level?.hash?.levelInfo ? level.actors[0] : target, name, args);
  function fixupStartupBase(actor) {
    // 0x1038dace-0x1038db02: a live AttachTag name binds to the first live
    // actor whose Tag matches through AActor::SetBase(other, bNotify=0).
    const attachTag = startupRead(actor, 'AttachTag');
    if (hasNamedValue(attachTag)) {
      for (let index = 0; index < level.actors.length; index++) {
        const other = level.actors[index];
        if (other == null || other === actor) continue;
        if (lower(startupRead(other, 'Tag')) !== lower(attachTag)) continue;
        setBase(actor, other, startupBaseDispatch, false);
        break;
      }
      return;
    }
    // 0x1038db11-0x1038dbd5: otherwise Base==NULL && bCollideWorld && the
    // class gate && Physics in {0,5} runs AActor::FindBase; a hit on the
    // LevelInfo (BSP) is un-based again by SetBase(NULL, 0).
    if ((actor.base ?? startupRead(actor, 'Base') ?? null) !== null) return;
    if (!startupRead(actor, 'bCollideWorld')) return;
    if (!startupBaseEligible(actor)) return;
    const physics = Number(startupRead(actor, 'Physics') ?? 0);
    if (physics !== 0 && physics !== 5) return;
    findActorBase(actor, { lineCheck: (...args) => level.hash.lineCheck(...args), dispatch: startupBaseDispatch });
    if ((actor.base ?? null) === levelInfo || (actor.base ?? null) === level?.hash?.levelInfo)
      setBase(actor, null, startupBaseDispatch, false);
  }
  function clearStartupTouching() {
    // EAX increments before [actor+eax*4+0xe4] at 0x1038d818: all four
    // Touching slots (+0xe8..+0xf4) clear, with no Touch/UnTouch dispatch.
    forEachLiveActor(level, actor => {
      if (!startupNative(actor) || npcFailures.has(actor)) return;
      if (Array.isArray(actor.touching) && actor.touching.length === 4) {
        actor.touching.fill(null);
        return;
      }
      try {
        const touching = startupField(actor, 'Touching').get();
        if (Array.isArray(touching) && touching.length === 4)
          startupField(actor, 'Touching').set([null, null, null, null]);
      } catch { /* an identity without script Touching storage */ }
    });
  }
  function setStartupActorZones() {
    // 0x1038da02-0x1038da26: ULevel::SetActorZone(actor, 1, 1) on vtable +0xac.
    // test=1 suppresses the zone callbacks; force=1 rebuilds Region (and the
    // pawn Foot/Head regions) from PointRegion.
    forEachLiveActor(level, actor => {
      if (!startupNative(actor) || npcFailures.has(actor)) return;
      setStartupActorZone(actor);
    });
  }
  function writeStartupLastRenderTime() {
    // 0x1038da26-0x1038da45: LastRenderTime = -10.0f on every live actor.
    forEachLiveActor(level, actor => {
      if (!startupNative(actor) || npcFailures.has(actor)) return;
      try { startupField(actor, 'LastRenderTime').set(-10); }
      catch { /* an identity without script LastRenderTime storage */ }
    });
  }
  function fixupStartupBases() {
    forEachLiveActor(level, actor => {
      if (!startupNative(actor) || npcFailures.has(actor)) return;
      fixupStartupBase(actor);
    });
  }
  function partitionStartupActors() {
    const { actors, firstNetActor } = partitionActorArray(level.actors, actor =>
      Boolean(startupRead(actor, 'bStatic') ?? actor?.static ?? ((actor?.actorFlags ?? 0) & 1)));
    level.iFirstNetActor = firstNetActor;
    level.actors = actors;
  }
  function clearStartupPawnList() {
    // Level.PawnList membership is the original's callback-order list: the
    // host's collidable rebuild inserted every pawn already, so evict those
    // entries and let the PreBeginPlay pass rebuild membership solely through
    // each pawn's own AddPawn — a second head-insert would self-cycle the
    // list MakeNoise and perception walk (docs/pawn-list.md).
    const seen = new Set();
    for (let pawn = level.pawnList; pawn && !seen.has(pawn); pawn = pawn.nextPawn) seen.add(pawn);
    for (const pawn of seen) pawn.nextPawn = null;
    level.pawnList = null;
  }

  const NPC_HOST_PROPS = Object.freeze(['position', 'rotation', 'physics', 'base', 'velocity',
    'standingCount', 'motionFlags', 'pawnFlags', 'hitSlopedWall', 'touching', 'waitingPawn',
    'marker', 'specialGoal', 'clientUpdate', 'simOldPosition', 'simOldRotYaw', 'simOldRotPitch',
    'simOldRotRoll', 'simInterpolate', 'realPosition', 'realRotation', 'ambientSound',
    'nextPawn', 'collisionValues', '_pawnPhysics']);
  // Restore the serialized map state the original regains by reloading the
  // level, relink the pawn into Level.PawnList (playerScene.reset rebuilds the
  // list from the collidable set only), then re-run the LoadMap startup chain.
  // An actor whose startup reaches an explicit boundary — e.g. the armed NPCs'
  // Inventory SpawnActor inside InitializeInventory — is recorded and left out
  // of ticking instead of resuming a half-advanced state.
  function resetNpcs() {
    // Destroy every runtime-spawned actor first, in reverse spawn order, so
    // Inventory.Destroyed -> Pawn.DeleteInventory / Weapon.Destroyed ->
    // Owner.Weapon clear / SetBase(NULL) StandingCount-1 / SetOwner(NULL)
    // LostChild all run while the owner pawns still hold their live state —
    // exactly the recovered ULevel::DestroyActor order the original's level
    // reload implies (docs/script-npc-weapon-startup.md "Reset lifecycle").
    // This is also what fixes the measured spawned-Shadow leak (15->29->52).
    for (const actor of [...npcSpawned].reverse()) {
      if (!level.actors.includes(actor)) continue;
      let instance = null;
      try { instance = runtime.instance(actor); } catch { instance = null; }
      if (!instance || instance.pendingKill) continue;
      runtime.destroyActor(actor, false);
    }
    npcSpawned.clear();
    npcSpawnedOwner.clear();
    npcFailures.clear();
    // Destruction must see the old world first. Now reload the authored map
    // prefix, preserving the surviving player/subsystem tail exactly once.
    const persistentTail = level.actors.filter(actor => actor && !initialActorSet.has(actor));
    level.actors = [...initialActorArray, ...persistentTail];
    level.zoneLastRenderTimes?.fill(0);
    // Restore the serialized map state before any startup callback can observe
    // another actor — the same reload state the original reaches by loading
    // the level. The passes below then run LoadMap's shared schedule.
    for (const actor of npcPawns) {
      try {
        // The collision hash validates that the live transform still matches
        // the registration (level-queries changeActor contract): unregister
        // through the current hash BEFORE restoring serialized state — the
        // closure `queries` goes stale after reset's registerActors rebuild —
        // then re-register at the restored location so no tick window leaves
        // the pawn unregistered.
        level.hash?.removeActor(actor);
        identities.get(actor).store.clear();
        for (const prop of NPC_HOST_PROPS) delete actor[prop];
        if (actor.values?.Location) actor.position = [...actor.values.Location];
        actor.isPawn = true; actor.pawnFlags = 0;
        // Restore serialized Touching refs before LoadMap clears all four.
        actor.touching = [0, 1, 2, 3].map(i => actorByIndex.get(actor.values?.[i ? `Touching[${i}]` : 'Touching']) ?? null);
        // The recovered AActor::SetBase (walking-callbacks.mjs) mutates
        // standingCount on the raw host — NPC inventory SetBase(Self) calls
        // arrive through the script, not a binding — so reseed it from the
        // serialized field like the other live host props.
        actor.standingCount = actor.values?.StandingCount ?? 0;
        actor.base = actorByIndex.get(actor.values?.Base) ?? null;
        actor.waitingPawn = actorByIndex.get(actor.values?.WaitingPawn) ?? null;
        actor.marker = actorByIndex.get(actor.values?.MyMarker) ?? null;
        level.hash?.addActor(actor);
      } catch (error) {
        npcFailures.set(actor, String(error?.message ?? error));
      }
    }
    // PatrolPoint actors get the same serialized-state restore; they hold no
    // pawn host props and never move, so the restore is just the field store
    // and Location.
    for (const actor of npcPatrolPoints) {
      try {
        identities.get(actor).store.clear();
        if (actor.values?.Location) actor.position = [...actor.values.Location];
      } catch (error) {
        npcFailures.set(actor, String(error?.message ?? error));
      }
    }
    // The map reload returns picked-up items to the world. discardKeyRing above
    // already removed the ring; detach everything JC acquired during play from
    // the Inventory list — the serialized pickups (returned to the world by the
    // store.clear below) and the ammo their GiveTo spawned (a play spawn, so it
    // is not in the serialized map set and is left orphaned, holding no
    // Location). spawnKeyRing re-adds the ring after resetNpcs.
    let prevInv = null, invItem = runtime.namedReference(playerActor, 'Inventory').get();
    while (invItem && typeof invItem === 'object') {
      const nextInv = runtime.namedReference(invItem, 'Inventory').get();
      if (npcPickupSet.has(invItem) || !initialActorSet.has(invItem)) {
        if (prevInv) runtime.namedReference(prevInv, 'Inventory').set(nextInv);
        else runtime.namedReference(playerActor, 'Inventory').set(nextInv);
      } else prevInv = invItem;
      invItem = nextInv;
    }
    for (const actor of npcPickups) {
      try {
        identities.get(actor).store.clear();
        if (actor.values?.Location) actor.position = [...actor.values.Location];
      } catch (error) {
        npcFailures.set(actor, String(error?.message ?? error));
      }
    }
    // Decorations regain their serialized state too (HitPoints, ScaleGlow,
    // state frame, a pushed position): the original reloads them with the
    // level. A decoration whose hash cylinder tracks its live position is
    // moved inside the rebuilt hash's remove/re-add (level-queries contract).
    for (const actor of npcDecorations) {
      try {
        identities.get(actor).store.clear();
        const restore = () => {
          if (actor.values?.Location) actor.position = [...actor.values.Location];
          delete actor.velocity; delete actor.acceleration; delete actor.landingCounter;
          actor.base = actorByIndex.get(actor.values?.Base) ?? null;
        };
        if (level.hash && actor.collisionValues && actor.collideActors !== false) level.hash.changeActor(actor, restore);
        else restore();
      } catch (error) {
        npcFailures.set(actor, String(error?.message ?? error));
      }
    }
    // The original Player start reloads the level, giving a fresh player with an
    // empty hand and no drawn weapon; this host reuses the player identity, so
    // clear the in-hand / weapon selection it may have made in Play. The selected
    // item itself is a serialized pickup already returned to the world above; at
    // map start these player fields are None/false (their class defaults).
    for (const field of ['inHand', 'inHandPending', 'ClientInHandPending', 'SelectedItem', 'Weapon', 'PendingWeapon'])
      runtime.namedReference(playerActor, field).set(null);
    runtime.namedReference(playerActor, 'bInHandTransition').set(false);
    // A held fire button does not survive the reload either (input byte 0).
    runtime.namedReference(playerActor, 'bFire').set(0);
    clearStartupPawnList();
    clearStartupTouching();
    // ULevel::IsServer (vtable +0x84) gates a client-only Role swap/destroy
    // pass; standalone netMode 0 is a server, so that pass never runs here.
    runStartupInitExecution();
    // 0x1038d885-0x1038d899: LevelInfo +0x4f0 |= 0x42 — bBegunPlay|bStartup.
    // The cold path also zeros ULevel+0xdc/+0xe0 and LevelInfo+0x478
    // (TimeSeconds); the game clock owns those and restores them on reset.
    startupField(levelInfo, 'bBegunPlay').set(true);
    startupField(levelInfo, 'bStartup').set(true);
    startupField(levelInfo, 'TimeSeconds').set(0);
    // 0x1038d897: the original calls `Game->InitGame(Options, Error)` when
    // LevelInfo.Game is set. In the original standalone LoadMap the GameInfo
    // is spawned inside LoadMap itself before this point; this host has no
    // original game spawn — the live DataLink fixture populates Game with a
    // 'DataLink runtime' stub for the script reads that need it, so the
    // InitGame dispatch remains an unimplemented LoadMap branch (documented
    // in docs/script-loadmap-startup.md), not a runtime call on the stub.
    runStartupEvent('PreBeginPlay');
    runStartupEvent('BeginPlay');
    setStartupActorZones();
    writeStartupLastRenderTime();
    runStartupEvent('PostBeginPlay');
    runStartupEvent('SetInitialState');
    fixupStartupBases();
    // 0x1038dbe0: LevelInfo +0x4f0 &= ~0x40 — bStartup clear before the last pass.
    startupField(levelInfo, 'bStartup').set(false);
    runStartupEvent('PostPostBeginPlay');
    // 0x1038dcd5 tail: static/dynamic partition with the net boundary recorded.
    partitionStartupActors();
    // SpawnPlayActor's player construction runs after LoadMap and the player's
    // own Pawn.PreBeginPlay -> AddPawn owns the list head.
    addPawn(level, playerActor);
  }

  // Live TriggerLights (base Engine.TriggerLight). createScriptLights shares this
  // runtime, runs their native startup (BeginPlay -> SetInitialState) so they enter
  // TriggerToggle, and drives their Trigger/Tick bodies. This is what makes a
  // LightSwitch.Frob's AllActors(Event) fanout (Actor.Trigger on each tagged light)
  // dispatch to the real state Trigger instead of the empty base. Subclasses are
  // outside this selected subset and are left inert (docs/script-light-switch.md).
  const triggerLightClass = await loadClass(engine, 'triggerlight', 'Engine.TriggerLight class');
  const triggerLights = (level.actors ?? []).filter(actor => {
    try { return runtime.instance(actor).cls.record === triggerLightClass.record; } catch { return false; }
  });
  const lights = await createScriptLights({ runtime, assets, lights: triggerLights });
  const missionTriggers=(level.actors??[]).filter(actor=>actor?.lineage?.includes('engine.trigger'));

  const records = [];
  for (const mover of movers) {
    if (!selectedMover(mover,level) && !mover?.supported) continue;
    if (!selectedMover(mover,level)) throw new Error(`Mover is marked supported outside the selected TriggerToggle subset: ${mover?.name ?? '<unnamed>'}`);
    const state = mover.interpolation;
    if (!state) throw new Error(`Doors.reset() must create interpolation state before attaching ${mover.name}`);
    const entry=asset?.pkg.exports[mover.index-1];
    if(!entry||(await runtime.loadClass(asset,entry.classIndex)).record!==deusExMoverClass.record){
      throw new Error(`Mover subclass is outside the prepared script subset: ${mover.name}`);
    }
    const record = await attach(mover, deusExMoverClass, 'mover');
    moversByObject.set(mover, record);
    record.mover = mover;
    records.push(record);
  }

  function resetMover(record) {
    const mover = record.mover, values = mover.values ?? {}, state = mover.interpolation;
    if (!state) throw new Error(`Doors.reset() removed interpolation state for ${mover.name}`);
    const pairs = moverKeyPairs(mover);
    state.basePosition = vector(values.BasePos ?? values.Location);
    state.baseRotation = vector(values.BaseRot ?? values.Rotation, true);
    state.oldPosition = vector(state.position ?? values.Location);
    state.oldRotation = vector(state.rotation ?? values.Rotation, true);
    state.keyPositions = pairs.positions;
    state.keyRotations = pairs.rotations;
    state.scriptInterpolateEnd = true;
    state.onInterpolateEnd = () => {
      runtime.processEvent(mover, 'InterpolateEnd', [null]);
    };
    record.store.clear();
    record.state.transition(triggerState, deusExMoverClass.metadata);
    mover.target = 0; mover.active = false; mover.alpha = 0;
    mover.clientUpdate = 0;
    mover.ambientSound = values.AmbientSound ?? null;
    mover.realPosition = vector(values.RealPosition ?? values.Location);
    mover.realRotation = vector(values.RealRotation ?? values.Rotation, true);
    mover.simOldPosition = vector(values.SimOldPos ?? values.Location);
    mover.simOldRotYaw = Number(values.SimOldRotYaw ?? 0) | 0;
    mover.simOldRotPitch = Number(values.SimOldRotPitch ?? 0) | 0;
    mover.simOldRotRoll = Number(values.SimOldRotRoll ?? 0) | 0;
    mover.simInterpolate = vector(values.SimInterpolate);
    mover.physics = values.Physics ?? mover.physics ?? 0;
  }

  function updateDisplay(record) {
    const mover = record.mover, state = mover.interpolation;
    const scriptState = record.state;
    mover.active = Boolean(state.interpolating || scriptState.latent ||
      scriptState.execution && scriptState.execution.cursor !== null);
    mover.alpha = state.interpolating ? state.key === 1 ? f(state.alpha) : f(1 - state.alpha) : state.key;
  }

  let liveDataLink=null;
  let playerStartup=null;

  // World destruction services and the browser-side ledger that "Player start"
  // uses to return destroyed actors to their serialized map state, which the
  // original reaches by reloading the level (docs/script-world-destroy.md).
  const destroyedActors=createDestroyedActorLedger({level,runtime});
  const destroyServices=createWorldDestroyServices({runtime,level,dispatch,
    hash:()=>{
      if(!level.hash)throw new Error('Live DestroyActor requires the level collision hash');
      return level.hash;
    }});

  function reset() {
    playerLogs?.reset();
    // Player start reloads the map and its inventory. Reuse the native window
    // tree, but clear its belt through the original helper before the new
    // KeyRing GiveTo/AddInventory path publishes the replacement in slot 0.
    if(windowHost?.hud){
      const belt=runtime.namedReference(windowHost.hud,'belt').get();
      runtime.callFunction(runtime.lookup(belt,'ClearBelt'),belt,0);
    }
    playerStartup?.discardKeyRing?.();
    destroyedActors.restore(receiver=>identities.get(receiver)?.store.clear());
    liveConPlay?.reset();
    // Destroy the mission actor before the map reload so its reset-time
    // destruction precedes the NPC startup's shadow destroys (it is re-spawned
    // into the restored world after resetNpcs, below).
    liveMission?.destroy();
    liveDataLink?.reset();
    faceConversations?.reset?.();
    triggerActions.flagBase.entries.clear();
    for (const [key, value] of initialFlags) triggerActions.flagBase.entries.set(key, {...value});
    for (const record of records) resetMover(record);
    // Re-run the TriggerLights' native startup so they return to TriggerToggle.
    lights.reset();
    if (onLightingChanged) onLightingChanged(lights.collectLightingChanges({ force: true }));
    // player-scene.reset() relinks Level.PawnList. Attach any newly linked
    // identity before a later FinishNotify can traverse it. Bindings themselves
    // read the list dynamically on every script field access.
    // Map pawns restore their serialized state and re-run the LoadMap startup
    // chain (the original reloads the level on "Player start"). This must run
    // after playerScene.reset rebuilt the pawn list; game.reset orders it so.
    resetNpcs();
    // Bind the local viewport listener onto PlayerPawn.Player. The engine sets
    // this to the possessing viewport for the local player; here it is the same
    // Client.Viewports[0] listener GetPlayerPawn (720) already follows. Original
    // reachable bytecode such as DeusExPlayer.GetDisplayName gates on
    // (player == None) — an unset viewport made the conversation speaker name
    // resolve to "" — while the native readInput path stays dormant because the
    // viewer, not Level.Tick, drives this pawn (docs/script-instructor-conversation.md).
    const viewport = level?.engine?.client?.viewports?.[0] ?? null;
    if (viewport) runtime.namedReference(playerActor, 'Player').set(viewport);
    // Re-spawn the mission actor into the freshly restored world so its timer
    // and state machine start over (the original reloads the level on reset).
    liveMission?.spawn();
    playerStartup?.spawnKeyRing?.();
    // The reloaded player is a fresh SpawnActor product: bTicked = !Level tick
    // parity (script-spawn.mjs), so the first frame defers what it owns.
    runtime.namedReference(playerActor, 'bTicked').set(!Boolean(npcTickLevel.tickTag));
  }

  // Pushable decorations that have been bumped: their SetTimer(0.2) push-sound
  // lifetime is advanced each tick until the one-shot Timer clears it.
  const bumpedDecorations = new Set();

  const isDecoration = actor =>
    Boolean(actor?.lineage?.includes('deusex.deusexdecoration') || actor?.lineage?.includes('engine.decoration'));

  /** General scene-event router: run an attached actor's real event bytecode
   * through the linked VM (docs/scene-events.md). This is the single VM entry the
   * scene adapter delegates to for any actor/event outside its recovered
   * native-semantics branches. Returns `{handled:false}` when the class ancestry
   * declares no such function — the original empty-event no-op (e.g. Actor.HitWall
   * on a plain actor); returns `{handled:true, result}` when the real body ran. A
   * body that reaches a not-yet-prepared function or an unimplemented native still
   * throws the original specific pause, now from the real bytecode rather than the
   * adapter. Synchronous: the movement/touch callers dispatch within the tick, so
   * event functions must be prepared at setup (per milestone), not on demand. */
  function dispatchEvent(target, event, args = []) {
    let attached = identities.has(target);
    if (!attached) {
      try { attached = Boolean(runtime.instance(target)); } catch { attached = false; }
    }
    if (!attached)
      throw new Error(`Scene event target is not attached to the script runtime: ${target?.name ?? '<unnamed>'}.${event}`);
    const record = runtime.lookup(target, event);
    if (!record) return { handled: false };
    if (!record.function)
      throw new Error(`Original scene event is not prepared: ${runtime.instance(target).cls.record.key}.${event}`);
    const invoke=()=>runtime.processEvent(target,event,args);
    const result=liveConPlay?liveConPlay.withLifecycle(invoke):invoke();
    // A pushable decoration's Bump starts a SetTimer(0.2) push-sound lifetime the
    // tick advances (bumpedDecorations); track it here now that decoration Bump
    // routes through the general path (docs/script-plant-contact.md).
    if (event === 'Bump' && isDecoration(target)) bumpedDecorations.add(target);
    return { handled: true, result };
  }

  /** Back-compat wrapper for the decoration Bump entry (now the general router). */
  function bumpDecoration(decoration, other) {
    const outcome = dispatchEvent(decoration, 'Bump', [other]);
    if (!outcome.handled) throw new Error(`Bumped decoration has no Bump body: ${decoration?.name ?? '<unnamed>'}`);
  }

  /** Signature of the state a Trigger changes on one prepared mover, so a frob
   * can report exactly which movers its body triggered. TriggerToggle.Trigger
   * selects a state label, which moves the FStateFrame cursor before any
   * interpolation runs, so both halves are part of the signature. */
  function frobSignature(record) {
    const state = record.mover.interpolation, script = record.state;
    return `${state.key}/${state.previousKey}/${state.interpolating ? 1 : 0}/${f(state.alpha ?? 0)}` +
      `|${script.latent}/${script.execution ? script.execution.cursor : 'none'}`;
  }

  /** Original DeusExMover.Frob. Play's door use runs this body instead of a
   * host lock/one-way/group substitute, so bFrobbable, bDestroyed, bSlave,
   * bPicking, the KeyNum/PrevKeyNum "already open" test, the bOneWay GetAxes
   * dot product, the lock branches and the Tag fanout through native AllActors
   * are all the original's decisions. `frobWith` is the item in the player's
   * hand; Play has no inventory yet and passes None, which is the branch the
   * original takes for an empty hand. A non-null frobWith would reach the
   * Lockpick/NanoKeyRing paths, which need Stage-5 inventory.
   *
   * The body's own localized ClientMessage stays a recorded boundary: the
   * original delivers it through Player.Console, and that console/HUD
   * presentation is Stage 4. The recorded string is the one the bytecode
   * selected from the class's localized defaults, not a host message.
   */
  function frobMover(mover, frobber = playerActor, frobWith = null) {
    if (!moversByObject.has(mover))
      throw new Error(`Mover is outside the prepared TriggerToggle subset: ${mover?.name ?? '<unnamed>'}`);
    const before = records.map(item => [item, frobSignature(item)]);
    const messages = [];
    const messageKey = runtime.lookup(frobber, 'ClientMessage')?.key ?? null;
    const hadBoundary = messageKey !== null && runtime.boundaryFunctions.has(messageKey);
    const previousBoundary = messageKey === null ? undefined : runtime.boundaryFunctions.get(messageKey);
    if (messageKey !== null) runtime.boundaryFunctions.set(messageKey, call => {
      // This route's argument is the body's local `msg` string, so evaluating
      // it has no effects of its own.
      messages.push(call.argumentCount > 0 ? refValue(call.evaluateArgument(0)) : '');
      return undefined;
    });
    try {
      runtime.processEvent(mover, 'Frob', [frobber, frobWith]);
    } finally {
      if (messageKey !== null) {
        if (hadBoundary) runtime.boundaryFunctions.set(messageKey, previousBoundary);
        else runtime.boundaryFunctions.delete(messageKey);
      }
    }
    // Display bookkeeping for exactly the movers the body actually triggered;
    // a refused frob leaves every interpolation state untouched.
    const triggered = [];
    for (const [item, signature] of before) {
      if (frobSignature(item) === signature) continue;
      item.mover.target = stateLabelForTarget(item.mover) === 'open' ? 1 : 0;
      item.mover.active = true;
      triggered.push(item.mover);
    }
    return { messages, triggered };
  }

  function use(mover, group = [mover]) {
    const selected = [...new Set((Array.isArray(group) ? group : [group]).map(item => item?.actor ?? item))];
    if (!selected.length) throw new Error('TriggerToggle use requires at least one mover');
    for (const target of selected) {
      const record = moversByObject.get(target);
      if (!record) throw new Error(`Mover is outside the prepared TriggerToggle subset: ${target?.name ?? '<unnamed>'}`);
      const accepted = !target.values?.bDestroyed;
      runtime.processEvent(target, 'Trigger', [playerActor, playerActor]);
      if (accepted) {
        target.target = stateLabelForTarget(target) === 'open' ? 1 : 0;
        target.active = true;
      }
    }
    return { ok: true, mover, actors: selected };
  }

  // Inventory the player carries, walked from Pawn.Inventory: picked-up map
  // pickups and items spawned into the chain (GiveTo's ammo, the key ring).
  // The original ULevel::Tick ticks every live actor; this host admits the
  // carried ones (Physics None, no collision after BecomeItem), which is what
  // advances a drawn weapon's latent states, animation notifies and Tick
  // (docs/script-weapon-fire.md). World pickups still resting in their Pickup
  // state stay unticked: their PHYS_Falling needs the non-Pawn performPhysics.
  function playerCarriedItems() {
    const carried = new Set();
    for (let item = runtime.namedReference(playerActor, 'Inventory').get(), guard = 0;
      item && typeof item === 'object' && guard < 256; item = runtime.namedReference(item, 'Inventory').get(), guard++)
      carried.add(item);
    return carried;
  }
  // One carried item's Actor.Tick. A boundary reached by the player's own
  // weapon is not skipped silently: it is recorded and rethrown so Play pauses
  // on the explicit original boundary instead of freezing the weapon mid-state.
  function tickCarried(actor, delta) {
    if (npcFailures.has(actor) || runtime.instance(actor).pendingKill) return 0;
    const spawnedFrom = level.actors.length;
    let ticked = 0;
    try { ticked = liveConPlay.withLifecycle(() => runtime.processActorTick(actor, delta, npcTickOptions)); }
    catch (error) {
      npcFailures.set(actor, String(error?.message ?? error));
      throw error;
    } finally { collectSpawned(spawnedFrom); }
    return ticked;
  }

  function tick(seconds, { tickPlayer = null } = {}) {
    const delta = f(seconds);
    // ULevel::Tick 0x103a55c1-0x103a5698: with the first viewport's Actor a
    // PlayerPawn holding a Player, snapshot its Location and write
    // DistanceFromPlayer for every non-null slot from FirstDynamicActor (+0x110,
    // the LoadMap partition boundary) — all distances precede all ticks. The
    // stasis gate and ScriptedPawn.Tick read it; the map's serialized editor
    // value is never current (docs/script-level-tick.md).
    const viewer = level?.engine?.client?.viewports?.[0]?.actor ?? null;
    if (viewer === playerActor && runtime.namedReference(playerActor, 'Player').get()) {
      const origin = [...runtime.namedReference(playerActor, 'Location').get()];
      for (let index = level.iFirstNetActor ?? 0; index < level.actors.length; index++) {
        const actor = level.actors[index];
        if (!actor) continue;
        let reference;
        try { reference = runtime.namedReference(actor, 'DistanceFromPlayer'); } catch { continue; }
        reference.set(playerDistance(runtime.namedReference(actor, 'Location').get(), origin));
      }
    }
    // ULevel::Tick clears the deferred-actor list before its actor loop.
    npcTickLevel.deferredHead = null;
    let progress = 0;
    const carried = playerCarriedItems();
    for (const record of records) {
      // Actor.Tick's ProcessState phase precedes performPhysics. A newly
      // selected label therefore executes here, and a latent 302 is polled
      // before the same actor's next script statements.
      runtime.processActorScript(record.mover,delta);
      tickMoverInterpolation(record.mover.interpolation, delta);
      updateDisplay(record);
    }
    // A bumped decoration's SetTimer(0.2) push-sound lifetime now advances in
    // its own Actor.Tick timer phase (the decoration branch below), in
    // Level.Actors order, instead of a separate host pass.
    // Mission triggers share the recovered native timer step. DamageTrigger's
    // original Timer runs the prepared Training radiation chain, including the
    // GM_Trench PlayAnim state write, and stops at Human.PlayTakeHitSound's
    // Actor.PlaySound audio boundary after preserving damage and flash writes.
    for(const trigger of missionTriggers)
      updateActorTimer(runtime.timerState(trigger),delta,()=>dispatch(trigger,'Timer',[]));
    // DataLinkPlay is a spawned Actor. Its selected playback state and Timer
    // phase run after ProcessState and before physics, on the same fixed tick.
    liveDataLink?.tick(delta);
    // Pawn phase: the recovered standalone Actor.Tick runs in Level.Actors
    // array order — the original ULevel::Tick iteration. Serialized map pawns
    // (the player's own route is separate) plus every runtime-spawned
    // Inventory-ancestry actor: the items append after their owner and tick
    // after it in the same frame (docs/script-npc-weapon-startup.md "Ticking
    // the spawned items"). Spawned Shadows (Decal ancestry) are NOT ticked —
    // the recorded Shadow.Tick boundary (docs/script-decal-startup.md). An
    // actor whose startup/tick hit an explicit boundary stays in its
    // serialized pose rather than resuming a half-advanced state.
    for (let index = 0; index < level.actors.length; index++) {
      const actor = level.actors[index];
      if (!actor) continue;
      if(liveConPlay.spawned.has(actor)) {
        if(!runtime.instance(actor).pendingKill){
          const spawnedFrom=level.actors.length;
          progress+=liveConPlay.withLifecycle(()=>runtime.processActorTick(actor,delta,npcTickOptions));
          collectSpawned(spawnedFrom);
        }
      } else if (carried.has(actor)) {
        // Owner = the player, whose own route runs after this loop: the
        // recovered owner test defers the item onto the deferred list below.
        progress += tickCarried(actor, delta);
      } else if (npcDecorationSet.has(actor)) {
        // Map decorations run the recovered Actor.Tick: stasis gate (bStasis,
        // LastRenderTime), animation, the DeusExDecoration.Tick event, state
        // code, the Timer phase (a bump's push-sound lifetime) and the non-Pawn
        // performPhysics above. A reached boundary records the decoration and
        // leaves it out of later ticks, like the map pawns.
        if (npcFailures.has(actor) || runtime.instance(actor).pendingKill) continue;
        const spawnedFrom = level.actors.length;
        try { progress += liveConPlay.withLifecycle(()=>runtime.processActorTick(actor, delta, npcTickOptions)); }
        catch (error) { npcFailures.set(actor, String(error?.message ?? error)); }
        collectSpawned(spawnedFrom);
      } else if (npcPawnSet.has(actor)) {
        if (npcFailures.has(actor) || runtime.instance(actor).pendingKill) continue;
        // startup state's Begin: InitializePawn -> InitializeInventory runs on
        // the first ProcessState tick, so the armed NPCs' weapon SpawnActor
        // boundary surfaces here rather than at reset. Recording it leaves the
        // pawn out of later ticks instead of resuming a half-advanced state.
        const spawnedFrom = level.actors.length;
        try { progress += liveConPlay.withLifecycle(()=>runtime.processActorTick(actor, delta, npcTickOptions)); }
        catch (error) { npcFailures.set(actor, String(error?.message ?? error)); }
        collectSpawned(spawnedFrom);
      } else if (npcSpawned.has(actor)) {
        // Inventory, Projectile and TraceHitSpawner actors share Actor.Tick.
        // Decal-ancestry spawned Shadows remain the recorded non-ticked case.
        let lineage = null;
        try { lineage = runtime.instance(actor).cls; } catch { continue; }
        let admitted = false;
        for (let cls = lineage; cls; cls = cls.base)
          if (['engine.inventory','engine.projectile','deusex.tracehitspawner'].includes(cls.record.key)) { admitted = true; break; }
        if (!admitted || lineage === null) continue;
        const owner = npcSpawnedOwner.get(actor) ?? runtime.namedReference(actor, 'Owner').get();
        if (runtime.instance(actor).pendingKill) continue;
        if (owner && npcFailures.has(owner)) continue;
        const spawnedFrom = level.actors.length;
        try { progress += liveConPlay.withLifecycle(()=>runtime.processActorTick(actor, delta, npcTickOptions)); }
        catch (error) {
          npcFailures.set(owner ?? actor,
            `${actor.name ?? runtime.namedReference(actor, 'Name').get()}: ${String(error?.message ?? error)}`);
        }
        collectSpawned(spawnedFrom);
      } else if (liveMission?.has(actor)) {
        // The mission state machine ticks in Level.Actors order like the map
        // pawns; its SetTimer fires Mission00.Timer through Actor.Tick.
        const spawnedFrom = level.actors.length;
        try { progress += liveConPlay.withLifecycle(()=>runtime.processActorTick(actor, delta, npcTickOptions)); }
        catch (error) { npcFailures.set(actor, String(error?.message ?? error)); }
        collectSpawned(spawnedFrom);
      }
    }
    // Decoration physics now runs inside each decoration's Actor.Tick above
    // (non-Pawn performPhysics), not as a separate pass after the pawns.
    // Advance the TriggerLights' Alpha animation (their Tick/ProcessState phase).
    const lightTicks = lights.tick(delta);
    // The player's own route (the viewer's recovered movement port) runs after
    // the scripted actors, as before; its Actor.Tick writes bTicked = TickTag&1
    // (actor-tick.mjs), which is what releases the actors it owns.
    if (typeof tickPlayer === 'function') { tickPlayer(delta); progress = (progress + 1) | 0; }
    runtime.namedReference(playerActor, 'bTicked').set(Boolean(npcTickLevel.tickTag & 1));
    // ULevel::Tick's deferred list (level-tick.mjs): actors whose Owner had not
    // ticked yet when the loop reached them — the player's carried weapon —
    // tick now, once their owner's bTicked matches this frame's TickTag. Nodes
    // were pushed at the head, so they run in reverse deferral order.
    while (npcTickLevel.deferredHead && progress !== 0) {
      let node = npcTickLevel.deferredHead;
      npcTickLevel.deferredHead = null; progress = 0;
      while (node) {
        if (Number(Boolean(runtime.namedReference(node.actor, 'bTicked').get())) !== npcTickLevel.tickTag) {
          if (carried.has(node.actor)) progress = (progress + tickCarried(node.actor, delta)) | 0;
          else if (!npcFailures.has(node.actor) && !runtime.instance(node.actor).pendingKill) {
            // Any other owner-deferred actor keeps the NPC failure contract.
            const spawnedFrom = level.actors.length;
            try { progress = (progress + liveConPlay.withLifecycle(() =>
              runtime.processActorTick(node.actor, delta, npcTickOptions))) | 0; }
            catch (error) { npcFailures.set(node.actor, String(error?.message ?? error)); }
            collectSpawned(spawnedFrom);
          }
        }
        node = node.next;
      }
    }
    npcTickLevel.tickTag = Number(npcTickLevel.tickTag === 0);
    const lightingChanges = lightTicks.map(result => result.lightingChange).filter(Boolean);
    if (onLightingChanged && lightingChanges.length) onLightingChanged(lightingChanges);
    return records.length;
  }

  let windowHost=null,playerLogs=null;
  if(nativeHud){
    // HUD.InitWindow reads the initialized augmentation/theme/inventory
    // graph. Allocate that actor world before the native root is constructed.
    await prepareLiveActorSpawnWorld({runtime,engine,deusEx,level,levelInfo});
    playerStartup=await createPlayerAugmentationStartup({runtime,assets,deusEx,level,
      player:playerActor,warning:message=>callbacks.warning?.(message)});
    // ConstructRootWindow belongs to the possessing viewport. The root's
    // original ConsoleCommand calls must already see that UPlayer identity.
    runtime.namedReference(playerActor,'Player').set(level.engine.client.viewports[0]);
    const {createWindowHost}=await import('./script-window-host.mjs');
    windowHost=await createWindowHost({runtime,assets,player:playerActor});
    windowHost.install();windowHost.constructRootWindow(playerActor);
    playerLogs=await preparePlayerLogStore({runtime,assets,player:playerActor});
    playerLogs.enableMessages();
  }
  const infoLinkShellValue=await createInfoLinkShellPreview({runtime,assets,player:playerActor,windowHost});
  liveDataLink=await createLiveDataLinkRuntime({runtime,assets,engine,deusEx,level,levelInfo,
    player:playerActor,shell:infoLinkShellValue,spawnWorldPrepared:nativeHud,
    onLifecycle:event=>callbacks.dataLinkTransmission?.(event)});
  // player.rootWindow is the shell's native-backed root window
  // (script-datalink-live sets it). Window hierarchy natives reachable from
  // NPC ticks — GetRootWindow(1425) via DeusExPlayer.CanStartConversation →
  // DeusExRootWindow.CanStartConversation — read the same +0x138 parent and
  // +0x28 type words the shell allocates, so publish those readers for the
  // whole Play session rather than only inside the DataLink lifecycle.
  runtime.windowLifecycle={...runtime.windowLifecycle,
    hierarchy:{readParent:object=>infoLinkShellValue.readNative(object,WINDOW_DESTROY_OFFSETS.parent,'ptr'),
      readType:object=>infoLinkShellValue.readNative(object,WINDOW_DESTROY_OFFSETS.type,'u8')}};
  if(!nativeHud)playerStartup=await createPlayerAugmentationStartup({runtime,assets,deusEx,level,
    player:playerActor,warning:message=>callbacks.warning?.(message)});
  await prepareShadowStartup(runtime,assets,level);
  await prepareConversationBinding(runtime,level);
  // Prepare the live face-to-face (ConPlay) conversations the map's
  // conversation-owning pawns can invoke, so a frobbed instructor runs the real
  // DeusExPlayer.StartConversation selection over attached ConFlagRef/ConEvent
  // graphs. docs/script-instructor-conversation.md.
  const faceConversations=await prepareFaceConversations(runtime,{assets,level});
  liveConPlay=await createLiveConPlayRuntime({runtime,assets,level,player:playerActor,shell:infoLinkShellValue,
    conversations:faceConversations.conversations,prepareClass:prepareNpcClass,
    onSpeech:event=>callbacks.conversationSpeech?.(event)});
  // Mission00's timer: DeusExLevelInfo.SpawnScript spawns the mission actor,
  // whose PostPostBeginPlay SetTimer runs Mission00.Timer through the shared
  // scheduler. Created after liveConPlay so its one-shot spawn route wraps the
  // conversation lifecycle (docs/script-mission-timer.md).
  liveMission=await createLiveMissionRuntime({runtime,assets,level,player:playerActor});
  const initialFlags = [...triggerActions.flagBase.entries].map(([key, value]) => [key, {...value}]);
  runtime.boundaryFunctions.set('deusex.deusexplayer.startdatalinktransmission',liveDataLink.startHandler);
  runtime.boundaryFunctions.set('deusex.datalinkplay.startconversation',liveDataLink.handleStartConversation);

  // Live Actor.Destroy. The DataLink spawn world above installs the spawn-side
  // actorLifecycle and the minimal no-hash level fields; merge the world
  // destruction services onto them afterwards and publish the level's real
  // FCollisionHash, so an original body such as OrdersTrigger.Touch runs the
  // recovered ULevel::DestroyActor order instead of pausing Play.
  // docs/script-destroy.md, docs/script-world-destroy.md.
  runtime.actorLifecycle={...runtime.actorLifecycle,...destroyServices};
  level.collisionHash=destroyServices.collisionHash;
  // SpawnActor's bTicked write reads the original Level+0x10c tick parity —
  // the npcTickLevel tag the recovered actor-tick scheduler owns.
  Object.defineProperty(level,'tickParity',{
    configurable:true,enumerable:true,
    get:()=>Boolean(npcTickLevel.tickTag),
  });
  const baseDestroyActor=runtime.destroyActor.bind(runtime);
  runtime.destroyActor=(receiver,netForce=false)=>{
    const saved=destroyedActors.snapshot(receiver);
    const accepted=baseDestroyActor(receiver,netForce);
    // Record only a request that actually cleared the saved Level.Actors slot;
    // the recovered gates can accept an already-deleting actor without one.
    // Runtime-spawned actors (NPC inventory, Shadows) are never ledgered —
    // reset must not reintroduce them as serialized map actors.
    if(accepted&&saved.slot>=0&&level.actors[saved.slot]===null&&identities.has(receiver))
      destroyedActors.record(receiver,saved);
    return accepted;
  };
  // Eagerly link every pawn class's script surface and decode its mesh before
  // the initial reset() runs the NPC startup chain synchronously.
  await prepareNpcs();
  await prepareCrateLifecycle({runtime,assets,level,decorations:npcDecorations,
    prepareClass:prepareNpcClass,prepareItemMeshes:prepareItemViewMeshes});
  reset();
  const infoLinkShell=()=>Promise.resolve(liveDataLink.shell());
  return { reset, use, frob: frobMover, tick, runtime, bumpDecoration, dispatchEvent, decorations, triggerActions,
    npcPawns, npcFailures,
    infoLinkShell,playerStartup,windowHost,playerLogs,dataLinkPresentation:liveDataLink.presentation,dataLinkActive:liveDataLink.active,
    dataLinkReceivedItems:liveDataLink.receivedItems,faceConversations,liveConPlay,liveMission };
}

export default createScriptDoors;
