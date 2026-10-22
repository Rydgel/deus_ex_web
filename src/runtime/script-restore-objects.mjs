/** The non-actor objects of a saved game's level (docs/travel.md "The .dxs", "Play, step 4"). A level file written by `SaveGame` holds the whole object
 * graph of the player, not only the actors: `SaveCurrentLevel(position)` is not preceded by `PruneTravelActors` there, so the saved pawn still holds its
 * `FlagBase` and the `Flag*` objects it links, its notes, goals, key list, logs and conversation history. Each is an export with flags `0x70000` whose
 * tagged properties are its state (the Level's actor array does not list them); a restored level gives each its class storage and properties
 * (script-doors.mjs `restoreScriptObjects`), and this module adds what is native about them:
 *
 *   - `DeusExLog` (3010's `new DDeusExLog`, vtable 0x10027ad0) and `DataVaultImageNote` (3014, vtable 0x10027b24): UObject natives with no state of their own
 *     (script-player-log.mjs: the same vtables for a fresh object);
 *   - `FlagBase` and the `Flag*` chain: Play's flag store is the host store of script-triggers.mjs `createFlagBase` on the FlagBase object's identity, not a
 *     graph of script objects (travel-export.mjs, travel-import.mjs). The saved `hashTable[64]` heads and `nextFlag` chains are walked in file order into that
 *     store, each flag with its saved type (its class), value, expiration and name, and `defaultFlagExpiration` (the same fill as the travel import's).
 *
 * `DeusExNote`, `DeusExGoal` and `NanoKeyInfo` are plain script Objects (no native part): the generic restore is all they need. ConHistory/ConHistoryEvent have
 * their own adoption (script-conplay-live.mjs `adoptHistoryObject`). Any other class is an explicit stop. */
import { createFlagBase } from './script-triggers.mjs';
import { destroyFlagBaseNative } from './script-player-destroy.mjs';
import { NATIVE_ACTOR_CONSTRUCTORS } from './script-native-actor-constructors.mjs';
import { hashScriptName } from './script-names.mjs';

const lower = value => String(value ?? '').toLowerCase();

/** Script-only Object classes: the generic restore is complete. */
export const PLAIN_SAVED_OBJECTS = Object.freeze(new Set(['deusex.deusexnote', 'deusex.deusexgoal', 'deusex.nanokeyinfo']));
/** Native Object classes and the vtable of the object `CreateLogObject` / `CreateDataVaultImageNoteObject` make. */
export const NATIVE_SAVED_OBJECTS = Object.freeze({ 'deusex.deusexlog': 0x10027ad0, 'deusex.datavaultimagenote': 0x10027b24 });
const FLAG_TYPE = Object.freeze({ 'extension.flagbool': 0, 'extension.flagint': 2 });
const FLAG_VALUE = Object.freeze({ 'extension.flagbool': 'bValue', 'extension.flagint': 'intValue' });

export const isSavedFlagBase = key => key === 'extension.flagbase';
export const isSavedFlag = key => key === 'extension.flagbase' || key.startsWith('extension.flag');

/** A registered native record for a restored object whose identity already exists (the shape adoptHistoryObject builds). */
export function adoptNativeObject(runtime, level, identity, cls, entry, vtable) {
  const construction = runtime.actorLifecycle.construction, fname = construction.internName(entry.name);
  const native = { identity, index: -1, hashNext: null, stateFrame: null, linker: null, linkerIndex: -1,
    outer: level.nativeObject.outer, flags: 0, name: fname.name, nameIndex: fname.index, objectClass: cls };
  construction.registry.add(native);
  runtime.bindNativeObject(identity, native);
  native.nativeVtable = vtable;
  native.destroy = receiver => runtime.destroyObjectBase(receiver);
  return native;
}

/** The saved FlagBase object becomes the host flag store (XFlagBase's native vtable and Destroy, constructPlayerFlagBase's contract). */
export function adoptFlagBase(runtime, level, identity, cls, entry) {
  const contract = NATIVE_ACTOR_CONSTRUCTORS['deusex.deusexplayer'].conditionalFlagBase;
  const native = adoptNativeObject(runtime, level, identity, cls, entry, contract.vtable);
  native.destroy = receiver => destroyFlagBaseNative(receiver, { destroyObjectBase: target => runtime.destroyObjectBase(target) });
  Object.defineProperties(identity, Object.getOwnPropertyDescriptors(createFlagBase({ defaultExpiration: 0 })));
  return native;
}

/** Walk the saved `hashTable` heads and `nextFlag` chains of `base` (a FlagBase with its class storage) into its host store. Returns the number of flags. */
export function fillRestoredFlagStore(runtime, base, flagKeyOf) {
  const read = (object, name) => runtime.readNamed(object, name);
  base.deleteAllFlags();
  base.setDefaultExpiration(read(base, 'defaultFlagExpiration') | 0);
  let count = 0;
  for (const head of read(base, 'hashTable') ?? []) {
    for (let at = head; at; at = read(at, 'nextFlag')) {
      const key = flagKeyOf(at);
      const type = FLAG_TYPE[key], valueName = FLAG_VALUE[key];
      if (type === undefined) throw new Error(`A saved game's flag store holds a ${key} flag: only FlagBool and FlagInt have recovered natives (Play's flag store)`);
      const name = String(read(at, 'flagName')), expiration = read(at, 'expiration') | 0;
      const hash = read(at, 'flagHash') | 0;
      if (hash !== 0 && hash !== (hashScriptName(lower(name)) | 0)) throw new Error(`Saved flag ${name} carries the hash ${hash}, not the FName hash`);
      const value = read(at, valueName);
      if (type === 0) base.setBool(name, Boolean(value), true, expiration); else base.setInt(name, value | 0, true, expiration);
      count++;
    }
  }
  return count;
}
