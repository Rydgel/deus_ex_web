/** SpawnPlayActor's travel import (Engine.dll 0x10396bd0, body 0x103971f7..0x10397c34): the three-pass read of the travel text and the
 * callbacks around it (docs/travel.md "SpawnPlayActor: importing the travel text").
 *
 *   0. `name = URL.GetOption("NAME=", DefaultName)`; the text is TravelInfo[name] (case-insensitive), else, in NM_Standalone, the
 *      first pair's value. No text: nothing is imported. A `loadonly` option skips the import altogether (the caller).
 *   1. objects: for each record, StaticLoadClass(UObject, class path); a missing class logs `SpawnPlayActor: Cannot accept travelling
 *      class '<class>'` and the record is ignored; a PlayerPawn class stands for the new player (the one Login made); an Actor class is
 *      SpawnActor(Class, None, Owner = player, Instigator = None, player.Location, player.Rotation, bNoCollisionFail), a failure
 *      logging `Failed to spawn travelling class`; the Extension flag objects become the player's flag store (below); any other
 *      class is StaticConstructObject(Class, Outer = player, NAME_None, 0, NULL), which is the script's `new(Self) class'X'`
 *      (ScriptRuntime.newObject: DeusExNote, DeusExGoal and NanoKeyInfo, the Object subclasses of a player's notes, goals and keys; the native
 *      ConSys.ConHistory and ConHistoryEvent through script-conplay-live.mjs constructHistoryObject); a class the runtime has no constructor
 *      for is an explicit stop. Each object is entered in a table with
 *      its record's `Ptr`.
 *   2. properties: every stored line, the property found in the object's class chain among those with CPF_Travel (a missing or
 *      non-travel property is ignored); an object property with a hex pointer is remembered for pass 3, `None` is stored; any other
 *      property is ImportText of the value.
 *   3. references: each remembered (slot, pointer) whose pointer matches an entry's `Ptr` gets that entry's object. A pointer that
 *      matches nothing leaves the slot as Login made it.
 *   then, around AcceptInventory: TravelPreAccept on the imported actors last to first, TravelPostAccept last to first (the player's
 *   own come from the caller: script-player-login.mjs).
 *
 * The FlagBase records are Play's flag store (script-triggers.mjs createFlagBase): the player's store is emptied and refilled from the
 * `hashTable` heads and `nextFlag` chains in text order, each flag with its record's type, value and expiration, and
 * `defaultFlagExpiration` as the default expiration. The text's `flagHash` is checked against the FName hash the store uses.
 *
 * Class loading is asynchronous, so `prepare` loads every class of the text first; `apply` is then synchronous like Login. */
import { importText } from './config-text.mjs';
import { hashScriptName } from './script-names.mjs';
import { parseTravelText, parsePropertyLine, parseObjectValue, TravelTextError } from './travel-text.mjs';
import { isHostFlagBase } from './travel-export.mjs';
import { constructHistoryObject } from './script-conplay-live.mjs';

const lower = value => String(value ?? '').toLowerCase();
export class UnsupportedTravelImportError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'UnsupportedTravelImportError'; Object.assign(this, details); }
}

const FLAG_CLASS_TYPE = { flagbool: 0, flagbyte: 1, flagint: 2, flagfloat: 3, flagname: 4, flagvector: 5, flagrotator: 6 };
const FLAG_VALUE = { flagbool: 'bValue', flagint: 'intValue' };

/** URL.GetOption("NAME=", DefaultName) over the URL's option list; DefaultName is "Player" ([DefaultPlayer] Name). */
export function travelKey(options, fallback = 'Player') {
  for (const option of options) if (lower(option).startsWith('name=')) return option.slice(5);
  return fallback;
}

/** TravelInfo[name] by appStricmp, else the first pair's value (NM_Standalone, non-empty map). */
export function findTravelText(pairs, name) {
  if (!pairs?.length) return null;
  const found = pairs.find(([key]) => lower(key) === lower(name)) ?? pairs[0];
  return found[1];
}

