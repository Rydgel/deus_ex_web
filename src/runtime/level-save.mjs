/** UObject::SavePackage(GLevel->GetOuter(), GLevel, 0, file) for Play's live level: the version-68 package a saved level is (docs/travel.md "The .dxs").
 *
 * What the original's file holds, and where each part comes from here:
 *   - every actor of Level.Actors, as `[FStateFrame header][tagged properties]` (RF_HasStack, flags 0x2070001): the class chain's properties that
 *     are not transient or native and not Identical to the class default's (tagged-write.mjs), read from the live objects;
 *   - the objects the actors reach whose Outer is the level package or an actor of it (the conversation history, notes, goals, logs): `[tagged
 *     properties]`, flags 0x70000;
 *   - `EventManager` and its `AIEventType`, `AISenderEvent` and `AIReceiverEvent` objects (ai-events-payload.mjs), from the Rust manager;
 *   - `Level` (`MyLevel`): Actors, URL, Model, ReachSpecs, TimeSeconds, 16 text blocks (none), TravelInfo;
 *   - the world `Model`, each mover's brush `Model`, their `Polys`, and the `LevelSummary`: the source package's payloads with every reference
 *     translated (model-transcode.mjs).
 * A reference to an object outside the package is an import (package-write.mjs); one to an object the original does not save (the viewport, windows,
 * a destroyed actor) is None.
 *
 * NOT the original's: the order of the exports, names and imports (the original's is GObjObjects and FName-table order, which a Play session does not
 * reproduce, docs/travel.md "Unresolved" 10) and the GUID (new for each save, as the original's). Everything else is checked against the original's
 * own files by scripts/validate-level-save.mjs. */
import { ByteWriter } from './byte-writer.mjs';
import { PackageTables, buildPackage } from './package-write.mjs';
import { writeTaggedProperties } from './tagged-write.mjs';
import { transcodeModel, transcodePolys, transcodeProperties } from './model-transcode.mjs';
import { parseAiWords, encodeAiEvents } from './ai-events-payload.mjs';
import { identityOfHandle } from './script-object-handles.mjs';
import { isHostFlagBase, FLAG_CLASSES, FLAG_VALUE_PROPERTY } from './travel-export.mjs';
import { hashScriptName } from './script-names.mjs';

const ACTOR_FLAGS = 0x2070001, OBJECT_FLAGS = 0x70000;
const NATIVE_SOURCE = new Set(['Model', 'Polys', 'LevelSummary']);

export class UnsupportedSaveObject extends Error {
  constructor(message, details = {}) { super(message); this.name = 'UnsupportedSaveObject'; Object.assign(this, details); }
}

/** The class chain's properties in tag order: the most derived class first, declaration order inside a class. */
export function classFields(cls) {
  const fields = new Map();
  for (let node = cls; node; node = node.base) for (const field of node.fields?.values() ?? []) if (!fields.has(field.key)) fields.set(field.key, field);
  return [...fields.values()];
}

/**
 * @param runtime         the ScriptRuntime
 * @param level           the live level: actors, reachSpecs, travelInfo (Map), timeSeconds, nativeObject
 * @param asset           the package the level was loaded from ({name, pkg, bytes})
 * @param modelIndex      the source package's export index of the level's world Model
 * @param levelUrl        {map, portal, options}: the URL the level was loaded with
 * @param ai              {words: ai_snapshot words, spelling(id)} or null
 * @param guid            16 bytes
 * @param restoredObjects the non-actor objects a restore made (identities with the source `index`)
 * @param flags           {classes, owner()} when the player's FlagBase is part of the file (SaveGame; a level left by travel has none, PruneTravelActors
 *                        destroyed it): the loaded Extension flag classes (travel-export.mjs loadFlagClasses) and the actor the FlagBase is the Outer-owned
 *                        object of. The host FlagBase (script-triggers.mjs createFlagBase) is written as the `FlagBase` and `Flag*` objects the original holds.
 */
