import { preparePlayerLogin } from './script-player-login.mjs';
import { hostDate } from './host-clock.mjs';
import { preparePlayerDumpStore } from './script-player-dump.mjs';
import { prepareLoadMapGame } from './script-loadmap-game.mjs';
import { ScriptRuntime } from './script-runtime.mjs';
import { initScriptRunaway, refValue, x87load, x87double, x87int32, x87mul, x87ftol, x87store } from './script-vm.mjs';
import { physMovingBrush } from './mover-interpolation.mjs';
import { moverFinishBounds } from './mover-finish.mjs';
import { prepareMapProperties } from './script-map-properties.mjs';
import { linkDecorationCollision } from './decoration-physics.mjs';
import { createScriptLights } from './script-lights.mjs';
import { createScriptTriggers, prepareTriggerFunctions } from './script-triggers.mjs';
import { createLiveDataLinkRuntime, prepareLiveActorSpawnWorld } from './script-datalink-live.mjs';
import { createExtStringSource } from './script-text-parser-natives.mjs';
import { readObject } from '../unreal/objects.mjs';
import { createPlayerAugmentationStartup } from './script-player-startup.mjs';
import { preparePlayerLogStore } from './script-player-log.mjs';
import { createWorldDestroyServices, createDestroyedActorLedger, mapActorNativeObject } from './script-world-destroy.mjs';
import { setActorCollisionSize, findActorBase, setActorCollision, setCollisionArguments } from './script-actor-collision.mjs';
import { writeCollisionFlags, isMapMoveHost } from './map-actor-native.mjs';
import { installActorFlagWords, flagWord, MOTION_WORD, COLLISION_WORD } from './actor-flag-words.mjs';
import { installMirrorFields, mirrorsField, resetMirrorField, imageField, PLAYER_BOUND, PLAYER_PORT } from './actor-mirror-fields.mjs';
import { installPoseFields, posesField, resetPoseField, isPoseProp, keepLivePose, imagePoseField } from './actor-pose-fields.mjs';
import { installLinkFields, linksField, isLinkProp, resetLinkField } from './actor-link-fields.mjs';
import { setBase } from './walking-callbacks.mjs';
import { bumpBaseEpoch, noteBaseChange } from './base-epoch.mjs';
import { setActorZone } from './zone.mjs';
import { pawnPhysicsView } from './script-pawn-physics.mjs';
import { forEachLiveActor, partitionActorArray } from './script-loadmap-startup.mjs';
import { prepareShadowStartup, resetLevelDecals } from './script-decal.mjs';
import { prepareConversationBinding } from './script-conversation-startup.mjs';
import { createLiveConPlayRuntime, registerLoadedPackage, adoptHistoryObject } from './script-conplay-live.mjs';
import { createLiveAudio } from './script-audio-live.mjs';
import { execActorPlaySound, execActorStopSound } from './script-sound.mjs';
import { mapPlayerIndex } from './map-object-indices.mjs';
import { assignMeasuredObjectIndices } from './measured-object-indices.mjs';
import { createLiveMissionRuntime } from './script-mission-live.mjs';
import { prepareFaceConversations } from './script-conversation-face-live.mjs';
import { performActorPhysics, linkedActorPhysics } from './actor-physics.mjs';
import { prepareCrateLifecycle } from './script-crate-lifecycle.mjs';
import { runSpawnedActorFalling, runActorRolling, runActorRotation, runActorProjectile, runActorPathing } from './script-actor-physics.mjs';
import { createLevelCollection } from './script-level-collection.mjs';
import { createSaveStore, installTravelNatives } from './script-travel.mjs';
import { prepareGameDirectoryStore } from './script-game-directory.mjs';
import { hostSaveDirectory } from './save-directory.mjs';
import { createTravelExporter, loadFlagClasses } from './travel-export.mjs';
import { createTravelImporter } from './travel-import.mjs';
import { decodeAiEvents } from './ai-events-payload.mjs';
import { createLevelSaver } from './travel-save.mjs';
import { PLAIN_SAVED_OBJECTS, NATIVE_SAVED_OBJECTS, isSavedFlag, isSavedFlagBase, adoptNativeObject, adoptFlagBase, fillRestoredFlagStore } from './script-restore-objects.mjs';
import { createGameSaver } from './game-save.mjs';
import { handleOf } from './script-object-handles.mjs';

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
const MOVER_STATE_FIELDS = new Set(['keynum', 'prevkeynum', 'physalpha', 'physrate', 'binterpolating',
  'oldpos', 'oldrot', 'basepos', 'baserot', 'keypos', 'keyrot']);
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
function makeBinding(runtime, record, field) {
  const host = record.object;
  const name = field.name;
  const key = lower(name);
  const values = host.values ?? {};
  const interpolation = () => host.interpolation;
  // The object's own storage for this property (script-object-image.mjs): the
  // map-authored or class-default value until a script or the host writes it.
  const stored = () => runtime.readStoredField(host, field);
  if (field.key === 'core.object.class') return {
    get: () => record.cls.record,
    set: () => { throw new Error('Changing a native actor Class requires object reconstruction'); },
  };
  if (field.key === 'core.object.name' && Number.isInteger(host.index)) return {
    get: () => host.name,
    set: () => { throw new Error('Changing a native actor Name requires object rename support'); },
  };
  // Physics, Velocity, Acceleration, StandingCount, the pawn-list and
  // navigation pointers and the mover's replication fields are the image's
  // cells, and their host members accessors over them (actor-mirror-fields.mjs,
  // installed by attach). The controlled player's Velocity is its image field,
  // which Player.velocity links to; its Physics stays the movement port's
  // (docs/rust-core.md 1e-2).
  if (mirrorsField(host, runtime.instance(host), field, { exclude: host.controlledPlayer ? PLAYER_BOUND : null })) return null;
  // Location, Rotation and the collision size are the image's cells too, and
  // so is OldLocation, which the entry below bound only for a map move host
  // and the controlled player: their host members are accessors over the
  // cells (actor-pose-fields.mjs, installed by attach; `poseOldLocation`
  // marks the hosts whose OldLocation member exists), and the player's are
  // Player members linked to them (docs/rust-core.md 1e-3).
  if (posesField(runtime.instance(host), field)) {
    if (field.key === 'engine.actor.oldlocation' && (isMapMoveHost(host) || host.controlledPlayer)) record.poseOldLocation = true;
    return null;
  }
  // Base and Touching are the image's cells too, with the host `base` and
  // `touching` members accessors over them (actor-link-fields.mjs, installed
  // by attach). The controlled player keeps the `base` and `touching` entries
  // below: its base is the movement port's (docs/rust-core.md 1e-4, 1e-6).
  if (!host.controlledPlayer && linksField(runtime.instance(host), field)) return null;

  // The entries for mirrored fields (pawnlist, nextpawn, specialgoal,
  // waitingpawn, mymarker, standingcount, physics, velocity, acceleration,
  // clientupdate, sim*, real*) and pose fields (location, rotation,
  // collisionradius, collisionheight, the oldlocation entry below) serve only
  // a host whose class has no image cell for them (isolated fixtures) and the
  // controlled player's Physics.
  const dynamic = {
    // record.levelInfo and level.netMode change only through these setters,
    // so the runtime keeps a copy in the image (mirror) for the Rust VM.
    level: {
      get: () => record.levelInfo,
      set: value => { record.levelInfo = value; },
      mirror: true,
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
      set: value => { const old = host.base ?? null; host.base = value; noteBaseChange(old, value ?? null); },
    },
    // The live four `Touching` slots (Actor.uc:186) are kept on the host actor
    // by the recovered BeginTouch/EndTouch pair (actor-touch.mjs). Script reads
    // of `Touching` — the ULevel::DestroyActor scan among them — must see that
    // live state. An actor the scene never prepared for contact has no live
    // slots, and its serialized startup value stays authoritative.
    touching: {
      get: () => Array.isArray(host.touching) && host.touching.length === 4 ? [...host.touching] : stored(),
      set: value => {
        if (!Array.isArray(value) || value.length !== 4) throw new Error('Original Touching requires four explicit slots');
        if (Array.isArray(host.touching) && host.touching.length === 4) host.touching = [...value];
        else runtime.writeStoredField(host, field, value);
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
      get: () => interpolation() ? Boolean(interpolation().interpolating) : stored(),
      set: value => { if (interpolation()) interpolation().interpolating = Boolean(value);
        else runtime.writeStoredField(host,field,Boolean(value)); },
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
    // KeyPos[8]/KeyRot[8]: every slot is the interpolation state's, which
    // seedMoverInterpolation fills from the object's own storage.
    keypos: {
      get: () => {
        const state = interpolation();
        const dimension = field.metadata.arrayDim || 8;
        return Array.from({ length: dimension }, (_, index) => vector(state?.keyPositions?.[index] ?? values[index ? `KeyPos[${index}]` : 'KeyPos']));
      },
      set: value => {
        const state = interpolation();
        if (state && Array.isArray(value)) state.keyPositions = value.map(item => vector(item));
      },
    },
    keyrot: {
      get: () => {
        const state = interpolation();
        const dimension = field.metadata.arrayDim || 8;
        return Array.from({ length: dimension }, (_, index) => vector(state?.keyRotations?.[index] ?? values[index ? `KeyRot[${index}]` : 'KeyRot'], true));
      },
      set: value => {
        const state = interpolation();
        if (state && Array.isArray(value)) state.keyRotations = value.map(item => vector(item, true));
      },
    },
    physics: {
      get: () => host.physics ?? values.Physics ?? 0,
      set: value => { host.physics = Number(value) & 0xff; },
    },
    velocity: {
      get: () => vector(host.velocity ?? values.Velocity ?? ZERO_VECTOR),
      set: value => { host.velocity = vector(value); },
    },
    acceleration: {
      get: () => vector(host.acceleration ?? values.Acceleration ?? ZERO_VECTOR),
      set: value => { host.acceleration = vector(value); },
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
    netmode: {
      get: () => record.level?.netMode ?? 0,
      set: value => { if (record.level) record.level.netMode = Number(value) | 0; },
      mirror: true,
    },
  };
  // The Mover native fields above are a mover's interpolation state. PhysAlpha,
  // PhysRate and bInterpolating are Actor fields: on any other actor (a
  // helicopter an InterpolateTrigger sends along a path) they are its own
  // storage, which physPathing and FinishInterpolation read.
  if (MOVER_STATE_FIELDS.has(key) && !host.interpolation) return null;
  if (dynamic[key]) return dynamic[key];
  // bDeleteMe, the +0x1dc collision bools and bJustTeleported need no
  // binding: they are bits of the native flag words (+0x28, +0x1dc, +0x1ec)
  // whose host members are accessors over the image (actor-flag-words.mjs,
  // installed by attach). A script write such as DeusExPlayer's
  // `bCollideWorld = False` on a carried decoration changes the native word
  // the collision hash, line filter and move bodies read, as in the original.
  // Hash AddActor/RemoveActor read bDeleteMe (+0x28 bit 0x80) on the
  // registered identity, and Actor.Tick can finish physics after its state
  // destroys the pawn: that word is the bDeleteMe the VM wrote, so the
  // physics tail cannot re-register a destroyed pawn's cylinder.
  //
  // FarMoveActor writes OldLocation (+0x12c) on the native actor. A non-pawn
  // map actor's move bodies run on this host, so that field is its member
  // once written (an imaged host's member is the cell itself, above).
  if (key === 'oldlocation' && (isMapMoveHost(host) || host.controlledPlayer)) {
    return {
      get: () => host.oldLocation === undefined ? stored() : vector(host.oldLocation),
      set: value => { host.oldLocation = vector(value); },
    };
  }
  // ULevel::SetActorZone (0x1039b940) stores straight into the linked
  // Region (+0xc8), FootRegion (+0x330) and HeadRegion (+0x33c) properties.
  // The player scene runs that translated body on the controlled player and
  // on moving brushes (player-scene.mjs updateZone), keeping the result on
  // the host, so those script fields are that same storage (docs/zone.md).
  const regionProp = { region: 'region', footregion: 'footRegion', headregion: 'headRegion' }[key];
  if (regionProp && (host.controlledPlayer || host.movingBrush)) return {
    get: () => {
      const region = host[regionProp];
      if (!region) return stored();
      return { 'engine.actor.pointregion.zone': region.zone ?? null,
        'engine.actor.pointregion.ileaf': region.leaf ?? -1,
        'engine.actor.pointregion.zonenumber': region.zoneNumber ?? 0 };
    },
    set: value => { host[regionProp] = { zone: value?.['engine.actor.pointregion.zone'] ?? null,
      leaf: value?.['engine.actor.pointregion.ileaf'] ?? -1,
      zoneNumber: value?.['engine.actor.pointregion.zonenumber'] ?? 0 }; },
  };
  // Original PlayerInput/PlayerTick/UpdateRotation now own these live fields.
  // Keep ViewRotation as raw signed rotator storage: masks belong to the
  // bytecode operation that performs them, not every subsequent field read.
  if (host.controlledPlayer) {
    const view = {
      viewrotation: {
        get: () => vector(host.viewRotation, true),
        set: value => { host.viewRotation = vector(value, true); },
      },
      eyeheight: { get: () => f(host.eyeHeight ?? 0), set: value => { host.eyeHeight = f(value); } },
      baseeyeheight: {
        get: () => f(host.baseEyeHeight ?? values.BaseEyeHeight ?? 0),
        set: value => { host.baseEyeHeight = f(value); },
      },
      walkbob: {
        get: () => vector(host.walkBob ?? ZERO_VECTOR),
        set: value => { host.walkBob = vector(value); },
      },
      biscrouching: {
        get: () => Boolean(host.isCrouching),
        set: value => { host.isCrouching = Boolean(value); },
      },
    };
    if (view[key]) return view[key];
  }

  // Every other property lives in the object's image with no binding. A
  // property without an image cell keeps its authored/default value in the
  // record's store: InitProperties gives it once, kept on first read; a
  // reset clears the store, so the next read starts from the initial value.
  if (runtime.hasImageCell(host, field)) return null;
  return {
    get: () => {
      const stored = record.store.get(field.key);
      if (stored !== undefined || record.store.has(field.key)) return stored;
      const value = record.initialProperty(field);
      record.store.set(field.key, value);
      return value;
    },
    set: value => { record.store.set(field.key, value); },
  };
}

function stateLabelForTarget(mover) {
  const state = mover.interpolation;
  return state.key === 0 || state.key < state.previousKey ? 'open' : 'close';
}

/** FName's case rule for level package names: the first spelling a process made of a name is the one every later spelling resolves to. */
const levelPackageNames=new Map();
function internLevelName(name){const key=String(name).toLowerCase();if(!levelPackageNames.has(key))levelPackageNames.set(key,String(name));return levelPackageNames.get(key);}

/**
 * Prepare the original Engine/DeusEx functions used by the selected
 * TriggerToggle state. This adapter never rewrites their script bodies.
 */
export async function createScriptDoors({
  assets, asset, movers = [], playerActor, playerScene, playerController, level, callbacks = {}, rng, queries, zoneAt, onLightingChanged = null,
  nativeHud = false, musicLibrary = null, travel = null, saveDirectory = null, restore = null, modelIndex = null,
} = {}) {
  if (!assets?.get) throw new TypeError('createScriptDoors requires an AssetStore');
  if (!level || typeof level !== 'object') throw new TypeError('createScriptDoors requires the linked Level object');
  if (!playerActor || typeof playerActor !== 'object') throw new TypeError('createScriptDoors requires the existing player actor');
  if (onLightingChanged != null && typeof onLightingChanged !== 'function') throw new TypeError('createScriptDoors onLightingChanged must be a function');

  // Keep the authored slot order before player subsystems append or LoadMap
  // partitions the live array. Public reset emulates reloading that map.
  const initialActorArray = level.actors.filter(actor => actor !== playerActor);
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
  let levelCollection=null,lastCollection=null;
  let loadMapGame=null;
  let playerLogin=null, preparedPlayerStartup=null, loggingIn=false, travelExporter=null;
  // The travel that brought the player here (travel.mjs request): the URL's portal and options for Login and InitGame, the travel text for
  // SpawnPlayActor's import. Null for a cold open.
  const arrival=travel?.arrival?{...travel.arrival,optionsText:travel.arrival.options.map(option=>`?${option}`).join('')}:null;
  // The level package's name in the engine log and in object names: LoadMap creates it from URL.Map, so the spelling the travel URL used
  // ('dxonly', '99_endgame3'; the original's logs show these) unless the process has already made the name in another spelling (names compare
  // case-insensitively and keep the first spelling: a `?restart`'s `00_training` is the package `00_Training`); the file's own name for a map opened directly.
  // A restored or loaded level (restore-asset.mjs) is named by its own rule (a live package's spelling, travel.mjs loadGame): its asset's name.
  const levelName=restore?(internLevelName(asset.name),asset.name):internLevelName(arrival?.map??asset.name);
  // `?load?loadonly?loadgame` (travel.mjs loadGame): the saved player is already in the level with its whole object graph.
  const loadedGame=Boolean(restore&&arrival?.options.some(option=>option.toLowerCase()==='loadgame'));
  // ULevel::SpawnPlayActor -> DeusExGameInfo.Login (docs/script-player-login.md).
  function loginPlayer(){
    loggingIn=true;
    try{if(!playerLogin.login())throw new Error(`Original Login failed: ${playerLogin.error}`);}
    finally{loggingIn=false;}
    // A loaded game's subsystems are the file's (no ResetPlayerToDefaults, no import): the graph is verified without the cold defaults, as an imported one is.
    playerStartup=preparedPlayerStartup.complete(playerActor,{imported:playerLogin.imported||loadedGame});
    // The player's global UObject index as measured in this map's open
    // capture (build-map-object-indices.mjs): the channel ids of its sounds.
    const playerIndex=mapPlayerIndex(asset?.name);
    if(Number.isInteger(playerIndex)&&runtime.instance(playerActor).cls?.record.key==='deusex.jcdentonmale')
      runtime.registerGlobalObjectIndex(playerActor,playerIndex);
    // A map entered by travel gets PlayerTraveling from the travel text (PreTravel set it in the level left: travel-import.mjs);
    // only a cold open, which has no incoming travel state, is given the marker (docs/script-training-mission-entry.md).
    if(!arrival&&!restore)liveMission.beginFreshMission(playerActor);
    // LoadMap's last step once the player is in: the moving brush tracker of the new level (GNewBrushTracker, Engine 0x1038dfb5)
    logLine('Init',`Initialized moving brush tracker for Level ${levelName}.MyLevel`);
    // ...and, right after it, `Client->Viewports(i)->Input->ResetInput()` for every viewport (0x1038dfe0..0x1038dff3, the viewport's Actor being the player Login
    // just gave it): the held-key table, every CPF_Input byte and float of the player (a saved bDuck 1 included) and Action/Delta are zeroed, then UpdateInput(1)
    // replays the physical keys. docs/script-input-reset.md.
    windowHost.resetInput();
  }
  // GLog output device: Object.Log (native 231) is a synchronous side channel
  // with no gameplay effect. MissionScript.InitStateMachine logs its startup
  // line, so supply the host sink the original always has, recording a bounded
  // ring for diagnostics rather than leaving it an explicit boundary throw.
  const scriptLog=[];
  // The engine log as the original's GLog prints it (docs/travel.md "What each travel did"): Object.Log lines (tag ScriptLog) and the
  // native lines the travel code adds ("Log: Browse: ..."), in the order they happen.
  const engineLog=[];
  const logLine=(tag,text)=>{engineLog.push(`${tag}: ${text}`);if(engineLog.length>8192)engineLog.splice(0,4096);};
  const runtime = new ScriptRuntime(assets, { native: nativeCall, rng, levelFor: () => level, nativeClassLoading: true,
    conversationObjects:()=>level.actors.filter(Boolean),boundaryNatives: [264, 265],
    logDevice:event=>{scriptLog.push(event);if(scriptLog.length>512)scriptLog.shift();logLine(event.tag,event.text);} });
  // LoadMap startup (Mover.BeginPlay's Move/SetRotation) and Login already
  // move actors and cross zones. Bind the scene's event, rider, map-rotation
  // and pawn-move entries to the original runtime as soon as it exists, so no
  // move reaches the scene's pre-runtime fixture callbacks.
  playerScene.hooks.dispatchEvent=(target,event,args)=>dispatchEvent(target,event,args);
  playerScene.hooks.moveRider=(actor,delta,rotation)=>runtime.moveSpawnedActor(actor,delta,rotation);
  playerScene.hooks.rotateMapActor=(actor,rotation)=>runtime.rotateMapActor(actor,rotation);
  playerScene.hooks.movePawn=(actor,delta,rotation,flags)=>runtime.movePawn(actor,delta,rotation,flags);
  playerScene.hooks.moveSmoothPawn=(actor,delta)=>runtime.moveSmoothPawn(actor,delta);
  playerScene.hooks.moveSmoothActor=(actor,delta)=>runtime.moveSmoothActor(actor,delta);
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
  // A saved level's non-actor objects (the player's conversation history, notes, logs ...) are exports an actor's properties point at: their
  // identities exist before any property resolves; `restoreScriptObjects` gives them their class storage and properties once the registry exists.
  const restoredObjects = [];
  if (restore) {
    const handled = new Set(['Level', 'Model', 'Polys', 'LevelSummary', 'EventManager', 'AIEventType', 'AISenderEvent', 'AIReceiverEvent']);
    asset.pkg.exports.forEach((entry, i) => {
      if (!entry.serialSize || actorByIndex.has(i + 1) || handled.has(entry.className)) return;
      const identity = { index: i + 1, name: entry.name, className: entry.className, restoredObject: true };
      restoredObjects.push(identity); actorByIndex.set(i + 1, identity);
    });
  }
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
    // Its Super.Frob is the empty Actor.Frob above. Original ParseLeftClick /
    // DoFrob can pass the item in hand for the lockpick and NanoKeyRing paths;
    // right-click's ordinary empty-hand Frob passes None.
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
    // PlayHit, which calls Human.PlayTakeHitSound. Its discarded PlaySound
    // result qualifies for the recorded Stage-4 audio seam below.
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
      if (!result?.min || !result?.max || typeof result.valid !== 'boolean') throw new Error('GetBoundingBox callback returned invalid bounds');
      return { min: vector(result.min), max: vector(result.max), valid: result.valid };
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
    if (!method) {
      // The decoded call writes only to statement scratch storage. Retain
      // argument effects and an audio record; see docs/script-sound.md.
      if (call.resultDiscarded === true) { decorationEffect(call, 'PlaySound'); return 0; }
      throw new Error(`Unsupported original door native 264 PlaySound from ${path}`);
    }
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
      // execPlaySound (103e1f60) -> CheckHearSound -> the player's native
      // ClientHearSound -> Galaxy PlaySound, for an emitter whose global
      // UObject index is measured (map/pawn tables, the player's capture) or
      // modeled (the slot AddObject's rule gives a runtime spawn, continued
      // from the map's measured registry: original-object-index.mjs,
      // docs/object-index-captures.md "Runtime spawns"). An emitter with
      // neither (created before the model was seeded, absent from the capture)
      // keeps the recorded boundary below; the host registry's own slot is
      // never used for an id.
      const soundIndex = runtime.soundObjectIndex(call.receiver);
      if (soundIndex !== null) {
        const result = execActorPlaySound(call, runtime.playSoundServices(call));
        if (soundIndex.source === 'modeled') runtime.audio.noteModeledId(call.receiver);
        return result.resultWritten ? result.result : undefined;
      }
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
      // HUDKeypadWindow.PressButton's tone and ValidateCode's success/failure
      // sounds are one-shot UI audio whose returns the script discards
      // (docs/script-window-input.md, Sounds): the same deferred contract.
      if (path === 'hudkeypadwindow.pressbutton' || path === 'hudkeypadwindow.validatecode') { decorationEffect(call, 'KeypadSound'); return 0; }
      // The Training medical/repair screens raise their bot arm with a one-shot
      // actor sound and discard PlaySound's channel id. Audible ClientHearSound
      // remains the existing Stage-4 boundary; retain the reached call and let
      // the original Set*Bot script continue to its following statements.
      if (path === 'hudmedbothealthscreen.setmedicalbot' || path === 'hudrechargewindow.setrepairbot') {
        decorationEffect(call, 'BotRaiseArmSound'); return 0;
      }
      return soundBoundary(call);
    }
    if (call.index === 713) { decorationEffect(call, 'AISendEvent'); return undefined; }
    // execStopSound (103e27d0): XLevel->Engine->Audio's StopSoundId. The
    // player's speech-channel stops were consumed by liveConPlay above. A
    // recorded PlaySound's placeholder id 0 matches only an idle channel.
    if (call.index === 265) {
      execActorStopSound(call, runtime.audioServices());
      return undefined;
    }
    if (call.index === 714) { decorationEffect(call, 'AIStartEvent'); return null; }
    if (call.index === 715) { decorationEffect(call, 'AIEndEvent'); return undefined; }
    if (call.index === 716) { decorationEffect(call, 'AIClearEvent'); return undefined; }
    if (call.index === 301) {
      runtime.instance(call.receiver).state.latent = 302;
      return undefined;
    }
    // execPollFinishInterpolation (0x103e0100): the latent action ends when
    // the actor's bInterpolating (+0x1ec bit 7) is clear.
    if (call.index === 302) {
      if (runtime.readNamed(call.receiver, 'bInterpolating')) return undefined;
      runtime.instance(call.receiver).state.latent = 0;
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
      // Every attached non-mover actor runs the recovered AActor::setPhysics
      // 0x103c95f0 in script-runtime.mjs. A mover (InterpolateTo) only asks for
      // PHYS_MovingBrush while already moving-brush, where the body returns at
      // its equal-Physics test (0x103c9620); anything else is unrecovered here.
      const value = Number(refValue(call.evaluateArgument(0))) & 0xff;
      const current = Number(call.receiver.physics ?? call.receiver.values?.Physics ?? 0) & 0xff;
      if (value !== current) throw new Error(`SetPhysics(${value}) on ${runtime.instance(call.receiver).cls.record.key} with Physics ${current} is not routed to the recovered body`);
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
      // Engine execGetBoundingBox 0x1036dea0 returns the primitive FBox's
      // IsValid byte (0x1036e0cc-0x1036e0da). DeusExMover.ComputeMovementArea
      // only adds a swing pose's box when this is true.
      return bounds.valid;
    }
    if (call.index === 262 && !call.receiver?.controlledPlayer && Number.isInteger(call.receiver?.flags)) {
      // execSetCollision 0x103e1900 -> AActor::SetCollision 0x10369200 on the
      // map actor's native word: skipped arguments keep the current bits, the
      // hash registration is removed while colliding and re-added when the
      // new word collides (script-actor-collision.mjs).
      if(call.argumentCount>3)throw new Error('SetCollision accepts at most three boolean arguments');
      const receiver=call.receiver,hash=runtime.levelFor(receiver)?.hash;
      if(!hash)throw new Error('Map actor SetCollision requires the level collision hash');
      const [collide,blockActors,blockPlayers]=setCollisionArguments(receiver,call.argumentCount,
        index=>refValue(call.evaluateArgument(index)));
      setActorCollision(receiver,collide,blockActors,blockPlayers,{level:{hash}});
      writeCollisionFlags(receiver,receiver.flags);
      return undefined;
    }
    if (call.index === 262) {
      // Map actors with the native +0x1dc word run AActor::SetCollision above
      // and spawned actors their collision view in script-runtime.mjs; no
      // Training receiver reaches a third representation.
      throw new Error(`SetCollision on ${runtime.instance(call.receiver).cls.record.key} has no recovered collision representation`);
    }
    if (call.index === 1052) {
      // APlayerPawnExt::execInitRootWindow 0x10038560 -> InitRootWindow
      // 0x10037df0: construct only while rootWindow (+0x894) is still None.
      if (call.argumentCount !== 0) throw new Error('InitRootWindow accepts no arguments');
      if (!windowHost) throw new Error('InitRootWindow requires the native window host');
      if (!runtime.readNamed(call.receiver, 'rootWindow')) windowHost.constructRootWindow(call.receiver);
      return undefined;
    }
    if (call.index === 544) {
      // APlayerPawn::execResetKeyboard 0x103b96d0: Player (+0x5d4) must be a
      // UViewport holding an Input (+0x60); then UObject::ResetConfig(Input.Class).
      if (call.argumentCount !== 0) throw new Error('ResetKeyboard accepts no arguments');
      const viewport = runtime.readNamed(call.receiver, 'Player');
      let viewportClass = false;
      for (let cls = viewport ? runtime.instance(viewport).cls : null; cls; cls = cls.base)
        if (cls.record.key === 'engine.viewport') viewportClass = true;
      if (viewportClass && viewport.input) viewport.input.resetConfig();
      return undefined;
    }
    if (call.index === 3971) {
      // AActor::execAutonomousPhysics 0x103c8f30 (PlayerPawn.CheatFlying's
      // ProcessMove): P_GET_FLOAT DeltaSeconds; each Acceleration component
      // (+0x150..+0x158) becomes FILD(_ftol(A * 10.0f)) * 0.1 (double
      // 0x1042bcb0) stored to a float, at the game thread's 64-bit precision;
      // a nonzero Physics (+0x30) then runs performPhysics (vtable +0x8c),
      // ahead of the one Actor.Tick runs after the script.
      if (call.argumentCount !== 1) throw new Error('AutonomousPhysics takes one float argument');
      const delta = Math.fround(refValue(call.evaluateArgument(0)));
      const acceleration = runtime.readNamed(call.receiver, 'Acceleration').map(a =>
        x87store(x87mul(x87int32(x87ftol(x87mul(x87load(a), x87load(10)))), x87double(0.1))));
      runtime.writeNamed(call.receiver, 'Acceleration', acceleration);
      if (runtime.readNamed(call.receiver, 'Physics') !== 0) runtime.processActorPhysics(call.receiver, delta);
      return undefined;
    }
    if (call.index === 256) throw new Error(`Unsupported Sleep in selected door script: ${path}`);
    if (path.endsWith('.stopwaiting')) return dispatch(call.receiver, 'StopWaiting', []);
    throw new Error(`Unsupported original door native ${call.index} in ${path}`);
  }

  runtime.pollLatent = ({ index, receiver, state }) => {
    if (index !== 302) throw new Error(`Unsupported original latent action ${index}`);
    if (!runtime.readNamed(receiver, 'bInterpolating')) state.latent = 0;
  };

  // Mover.uc's native interpolation fields (KeyNum, PrevKeyNum, PhysAlpha,
  // PhysRate, bInterpolating, KeyPos[8], KeyRot[8], BasePos, BaseRot, OldPos,
  // OldRot) are bound to the host's interpolation state (makeBinding), which
  // AMover::physMovingBrush reads. Seed it from the object's own storage — the
  // map-authored value or the class default, which the bindings never write —
  // after each property reset and before the startup passes run Mover.BeginPlay.
  const moverClassRecords = new WeakMap();
  function isMoverRecord(record) {
    if (!record?.cls) return false;
    let known = moverClassRecords.get(record.cls);
    if (known === undefined) {
      known = false;
      for (let cls = record.cls; cls; cls = cls.base) if (cls.record?.key === 'engine.mover') { known = true; break; }
      moverClassRecords.set(record.cls, known);
    }
    return known;
  }
  function seedMoverInterpolation(record) {
    const mover = record.object, state = mover.interpolation;
    if (!state || !isMoverRecord(record)) return;
    const stored = name => runtime.readStoredField(mover, runtime.lookupMember(record.cls, 'fields', name));
    const slots = (value, integer) => Array.from({ length: 8 }, (_, index) => vector(value?.[index], integer));
    state.key = Number(stored('KeyNum')) & 0xff;
    state.previousKey = Number(stored('PrevKeyNum')) & 0xff;
    state.alpha = f(stored('PhysAlpha'));
    state.rate = f(stored('PhysRate'));
    state.interpolating = Boolean(stored('bInterpolating'));
    state.keyPositions = slots(stored('KeyPos'), false);
    state.keyRotations = slots(stored('KeyRot'), true);
    state.basePosition = vector(stored('BasePos'));
    state.baseRotation = vector(stored('BaseRot'), true);
    state.oldPosition = vector(stored('OldPos'));
    state.oldRotation = vector(stored('OldRot'), true);
    state.scriptInterpolateEnd = true;
    state.onInterpolateEnd = () => runtime.processEvent(mover, 'InterpolateEnd', [null]);
  }

  /** Return a map actor's properties to their initial (map-authored or
   * class-default) values: its object storage and the store of properties
   * without an image cell. */
  function resetProperties(record) {
    record.store.clear();
    // LevelInfo.PawnList is the scene level's pawn list, which the host's
    // collidable rebuild (player-scene reset) owns until clearStartupPawnList
    // evicts it; the property reset leaves it as the rebuild left it.
    const pawnList = record.role === 'level' ? level.pawnList : undefined;
    // Location, Rotation and the collision size were host members the
    // property reset never touched: the reset code below restores each
    // actor's own, inside the hash's remove/re-add where it is registered
    // (actor-pose-fields.mjs keepLivePose).
    const keepPose = keepLivePose(record.object);
    runtime.restoreStorage(record.object, record.initialStorage);
    keepPose();
    if (record.role === 'level') level.pawnList = pawnList;
    resetMirrorField(record.object, 'acceleration');
  }

  // The image cells behind a map actor's mirrored members (actor-mirror-fields.mjs):
  // each takes the member's current value, which was that field's storage.
  // The controlled player keeps its Physics as movement-port state and links
  // Player.velocity to its Velocity field. The scene level's `pawnList` is
  // LevelInfo.PawnList.
  function installMirrors(record) {
    const host = record.object, instance = runtime.instance(host), fields = classFields(record.cls), values = host.values ?? {};
    if (host.controlledPlayer) {
      installMirrorFields(host, instance, fields, { values, exclude: PLAYER_PORT });
      const velocity = fields.find(field => field.key === 'engine.actor.velocity');
      const field = velocity && imageField(instance, velocity);
      if (field) playerController.linkVelocity(field);
      return;
    }
    installMirrorFields(host, instance, fields, { values });
    if (record.level) installMirrorFields(host, instance, fields, { values, target: record.level });
  }

  // The image cells behind a map actor's Location, Rotation, collision size
  // and (a map move host's) OldLocation members (actor-pose-fields.mjs): each
  // takes the member's current value. The controlled player's are Player
  // members (position, bodyRotation, radius, height, spawnOldLocation),
  // linked to its identity's cells.
  function installPoses(record) {
    const host = record.object, instance = runtime.instance(host), fields = classFields(record.cls);
    if (host.controlledPlayer) {
      playerController.linkPose(fields.map(field => imagePoseField(instance, field)).filter(Boolean));
      return;
    }
    installPoseFields(host, instance, fields, { values: host.values ?? {}, oldLocation: Boolean(record.poseOldLocation) });
  }

  // The image cells behind a map actor's Base and Touching members
  // (actor-link-fields.mjs): `base` takes the member's current value (None
  // while absent, as the binding read it); `touching` is installed where the
  // host has its four live slots, which move into the cells. The controlled
  // player keeps its bindings (stage 1e step 6).
  function installLinks(record) {
    const host = record.object;
    if (host.controlledPlayer) return;
    installLinkFields(host, runtime.instance(host), classFields(record.cls));
  }

  // A map actor's native flag words become its image's bytes: the members a
  // level-load host carries (`flags`, `actorFlags`, a map move host's or map
  // pawn's `motionFlags`) turn into accessors (actor-flag-words.mjs). The
  // controlled player's movement port keeps its collision members (stage 1e
  // step 6); its motion word, which bJustTeleported reads, is the attached
  // identity's. A map pawn's physics (script-pawn-physics.mjs) reads and
  // writes the +0x1ec word the original reads: physWalking, physFalling,
  // physFlying and physSwimming clear bJustTeleported, FarMoveActor and
  // stepUp set it, APawn::physicsRotation sets bRotateToDesired and clears
  // bFixedRotationDir (docs/rust-core.md 1e-1).
  function installFlagWords(host) {
    if (host.controlledPlayer) {
      playerController.linkMotionFlags(flagWord(runtime.instance(host), MOTION_WORD));
      playerController.linkCollisionFlags(flagWord(runtime.instance(host), COLLISION_WORD));
      return;
    }
    const collision = Number.isInteger(host.flags), actor = Number.isInteger(host.actorFlags);
    const motion = isMapMoveHost(host) || runtime.isMapPawn(host);
    if (collision || actor || motion) installActorFlagWords(host, runtime.instance(host), {collision, actor, motion});
  }

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
    runtime.applyInitialProperties(identity, record.initialProperty);
    for (const field of fields) {
      const binding = makeBinding(runtime, record, field);
      if (binding) runtime.bindProperty(identity, field, binding);
    }
    installFlagWords(identity);
    // A reset returns the actor's properties to these initial values.
    record.initialStorage = runtime.snapshotStorage(identity);
    installMirrors(record);
    installPoses(record);
    installLinks(record);
    // Core UObject identity for a pre-placed map export. Actor.Destroy's
    // ConditionalDestroy -> AActor::Destroy -> UObject::Destroy chain reads this
    // record, and the export table supplies its measured Name/ObjectFlags
    // (docs/script-world-destroy.md).
    const entry = Number.isInteger(identity.index) ? asset?.pkg.exports[identity.index - 1] : null;
    if (entry && entry.name === identity.name) {
      const object = mapActorNativeObject(identity, entry, {
        index: runtime.resolveOriginalObjectIndex?.(identity, runtime.instance(identity)) ?? null,
        destroy: receiver => runtime.destroyActorBase(receiver),
      });
      // A saved level's pawn: no measured slot, so the registry models one when the pawn needs it (playerNativeObject).
      if (restore && role === 'player') object.modeledIndex = true;
      // A saved level's objects have no measured GObjObjects slot (docs/travel.md "Unresolved" 10): an object they own (an actor's render
      // interface) hashes under a modeled one, unique per export; labelled so, not a measurement.
      if (restore && !Number.isInteger(object.index)) object.hashIndex = 0x100000 + identity.index;
      runtime.bindNativeObject(identity, object);
    }
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
  // A saved level's pawn is the player (GameInfo.Login re-possesses it): the natives treat it as they treat a spawned player, through its
  // collision view (the hook `bindCollisionView` makes that for a spawned one).
  if (restore) { runtime.collisionViewActors.add(playerActor); Object.assign(playerActor, { pawn: true, scriptView: true }); }
  // The browser creates JCDentonMale before the script level is attached.
  // ULevel::SpawnActor would have written this inherited Actor.Level slot
  // during construction; restore that source-required identity before any
  // PostBeginPlay subsystem code reads Player.Level.NetMode.
  runtime.writeNamed(playerActor, 'Level',levelInfo);
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
    if (runtime.readNamed(actor, 'Owner') || runtime.readNamed(actor, 'bHidden')
      || !runtime.readNamed(actor, 'Location')) continue;
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
      for (const reference of [actor ? runtime.readNamed(actor, name) : null, runtime.defaultValue(cls, field)]) {
        if (!reference || !['LodMesh', 'Mesh'].includes(reference.kind)) continue;
        const resource = await runtime.prepareResource(reference);
        if (resource.payloadStatus !== 'decoded-lodmesh' && resource.payloadStatus !== 'decoded-mesh')
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
  // Spawn closure: a live map actor's scripts can name further classes to
  // SpawnActor, through class constants in its class chain's bytecode
  // (TrashGenerator.Timer's Spawn(class'TrashPaper')) or its class-valued
  // properties (RatGenerator's PawnClasses[i].PawnClass). SpawnActor and the
  // spawned actor's first PlayAnim run synchronously, so each such Actor
  // class's scripts and default Mesh are prepared here, at load, transitively.
  // So is every other mesh its defaults or a live actor's properties name:
  // the original loads them with the class or the level, and a script
  // assigns one to Mesh (DeusExCarcass.InitFor's Mesh2 after DeathFront,
  // Mesh3 in water) that DrawActorSprite draws in the next frame.
  // This is resource readiness only; no spawn happens here.
  async function prepareSpawnClosure(actors) {
    const seen = new Set(), queue = [], meshes = new Map();
    const addClass = ref => {
      if (!ref || ref.kind !== 'Class' || !ref.asset || !Number.isInteger(ref.index) || seen.has(ref.key)) return;
      seen.add(ref.key); queue.push(ref);
    };
    const collectValue = (value, depth = 0) => {
      if (value === null || value === undefined || depth > 4 || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) collectValue(item, depth + 1); return; }
      if (value.kind === 'Class') { addClass(value); return; }
      if ((value.kind === 'LodMesh' || value.kind === 'Mesh') && value.asset) { meshes.set(value.key, value); return; }
      if (value.kind || value.asset) return;
      for (const item of Object.values(value)) collectValue(item, depth + 1);
    };
    const collectBytecode = fn => {
      const expressions = fn?.compiled?.decoded?.expressions;
      if (!expressions) return;
      for (const node of expressions.values())
        if (node.op === 0x20) addClass(runtime.objects.operand(fn.script, node));
    };
    const collectClass = (cls, read) => {
      for (let node = cls; node && node.record.key !== 'core.object'; node = node.base) {
        for (const field of node.fields?.values() ?? []) {
          try { collectValue(read(field)); } catch { /* a field without a readable value names no class */ }
        }
        for (const member of node.methods?.values() ?? []) collectBytecode(member.function);
        for (const state of node.states?.values() ?? []) {
          collectBytecode(state.function);
          for (const member of state.methods?.values() ?? []) collectBytecode(member.function);
        }
      }
    };
    const isActorClass = cls => { for (let node = cls; node; node = node.base) if (node.record.key === 'engine.actor') return true; return false; };
    for (const actor of actors) {
      if (!actor || !identities.has(actor)) continue;
      const cls = runtime.instance(actor).cls;
      // Bytecode is scanned from prepared functions (DeusExCarcass.Timer's
      // Spawn(Class'FlyGenerator') lives in an ordinary method).
      await prepareNpcClass(cls);
      collectClass(cls, field => runtime.readNamed(actor, field.name ?? field.record?.name));
    }
    while (queue.length) {
      const ref = queue.shift();
      const cls = await runtime.loadClass(ref.asset, ref.index);
      if (!isActorClass(cls)) continue;
      await prepareNpcClass(cls);
      const meshField = runtime.lookupMember(cls, 'fields', 'Mesh');
      const mesh = meshField ? runtime.defaultValue(cls, meshField) : null;
      if (mesh && ['LodMesh', 'Mesh'].includes(mesh.kind)) await runtime.prepareResource(mesh);
      collectClass(cls, field => runtime.defaultValue(cls, field));
    }
    // A mesh that cannot be prepared fails where it is drawn (the actor mesh
    // layer reports it), as it did before.
    for (const mesh of meshes.values()) await runtime.prepareResource(mesh).catch(() => {});
    return seen.size;
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
      for (let node = runtime.readNamed(manager, head), guard = 0; node && guard < 64;
        node = runtime.readNamed(node, 'next'), guard++)
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
        // (a Pawn that is not a ScriptedPawn, such as a saved level's GeneratorScout, has no InitialInventory)
        const initialInventory = runtime.lookupMember(identities.get(actor).cls, 'fields', 'InitialInventory')
          ? runtime.namedReference(actor, 'InitialInventory')?.get?.() ?? [] : [];
        for (const slot of initialInventory) {
          for (const [key, value] of Object.entries(slot ?? {})) {
            if (!key.toLowerCase().endsWith('.inventory') || !value) continue;
            const itemClass = await runtime.loadClass(value.asset, value.index);
            await prepareNpcClass(itemClass);
            // InitializeInventory gives the authored item to its pawn; weapon
            // selection can immediately PlayAnim on a switched view mesh.
            await prepareItemViewMeshes(itemClass);
            // Only classes that declare/inherit AmmoName (Weapon ancestry)
            // reference a second class through it — Ammo subclasses do not.
            const ammoField = runtime.lookupMember(itemClass, 'fields', 'AmmoName');
            const ammoRef = ammoField ? runtime.defaultValue(itemClass, ammoField) : null;
            if (ammoRef) {
              const ammoClass = await runtime.loadClass(ammoRef.asset, ammoRef.index);
              await prepareNpcClass(ammoClass);
            }
            // Fresh-object naming continues each class's counter from 0 (MakeUniqueObjectName, Core 0x101575b0), skipping the names the
            // map's exports hold (script-datalink-live.mjs `uniqueFindObject`): the original's Underworld capture sndm5 names its first
            // spawns WeaponStealthPistol0, AmmoPepper0 and Credits0, 2, 4 (the map holds Credits1, 3, 9). The former preset to 1 is gone.
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
    const gameInfo = runtime.readNamed(playerActor, 'Level');
    const gameObject = gameInfo && runtime.readNamed(gameInfo, 'Game');
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
        }
      } catch (error) {
        npcFailures.set(actor, String(error?.message ?? error));
      }
    }
    // Every serialized actor receives the LoadMap events. Link its full class
    // chain before synchronous dispatch, including base-fixup callbacks.
    for (const actor of level.actors ?? []) {
      if (!actor || actor === playerActor) continue;
      const record = identities.get(actor);
      if (!record || npcPawnSet.has(actor) || npcPatrolPointSet.has(actor)) continue;

      // A class whose methods cannot link is a load-time boundary, not a
      // per-actor startup failure: the dispatch would throw later anyway.
      await prepareNpcClass(record.cls);
    }
  }

  // The scene level and scheduler share the actual actor array, parity,
  // clock and pending-deletion chain. No category-owned tick view remains.
  Object.assign(level, { netMode: 0, netDriver: null, demoRecDriver: null,
    serviceAtF8: null, tickTag: 0, deferredHead: null, inTick: 0 });
  Object.defineProperty(level, 'firstViewport', {configurable:true,
    get:()=>level.engine.client.viewports[0]});
  level.zoneLastRenderTime = actor => {
    const region = runtime.readNamed(actor, 'Region');
    return level.zoneLastRenderTimes?.[region?.['engine.actor.pointregion.zonenumber']];
  };
  let tickBoundary = null, lastTickDelta = 0;
  const npcTickOptions = {
    allocateDeferredActor: () => ({}),
    readInput: (viewport, delta) => {
      if (viewport !== level.engine.client.viewports[0])
        throw new Error('ReadInput requires the linked local viewport');
      windowHost.viewportReadInput(delta);
    },
    farMoveActor: (actor, destination, test, noCheck) =>
      runtime.farMoveActor(actor, destination, test, noCheck),
    // ULevel::Tick's GInitRunaway (0x103a5265) zeroes the script runaway count.
    beginTick: () => { initScriptRunaway(); return {}; },
    endTick: () => {},
    updateTime: info => {
      const now = hostDate();
      for (const [name,value] of Object.entries({Year:now.getFullYear(),Month:now.getMonth()+1,
        Day:now.getDate(),DayOfWeek:now.getDay(),Hour:now.getHours(),Minute:now.getMinutes(),
        Second:now.getSeconds(),Millisecond:now.getMilliseconds()})) runtime.writeNamed(info,name,value);
    },
    // The string adapter does not retain allocated-empty FString storage.
    // Only an actual EventManager needs this distinction; remain explicit.
    // The Rust AI event manager (script-vm-aievent.mjs) stands for LevelInfo.EventManager. Pauser's FString array count: 0 for the
    // empty string, the length plus its terminator otherwise (an allocated empty string, which the original counts as 1, is not told
    // apart: the string adapter does not keep it).
    pauserArrayCount: info => {
      if (!runtime.scriptVm?.aiEvents?.active) throw new Error('Level.Tick EventManager requires native Pauser FString allocation storage');
      const pauser = runtime.readNamed(info, 'Pauser');
      return pauser && pauser.length ? pauser.length + 1 : 0;
    },
    eventManager: info => (runtime.scriptVm?.aiEvents?.active && runtime.scriptVm.aiEvents.levelInfo === info ? true : null),
    tickEventManager: () => {
      const aiEvents = runtime.scriptVm?.aiEvents;
      if (!aiEvents?.active) throw new Error('Level.Tick EventManager.Tick is not linked');
      aiEvents.tick();
    },
    aroundActorTick: (actor, run) => {
      const from = level.actors.length;
      try { return liveConPlay.withLifecycle(run); }
      catch (error) { npcFailures.set(actor, String(error?.message ?? error)); throw error; }
      finally { collectSpawned(from); }
    },
  };

  // Non-Pawn AActor::performPhysics (actor-physics.mjs), reached from the
  // recovered Actor.Tick. Map decorations use the same live field-backed
  // physics adapter as other map actors: it reaches the native MoveActor,
  // SetPhysics/SetSupportBase callbacks and ProcessEvent synchronously, so
  // script writes are never hidden by a detached host snapshot. Falling selects
  // the recovered class-specific processLanded branch (Decoration or other
  // non-Pawn); Rolling may recurse into that same live Falling adapter.
  // linkDecorationCollision above remains the map-load hash linkage for
  // decoration queries. Spawned actors and physicsRotation share these bodies.
  const actorPhysicsServices = {
    read: (target, name) => runtime.readNamed(target, name),
    write: (target, name, value) => runtime.writeNamed(target, name,value),
    physFalling: (actor,delta)=>runSpawnedActorFalling(runtime,actor,delta),
    physRolling: (actor,delta)=>runActorRolling(runtime,actor,delta,zoneAt?.(actor.position)??{}),
    physProjectile: (actor,delta)=>runActorProjectile(runtime,actor,delta),
    physPathing: (actor,delta)=>runActorPathing(runtime,actor,delta),
    physMovingBrush: (actor,delta)=>{
      // AMover::physMovingBrush (mover-interpolation.mjs) for every map mover:
      // any KeyNum, rotating keys, and the original InterpolateEnd event. It
      // returns when bInterpolating is clear.
      let mover=false;
      for(let cls=runtime.instance(actor).cls;cls;cls=cls.base)if(cls.record.key==='engine.mover'){mover=true;break;}
      if(!mover||!runtime.readNamed(actor,'bInterpolating'))return;
      const state=actor.interpolation;
      if(!state)throw new Error('MovingBrush requires its original mover interpolation storage');
      physMovingBrush(state,delta,{
        location:()=>actor.position,
        glideType:()=>runtime.readNamed(actor,'MoverGlideType'),
        move:(offset,rotation)=>state.move(offset,rotation),
        interpolateEnd:()=>runtime.processEvent(actor,'InterpolateEnd',[null]),
      });
    },
    physicsRotation: (target,delta)=>runActorRotation(runtime,target,delta),
    processEvent: (target, name, args) => runtime.processEvent(target, name, args),
    unsupported: (target, what) => {
      throw new Error(`Non-Pawn performPhysics ${what} is not linked for ${runtime.instance(target).cls.record.key}`);
    },
  };
  runtime.actorPhysics = (actor, delta) => performActorPhysics(actor, delta, actorPhysicsServices);
  // The Rust falling body runs under this function with these services
  // (actor-physics-kernel.mjs).
  linkedActorPhysics.set(runtime.actorPhysics, actorPhysicsServices);

  runtime.relocation={actorFor:actor=>actor,
    farMoveActor:(_level,actor,destination,test,noCheck)=>runtime.farMoveActor(actor,destination,test,noCheck)};

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
  // Every original map slot and every actor appended by a startup callback
  // participates. The player is created after LoadMap in the original.
  const startupAdmitted = actor => (restore || actor !== playerActor) && (identities.has(actor) || npcSpawned.has(actor) || loadMapGame?.actors.has(actor));
  // Native passes (Touching clear, SetActorZone, LastRenderTime, base fixup)
  // apply to every actor the original would have had in the array at LoadMap:
  // the serialized map actors and actors these same passes spawn. The player
  // and its post-load subsystems are excluded exactly like the original, whose
  // SpawnPlayActor runs after LoadMap.
  const startupNative = actor => actor !== playerActor && (identities.has(actor) || npcSpawned.has(actor) || loadMapGame?.actors.has(actor));
  // Serialized map actors the event passes above skip. The original has no
  // such gate (docs/script-loadmap-startup.md "Remaining gaps"); the Stage 3
  // conformance gate counts them (scripts/validate-stage3-training-conformance.mjs).
  function loadMapStartupExclusions() {
    const excluded = [];
    forEachLiveActor(level, actor => {
      if (actor !== playerActor && identities.has(actor) && !startupAdmitted(actor)) excluded.push(actor);
    });
    return excluded;
  }
  const startupField = (actor, name) => name==='Region'
    ?runtime.fieldReference(actor,runtime.lookupMember(runtime.actorClass,'fields','Region'))
    :runtime.namedReference(actor, name);
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
    level.actors = actors; bumpBaseEpoch();
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

  // `motionFlags` is not a host prop: it is the +0x1ec image word
  // (installFlagWords), which resetProperties restores with the image. The
  // mirrored members among these (physics, velocity, standingCount, nextPawn,
  // specialGoal, ...) are image accessors too; resetMirrorField returns each to
  // the value the old binding showed once its host copy was deleted,
  // resetPoseField does the same for `position` and `rotation`
  // (actor-pose-fields.mjs), and resetLinkField for `base` and `touching`
  // (actor-link-fields.mjs).
  const NPC_HOST_PROPS = Object.freeze(['position', 'rotation', 'physics', 'base', 'velocity',
    'standingCount', 'pawnFlags', 'touching', 'waitingPawn',
    'marker', 'specialGoal', 'clientUpdate', 'simOldPosition', 'simOldRotYaw', 'simOldRotPitch',
    'simOldRotRoll', 'simInterpolate', 'realPosition', 'realRotation', 'ambientSound',
    'nextPawn', 'collisionValues', '_pawnPhysics']);
  // Restore the serialized map state the original regains by reloading the
  // level, relink the pawn into Level.PawnList (playerScene.reset rebuilds the
  // list from the collidable set only), then re-run the LoadMap startup chain.
  // An actor whose startup reaches an explicit boundary — e.g. the armed NPCs'
  // Inventory SpawnActor inside InitializeInventory — is recorded and left out
  // of ticking instead of resuming a half-advanced state.
  function resetNpcs({ reload = false } = {}) {
    // A reload destroys no spawned actor: ResetLoaders(GLevel.Outer, 1, 0)
    // detaches the map's exports and the new load replaces each one in place
    // (StaticAllocateObject keeps its address and GObjObjects index), so the
    // reloaded GLevel->Actors holds the map exports only. Everything the old
    // level spawned — NPC inventory and Shadows, the GameInfo graph, the old
    // player's graph — is purged by LoadMap's collection below, with no script
    // event (docs/script-loadmap-gc.md). The cold load keeps the GameInfo its
    // LoadMap already spawned.
    npcSpawned.clear();
    npcSpawnedOwner.clear();
    npcFailures.clear();
    tickBoundary = null;
    level.tickTag = 0; level.deferredHead = null; level.inTick = 0;
    bumpBaseEpoch();
    level.actors = reload ? [...initialActorArray]
      : [...initialActorArray, ...level.actors.filter(actor => actor && !initialActorSet.has(actor))];
    level.zoneLastRenderTimes?.fill(0);
    // The reloaded UModel starts with no surface decals; the purged Shadows
    // run no DetachDecal (script-decal.mjs levelDecals).
    if (reload) resetLevelDecals(level);
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
        resetProperties(identities.get(actor));
        for (const prop of NPC_HOST_PROPS)
          (isPoseProp(prop) ? resetPoseField : isLinkProp(prop) ? resetLinkField : resetMirrorField)(actor, prop);
        if (actor.values?.Location) actor.position = [...actor.values.Location];
        actor.isPawn = true; actor.pawnFlags = 0;
        // Restore serialized Touching refs before LoadMap clears all four.
        actor.touching = [0, 1, 2, 3].map(i => actorByIndex.get(actor.values?.[i ? `Touching[${i}]` : 'Touching']) ?? null);
        // The recovered AActor::SetBase (walking-callbacks.mjs) mutates
        // standingCount on the raw host — NPC inventory SetBase(Self) calls
        // arrive through the script, not a binding — so reseed it from the
        // serialized field like the other live host props.
        actor.standingCount = actor.values?.StandingCount ?? 0;
        actor.base = actorByIndex.get(actor.values?.Base) ?? null; bumpBaseEpoch();
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
        resetProperties(identities.get(actor));
        if (actor.values?.Location) actor.position = [...actor.values.Location];
      } catch (error) {
        npcFailures.set(actor, String(error?.message ?? error));
      }
    }
    // A picked-up item rode its owner (Base) with a live collision cylinder
    // (map-actor-native.mjs linkLiveCollision); it returns to its serialized
    // Location and Base inside the rebuilt hash's remove/re-add, like a
    // decoration below. prepareActor already restored its collision word.
    for (const actor of npcPickups) {
      try {
        resetProperties(identities.get(actor));
        const restore = () => {
          if (actor.values?.Location) actor.position = [...actor.values.Location];
          // Full-world ticking now advances Falling pickups. Their native
          // velocity/acceleration mirrors must reload with the map image.
          resetMirrorField(actor, 'velocity'); resetMirrorField(actor, 'acceleration');
          actor.base = actorByIndex.get(actor.values?.Base) ?? null; bumpBaseEpoch();
        };
        if (level.hash && actor.collisionValues && actor.collideActors !== false) level.hash.changeActor(actor, restore);
        else restore();
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
        resetProperties(identities.get(actor));
        const restore = () => {
          if (actor.values?.Location) actor.position = [...actor.values.Location];
          resetMirrorField(actor, 'velocity'); resetMirrorField(actor, 'acceleration'); delete actor.landingCounter;
          actor.base = actorByIndex.get(actor.values?.Base) ?? null; bumpBaseEpoch();
        };
        if (level.hash && actor.collisionValues && actor.collideActors !== false) level.hash.changeActor(actor, restore);
        else restore();
      } catch (error) {
        npcFailures.set(actor, String(error?.message ?? error));
      }
    }
    for (const actor of initialActorArray) {
      if (!actor || actor === playerActor || npcPawnSet.has(actor) || npcPatrolPointSet.has(actor)
          || npcPickupSet.has(actor) || npcDecorationSet.has(actor) || moversByObject.has(actor)) continue;
      const record = identities.get(actor);
      if (record) { resetProperties(record); seedMoverInterpolation(record); }
    }
    clearStartupPawnList();
    // A freshly loaded ULevel starts with an empty deferred-deletion chain;
    // what the old chain held belongs to the unloaded level.
    level.pendingDeleted = null;
    if (reload) lastCollection = levelCollection.collect();
    loadMapGame.reload();
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
    // Original InitGame executes here, creating BaseMutator itself.
    // LoadMap's native log lines before the game is initialised (docs/travel.md "What each travel did"); the "(0)" is the measured constant.
    logLine('Log',`Game class is '${loadMapGame.class.record.name}'`);
    logLine('Log',`Bringing Level ${levelName}.MyLevel up for play (0)...`);
    loadMapGame.init(arrival?arrival.optionsText:'');
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
  }

  // A saved level (docs/travel.md "Restoring a level"): LoadMap finds LevelInfo.bBegunPlay set in the file and skips the begin-play pass
  // (Engine 0x1038d6f6 `jne 0x1038dbec`), so no InitExecution, PreBeginPlay, BeginPlay, SetInitialState or PostBeginPlay runs: every actor
  // continues from the properties and the FStateFrame it was saved with. What it still does (0x1038dbec..): ULevel.TimeSeconds = the saved
  // LevelInfo.TimeSeconds (the caller's clock), then the PostPostBeginPlay pass over the live array, then the static/dynamic partition.
  const savedStates = new Map();
  async function prepareSavedStates() {
    const resolve = async ref => {
      if (!ref) return null;
      const object = await runtime.objects.resolve(asset, ref);
      if (object.entry.className !== 'State') return null;   // the class itself: the actor has no state
      await runtime.prepareState(object.asset, object.index);
      return runtime.states.get(object.key) ?? null;
    };
    for (const actor of level.actors) {
      if (!actor?.stack) continue;
      const { node, state } = actor.stack;
      savedStates.set(actor, { stateNode: await resolve(state), codeNode: await resolve(node) });
    }
  }
  function applySavedStates() {
    for (const [actor, nodes] of savedStates) {
      const { probeMask, latentAction, offset } = actor.stack;
      runtime.instance(actor).state.restoreFrame({ ...nodes, probeMask, latentAction, offset: offset ?? -1 });
    }
    savedStates.clear();
  }
  /** Give each saved non-actor object its class storage, native record and saved properties (after the registry and the spawn world exist). A saved game's
   * level holds the player's whole object graph (script-restore-objects.mjs): the flag store, notes, goals, keys, logs and the conversation history. */
  async function restoreScriptObjects() {
    const flagObjects = [];
    for (const identity of restoredObjects) {
      const entry = asset.pkg.exports[identity.index - 1];
      const cls = await runtime.loadClass(asset, entry.classIndex);
      const key = cls.record.key, history = key === 'consys.conhistory' || key === 'consys.conhistoryevent';
      if (!history && !isSavedFlag(key) && !PLAIN_SAVED_OBJECTS.has(key) && !(key in NATIVE_SAVED_OBJECTS))
        throw new Error(`Restoring a saved ${entry.className} (${entry.name}) is not implemented: only the flag store, notes, goals, keys, logs and the conversation history are`);
      await prepareNpcClass(cls);
      runtime.attach(identity, cls);
      runtime.instance(identity).state = null;   // an Object (not an Actor) has no StateFrame
      const properties = readObject(asset.pkg, asset.bytes, identity.index).properties;
      identity.properties = properties.map(({ data, ...property }) => ({ ...property, byteLength: data.length, data }));
      for (const field of classFields(cls)) await runtime.field(field);
      runtime.applyInitialProperties(identity, await prepareMapProperties(runtime, asset, identity, cls, actorByIndex));
      if (history) adoptHistoryObject(runtime, level, identity, cls, key === 'consys.conhistoryevent', entry);
      else if (key in NATIVE_SAVED_OBJECTS) adoptNativeObject(runtime, level, identity, cls, entry, NATIVE_SAVED_OBJECTS[key]);
      // a script-only Object is a plain UObject (`new`, vtable 0x10179dfc: CriticalDelete runs ~UObject on it)
      else if (PLAIN_SAVED_OBJECTS.has(key)) adoptNativeObject(runtime, level, identity, cls, entry, 0x10179dfc);
      else if (isSavedFlag(key)) flagObjects.push({ identity, cls, entry, key });
    }
    // The flag store: the saved FlagBase is the host store, filled from the saved chains
    const keyOfFlag = flag => runtime.instance(flag).cls.record.key;
    const playersBase = actorByIndex.get(restore?.player?.values?.FlagBase) ?? null;
    for (const { identity, cls, entry, key } of flagObjects) {
      if (!isSavedFlagBase(key)) continue;
      adoptFlagBase(runtime, level, identity, cls, entry);
      fillRestoredFlagStore(runtime, identity, keyOfFlag);
      // the pawn's FlagBase property was bound to the trigger natives' store before the file's objects existed: the file's object takes its place
      if (identity === playersBase) triggerActions.useFlagBase(identity);
    }
  }
  function restoreAiEvents() {
    const managerIndex = asset.pkg.exports.findIndex(entry => entry.className === 'EventManager') + 1;
    if (!managerIndex) return;
    const events = runtime.scriptVm.aiEvents;
    const decoded = decodeAiEvents(asset.pkg, asset.bytes, managerIndex, { nameId: text => events.nid(text),
      actorWord: ref => { const actor = ref ? actorByIndex.get(ref) : null; return actor ? handleOf(actor) : 0; } });
    events.load(levelInfo, decoded.words);
  }
  function warmLoadMap() {
    npcSpawned.clear(); npcSpawnedOwner.clear(); npcFailures.clear();
    tickBoundary = null;
    level.tickTag = 0; level.deferredHead = null; level.inTick = 0;
    level.pendingDeleted = null;
    bumpBaseEpoch();
    // The movers' host interpolation state follows their saved fields (a cold load seeds it from them in resetNpcs).
    for (const actor of level.actors) { const record = actor && identities.get(actor); if (record && isMoverRecord(record)) seedMoverInterpolation(record); }
    applySavedStates();
    restoreAiEvents();
    runStartupEvent('PostPostBeginPlay');
    partitionStartupActors();
  }

  // Live TriggerLights share the LoadMap startup passes. This adapter prepares
  // their bodies and drives Trigger/Tick and renderer feedback. This is what makes a
  // LightSwitch.Frob's AllActors(Event) fanout (Actor.Trigger on each tagged light)
  // dispatch to the real state Trigger instead of the empty base. Subclasses are
  // outside this selected subset and are left inert (docs/script-light-switch.md).
  const triggerLightClass = await loadClass(engine, 'triggerlight', 'Engine.TriggerLight class');
  const triggerLights = (level.actors ?? []).filter(actor => {
    try { return runtime.instance(actor).cls.record === triggerLightClass.record; } catch { return false; }
  });
  const lights = await createScriptLights({ runtime, assets, lights: triggerLights, sharedStartup: true });

  const records = [];
  for (const mover of movers) {
    if (!selectedMover(mover,level) && !mover?.supported) continue;
    if (!selectedMover(mover,level)) throw new Error(`Mover is marked supported outside the selected TriggerToggle subset: ${mover?.name ?? '<unnamed>'}`);
    const state = mover.interpolation;
    if (!state) throw new Error(`Doors.reset() must create interpolation state before attaching ${mover.name}`);
    const entry=asset?.pkg.exports[mover.index-1];
    const moverClass=entry?await runtime.loadClass(asset,entry.classIndex):null;
    let descends=false;
    for(let cls=moverClass;cls;cls=cls.base)if(cls.record===deusExMoverClass.record){descends=true;break;}
    if(!descends)throw new Error(`Mover class is not a DeusExMover: ${mover.name}`);
    // BreakableGlass/BreakableWall run their own class's bodies (state code,
    // BaseChange/TakeDamage overrides) over the same mover record.
    await prepareNpcClass(moverClass);
    const record = await attach(mover, moverClass, 'mover');
    moversByObject.set(mover, record);
    record.mover = mover;
    records.push(record);
  }

  function resetMover(record) {
    const mover = record.mover, values = mover.values ?? {};
    if (!mover.interpolation) throw new Error(`Doors.reset() removed interpolation state for ${mover.name}`);
    resetProperties(record);
    seedMoverInterpolation(record);

    mover.target = 0; mover.active = false; mover.alpha = 0;
    mover.clientUpdate = 0;
    // A saved level's mover keeps the replication fields it was saved with, which are the class defaults unless the file holds them: the
    // cold load derives them from Location (the begin-play pass it skips).
    if (restore) { mover.physics = values.Physics ?? mover.physics ?? 0; return; }
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
    const scriptState = runtime.instance(record.mover).state;
    // The viewer's open/close label follows whatever moved the door (Frob
    // through ParseRightClick/ParseLeftClick, a Trigger, the Tag fanout).
    const signature = frobSignature(record);
    if (record.displaySignature !== undefined && record.displaySignature !== signature)
      mover.target = stateLabelForTarget(mover) === 'open' ? 1 : 0;
    record.displaySignature = signature;
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

  // UGameEngine::LoadMap, before it loads anything (Engine 0x1038c6c4..
  // 0x1038c731): NotifyLevelChange (vtable +0xc4, 0x1038c110) sends the first
  // viewport's Console its NotifyLevelChange event; then for every client
  // viewport, Actor.Player (+0x5d4) = None, Viewport.Actor (+0x30) = None and
  // Actor.XLevel.DestroyActor(Actor, 0) (ULevel vtable +0x94). The old player's
  // Destroyed chain runs in the old world, and its ConditionalDestroy reaches
  // ADeusExPlayer::Destroy outside a collection. game.reset calls this before
  // any host restore (docs/script-player-login.md, "Reset").
  function retirePlayer() {
    const viewports = level.engine.client.viewports;
    const console = viewports[0] && runtime.readNamed(viewports[0], 'Console');
    if (console) runtime.processEvent(console, 'NotifyLevelChange', []);
    for (const viewport of viewports) {
      const actor = runtime.readNamed(viewport, 'Actor');
      // The original dereferences Actor (+0xac XLevel) without a test.
      if (!actor) throw new Error('LoadMap viewport dissociation requires a viewport Actor');
      runtime.writeNamed(actor, 'Player',null);
      runtime.writeNamed(viewport, 'Actor',null);
      level.retiringPlayer = actor;
      try { runtime.destroyActor(actor, false); }
      finally { level.retiringPlayer = null; }
    }
  }

  function reset() {
    // Player start is a cold reload of this map, then SpawnPlayActor. The
    // retired player was destroyed by retirePlayer; the reload below replaces
    // the map's exports in place and LoadMap's collection purges everything
    // the old level spawned (docs/script-player-login.md, "Reset").
    destroyedActors.restore(receiver=>{const record=identities.get(receiver);if(record)resetProperties(record);});
    liveConPlay?.reset();
    liveDataLink?.reset();
    runtime.audio?.reset();
    faceConversations?.reset?.();
    for (const record of records) resetMover(record);
    // Restore fields; the shared passes below own all startup events.
    lights.reset();
    // As at cold boot, the reloaded level's startup runs with no player.
    playerScene.detachPlayerIdentity();
    // Map pawns restore their serialized state and re-run the LoadMap startup
    // chain. This must run after playerScene.reset rebuilt the pawn list;
    // game.reset orders it so.
    resetNpcs({ reload: true });
    loginPlayer();
    // The Play services follow the new player; the old HUD tree went with the
    // retired player's root window, and the new Possess built the new one.
    liveConPlay.bindPlayer(playerActor);
    liveDataLink.bindPlayer(playerActor);
    finishPlayerStartup();
  }

  function finishPlayerStartup() {
    if (onLightingChanged) onLightingChanged(lights.collectLightingChanges({ force: true }));
    playerController.actorRegistered=true;
    playerController.yaw=runtime.readNamed(playerActor,'ViewRotation')[1]*Math.PI/32768;

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
    const invoke=()=>runtime.dispatchSpawnedEvent(target,event,args);
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
    const state = record.mover.interpolation, script = runtime.instance(record.mover).state;
    return `${state.key}/${state.previousKey}/${state.interpolating ? 1 : 0}/${f(state.alpha ?? 0)}` +
      `|${script.latent}/${script.execution ? script.execution.cursor : 'none'}`;
  }

  /** Original DeusExMover.Frob. Play's door use runs this body instead of a
   * host lock/one-way/group substitute, so bFrobbable, bDestroyed, bSlave,
   * bPicking, the KeyNum/PrevKeyNum "already open" test, the bOneWay GetAxes
   * dot product, the lock branches and the Tag fanout through native AllActors
   * are all the original's decisions. This retained door fixture helper passes
   * None unless its caller supplies frobWith. Live Play now enters Frob through
   * the original player input/DoFrob bytecode, including the item in hand for
   * the Lockpick/NanoKeyRing paths.
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

  // Every dynamic actor is admitted by the original level/actor scheduler.
  function tick(seconds) {
    if (tickBoundary) throw tickBoundary;
    if (npcFailures.size) {
      const [actor,message] = npcFailures.entries().next().value;
      throw new Error(`Original actor boundary (${actor.name ?? 'unnamed'}): ${message}`);
    }
    try {
      lastTickDelta = runtime.processLevelTick(level, seconds, npcTickOptions);
    } catch (error) {
      // A failed frame must never resume partially advanced actor state.
      // Reset/reload is the only way to leave this explicit boundary.
      tickBoundary = error;
      throw error;
    }
    liveDataLink?.observe();
    for (const record of records) updateDisplay(record);
    const lightingChanges = lights.collectLightingChanges();
    if (onLightingChanged && lightingChanges.length) onLightingChanged(lightingChanges);
    return records.length;
  }

  // The script-visible UViewport/Console graph must precede root construction.
  // Platform window/input construction remains outside this projection.
  const {attachLocalViewportConsole}=await import('./script-viewport-console.mjs');
  if(level?.engine?.client?.viewports?.[0])
    await attachLocalViewportConsole({runtime,assets,engine,viewport:level.engine.client.viewports[0],player:restore?null:playerActor});
  let windowHost=null,playerLogs=null;
  // Cold LoadMap owns Game creation and startup before player subsystems.
  await prepareLiveActorSpawnWorld({runtime,engine,deusEx,level,levelInfo,mapAsset:asset,packageName:levelName});
  // Live Actor.Destroy. The DataLink spawn world above installs the spawn-side
  // actorLifecycle and the minimal no-hash level fields; merge the world
  // destruction services onto them afterwards and publish the level's real
  // FCollisionHash, so an original body such as OrdersTrigger.Touch runs the
  // recovered ULevel::DestroyActor order instead of pausing Play.
  // docs/script-destroy.md, docs/script-world-destroy.md.
  runtime.actorLifecycle={...runtime.actorLifecycle,...destroyServices};
  level.collisionHash=destroyServices.collisionHash;
  // ULevel+0x110: the LoadMap partition stores it as iFirstNetActor; Level.Tick,
  // CleanupDestroyed and CompactActors read it as FirstDynamicActor. Play never
  // runs an editor level.
  Object.defineProperty(level,'firstDynamicActor',{configurable:true,enumerable:true,
    get:()=>level.iFirstNetActor,set:value=>{level.iFirstNetActor=value;}});
  level.editor=false;
  // SpawnActor's bTicked write reads the original Level+0x10c tick parity —
  // the parity owned by the recovered level scheduler.
  Object.defineProperty(level,'tickParity',{
    configurable:true,enumerable:true,
    get:()=>Boolean(level.tickTag),
  });
  const baseDestroyActor=runtime.destroyActor.bind(runtime);
  runtime.destroyActor=(receiver,netForce=false)=>{
    const saved=destroyedActors.snapshot(receiver);
    const accepted=baseDestroyActor(receiver,netForce);
    // Record only a request that actually cleared the saved Level.Actors slot;
    // the recovered gates can accept an already-deleting actor without one.
    // Only map exports are reloaded in place: spawned actors (NPC inventory,
    // Shadows, the retired player) are never ledgered.
    if(accepted&&saved.slot>=0&&level.actors[saved.slot]===null&&initialActorSet.has(receiver))
      destroyedActors.record(receiver,saved);
    return accepted;
  };
  // The original has every function and state of its loaded script packages in
  // memory before LoadMap runs BeginPlay. The VM links/compiles bodies
  // asynchronously and cannot do so mid-execution, so a body nobody prepared
  // ahead (a HUD screen pushed by a Frob, a declared notification) stopped as a
  // host-only "not prepared" gap. Prepare them all; a body whose preparation
  // fails keeps that failure, recorded here, as its boundary.
  const scriptPreparationFailures=new Map();
  for(const name of ['Core','Engine','Extension','ConSys','DeusEx']){
    const packageAsset=await assets.get(name);
    for(const [position,entry] of packageAsset.pkg.exports.entries()){
      if(entry.className!=='Function'&&entry.className!=='State')continue;
      try{
        if(entry.className==='Function')await runtime.prepareFunction(packageAsset,position+1);
        else await runtime.prepareState(packageAsset,position+1);
      }catch(error){scriptPreparationFailures.set(`${name}.${entry.path}`,String(error?.message??error));}
    }
  }
  if(!playerScene||!playerController)throw new Error('Real player Login requires the existing scene movement port');
  await prepareNpcClass(playerClass);
  const extension=await assets.get('Extension');
  await runtime.loadClass(extension,extension.exportsByPath.get('flagbase'));
  preparedPlayerStartup=await createPlayerAugmentationStartup({runtime,assets,deusEx,level,player:playerActor});
  let travelImporter=null,saveFlagClasses=null;
  if(travel){
    const flagClasses=await loadFlagClasses(runtime,assets);
    saveFlagClasses=flagClasses;
    travelExporter=createTravelExporter({runtime,flagClasses});
    travelImporter=createTravelImporter({runtime,assets,level,exporter:travelExporter,log:logLine,prepareClass:prepareNpcClass,
      flagBaseOf:player=>runtime.readNamed(player,'FlagBase')});
  }
  playerLogin=await preparePlayerLogin({runtime,assets,level,levelInfo,
    viewport:level.engine.client.viewports[0],prepareClass:prepareNpcClass,arrival,importer:travelImporter,log:logLine});
  // DeusExGameInfo.Login unconditionally runs native 3015
  // CreateDumpLocationObject on the logged-in player (docs/script-player-dump.md).
  await preparePlayerDumpStore({runtime,assets});
  // The Load Game and Save Game screens' save-game directory (natives 3013 and 3075..3094, docs/save-directory.md): Play's Save directory,
  // empty unless the host supplies one (the page's, which outlives the maps).
  await prepareGameDirectoryStore({runtime,assets,directory:saveDirectory??hostSaveDirectory(),windowHost:()=>windowHost});
  // A session that travels (Play, the travel validators) runs ClientTravel and DeleteSaveGameFiles as recovered; others keep their named stops.
  const saveStore=travel?createSaveStore({directory:saveDirectory??hostSaveDirectory(),releaseLoaders:()=>logLine('Log',`Unloading: Package ${levelName}`)}):null;
  if(travel)installTravelNatives({runtime,store:saveStore});
  // PruneTravelActors and SaveCurrentLevel(-2) for the tick's travel step (travel-save.mjs).
  const levelSaver=travel?createLevelSaver({runtime,level,asset,store:saveStore,log:logLine,viewport:()=>level.engine.client.viewports[0],
    modelIndex,arrival,restoredObjects,flagClasses:saveFlagClasses}):null;
  // SaveGame (native 3011), the console's SAVEGAME and DELETEGAME, DeleteSaveGameFiles of a slot (game-save.mjs)
  const gameSaver=travel?createGameSaver({runtime,level,directory:saveDirectory??hostSaveDirectory(),store:saveStore,levelSaver,log:logLine,
    viewport:()=>level.engine.client.viewports[0],config:runtime.classLoader?.graph?.config,windowHost:()=>windowHost,
    textureClass:await runtime.loadClass(await assets.get('Engine'),(await assets.get('Engine')).exportsByPath.get('texture')),
    snapshotSource:travel.snapshotSource??null,clock:travel.clock,
    onMessage:(kind,error)=>logLine('Warning',`SaveGame: the save could not be kept: ${error?.message??error}`)}):null;
  if(gameSaver){
    runtime.travelServices.saveGame=(index,description)=>gameSaver.saveGame(index,description);
    runtime.travelServices.deleteSaveGameFiles=path=>gameSaver.deleteSaveGameFiles(path);
  }
  runtime.actorLifecycle.bindCollisionView=(actor,cls,lineage)=>{
    if(!loggingIn||!lineage.includes('engine.playerpawn'))return false;
    const fields=classFields(cls).filter(field=>!field.key.startsWith('core.object.')),snapshot=new Map(fields.map(field=>[field.key,runtime.fieldReference(actor,field).get()]));
    const values=Object.fromEntries(fields.map(field=>[field.name,snapshot.get(field.key)]));
    playerScene.bindPlayerIdentity(actor,values);
    actor.lineage=Object.freeze(lineage);actor.pawn=true;actor.scriptView=true;
    // Imaged properties keep their values in the player's object image; the
    // store holds the snapshot only for properties without an image cell.
    const record={object:actor,cls,state:runtime.instance(actor),role:'player',
      store:new Map([...snapshot].filter(([key])=>!runtime.instance(actor).cells?.has(key))),level,levelInfo,
      initialProperty:field=>snapshot.get(field.key)};
    identities.set(actor,record);
    for(const field of fields){
      const binding=makeBinding(runtime,record,field);
      if(binding)runtime.bindProperty(actor,field,binding);
    }
    installFlagWords(actor);
    installMirrors(record);
    installPoses(record);
    playerActor=actor;
    triggerActions.bindPlayerFlagBase(runtime,actor);
    playerLogs?.bindPlayer(actor);windowHost?.bindPlayer(actor);
    return true;
  };
  // A saved level keeps its pawn: GameInfo.Login finds it in Level.PawnList and does not spawn another.
  if(!restore)playerScene.detachPlayerIdentity();
  // The pre-placed actors' measured global indices, before any startup sound.
  assignMeasuredObjectIndices(runtime,level.actors);
  // Galaxy's channels over the live level (ambient sounds; docs/galaxy-audio.md).
  runtime.audio=await createLiveAudio({runtime,level,player:()=>playerActor,onVoice:event=>callbacks.audioVoice?.(event),
    ...(musicLibrary?{library:musicLibrary}:{})});
  // XLevel->Engine->Audio, Galaxy's UAudioSubsystem, linked before the map's
  // startup and Login run: PlaySound (+0x74) from ClientHearSound,
  // StopSoundId (+0x78) from execStopSound, and ULevel::DestroyActor's
  // NoteDestroy (script-destroy.mjs).
  level.engine.audio={
    playSound:(...args)=>runtime.audio.galaxy.playSound(...args),
    stopSoundId:id=>runtime.audio.galaxy.stopSoundId(id),
    noteDestroy:actor=>runtime.audio.galaxy.noteDestroy(actor),
  };
  loadMapGame=await prepareLoadMapGame({runtime,assets,level,levelInfo,prepareClass:prepareNpcClass});
  // A saved level keeps the GameInfo it was saved with (LevelInfo.Game is one of its objects): LoadMap's GameInfo branch does not run.
  if(!restore)loadMapGame.reload();
  await prepareShadowStartup(runtime,assets,level);
  await prepareConversationBinding(runtime,level);
  liveMission=await createLiveMissionRuntime({runtime,assets,level});
  await prepareNpcs();
  await prepareCrateLifecycle({runtime,assets,decorations:npcDecorations,
    prepareClass:prepareNpcClass,prepareItemMeshes:prepareItemViewMeshes});
  await prepareSpawnClosure(level.actors);
  for(const record of records)resetMover(record);
  lights.reset();
  if(restore){await restoreScriptObjects();await prepareSavedStates();warmLoadMap();}
  else resetNpcs();
  // The native window system exists before SpawnPlayActor: Login's
  // SetPlayer -> PlayerPawnExt.Possess calls InitRootWindow (native 1052),
  // whose ConstructRootWindow runs HUD.InitWindow over the player's already
  // initialized augmentation/theme/inventory graph. DeusExTextParser.OpenText
  // loads InformationDevices' XExtString texts from DeusExText
  // (docs/script-text-parser.md).
  runtime.textSource=createExtStringSource([await assets.get('DeusExText')],{readObject});
  await prepareNpcClass(playerClass);
  const {createWindowHost}=await import('./script-window-host.mjs');
  windowHost=await createWindowHost({runtime,assets,player:playerActor});
  windowHost.install();
  if(gameSaver){windowHost.gameEngineHooks.saveGame=index=>{gameSaver.saveGame(index,'');};windowHost.gameEngineHooks.deleteGame=index=>{gameSaver.deleteGame(index);};}
  // LoadMap's collection of the unloaded level, run by every reload
  // (docs/script-loadmap-gc.md). A released object leaves the host's maps.
  // DeusEx.u's package object, found by Conversation.CreateConCamera.
  const deusExPackage=registerLoadedPackage(runtime,deusEx);
  levelCollection=createLevelCollection({runtime,level,viewports:level.engine.client.viewports,
    transientPackage:runtime.actorLifecycle.construction.transientPackage,
    packages:[runtime.conversationLifecycle?.packageRecord,deusExPackage].filter(Boolean),
    onReleased:identity=>{identities.delete(identity);windowHost.heap.forget(identity);}});
  // ULevel::CleanupDestroyed's reference pass, once 128 actors await deletion.
  runtime.actorLifecycle={...runtime.actorLifecycle,references:levelCollection.references,
    release:(actor,flags)=>levelCollection.release(actor,flags)};
  // UViewport::Input (+0x60) exists before SpawnPlayActor; TravelPostAccept's
  // ResetKeyboard reaches it through the new player's Player.
  level.engine.client.viewports[0].input=windowHost.input;
  // Client.Decals is the live UWindowsClient property (the Display screen's Decals choice sets it).
  Object.defineProperty(level.engine.client,'decals',{configurable:true,enumerable:true,
    get:()=>windowHost.nativeConfig.instance('WinDrv.WindowsClient','Decals')});
  playerLogs=await preparePlayerLogStore({runtime,assets,player:playerActor});
  loginPlayer();
  playerLogs.enableMessages();
  // Original DataLinkPlay constructs and owns its display in the native HUD.
  liveDataLink=await createLiveDataLinkRuntime({runtime,assets,engine,deusEx,level,levelInfo,
    player:playerActor,windowHost,spawnWorldPrepared:true,
    onLifecycle:event=>callbacks.dataLinkTransmission?.(event)});
  const nativeWindowFacade={get root(){return windowHost.root;},get hud(){return windowHost.hud;},
    withLifecycle:fn=>fn(),readNative:windowHost.raw.read,isDestroyed:windowHost.isDestroyed};

  // Prepare the live face-to-face (ConPlay) conversations the map's
  // conversation-owning pawns can invoke, so a frobbed instructor runs the real
  // DeusExPlayer.StartConversation selection over attached ConFlagRef/ConEvent
  // graphs. docs/script-instructor-conversation.md.
  const faceConversations=await prepareFaceConversations(runtime,{assets,level});
  liveConPlay=await createLiveConPlayRuntime({runtime,assets,level,player:playerActor,shell:nativeWindowFacade,
    conversations:faceConversations.conversations,dataLinkConversations:liveDataLink.conversations,prepareClass:prepareNpcClass,
    onSpeech:event=>callbacks.conversationSpeech?.(event)});

  // Prepare the newly initialized player subsystem graph for subsequent ticks.
  await prepareNpcs();

  finishPlayerStartup();
  const infoLinkShell=()=>Promise.resolve(liveDataLink.shell());
  return { reset, retirePlayer, get lastCollection(){return lastCollection;}, use, frob: frobMover, tick, runtime, bumpDecoration, dispatchEvent, decorations, triggerActions,
    npcPawns, npcFailures, scriptPreparationFailures, loadMapStartupExclusions,
    get lastTickDelta(){return lastTickDelta;},
    infoLinkShell,get playerStartup(){return playerStartup;},windowHost,playerLogs,dataLinkPresentation:liveDataLink.presentation,dataLinkActive:liveDataLink.active,
    dataLinkReceivedItems:liveDataLink.receivedItems,faceConversations,liveConPlay,liveMission,engineLog,logLine,saveStore,levelSaver,gameSaver,arrival,get travelExporter(){return travelExporter;} };
}

export default createScriptDoors;