export function createTravelImporter({ runtime, assets, level, exporter, log, prepareClass, flagBaseOf }) {
  const classes = new Map();   // lower class path -> linked class | null
  const isChildOf = (cls, key) => { for (let c = cls; c; c = c.base) if (c.record.key === key) return true; return false; };

  async function loadClassPath(path) {
    const key = lower(path);
    if (classes.has(key)) return classes.get(key);
    let cls = null;
    const dot = path.indexOf('.');
    if (dot > 0 && assets.files.has(lower(path.slice(0, dot)))) {
      const asset = await assets.get(path.slice(0, dot)), index = asset.exportsByPath.get(lower(path.slice(dot + 1)));
      if (index && asset.pkg.exports[index - 1].className === 'Class') cls = await runtime.loadClass(asset, index);
    }
    classes.set(key, cls);
    return cls;
  }

  /** Load every class a text names (and prepare the Actor classes for spawning). Returns {records, key}. */
  async function prepare(arrival) {
    const key = travelKey(arrival.options), text = findTravelText(arrival.travelInfo, key);
    if (text === null) return { records: [], text: null, key };
    const records = parseTravelText(text);
    for (const record of records) {
      const cls = await loadClassPath(record.class);
      if (cls && isChildOf(cls, 'engine.actor')) await prepareClass(cls);
    }
    return { records, text, key };
  }

  /** Pass 1..3 for the new `player`; returns the callbacks to run around AcceptInventory. */
  function apply(prepared, player) {
    const { records } = prepared;
    if (!records.length) return { imported: [], preAccept() {}, postAccept() {} };
    const table = new Map();          // ptr -> entry
    const entries = [];
    const read = (object, name) => runtime.readNamed(object, name);
    // Pass 1
    for (const record of records) {
      const cls = classes.get(lower(record.class));
      if (!cls) { log('Log', `SpawnPlayActor: Cannot accept travelling class '${record.class}'`); continue; }
      const entry = { record, cls, object: null, flag: false };
      if (isChildOf(cls, 'engine.playerpawn')) entry.object = player;
      else if (isChildOf(cls, 'engine.actor')) {
        const object = runtime.spawnActor({ cls: cls.record, level, name: 'None', owner: player, instigator: null,
          location: [...read(player, 'Location')], rotation: [...read(player, 'Rotation')], noCollisionFail: true });
        if (!object) { log('Log', `Failed to spawn travelling class '${record.class}'`); continue; }
        entry.object = object;
      } else if (lower(cls.record.key).startsWith('extension.flag')) entry.flag = true;
      else {
        // Any other class: StaticConstructObject(Class, Outer = player, NAME_None, 0, NULL, GError), which is the `new(Self) class'X'` of
        // ScriptRuntime.newObject (DeusExNote, DeusExGoal and NanoKeyInfo are the script-only Object subclasses a player's lists hold).
        // The conversation history's two classes are native (ConSys): built as the CreateHistoryObject/CreateHistoryEvent natives build them, Outer = player.
        const historyKey = cls.record.key;
        try {
          if (historyKey === 'consys.conhistory' || historyKey === 'consys.conhistoryevent')
            entry.object = constructHistoryObject(runtime, level, cls, historyKey === 'consys.conhistoryevent', { outer: runtime.playerNativeObject(player) });
          else entry.object = runtime.newObject({ outer: player, name: 'None', flags: 0, classRef: cls.record });
        } catch (error) {
          throw new UnsupportedTravelImportError(`SpawnPlayActor: the travelling class ${record.class} is neither a PlayerPawn, an Actor, a flag object nor an Object subclass the runtime constructs (${error.message})`, { class: record.class });
        }
      }
      entries.push(entry);
      table.set(record.ptr, entry);
    }
    // Pass 2
    const references = [];
    const flagValues = new Map();     // flag entry -> {name, hash, expiration, value, type, next, hashTable heads...}
    for (const entry of entries) {
      const props = exporter.propertiesOf(entry.cls, true);
      const fl = entry.flag ? { hashTable: [], values: {} } : null;
      if (fl) flagValues.set(entry, fl);
      for (const line of entry.record.lines) {
        const parsed = parsePropertyLine(line);
        if (!parsed) continue;
        const property = props.find(candidate => lower(candidate.name) === lower(parsed.name));
        if (!property) continue;
        if (property.kind === 'ObjectProperty') {
          const object = parseObjectValue(parsed.value);
          if (!object) continue;
          if (object.ptr === null) { if (!entry.flag) writeElement(entry.object, property, parsed.index, null); continue; }
          references.push({ entry, property, index: parsed.index, ptr: object.ptr });
        } else if (entry.flag) fl.values[lower(property.name)] = importValue(entry, property, parsed.value);
        else writeElement(entry.object, property, parsed.index, importValue(entry, property, parsed.value));
      }
    }
    // Pass 3
    for (const reference of references) {
      const target = table.get(reference.ptr);
      if (!target) continue;
      const { entry, property } = reference;
      if (entry.flag) {
        const fl = flagValues.get(entry);
        if (lower(property.name) === 'hashtable') fl.hashTable[reference.index] = target;
        else fl.values[lower(property.name)] = target;
      } else if (target.flag) {
        // the player's FlagBase: Play's store is filled from the records below; the property itself keeps the store
        if (!isHostFlagBase(read(entry.object, property.name)))
          throw new UnsupportedTravelImportError(`SpawnPlayActor: ${exporter.classPath(entry.cls)}.${property.name} points at a flag object but is not the host FlagBase`);
      } else writeElement(entry.object, property, reference.index, target.object);
    }
    // The flag records -> the player's store
    const baseEntry = entries.find(entry => entry.flag && lower(entry.cls.record.key) === 'extension.flagbase');
    if (baseEntry) fillFlagStore(flagBaseOf(player), baseEntry, flagValues);
    const imported = entries.filter(entry => entry.object && entry.object !== player);
    const run = name => () => {
      for (let i = imported.length - 1; i >= 0; i--) {
        const object = imported[i].object;
        const record = runtime.lookup(object, name);
        if (record?.function) runtime.processEvent(object, name, [], null, record);
      }
    };
    return { imported: imported.map(entry => entry.object), preAccept: run('TravelPreAccept'), postAccept: run('TravelPostAccept') };
  }

  function importValue(entry, property, text) {
    const kind = { BoolProperty: 'bool', IntProperty: 'int', ByteProperty: 'byte', FloatProperty: 'float', NameProperty: 'name', StrProperty: 'string' }[property.kind];
    if (kind) {
      // pass 2 turns every `\` of the stored value back into a newline before ImportText (the exporter's replacement; docs/travel.md "Play, step 4")
      if (kind === 'string') text = text.replaceAll('\\', '\n');
      const result = importText(kind, text, { enumNames: exporter.enumNamesOf(property.property) });
      if (!result || result.value === undefined) throw new TravelTextError(`SpawnPlayActor: ${property.name}=${JSON.stringify(text)} is not a ${kind}`);
      return result.value;
    }
    if (property.kind === 'StructProperty') return importStruct(entry, property, text);
    throw new UnsupportedTravelImportError(`SpawnPlayActor: ${exporter.classPath(entry.cls)}.${property.name} (${property.kind.replace('Property', '')}) is not a property kind whose travel text was measured`,
      { class: exporter.classPath(entry.cls), property: property.name, kind: property.kind });
  }

  /** UStructProperty::ImportText for `(Member=value,...)` over simple members; the members the text omits keep their current value. */
  function importStruct(entry, property, text) {
    const field = entry.flag ? null : runtime.namedField(entry.object, property.name);
    if (!field?.metadata.structFields) throw new UnsupportedTravelImportError(`SpawnPlayActor: struct ${property.name} is not linked`);
    const match = /^\((.*)\)$/s.exec(text);
    if (!match) throw new TravelTextError(`SpawnPlayActor: ${property.name}=${JSON.stringify(text)} is not a struct`);
    const patch = {};
    for (const part of match[1].split(',')) {
      const [memberName, value] = [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)];
      const member = field.metadata.structFields.find(candidate => lower(candidate.name) === lower(memberName));
      if (!member) continue;
      const kind = { bool: 'bool', int: 'int', byte: 'byte', float: 'float', name: 'name', string: 'string' }[member.metadata.type];
      if (!kind || member.metadata.arrayDim > 1)
        throw new UnsupportedTravelImportError(`SpawnPlayActor: struct member ${property.name}.${memberName} (${member.metadata.type}) is not a measured kind`);
      patch[member.key] = importText(kind, value, { enumNames: null }).value;
    }
    return { struct: true, patch };
  }

  function writeElement(object, property, index, value) {
    if (value && value.struct) {
      const current = property.dim > 1 ? read2(object, property.name)[index] : read2(object, property.name);
      value = { ...current, ...value.patch };
    }
    if (property.dim > 1) {
      const whole = read2(object, property.name);
      whole[index] = value;
      runtime.writeNamed(object, property.name, whole);
    } else runtime.writeNamed(object, property.name, value);
  }
  const read2 = (object, name) => runtime.readNamed(object, name);

  function fillFlagStore(store, baseEntry, flagValues) {
    if (!store) throw new UnsupportedTravelImportError('SpawnPlayActor: the new player has no FlagBase to fill');
    store.deleteAllFlags();
    const base = flagValues.get(baseEntry);
    if (base.values.defaultflagexpiration !== undefined) store.setDefaultExpiration(base.values.defaultflagexpiration);
    for (const head of base.hashTable) {
      for (let at = head; at; at = flagValues.get(at).values.nextflag) {
        const flag = flagValues.get(at), type = FLAG_CLASS_TYPE[lower(at.cls.record.name)];
        const name = flag.values.flagname, expiration = flag.values.expiration ?? 0;
        if (type === undefined || !FLAG_VALUE[lower(at.cls.record.name)])
          throw new UnsupportedTravelImportError(`SpawnPlayActor: the flag type ${at.cls.record.name} is not a measured one`);
        if (flag.values.flaghash !== undefined && (flag.values.flaghash | 0) !== (hashScriptName(lower(name)) | 0))
          throw new UnsupportedTravelImportError(`SpawnPlayActor: flag ${name} carries the hash ${flag.values.flaghash}, not the FName hash`);
        const value = flag.values[lower(FLAG_VALUE[lower(at.cls.record.name)])];
        if (type === 0) store.setBool(name, Boolean(value), true, expiration);
        else store.setInt(name, value | 0, true, expiration);
      }
    }
  }

  return { prepare, apply, loadClassPath };
}
