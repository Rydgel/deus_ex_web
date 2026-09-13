/**
 * Native boundaries and original UFunction preparation for the mission
 * trigger slice.
 *
 * OrdersTrigger, FlagTrigger, and DamageTrigger remain original bytecode. The
 * host service below only owns the recovered native boundaries needed by those
 * UFunctions: Core string inequality, Extension.FlagBase bool operations, and
 * Actor.GetPlayerPawn's viewport walk. It deliberately does not hand-write a
 * second Orders/Flag event implementation: Play must execute the prepared
 * UFunctions through ScriptRuntime.
 */

import { scriptStringEqual } from './script-string-operations.mjs';

const lower = value => String(value ?? '').toLowerCase();

/**
 * Apply the native XFlagBool low-bit operation to a direct host value. The VM
 * supplies a typed UBOOL (0/1), while a direct native harness may pass an
 * integer word; preserving only bit 0 matches the SetBool body at
 * Extension.dll+0x23cac-0x23cb5 and +0x23cf5-0x23d07.
 */
function nativeBool(value, label = 'bool') {
  if (typeof value === 'boolean') return value;
  if (Number.isInteger(value)) return (value & 1) !== 0;
  throw new TypeError(`${label} must be a boolean or integer UBOOL word`);
}

/**
 * Execute the actual Engine native-720 pointer walk against an explicit host
 * graph. The retail body (Engine.dll+0x6d2a0, exported by the thunk at
 * +0x28ce) reads Actor+0xac (XLevel), XLevel+0x40 (Engine), Engine+0x44
 * (Client), Client+0x2c/+0x30 (Viewports data/count), then the first viewport's
 * +0x30 Actor. A null at any tested pointer or a non-positive count returns
 * null. `read` must expose those named graph slots; it may return either a JS
 * array or `{ data, count }` for the native TArray.
 */
export function resolveNativeGetPlayerPawn(receiver, { read } = {}) {
  if (typeof read !== 'function') throw new TypeError('GetPlayerPawn requires an explicit native graph read service');
  if (receiver === null || receiver === undefined) return null;
  const readField = (object, name) => {
    const value = read(object, name);
    if (value === undefined) throw new Error(`GetPlayerPawn graph field is not linked: ${name}`);
    return value;
  };

  const xLevel = readField(receiver, 'XLevel');
  if (xLevel == null) return null;
  const engine = readField(xLevel, 'Engine');
  if (engine == null) return null;
  const client = readField(engine, 'Client');
  if (client == null) return null;
  const viewportArray = readField(client, 'Viewports');
  let data, count;
  if (Array.isArray(viewportArray)) {
    data = viewportArray;
    count = viewportArray.length;
  } else if (viewportArray && typeof viewportArray === 'object') {
    data = viewportArray.data ?? viewportArray.Data;
    count = viewportArray.count ?? viewportArray.Count ?? viewportArray.num ?? viewportArray.Num;
  }
  if (!Array.isArray(data) || !Number.isInteger(count)) {
    throw new TypeError('GetPlayerPawn requires a native Viewports data/count pair');
  }
  if (count <= 0) return null;
  if (data.length === 0) throw new TypeError('GetPlayerPawn Viewports count is positive but data is empty');
  if (data[0] == null) return null;
  return readField(data[0], 'Actor') ?? null;
}

/** Native declarations reached by the original trigger bytecode. */
export const TRIGGER_NATIVE_INDICES = Object.freeze({
  GetPlayerPawn: 720,
  StringNotEqual: 123,
  SetTimer: 280,
  Destroy: 279,
  AllActors: 304,
  SetBool: 1100,
  GetBool: 1110,
});

/**
 * Minimal Extension.FlagBase bool store backed by the recovered native body.
 *
 * The VM's UBOOL wrapper normalizes inputs to logical false/true; the native
 * XFlagBool storage then retains the value's low bit. SetBool updates an
 * existing bool, creates a missing bool only
 * when bAdd is true, substitutes defaultExpiration for expiration -1, and
 * returns whether a bool object exists afterwards. XFlagBase::GetBool returns
 * false for a missing bool. Expiration storage is preserved, while the
 * separate DeleteExpiredFlags/clock path remains outside this slice.
 */
