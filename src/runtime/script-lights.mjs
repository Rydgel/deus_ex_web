/**
 * Execute the original Engine.TriggerLight script subset used by the
 * 00_Training LightSwitch0 fixture.
 *
 * The caller owns map identity construction and native actor storage.  This
 * module only prepares the original TriggerLight functions/state and provides
 * the synchronous startup, Trigger and Actor.Tick script phases.  In
 * particular, it does not implement LightSwitch.Frob, audio, animation or
 * renderer invalidation.
 */

const lower = value => String(value).toLowerCase();

function packageIndex(asset, path, description) {
  const index = asset.exportsByPath.get(lower(path));
  if (!Number.isInteger(index)) {
    throw new Error(`Original ${description} is missing: ${asset.name}.${path}`);
  }
  return index;
}

function requireMethod(runtime, name) {
  if (typeof runtime?.[name] !== 'function') {
    throw new TypeError(`createScriptLights requires ScriptRuntime.${name}()`);
  }
}

function asArray(values) {
  if (values == null) return [];
  if (Array.isArray(values)) return values.slice();
  if (values instanceof Map) return [...values.values()];
  if (typeof values !== 'string' && typeof values[Symbol.iterator] === 'function') {
    return [...values];
  }
  if (typeof values === 'object') return Object.values(values);
  throw new TypeError('createScriptLights requires an iterable light identity list');
}

/** The host supplies the raw identity already attached to ScriptRuntime. */
function attachedIdentity(runtime, value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`Light identity is not an object: ${value ?? '<unnamed>'}`);
  }
  // Let ScriptRuntime.instance() expose its native released/unattached error;
  // do not catch it and accidentally reinterpret a dead identity as a wrapper.
  runtime.instance(value);
  return value;
}

function finiteFloat(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
  return Math.fround(number);
}

function cloneSnapshotValue(value) {
  if (Array.isArray(value)) return value.slice();
  return value;
}

/**
 * Prepare and run the original TriggerLight subset.
 *
 * `lights` contains identities which have already been attached to the
 * supplied `runtime`; map/default property binding remains the host's job.
 * Once the returned promise resolves, all methods are synchronous:
 *
 *   reset()                         BeginPlay -> SetInitialState
 *   trigger(light, other, pawn)     ProcessEvent(light, Trigger, ...)
 *   tickActor(light, dt)             Tick event -> ProcessState -> Timer
 *   tick(dt)                         tickActor for each supplied light order
 *   snapshot(light)                 typed fields through namedReference()
 */
