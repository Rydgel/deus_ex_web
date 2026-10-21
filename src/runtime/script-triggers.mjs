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
import { hashScriptName } from './script-names.mjs';

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
  SetInt: 1102,
  GetBool: 1110,
  GetInt: 1112,
  CheckFlag: 1120,
  DeleteFlag: 1121,
  SetExpiration: 1122,
  DeleteExpiredFlags: 1124,
  SetDefaultExpiration: 1125,
  CreateIterator: 1126,
  GetNextFlagName: 1127,
  GetNextFlag: 1128,
  DestroyIterator: 1129,
  DeleteAllFlags: 1130,
});

/**
 * Minimal Extension.FlagBase bool store backed by the recovered native body.
 *
 * The VM's UBOOL wrapper normalizes inputs to logical false/true; the native
 * XFlagBool storage then retains the value's low bit. SetBool updates an
 * existing bool, creates a missing bool only
 * when bAdd is true, substitutes defaultExpiration for expiration -1, and
 * returns whether a bool object exists afterwards. XFlagBase::GetBool returns
 * false for a missing bool. Expiration is compared with mission criteria,
 * not a clock (docs/script-training-mission-entry.md).
 */
export function createFlagBase({ initialFlags, defaultExpiration = 0, slots = null } = {}) {
  const entries = new Map();
  // Each flag is an XFlagBool, a UObject: AddFlag's `new` takes a GObjObjects slot and the delete gives it back
  // (`slots`: the host's slot model, original-object-index.mjs; the delete order here is insertion order, the native
  // walks its hash buckets, so the order slots are given back in is the model's, not measured).
  const holders = new Map();
  const takeSlot = (key, type = 0) => { if (slots && !holders.has(key)) { const holder = {}; slots.take(holder, FLAG_CLASSES[type], key.split('\u0000')[0]); holders.set(key, holder); } };
  const giveBackSlot = key => { const holder = holders.get(key); if (holder) { slots.giveBack(holder); holders.delete(key); } };
  const calls = [];
  // XFlagBase::SetDefaultExpiration (native 1125, exec 0x10025dc0) writes the
  // raw int to +0x128; SetBool substitutes it for an expiration of -1. The
  // constructor 0x100239a0 zeroes it, matching the default here.
  let currentDefaultExpiration = defaultExpiration | 0;
  const initial = initialFlags instanceof Map
    ? initialFlags.entries()
    : Object.entries(initialFlags ?? {});

  for (const [name, value] of initial) {
    const entry = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, value: nativeBool(value.value, 'initial flag value') }
      : { value: nativeBool(value, 'initial flag value'), expiration: undefined };
    entries.set(lower(name), { name, type: 0, ...entry });
  }

  // A flag is found by its name and its EFlagType (FindName 0x10024e60 compares the FName index and the type byte): a bool (type 0) is keyed
  // by its lowercase name, a flag of another type by the name and the type, so a bool and an int of one name are two flags.
  const keyOf = (name, type = 0) => type === 0 ? lower(name) : `${lower(name)}\u0000${type}`;
  const current = (name, type = 0) => entries.get(keyOf(name, type));
  const FLAG_CLASSES = ['FlagBool', 'FlagByte', 'FlagInt', 'FlagFloat', 'FlagName', 'FlagVector', 'FlagRotator'];
  // The native table order the iterators walk (docs/script-flagbase-iterators.md):
  // 64 buckets by the FName CRC (hashScriptName) & 63, each chain ascending by
  // the signed full hash (FindName 0x10024e60's JG walk; AddFlag 0x10023b20
  // links a new flag there), a new flag after equal-hash flags of other names.
  // `entries` keeps insertion order (an update keeps its node, a delete and
  // re-add appends), so a stable sort by signed hash is each chain.
  const hashOf = key => hashScriptName(lower(entries.get(key).name));
  const chainOf = bucket => [...entries.keys()]
    .filter(key => (hashOf(key) & 63) === bucket)
    .sort((a, b) => (hashOf(a) | 0) - (hashOf(b) | 0));
  // XFlagBase::CreateIterator 0x10024bb0 GMallocs {type, current, bucket};
  // its address is the script's int. A counter stands in for the address,
  // which scripts only pass back.
  const iterators = new Map();
  let nextIterator = 1;

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
        ? currentDefaultExpiration : requestedExpiration;

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
        type: 0,
        value: boolValue,
        bAdd: add,
        expiration: effectiveExpiration,
        requestedExpiration,
      };
      entries.set(key, entry);
      takeSlot(key);
      calls.push({ method: 'SetBool', name: entry.name, value: entry.value,
        bAdd: entry.bAdd, expiration: entry.expiration, requestedExpiration,
        previous: previous?.value, added: !previous });
      return true;
    },
    /** XFlagBase::SetInt 0x10023e80 (exec 0x100251a0, the same thunk as SetBool's): SetBool's body with GetFlag's type 2, a FlagInt
     * (operator new 0x1001a9b0, vtable 0x1005c040) for a missing flag with bAdd, and the whole int stored at +0x40 (SetBool keeps bit 0). */
    setInt(name, value, bAdd = true, expiration = -1) {
      const key = keyOf(name, 2);
      const previous = entries.get(key);
      const add = bAdd === undefined ? true : nativeBool(bAdd, 'bAdd');
      if (!Number.isInteger(value)) throw new TypeError('FlagBase.SetInt requires an int');
      const requestedExpiration = expiration === undefined ? -1 : expiration;
      const effectiveExpiration = requestedExpiration === -1 ? currentDefaultExpiration : requestedExpiration;
      // (the missing-flag, bAdd false branch is SetBool's: see setBool)
      if (!previous && !add) {
        calls.push({ method: 'SetInt', name: name ?? 'None', value: value | 0, bAdd: add, expiration: effectiveExpiration, requestedExpiration, previous: undefined, added: false });
        return false;
      }
      const entry = { name: name ?? 'None', type: 2, value: value | 0, bAdd: add, expiration: effectiveExpiration, requestedExpiration };
      entries.set(key, entry);
      takeSlot(key, 2);
      calls.push({ method: 'SetInt', name: entry.name, value: entry.value, bAdd: entry.bAdd, expiration: entry.expiration, requestedExpiration,
        previous: previous?.value, added: !previous });
      return true;
    },
    /** XFlagBase::CheckFlag 0x100247d0 (exec 0x10025aa0): whether GetFlag
     * finds `name` with that EFlagType. */
    checkFlag(name, type) {
      if (!Number.isInteger(type) || type < 0 || type > 255) throw new TypeError('FlagBase.CheckFlag requires a byte flag type');
      const found = Boolean(current(name, type));
      calls.push({ method: 'CheckFlag', name: name ?? 'None', type, found });
      return found;
    },
    /** XFlagBase::DeleteFlag 0x10024860: exact name/type lookup, then delete. */
    deleteFlag(name,type) {
      if(!Number.isInteger(type)||type<0||type>255)throw new TypeError('FlagBase.DeleteFlag requires a byte flag type');
      const found=entries.delete(keyOf(name,type));
      if(found)giveBackSlot(keyOf(name,type));
      calls.push({method:'DeleteFlag',name:name??'None',type,found});
      return found;
    },
    /** XFlagBase::DeleteExpiredFlags 0x10024ac0: zero never expires; other
     * signed expirations <= criteria do, of every type. */
    deleteExpiredFlags(criteria) {
      if(!Number.isInteger(criteria))throw new TypeError('Flag expiration criteria requires a signed int');
      criteria|=0;
      for(const [key,entry] of entries)
        if((entry.expiration|0)!==0&&(entry.expiration|0)<=criteria){entries.delete(key);giveBackSlot(key);}
      calls.push({method:'DeleteExpiredFlags',criteria});
    },
    /** Extension.FlagBase.GetInt(Name): XFlagBase::execGetInt 0x10025790 -> GetInt 0x100244e0 (GetFlag type 2, the int at +0x40); a missing
     * flag leaves the result 0. */
    getInt(name) {
      const entry = current(name, 2);
      const value = entry ? entry.value | 0 : 0;
      calls.push({ method: 'GetInt', name: name ?? 'None', value, found: Boolean(entry) });
      return value;
    },
    /** Extension.FlagBase.GetBool(Name). */
    getBool(name) {
      const entry = current(name, 0);
      const value = Boolean(entry?.value);
      calls.push({ method: 'GetBool', name: name ?? 'None', value });
      return value;
    },
    setExpiration(name,type,expiration) {
      if(!Number.isInteger(expiration))throw new TypeError('Flag expiration requires a signed int');
      const entry=current(name,type);
      if(entry)entry.expiration=expiration|0;
      calls.push({method:'SetExpiration',name,type,expiration:expiration|0,found:Boolean(entry)});
    },
    /** Extension.FlagBase.SetDefaultExpiration(int): writes the raw int to +0x128. */
    setDefaultExpiration(expiration) {
      if(!Number.isInteger(expiration))throw new TypeError('Flag default expiration requires a signed int');
      currentDefaultExpiration=expiration|0;
      calls.push({method:'SetDefaultExpiration',expiration:currentDefaultExpiration});
    },
    get defaultExpiration(){return currentDefaultExpiration;},
    /** XFlagBase::CreateIterator 0x10024bb0(flagType): {type, current NULL,
     * bucket -1}. */
    createIterator(type) {
      const id = nextIterator++;
      iterators.set(id, { type: type | 0, current: null, bucket: -1 });
      calls.push({ method: 'CreateIterator', type: type | 0, iterator: id });
      return id;
    },
    /** XFlagBase::GetNextFlag 0x10024c50(iterator, &name, &type): from the
     * current flag's next link, else the next nonempty bucket, the first flag
     * whose type matches (an iterator type < 0 or >= 7 matches every type);
     * the iterator keeps that flag and bucket. Exhausted, or for a null
     * iterator: false, None, type 0. */
    getNextFlag(id) {
      const iterator = iterators.get(id);
      let found = null;
      if (iterator) {
        const matches = key => iterator.type >= 7 || iterator.type < 0 || iterator.type === entries.get(key).type;
        let bucket = iterator.bucket, chain = bucket >= 0 && bucket < 64 ? chainOf(bucket) : [], at = 0;
        if (iterator.current !== null) {
          at = chain.indexOf(iterator.current);
          // The native reads current->next: a flag deleted since the last call
          // was freed, and its link is gone.
          if (at < 0) throw new Error('FlagBase.GetNextFlag after its current flag was deleted (the native reads freed memory)');
          at++;
        } else at = chain.length;
        while (bucket < 64) {
          if (at < chain.length && matches(chain[at])) { found = chain[at]; break; }
          if (at < chain.length) { at++; continue; }
          bucket++; at = 0;
          chain = bucket < 64 ? chainOf(bucket) : [];
        }
        iterator.bucket = bucket;
        iterator.current = found;
      }
      const entry = found === null ? null : entries.get(found);
      const result = { found: Boolean(entry), name: entry ? entry.name : 'None', type: entry ? entry.type : 0 };
      calls.push({ method: 'GetNextFlag', iterator: id, ...result });
      return result;
    },
    /** XFlagBase::DestroyIterator 0x10024d00: GMalloc free. */
    destroyIterator(id) {
      iterators.delete(id);
      calls.push({ method: 'DestroyIterator', iterator: id });
    },
    /** XFlagBase::DeleteAllFlags 0x10024900: each bucket's head deleted until
     * the bucket is empty. */
    deleteAllFlags() {
      for (const key of [...entries.keys()]) giveBackSlot(key);
      entries.clear();
      calls.push({ method: 'DeleteAllFlags' });
    },
    getEntry(name, type = 0) {
      const entry = current(name, type);
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
    if (index === TRIGGER_NATIVE_INDICES.SetInt) {
      if (call.receiver !== flagBase || typeof flagBase.setInt !== 'function') throw new Error('FlagBase.SetInt reached with an unbound receiver');
      if (call.argumentCount < 2 || call.argumentCount > 4) throw new Error('FlagBase.SetInt argument count');
      const bAdd = call.argumentCount > 2 ? evaluateValue(call, 2) : true;
      const expiration = call.argumentCount > 3 ? evaluateValue(call, 3) : -1;
      return { handled: true, value: flagBase.setInt(evaluateValue(call, 0), evaluateValue(call, 1), bAdd, expiration) };
    }
    if(index===TRIGGER_NATIVE_INDICES.SetExpiration){
      if(call.receiver!==flagBase||call.argumentCount!==3)throw new Error('FlagBase.SetExpiration receiver/arguments');
      flagBase.setExpiration(evaluateValue(call,0),evaluateValue(call,1)&255,evaluateValue(call,2));
      return {handled:true,value:undefined};
    }
    if(index===TRIGGER_NATIVE_INDICES.DeleteFlag){
      if(call.receiver!==flagBase||call.argumentCount!==2)throw new Error('FlagBase.DeleteFlag receiver/arguments');
      return {handled:true,value:flagBase.deleteFlag(evaluateValue(call,0),evaluateValue(call,1)&255)};
    }
    if(index===TRIGGER_NATIVE_INDICES.DeleteExpiredFlags){
      if(call.receiver!==flagBase||call.argumentCount!==1)throw new Error('FlagBase.DeleteExpiredFlags receiver/arguments');
      flagBase.deleteExpiredFlags(evaluateValue(call,0));
      return {handled:true,value:undefined};
    }
    if(index===TRIGGER_NATIVE_INDICES.SetDefaultExpiration){
      if(call.receiver!==flagBase||call.argumentCount!==1)throw new Error('FlagBase.SetDefaultExpiration receiver/arguments');
      if(typeof flagBase.setDefaultExpiration!=='function')throw new Error('FlagBase.SetDefaultExpiration is unsupported for this store');
      flagBase.setDefaultExpiration(evaluateValue(call,0));
      return {handled:true,value:undefined};
    }
    if (index === TRIGGER_NATIVE_INDICES.CheckFlag) {
      if (call.receiver !== flagBase || call.argumentCount !== 2) throw new Error('FlagBase.CheckFlag receiver/arguments');
      if (typeof flagBase.checkFlag !== 'function') throw new Error('FlagBase.CheckFlag is unsupported for this store');
      return { handled: true, value: flagBase.checkFlag(evaluateValue(call, 0), evaluateValue(call, 1)) };
    }
    // FlagBase iterators (exec 0x10025e20/0x10025e90/0x10025f40/0x10026050/
    // 0x100260c0, docs/script-flagbase-iterators.md).
    if (index === TRIGGER_NATIVE_INDICES.CreateIterator) {
      if (call.receiver !== flagBase || call.argumentCount > 1) throw new Error('FlagBase.CreateIterator receiver/arguments');
      // P_GET_BYTE_OPTX(flagType, 7): FLAG_MAX, every type.
      const type = call.argumentCount ? evaluateValue(call, 0) & 255 : 7;
      return { handled: true, value: flagBase.createIterator(type) };
    }
    if (index === TRIGGER_NATIVE_INDICES.GetNextFlag || index === TRIGGER_NATIVE_INDICES.GetNextFlagName) {
      const withType = index === TRIGGER_NATIVE_INDICES.GetNextFlag;
      if (call.receiver !== flagBase || call.argumentCount !== (withType ? 3 : 2)) throw new Error('FlagBase.GetNextFlag receiver/arguments');
      const iterator = evaluateValue(call, 0);
      // The out name and type arrive through GPropAddr; a non-lvalue gets the
      // stack temporary.
      const name = call.evaluateArgument(1), type = withType ? call.evaluateArgument(2) : null;
      const result = flagBase.getNextFlag(iterator);
      if (name?.reference) name.set(result.name);
      if (type?.reference) type.set(result.type);
      return { handled: true, value: result.found };
    }
    if (index === TRIGGER_NATIVE_INDICES.DestroyIterator) {
      if (call.receiver !== flagBase || call.argumentCount !== 1) throw new Error('FlagBase.DestroyIterator receiver/arguments');
      flagBase.destroyIterator(evaluateValue(call, 0));
      return { handled: true, value: undefined };
    }
    if (index === TRIGGER_NATIVE_INDICES.DeleteAllFlags) {
      if (call.receiver !== flagBase || call.argumentCount !== 0) throw new Error('FlagBase.DeleteAllFlags receiver/arguments');
      flagBase.deleteAllFlags();
      return { handled: true, value: undefined };
    }
    if (index === TRIGGER_NATIVE_INDICES.GetInt) {
      if (call.receiver !== flagBase || typeof flagBase.getInt !== 'function') throw new Error('FlagBase.GetInt reached with an unbound receiver');
      if (call.argumentCount !== 1) throw new Error('FlagBase.GetInt argument count');
      return { handled: true, value: flagBase.getInt(evaluateValue(call, 0)) };
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
    const constructed=runtime.fieldReference(playerActor,field).get();
    if(constructed?.getBool && constructed?.setBool){flagBase=constructed;return flagBase;}
    if (!field) throw new Error('DeusExPlayer.FlagBase property is not linked');
    runtime.bindProperty(playerActor, field, {
      get: () => flagBase,
      set: value => {
        if (value !== flagBase) throw new Error('Changing the trigger FlagBase requires native ownership');
      },
    });
    return flagBase;
  }

  return { get flagBase(){return flagBase;}, handleNative, bindPlayerFlagBase };
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