export function createFlagBase({ initialFlags, defaultExpiration = 0 } = {}) {
  const entries = new Map();
  const calls = [];
  const initial = initialFlags instanceof Map
    ? initialFlags.entries()
    : Object.entries(initialFlags ?? {});

  for (const [name, value] of initial) {
    const entry = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, value: nativeBool(value.value, 'initial flag value') }
      : { value: nativeBool(value, 'initial flag value'), expiration: undefined };
    entries.set(lower(name), { name, ...entry });
  }

  const current = name => entries.get(lower(name));

  return {
    entries,
    calls,
    /** Extension.FlagBase.SetBool(Name,bool,optional bool,optional int). */
    setBool(name, value, bAdd = true, expiration = -1) {
      const key = lower(name);
      const previous = current(name);
      const add = bAdd === undefined ? true : nativeBool(bAdd, 'bAdd');
      const boolValue = nativeBool(value, 'value');
      const requestedExpiration = expiration === undefined ? -1 : expiration;
      const effectiveExpiration = requestedExpiration === -1
        ? defaultExpiration : requestedExpiration;

      // The native body returns false without inserting a missing flag when
      // bAdd is false.
      if (!previous && !add) {
        calls.push({ method: 'SetBool', name: name ?? 'None', value: boolValue,
          bAdd: add, expiration: effectiveExpiration, requestedExpiration,
          previous: undefined, added: false });
        return false;
      }

      const entry = {
        name: name ?? 'None',
        value: boolValue,
        bAdd: add,
        expiration: effectiveExpiration,
        requestedExpiration,
      };
      entries.set(key, entry);
      calls.push({ method: 'SetBool', name: entry.name, value: entry.value,
        bAdd: entry.bAdd, expiration: entry.expiration, requestedExpiration,
        previous: previous?.value, added: !previous });
      return true;
    },
    /** Extension.FlagBase.GetBool(Name). */
    getBool(name) {
      const entry = current(name);
      const value = Boolean(entry?.value);
      calls.push({ method: 'GetBool', name: name ?? 'None', value });
      return value;
    },
    getEntry(name) {
      const entry = current(name);
      return entry ? { ...entry } : null;
    },
  };
}

/**
 * Create the small native service used while original trigger UFunctions run.
 * `getPlayerPawn` must be supplied by the Play host, or the host can pass
 * `getPlayerPawnServices` to use resolveNativeGetPlayerPawn directly. There is
 * no global-player fallback: native 720 reads the receiver's XLevel -> Engine
 * -> Client -> first Viewport.Actor graph, so a callback that simply returns a
 * captured player would bypass the recovered native boundary.
 */
export function createScriptTriggers({
  player = null,
  flagBase = createFlagBase(),
  getPlayerPawn = null,
  getPlayerPawnServices = null,
} = {}) {
  if (!flagBase || typeof flagBase.getBool !== 'function' || typeof flagBase.setBool !== 'function') {
    throw new TypeError('Trigger natives require a FlagBase with getBool/setBool');
  }
  const resolvePlayerPawn = typeof getPlayerPawn === 'function'
    ? getPlayerPawn
    : getPlayerPawnServices
      ? receiver => resolveNativeGetPlayerPawn(receiver, getPlayerPawnServices)
      : null;

  const evaluateValue = (call, index) => {
    const value = call.evaluateArgument(index);
    return value?.reference ? value.get() : value;
  };

  /**
   * Native callback adapter. Return `value` only when `handled` is true and
   * let ScriptRuntime's normal native path handle all other indices.
   */
  function handleNative(call) {
    const index = call?.index;
    if (index === TRIGGER_NATIVE_INDICES.GetPlayerPawn) {
      if (call.argumentCount !== 0) throw new Error('GetPlayerPawn accepts no arguments');
      if (!resolvePlayerPawn) throw new Error('GetPlayerPawn requires an explicit native graph service');
      return { handled: true, value: resolvePlayerPawn(call.receiver) };
    }
    if (index === TRIGGER_NATIVE_INDICES.StringNotEqual) {
      if (call.argumentCount !== 2) throw new Error('String != accepts two arguments');
      const left = evaluateValue(call, 0);
      const right = evaluateValue(call, 1);
      if (typeof left !== 'string' || typeof right !== 'string') {
        throw new TypeError('String != requires typed string operands');
      }
      return { handled: true, value: !scriptStringEqual(left,right) };
    }
    if (index === TRIGGER_NATIVE_INDICES.SetBool) {
      if (call.receiver !== flagBase) throw new Error('FlagBase.SetBool reached with an unbound receiver');
      if (call.argumentCount < 2 || call.argumentCount > 4) throw new Error('FlagBase.SetBool argument count');
      const name = evaluateValue(call, 0);
      const value = evaluateValue(call, 1);
      const bAdd = call.argumentCount > 2 ? evaluateValue(call, 2) : true;
      const expiration = call.argumentCount > 3 ? evaluateValue(call, 3) : -1;
      return { handled: true, value: flagBase.setBool(name, value, bAdd, expiration) };
    }
    if (index === TRIGGER_NATIVE_INDICES.GetBool) {
      if (call.receiver !== flagBase) throw new Error('FlagBase.GetBool reached with an unbound receiver');
      if (call.argumentCount !== 1) throw new Error('FlagBase.GetBool argument count');
      return { handled: true, value: flagBase.getBool(evaluateValue(call, 0)) };
    }
    return { handled: false };
  }

  /** Bind the player field used by original FlagTrigger bytecode. */
  function bindPlayerFlagBase(runtime, playerActor = player) {
    if (!runtime || !playerActor) throw new TypeError('FlagBase binding requires runtime and player actor');
    const instance = runtime.instance(playerActor);
    const field = runtime.lookupMember(instance.cls, 'fields', 'flagBase');
    if (!field) throw new Error('DeusExPlayer.FlagBase property is not linked');
    runtime.bindProperty(playerActor, field, {
      get: () => flagBase,
      set: value => {
        if (value !== flagBase) throw new Error('Changing the trigger FlagBase requires native ownership');
      },
    });
    return flagBase;
  }

  return { flagBase, handleNative, bindPlayerFlagBase };
}