export async function createScriptLights({ runtime, assets, lights = [] } = {}) {
  requireMethod(runtime, 'loadClass');
  requireMethod(runtime, 'prepareFunction');
  requireMethod(runtime, 'prepareState');
  requireMethod(runtime, 'callFunction');
  requireMethod(runtime, 'processEvent');
  requireMethod(runtime, 'processActorScript');
  requireMethod(runtime, 'gotoState');
  requireMethod(runtime, 'namedReference');
  requireMethod(runtime, 'instance');
  if (!assets?.get) throw new TypeError('createScriptLights requires an AssetStore');

  const engine = await assets.get('Engine');
  const triggerLightClass = await runtime.loadClass(
    engine,
    packageIndex(engine, 'triggerlight', 'Engine.TriggerLight class'),
  );
  const functions = {
    beginPlay: await runtime.prepareFunction(
      engine,
      packageIndex(engine, 'triggerlight.beginplay', 'TriggerLight.BeginPlay'),
    ),
    tick: await runtime.prepareFunction(
      engine,
      packageIndex(engine, 'triggerlight.tick', 'TriggerLight.Tick'),
    ),
    setInitialState: await runtime.prepareFunction(
      engine,
      packageIndex(engine, 'actor.setinitialstate', 'Actor.SetInitialState'),
    ),
    beginEvent: await runtime.prepareFunction(
      engine,
      packageIndex(engine, 'actor.beginevent', 'Actor.BeginEvent'),
    ),
    endEvent: await runtime.prepareFunction(
      engine,
      packageIndex(engine, 'actor.endevent', 'Actor.EndEvent'),
    ),
  };
  const triggerToggleState = await runtime.prepareState(
    engine,
    packageIndex(engine, 'triggerlight.triggertoggle', 'TriggerLight.TriggerToggle state'),
  );
  const triggerFunction = await runtime.prepareFunction(
    engine,
    packageIndex(engine, 'triggerlight.triggertoggle.trigger', 'TriggerLight.TriggerToggle.Trigger'),
  );

  // Keep this local list stable.  The original level actor array is ordered;
  // the host can use tickActor() when it needs to interleave other supported
  // actors in that larger order.
  const identities = asArray(lights).map(value => attachedIdentity(runtime, value));
  const seen = new Set();
  for (const light of identities) {
    if (seen.has(light)) throw new Error(`Duplicate TriggerLight identity: ${light.name ?? '<unnamed>'}`);
    seen.add(light);
    const instance = runtime.instance(light);
    if (instance.cls.record !== triggerLightClass.record) {
      throw new Error(`Light is not an Engine.TriggerLight identity: ${light.name ?? '<unnamed>'}`);
    }
    // The selected map path uses the base TriggerLight state.  A subclass
    // override would need its own original state body and is rejected instead
    // of silently executing the wrong state's handler.
    const stateRecord = runtime.lookupMember(instance.cls, 'states', 'TriggerToggle');
    if (!stateRecord || stateRecord !== triggerToggleState.record) {
      throw new Error(`Light has an unsupported TriggerToggle state: ${light.name ?? '<unnamed>'}`);
    }
    const triggerRecord = runtime.lookupMember(triggerToggleState, 'methods', 'Trigger');
    if (!triggerRecord || triggerRecord !== triggerFunction) {
      throw new Error(`Light has an unsupported Trigger handler: ${light.name ?? '<unnamed>'}`);
    }
  }

  // Map/spawned actors arrive with authored light and corona values. Keep a
  // typed copy so repeated reset() calls recreate the pre-BeginPlay storage
  // before running the original startup body again. Without this, BeginPlay
  // would sample a previous tick's LightBrightness as InitialBrightness.
  const initialFields = new Map(identities.map(light => [light, {
    Alpha: runtime.namedReference(light, 'Alpha').get(),
    Direction: runtime.namedReference(light, 'Direction').get(),
    InitialBrightness: runtime.namedReference(light, 'InitialBrightness').get(),
    LightBrightness: runtime.namedReference(light, 'LightBrightness').get(),
    DrawType: runtime.namedReference(light, 'DrawType').get(),
    SavedTrigger: runtime.namedReference(light, 'SavedTrigger').get(),
    Skin: runtime.namedReference(light, 'Skin').get(),
    MultiSkins: runtime.namedReference(light, 'MultiSkins').get().slice(),
  }]));

  function stateFor(light) {
    const state = runtime.instance(light).state;
    if (!state) throw new Error(`Light has no initialized FStateFrame: ${light.name ?? '<unnamed>'}`);
    return state;
  }

  function assertSelected(light) {
    const identity = attachedIdentity(runtime, light);
    if (!seen.has(identity)) throw new Error(`Light is outside this controller: ${identity.name ?? '<unnamed>'}`);
    return identity;
  }

  function snapshot(light) {
    const identity = assertSelected(light);
    const state = stateFor(identity);
    const read = name => cloneSnapshotValue(runtime.namedReference(identity, name).get());
    const node = state.stateNode?.record ?? null;
    return {
      light: identity,
      state: node?.name ?? 'None',
      stateKey: node?.key ?? null,
      tickEnabled: state.isProbing(0x150),
      triggerEnabled: state.isProbing(0x132),
      latent: state.latent,
      Alpha: read('Alpha'),
      Direction: read('Direction'),
      InitialBrightness: read('InitialBrightness'),
      DrawType: read('DrawType'),
      LightBrightness: read('LightBrightness'),
      SavedTrigger: read('SavedTrigger'),
      Skin: read('Skin'),
      MultiSkins: read('MultiSkins'),
    };
  }

  function resetLight(light) {
    const state = stateFor(light);
    // A fresh map actor starts at the class sentinel.  On repeated reset(),
    // return there through the original GotoState path so stale TriggerToggle
    // probe bits cannot survive the subsequent BeginPlay Disable('Tick').
    if (state.stateNode) runtime.gotoState(light, 'None');
    const initial = initialFields.get(light);
    for (const name of ['Alpha', 'Direction', 'InitialBrightness', 'LightBrightness', 'DrawType', 'SavedTrigger', 'Skin']) {
      runtime.namedReference(light, name).set(initial[name]);
    }
    runtime.namedReference(light, 'MultiSkins').set(initial.MultiSkins.slice());
    // This is the native startup order for this actor: BeginPlay first, then
    // Actor.SetInitialState.  SetInitialState itself executes the original
    // GotoState(InitialState), rather than selecting TriggerToggle here.
    runtime.callFunction(functions.beginPlay, light, 0);
    runtime.callFunction(functions.setInitialState, light, 0);
    const active = stateFor(light).stateNode;
    if (active?.record !== triggerToggleState.record) {
      throw new Error(`TriggerLight InitialState did not select TriggerToggle: ${light.name ?? '<unnamed>'}`);
    }
    return snapshot(light);
  }

  function reset() {
    return identities.map(resetLight);
  }

  function trigger(light, other = null, eventInstigator = null) {
    const identity = assertSelected(light);
    const state = stateFor(identity);
    if (state.stateNode?.record !== triggerToggleState.record) {
      throw new Error(`TriggerLight is not in TriggerToggle: ${identity.name ?? '<unnamed>'}`);
    }
    // ProcessEvent supplies the original POD/object event parameter block and
    // applies the active state's Trigger probe gate.  TriggerToggle.Trigger,
    // including SavedTrigger BeginEvent/EndEvent and Direction reversal, is
    // still the installed script body.
    const executed = runtime.processEvent(identity, 'Trigger', [other ?? null, eventInstigator ?? null]);
    return { executed, snapshot: snapshot(identity) };
  }

  function tickActor(light, deltaTime) {
    const identity = assertSelected(light);
    const delta = finiteFloat(deltaTime, 'TriggerLight tick delta time');
    const tickEvent = runtime.processEvent(identity, 'Tick', [delta]);
    // AActor::Tick calls ProcessState and then the timer phase even when its
    // Tick probe is disabled.  Keep that ordering and let ScriptRuntime apply
    // its source-backed latent/timer behavior.
    runtime.processActorScript(identity, delta);
    return { tickEvent, snapshot: snapshot(identity) };
  }

  function tick(deltaTime) {
    return identities.map(light => tickActor(light, deltaTime));
  }

  // Keep the prepared event records alive through the closure.  BeginEvent
  // and EndEvent are intentionally prepared even though this module never
  // calls them directly: TriggerToggle's Context calls resolve these
  // inherited Actor methods on its real SavedTrigger object.
  void functions.beginEvent;
  void functions.endEvent;

  reset();
  return {
    runtime,
    lights: identities.slice(),
    reset,
    trigger,
    tickActor,
    tick,
    snapshot,
  };
}

export default createScriptLights;
