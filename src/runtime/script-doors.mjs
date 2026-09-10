import { ScriptRuntime } from './script-runtime.mjs';
import { refValue } from './script-vm.mjs';
import { tickMoverInterpolation } from './mover-interpolation.mjs';
import { moverFinishBounds } from './mover-finish.mjs';
import { prepareMapProperties } from './script-map-properties.mjs';

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
function selectedMover(mover) {
  const values = mover?.values ?? {};
  const { positions, rotations } = moverKeyPairs(mover);
  return values.InitialState === 'TriggerToggle' && values.NumKeys === 2 &&
    !isZeroVector(positions[1]) && isZeroVector(positions[0]) &&
    isZeroVector(rotations[0]) && isZeroVector(rotations[1]) &&
    !values.bSlave && !values.bTriggerOnceOnly && !(values.DelayTime ?? 0) &&
    !(values.KeyNum ?? 0) && !hasNamedValue(values.Event);
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
  assets, asset, movers = [], playerActor, level, callbacks = {}, rng,
} = {}) {
  if (!assets?.get) throw new TypeError('createScriptDoors requires an AssetStore');
  if (!level || typeof level !== 'object') throw new TypeError('createScriptDoors requires the linked Level object');
  if (!playerActor || typeof playerActor !== 'object') throw new TypeError('createScriptDoors requires the existing player actor');

  const engine = await assets.get('Engine');
  const deusEx = await assets.get('DeusEx');
  const runtime = new ScriptRuntime(assets, { native: nativeCall, rng, levelFor: () => level });
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
    if (!method) throw new Error(`PlaySound native reached from unsupported script: ${path}`);
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

  function nativeCall(call) {
    const path = nativePath(call);
    if (call.index === 264) return soundBoundary(call);
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
    return record;
  }

  await attach(levelInfo, levelClass, 'level');
  await attach(playerActor, playerClass, 'player');

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

  const records = [];
  for (const mover of movers) {
    if (!selectedMover(mover) && !mover?.supported) continue;
    if (!selectedMover(mover)) throw new Error(`Mover is marked supported outside the selected TriggerToggle subset: ${mover?.name ?? '<unnamed>'}`);
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

  function reset() {
    for (const record of records) resetMover(record);
    // player-scene.reset() relinks Level.PawnList. Attach any newly linked
    // identity before a later FinishNotify can traverse it. Bindings themselves
    // read the list dynamically on every script field access.
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
    return records.length;
  }

  reset();
  return { reset, use, tick, runtime };
}

export default createScriptDoors;