/**
 * Original trigger functions which a VM-backed Play host must prepare before
 * routing Touch/UnTouch/Trigger/UnTrigger/Timer. The list includes inherited
 * Actor callbacks used by Super and FlagTrigger's tagged fanout.
 */
const PREPARE_TARGETS = Object.freeze([
  ['Engine', 'actor.trigger'], ['Engine', 'actor.untrigger'],
  ['Engine', 'trigger.touch'], ['Engine', 'trigger.untouch'], ['Engine', 'trigger.isrelevant'],
  ['DeusEx', 'orderstrigger.touch'], ['DeusEx', 'orderstrigger.trigger'], ['DeusEx', 'orderstrigger.startpatrolling'],
  ['DeusEx', 'scriptedpawn.setorders'], ['DeusEx', 'scriptedpawn.followorders'],
  ['DeusEx', 'scriptedpawn.setstate'], ['DeusEx', 'scriptedpawn.setnextstate'],
  ['DeusEx', 'scriptedpawn.findtaggedactor'], ['DeusEx', 'scriptedpawn.findorderactor'],
  ['DeusEx', 'damagetrigger.timer'], ['DeusEx', 'damagetrigger.touch'],
  ['DeusEx', 'damagetrigger.untouch'], ['DeusEx', 'damagetrigger.trigger'], ['DeusEx', 'damagetrigger.untrigger'],
  // Live Training radiation reaches this exact original chain after the
  // DamageTrigger Timer writes damagee.  Keep every function on the VM path;
  // the later TakeDamage body remains bounded when it reaches its existing
  // PlayAnim/mesh integration boundary.
  ['DeusEx', 'deusexplayer.takedamage'], ['DeusEx', 'deusexplayer.adddamagedisplay'],
  ['DeusEx', 'deusexplayer.dxreducedamage'], ['DeusEx', 'deusexplayer.stoppoison'],
  ['DeusEx', 'deusexplayer.usingchargedpickup'], ['DeusEx', 'deusexplayer.setdamagepercent'],
  ['DeusEx', 'deusexplayer.clientflash'],
  ['DeusEx', 'flagtrigger.touch'], ['DeusEx', 'flagtrigger.untouch'],
  ['DeusEx', 'flagtrigger.trigger'], ['DeusEx', 'flagtrigger.untrigger'],
  ['Extension', 'flagbase.setbool'], ['Extension', 'flagbase.getbool'],
]);

/** Prepare the original trigger UFunctions for a VM-backed host. */
export async function prepareTriggerFunctions(runtime, assets) {
  if (!runtime?.prepareFunction || !assets?.get) throw new TypeError('Trigger preparation requires runtime and AssetStore');
  const records = new Map();
  for (const [packageName, path] of PREPARE_TARGETS) {
    const asset = await assets.get(packageName);
    const index = asset.exportsByPath?.get(path);
    if (!index) throw new Error(`Original trigger function is not exported: ${packageName}.${path}`);
    records.set(`${packageName}.${path}`, await runtime.prepareFunction(asset, index));
  }
  return records;
}

/** Bind FlagBase and prepare the original action functions in one setup call. */
export async function linkScriptTriggers({ runtime, assets, player, ...options } = {}) {
  const actions = createScriptTriggers({ player, ...options });
  actions.bindPlayerFlagBase(runtime, player);
  const functions = await prepareTriggerFunctions(runtime, assets);
  return { actions, functions };
}

export const createTriggerActions = createScriptTriggers;
export default createScriptTriggers;