export function serializeLevel({ runtime, level, asset, modelIndex, levelUrl, ai = null, guid, restoredObjects = [], flags = null }) {
  const source = asset.pkg, sourceBytes = asset.bytes;
  const tables = new PackageTables({ sourcePkg: source });
  const plan = [];                       // export descriptors, in export order
  const exportOf = new Map();            // identity -> 1-based position
  const sourceExport = new Map();        // source export index -> position
  const classCache = new Map();
  let closed = false;

  const add = (identity, spec) => {
    if (closed) throw new UnsupportedSaveObject(`the export set grew after it was fixed: ${spec.name}`);
    plan.push({ identity, ...spec });
    exportOf.set(identity, plan.length);
    if (Number.isInteger(spec.sourceIndex)) sourceExport.set(spec.sourceIndex, plan.length);
    return plan.length;
  };

  // CLASS_Transient (0x8, inherited): SavePackage leaves the objects of such a class out of the package, and a reference to one saves as None
  // (MissionScript is `transient`: Mission00 is spawned again by DeusExPlayer.TravelPostAccept, which is why the restored level logs it).
  const transientClass = cls => { for (let node = cls; node; node = node.base) if ((node.metadata?.classFlags ?? 0) & 0x8) return true; return false; };
  const transient = object => { try { return transientClass(runtime.instance(object).cls); } catch { return false; } };

  // --- the exports that are certain: the level's actors (source order first, spawned ones after), the saved script objects, the Level -----
  const actors = level.actors.filter(actor => actor && !transient(actor));
  const sourced = actors.filter(actor => Number.isInteger(actor.index)).sort((a, b) => a.index - b.index);
  const spawned = actors.filter(actor => !Number.isInteger(actor.index));
  for (const actor of [...sourced, ...spawned]) add(actor, { kind: 'actor', name: actor.name, flags: ACTOR_FLAGS, sourceIndex: actor.index, outerExport: 0 });
  // (a restored object the level has since released, such as the conversation history ResetPlayerToDefaults deleted, is not part of the file)
  const alive = object => { try { runtime.instance(object); return true; } catch { return false; } };
  for (const object of restoredObjects.filter(alive)) add(object, { kind: 'object', name: object.name, flags: OBJECT_FLAGS, sourceIndex: object.index, outerExport: 0 });
  const levelSource = source.exports.findIndex(entry => entry.className === 'Level') + 1;
  if (!levelSource) throw new UnsupportedSaveObject('the source package has no Level export');
  const levelPosition = add({ levelObject: true }, { kind: 'level', name: source.exports[levelSource - 1].name, flags: source.exports[levelSource - 1].flags,
    sourceIndex: levelSource, outerExport: 0 });

  // --- the AI event manager: its objects are known from the snapshot ------------------------------------------------------------------
  let events = null;
  if (ai) {
    const parsed = parseAiWords(ai.words);
    const positions = { manager: 0, types: [], senders: [], receivers: [] };
    const spec = (kind, name, className) => ({ kind: 'events', name, className, flags: OBJECT_FLAGS, sourceIndex: null, outerExport: positions.manager });
    positions.manager = add({ ai: 'manager' }, { ...spec('events', 'EventManager0', 'EventManager'), outerExport: 0 });
    parsed.manager.types.forEach((type, i) => positions.types.push(add({ ai: 'type', type }, spec('events', `AIEventType${i}`, 'AIEventType'))));
    parsed.senders.forEach((sender, i) => positions.senders.push(add({ ai: 'sender', sender }, spec('events', `AISenderEvent${i}`, 'AISenderEvent'))));
    parsed.receivers.forEach((receiver, i) => positions.receivers.push(add({ ai: 'receiver', receiver }, spec('events', `AIReceiverEvent${i}`, 'AIReceiverEvent'))));
    events = { parsed, positions };
  }

  // --- references -----------------------------------------------------------------------------------------------------------------------
  const levelPackage = level.nativeObject?.outer ?? null;
  const resourceKey = record => tables.resourceKey(record.asset, record.index);
  /** A runtime-created object the actors reach (new(Self) objects: notes, goals, history): exported when its Outer chain reaches the level package. */
  const exportableObject = value => {
    let instance = null;
    try { instance = runtime.attachedInstance(value); } catch { return null; }
    const native = instance?.nativeObject;
    if (!native || (native.flags & 0x4000) || transientClass(instance.cls)) return null;
    for (let outer = native.outer; outer; outer = outer.outer) {
      if (outer === levelPackage) return { native, outerExport: 0 };
      const owner = outer.identity && exportOf.get(outer.identity);
      if (owner) return { native, outerExport: owner };
    }
    return null;
  };
  // --- the player's FlagBase: a host store, written as the objects the original keeps (FlagBase, one Flag* per flag; Outer: the player / the FlagBase) ---
  let flagWork = null;
  function flagBaseExport(store) {
    if (!flags) return 0;
    if (flagWork) return flagWork.store === store ? flagWork.position : 0;
    const buckets = Array.from({ length: 64 }, () => []);
    for (const [key, entry] of store.entries) buckets[hashScriptName(String(entry.name).toLowerCase()) & 63].push({ key, entry });
    const hash = item => hashScriptName(String(item.entry.name).toLowerCase()) | 0;
    const owner = flags.owner() ? exportOf.get(flags.owner()) ?? 0 : 0;
    const position = add(store, { kind: 'flagbase', name: 'FlagBase0', flags: OBJECT_FLAGS, sourceIndex: null, outerExport: owner, cls: flags.classes.FlagBase });
    flagWork = { store, position, buckets, tokens: new Map(), counts: new Map() };
    for (const chain of buckets) {
      chain.sort((a, b) => hash(a) - hash(b));      // a stable sort: a flag added later follows an equal hash (createFlagBase chainOf)
      chain.forEach((item, at) => {
        const className = FLAG_CLASSES[item.entry.type];
        if (!flags.classes[className]) throw new UnsupportedSaveObject(`flag ${item.entry.name} has the unsupported type ${item.entry.type}`);
        const token = { flag: item, chain, at, className };
        const count = flagWork.counts.get(className) ?? 0;
        flagWork.counts.set(className, count + 1);
        flagWork.tokens.set(item.key, token);
        add(token, { kind: 'flag', name: `${className}${count}`, flags: OBJECT_FLAGS, sourceIndex: null, outerExport: position, cls: flags.classes[className] });
      });
    }
    return position;
  }
  const objectRef = value => {
    if (value === null || value === undefined) return 0;
    const position = exportOf.get(value);
    if (position) return position;
    if (isHostFlagBase(value)) return flagBaseExport(value);
    if (value.asset === asset && Number.isInteger(value.index) && value.index > 0) {
      // an export of the source package that is not an actor: the brush's Model, the Summary, the EventManager
      const found = sourceExport.get(value.index);
      if (found) return found;
      const entry = source.exports[value.index - 1];
      if (NATIVE_SOURCE.has(entry.className)) return addNative(value.index);
      if (entry.className === 'EventManager') return events ? events.positions.manager : 0;
      return 0;
    }
    if (typeof value.key === 'string' && value.asset) return tables.importIndex(resourceKey(value));
    const found = exportableObject(value);
    if (found) return add(value, { kind: 'object', name: found.native.name ?? value.name, flags: OBJECT_FLAGS, sourceIndex: null, outerExport: found.outerExport });
    return 0;      // the viewport, windows, destroyed actors: not part of the package
  };
  const sourceImportKeys = new Map();
  function importKeyOfSource(i) {
    let key = sourceImportKeys.get(i);
    if (key) return key;
    const entry = source.imports[i];
    const outerKey = entry.outer ? importKeyOfSource(-entry.outer - 1) : '';
    sourceImportKeys.set(i, key = tables.importEntry({ classPackage: entry.classPackage, className: entry.className, outerKey, name: entry.name }));
    return key;
  }
  function addNative(sourceIndex) {
    const entry = source.exports[sourceIndex - 1];
    if (sourceExport.has(sourceIndex)) return sourceExport.get(sourceIndex);
    // (a saved level's native objects carry no FStateFrame: RF_HasStack is dropped with the header)
    return add({ nativeSource: sourceIndex }, { kind: 'native', name: entry.name, flags: entry.flags & ~0x2000000, sourceIndex, outerExport: 0 });
  }
  const nameIndex = text => tables.name(text);
  const translate = {
    // a reference of the source package: an export the saved level also holds, or an import
    objectRef: ref => {
      if (ref === 0) return 0;
      if (ref < 0) return tables.importIndex(importKeyOfSource(-ref - 1));
      const found = sourceExport.get(ref);
      if (found) return found;
      const entry = source.exports[ref - 1];
      return NATIVE_SOURCE.has(entry.className) ? addNative(ref) : 0;
    },
    nameIndex,
  };
  const context = { nameIndex, objectRef, structName: field => field.metadata.struct.name };
  addNative(modelIndex);

  // --- serialize ------------------------------------------------------------------------------------------------------------------------
  function writeActor(w, actor) {
    const instance = runtime.instance(actor), cls = instance.cls, state = instance.state;
    // FStateFrame: Node, StateNode, ProbeMask (two words), LatentAction, then the code offset
    const running = Boolean(state?.execution) && state.execution.cursor !== null && state.execution.cursor !== undefined;
    const stateRecord = state?.stateNode?.record ?? cls.record;
    const nodeRecord = running ? (state.codeNode?.record ?? stateRecord) : stateRecord;
    w.compact(tables.importIndex(resourceKey(nodeRecord))); w.compact(tables.importIndex(resourceKey(stateRecord)));
    const mask = state?.probeMask ?? [0, 0];
    w.u32(mask[0]); w.u32(mask[1]);
    w.i32(state?.latent ?? 0);
    w.compact(running ? state.execution.cursor : -1);
    writeTaggedProperties(w, classFields(cls), field => runtime.fieldReference(actor, field).get(), field => runtime.defaultValue(cls, field), context);
  }
  function writeObject(w, object) {
    const cls = runtime.instance(object).cls;
    writeTaggedProperties(w, classFields(cls), field => runtime.fieldReference(object, field).get(), field => runtime.defaultValue(cls, field), context);
  }
  /** FlagBase: hashTable[i] the first flag of each bucket, defaultFlagExpiration; a Flag: its value, flagName, flagHash, flagBase, nextFlag, flagType,
   * expiration (the class chain's order; a value equal to the default is not stored). */
  function writeFlagObject(w, entry) {
    const cls = entry.cls, fields = classFields(cls), work = flagWork;
    const tokenOf = item => item ? work.tokens.get(item.key) ?? null : null;
    let read;
    if (entry.kind === 'flagbase') {
      read = field => {
        const name = field.name.toLowerCase();
        if (name === 'hashtable') return work.buckets.map(chain => tokenOf(chain[0]));
        if (name === 'defaultflagexpiration') return work.store.defaultExpiration | 0;
        throw new UnsupportedSaveObject(`FlagBase.${field.name} is not modelled`);
      };
    } else {
      const { flag: item, chain, at, className } = entry.identity, flagEntry = item.entry, valueName = FLAG_VALUE_PROPERTY[className].toLowerCase();
      read = field => {
        const name = field.name.toLowerCase();
        if (name === valueName) return flagEntry.value;
        switch (name) {
          case 'flagname': return flagEntry.name;
          case 'flaghash': return hashScriptName(String(flagEntry.name).toLowerCase()) | 0;
          case 'flagbase': return work.store;
          case 'nextflag': return tokenOf(chain[at + 1]);
          case 'flagtype': return flagEntry.type;
          case 'expiration': return flagEntry.expiration | 0;
          default: throw new UnsupportedSaveObject(`${className}.${field.name} is not modelled`);
        }
      };
    }
    writeTaggedProperties(w, fields, read, field => runtime.defaultValue(cls, field), context);
  }
  function writeLevel(w) {
    w.compact(nameIndex('None'));
    const count = level.actors.length;
    w.i32(count); w.i32(count);
    for (const actor of level.actors) w.compact(actor && !transient(actor) ? objectRef(actor) : 0);
    w.string('deusex'); w.string(''); w.string(levelUrl.map); w.string(levelUrl.portal ?? '');
    w.compact(levelUrl.options.length);
    for (const option of levelUrl.options) w.string(option);
    w.i32(7790); w.u32(1);
    w.compact(translate.objectRef(modelIndex));
    w.compact(level.reachSpecs.length);
    for (const spec of level.reachSpecs) {
      w.i32(spec.distance); w.compact(objectRef(spec.start)); w.compact(objectRef(spec.end));
      w.i32(spec.radius); w.i32(spec.height); w.i32(spec.reachFlags); w.u8(spec.pruned ? 1 : 0);
    }
    w.f32(level.timeSeconds);          // ULevel::Serialize writes the double as a float (0x1039d5a2)
    w.compact(0);                      // FirstDeleted: CleanupDestroyed(1) emptied the chain
    for (let i = 0; i < 16; i++) w.compact(0);   // TextBlocks
    const pairs = [...(level.travelInfo ?? [])];
    w.compact(pairs.length);
    for (const [key, text] of pairs) { w.string(key); w.string(text); }
  }
  const aiWriters = events && encodeAiEvents(events.parsed, events.positions, levelPosition, { nameIndex, spelling: ai.spelling,
    actorRef: word => { const actor = word ? identityOfHandle(word) : null; return actor ? exportOf.get(actor) ?? 0 : 0; } });
  const aiWriter = identity => {
    switch (identity.ai) {
      case 'manager': return aiWriters.manager;
      case 'type': return aiWriters.types[events.parsed.manager.types.indexOf(identity.type)];
      case 'sender': return aiWriters.senders[events.parsed.senders.indexOf(identity.sender)];
      default: return aiWriters.receivers[events.parsed.receivers.indexOf(identity.receiver)];
    }
  };
  const serializeOne = (entry, w) => {
    switch (entry.kind) {
      case 'actor': writeActor(w, entry.identity); break;
      case 'object': writeObject(w, entry.identity); break;
      case 'flagbase': case 'flag': writeFlagObject(w, entry); break;
      case 'level': writeLevel(w); break;
      case 'events': aiWriter(entry.identity)(w); break;
      case 'native': {
        const src = source.exports[entry.sourceIndex - 1];
        const raw = sourceBytes.subarray(src.serialOffset, src.serialOffset + src.serialSize);
        const transcode = src.className === 'Model' ? transcodeModel : src.className === 'Polys' ? transcodePolys : transcodeProperties;
        try { w.raw(transcode(source, raw, translate, { hasStack: Boolean(src.flags & 0x2000000) })); }
        catch (error) { throw new UnsupportedSaveObject(`${src.className} ${src.name} (export ${entry.sourceIndex}, flags 0x${src.flags.toString(16)}) does not transcode: ${error.message}`, { export: entry.sourceIndex }); }
        break;
      }
      default: throw new Error(`Unknown export kind ${entry.kind}`);
    }
  };

  // Pass 1: learn names, imports and the closure of reachable exports (the writers add exports while this runs).
  for (let i = 0; i < plan.length; i++) serializeOne(plan[i], new ByteWriter(1024));
  // the classes of every export, and the AI objects' own import chain
  const classKeyOf = entry => {
    switch (entry.kind) {
      case 'actor': case 'object': {
        const cls = runtime.instance(entry.identity).cls;
        let key = classCache.get(cls);
        if (!key) classCache.set(cls, key = resourceKey(cls.record));
        return key;
      }
      case 'flagbase': case 'flag': return resourceKey(entry.cls.record);
      case 'level': case 'native': return importKeyOfSource(-source.exports[entry.sourceIndex - 1].classIndex - 1);
      default: return tables.importEntry({ classPackage: 'Core', className: 'Class', outerKey: tables.packageKey({ name: 'Engine' }), name: entry.className });
    }
  };
  const classKeys = plan.map(classKeyOf);
  for (const entry of plan) tables.name(entry.name);
  closed = true;
  tables.finalize();

  const exports = plan.map((entry, i) => ({ classKey: classKeys[i], superRef: 0, outerExport: entry.outerExport, name: entry.name, flags: entry.flags,
    write: w => serializeOne(entry, w) }));
  const bytes = buildPackage(tables, exports, { guid });
  return { bytes, exports: plan.length, names: tables.nameList.length, imports: tables.importList.length, plan };
}
