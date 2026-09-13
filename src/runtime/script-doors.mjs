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
import { createLiveDataLinkRuntime } from './script-datalink-live.mjs';
import { createPlayerAugmentationStartup } from './script-player-startup.mjs';
import { createWorldDestroyServices, createDestroyedActorLedger, mapActorNativeObject } from './script-world-destroy.mjs';

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
} = {}) {
  if (!assets?.get) throw new TypeError('createScriptDoors requires an AssetStore');
  if (!level || typeof level !== 'object') throw new TypeError('createScriptDoors requires the linked Level object');
  if (!playerActor || typeof playerActor !== 'object') throw new TypeError('createScriptDoors requires the existing player actor');
  if (onLightingChanged != null && typeof onLightingChanged !== 'function') throw new TypeError('createScriptDoors onLightingChanged must be a function');

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
  const runtime = new ScriptRuntime(assets, { native: nativeCall, rng, levelFor: () => level,
    conversationObjects:()=>level.actors.filter(Boolean),boundaryNatives: [264] });
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
      return soundBoundary(call);
    }
    if (decoration && call.index === 713) { decorationEffect(call, 'AISendEvent'); return undefined; }
    if (call.index === 265) {
      if (decoration) decorationEffect(call, 'StopSound');
      // DataLinkPlay/ConPlayBase stop the player speech channel at termination.
      // Browser audio is driven by the same recovered duration and has already
      // ended on the supported path; there is no native channel id to stop here.
      return undefined;
    }
    if (decoration && call.index === 714) { decorationEffect(call, 'AIStartEvent'); return null; }
    if (decoration && call.index === 715) { decorationEffect(call, 'AIEndEvent'); return undefined; }
    if (call.index === 301) {
      runtime.instance(call.receiver).state.latent = 302;
      return undefined;
    }
    if (call.index === 302) {
      if (call.receiver?.interpolation?.interpolating) return undefined;
      runtime.instance(call.receiver).state.latent = 0;
      return undefined;
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
    destroyedActors.restore(receiver=>identities.get(receiver)?.store.clear());
    liveDataLink?.reset();
    for (const record of records) resetMover(record);
    // Re-run the TriggerLights' native startup so they return to TriggerToggle.
    lights.reset();
    if (onLightingChanged) onLightingChanged(lights.collectLightingChanges({ force: true }));
    // player-scene.reset() relinks Level.PawnList. Attach any newly linked
    // identity before a later FinishNotify can traverse it. Bindings themselves
    // read the list dynamically on every script field access.
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
    if (!identities.has(target))
      throw new Error(`Scene event target is not attached to the script runtime: ${target?.name ?? '<unnamed>'}.${event}`);
    const record = runtime.lookup(target, event);
    if (!record) return { handled: false };
    if (!record.function)
      throw new Error(`Original scene event is not prepared: ${runtime.instance(target).cls.record.key}.${event}`);
    const result = runtime.processEvent(target, event, args);
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

  function tick(seconds) {
    const delta = f(seconds);
    for (const record of records) {
      // Actor.Tick's ProcessState phase precedes performPhysics. A newly
      // selected label therefore executes here, and a latent 302 is polled
      // before the same actor's next script statements.
      runtime.processActorScript(record.mover,delta);
      tickMoverInterpolation(record.mover.interpolation, delta);
      updateDisplay(record);
    }
    // Advance the push-sound Timer for any bumped decoration. updateActorTimer
    // no-ops once the one-shot rate has been cleared, so a decoration can stay
    // tracked cheaply and re-fire if bumped again.
    for (const decoration of bumpedDecorations)
      updateActorTimer(runtime.timerState(decoration), delta, () => runtime.processEvent(decoration, 'Timer', []));
    // Mission triggers share the recovered native timer step. DamageTrigger's
    // original Timer runs the prepared Training radiation chain, including the
    // GM_Trench PlayAnim state write, and stops at Human.PlayTakeHitSound's
    // Actor.PlaySound audio boundary after preserving damage and flash writes.
    for(const trigger of missionTriggers)
      updateActorTimer(runtime.timerState(trigger),delta,()=>dispatch(trigger,'Timer',[]));
    // DataLinkPlay is a spawned Actor. Its selected playback state and Timer
    // phase run after ProcessState and before physics, on the same fixed tick.
    liveDataLink?.tick(delta);
    // Physics phase follows ProcessState and the timer phase for each actor.
    for (const decoration of decorations) {
      if (!queries) continue;
      runDecorationPhysics(decoration, delta, {
        queries,
        zone: zoneAt?.(decoration.position ?? decoration.values?.Location) ?? {},
        landedEvent: normal => runtime.processEvent(decoration, 'Landed', [normal]),
        // Non-Pawn processHitWall (0x103cecc0), recovered and oracle-validated as
        // processDecorationHitWall (docs/walking-callbacks.md): return for a Pawn
        // wall, else dispatch the unmodified HitWall(normal,wall) only while the
        // decoration probes HitWall. No Pawn direction/MinHitWall/MoveTimer path.
        onHitWall: hit => processDecorationHitWall(decoration, hit?.normal ?? [0, 0, 0], hit?.actor ?? null, {
          isProbing: (source, name) => runtime.isProbing(source, name),
          dispatch: (source, event, args) => runtime.processEvent(source, event, args),
        }),
        // physRolling calls eventHitWall directly for any hit (no processHitWall).
        onHitWallEvent: (normal, actor) => runtime.processEvent(decoration, 'HitWall', [normal, actor ?? null]),
      });
    }
    // Advance the TriggerLights' Alpha animation (their Tick/ProcessState phase).
    const lightTicks = lights.tick(delta);
    const lightingChanges = lightTicks.map(result => result.lightingChange).filter(Boolean);
    if (onLightingChanged && lightingChanges.length) onLightingChanged(lightingChanges);
    return records.length;
  }

  const infoLinkShellValue=await createInfoLinkShellPreview({runtime,assets,player:playerActor});
  liveDataLink=await createLiveDataLinkRuntime({runtime,assets,engine,deusEx,level,levelInfo,
    player:playerActor,shell:infoLinkShellValue,onLifecycle:event=>callbacks.dataLinkTransmission?.(event)});
  playerStartup=await createPlayerAugmentationStartup({runtime,assets,deusEx,level,
    player:playerActor,warning:message=>callbacks.warning?.(message)});
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
  const baseDestroyActor=runtime.destroyActor.bind(runtime);
  runtime.destroyActor=(receiver,netForce=false)=>{
    const saved=destroyedActors.snapshot(receiver);
    const accepted=baseDestroyActor(receiver,netForce);
    // Record only a request that actually cleared the saved Level.Actors slot;
    // the recovered gates can accept an already-deleting actor without one.
    if(accepted&&saved.slot>=0&&level.actors[saved.slot]===null)destroyedActors.record(receiver,saved);
    return accepted;
  };
  reset();
  const infoLinkShell=()=>Promise.resolve(liveDataLink.shell());
  return { reset, use, frob: frobMover, tick, runtime, bumpDecoration, dispatchEvent, decorations, triggerActions,
    infoLinkShell,playerStartup,dataLinkPresentation:liveDataLink.presentation,dataLinkActive:liveDataLink.active };
}

export default createScriptDoors;
