/**
 * UGameEngine::LoadMap's collection of the unloaded level (Engine
 * 0x1038d0ee..0x1038d1e1), over the host's modeled GObjObjects registry.
 *
 * After loading the new level, LoadMap tags every AActor whose Outer chain
 * reaches GLevel's package with 0x400 (0x1038d108..0x1038d1bb), clears the tag
 * again on each entry of the new GLevel->Actors (0x1038d1bd..0x1038d1dc) and
 * calls CollectGarbage(RF_Native) (0x1038d1e1). 0x400 is the collector
 * archive's exclusion bit (Core 0x1015ec90): a reference to a tagged actor is
 * written back as null and never marks it. Every actor the old level spawned
 * is therefore unreachable, whatever still points at it, and is purged by
 * Core's PurgeGarbage in this same call (script-gc.mjs).
 *
 * The mark phase here projects SerializeRootSet onto the objects the host
 * models: the caller's root array, then every surviving object it reaches
 * through `serialize`. Objects outside the registry (map exports whose slot is
 * unmeasured, classes, resources) are never purged by this host, so they are
 * walked once as persistent objects rather than marked. Evidence and bounds:
 * docs/script-loadmap-gc.md.
 */
import { createGarbageArchive, purgeGarbage, GC_FLAGS } from './script-gc.mjs';

export const LOADMAP_GC = Object.freeze({
  // RF_EliminateObject: LoadMap's tag, the archive's exclusion bit.
  eliminate: 0x00000400,
  // CollectGarbage(RF_Native) keep flags pushed at 0x1038d1dc.
  keepFlags: GC_FLAGS.native,
});

function required(value, name) {
  if (typeof value !== 'function') throw new TypeError(`LoadMap collection requires ${name}`);
  return value;
}

/**
 * Run the tag, mark and purge for one reload.
 *
 * - `registry`: the ScriptObjectRegistry (GObjObjects + GObjAvailable).
 * - `levelPackage`: the record GLevel->GetOuter() names.
 * - `levelActors`: the reloaded GLevel->Actors identities.
 * - `recordOf(identity)`: the object's native record, or null.
 * - `isActor(record)`: TObjectIterator<AActor>'s IsA(AActor) test.
 * - `rootArray`: identities in GObjRoot order (Core root FArray 0x1029e5f8).
 * - `serialize(identity, visit, visitName)`: the object's references in its
 *   Serialize order; each object reference is passed to `visit` as a mutable
 *   {get,set} lvalue and each FName's text to `visitName`.
 * - `names`: the FName table (script-names.mjs) whose entries the archive
 *   constructor tags and PurgeGarbage's third pass deletes.
 * - `conditionalDestroy(record)`, `finalDelete(record, flags)`: Core's two
 *   purge passes, in index order.
 * - `setGarbageCollecting(active)`: GObjInGarbageCollection (0x102a264c).
 */
export function collectLoadMapGarbage({
  registry, levelPackage, levelActors, recordOf, isActor, rootArray = [], names = null,
  serialize, conditionalDestroy, finalDelete, setGarbageCollecting,
}) {
  if (!Array.isArray(registry?.objects)) throw new TypeError('LoadMap collection requires the object registry');
  if (!levelPackage) throw new TypeError('LoadMap collection requires GLevel\'s package');
  required(recordOf, 'recordOf'); required(isActor, 'isActor'); required(serialize, 'serialize');
  const modeled = record => Boolean(record) && Number.isInteger(record.index) && registry.objects[record.index] === record;
  const isIn = (record, outer) => {
    for (let at = record.outer; at; at = at.outer) if (at === outer) return true;
    return false;
  };

  const eliminated = [];
  for (const record of registry.objects) {
    if (!record || !isActor(record) || !isIn(record, levelPackage)) continue;
    record.flags = (record.flags | LOADMAP_GC.eliminate) >>> 0;
    eliminated.push(record);
  }
  for (const actor of levelActors) {
    const record = actor && recordOf(actor);
    if (modeled(record)) record.flags = (record.flags & ~LOADMAP_GC.eliminate) >>> 0;
  }

  if (names && (!Array.isArray(names.names) || typeof names.find !== 'function' || typeof names.deleteEntry !== 'function'))
    throw new TypeError('LoadMap collection requires an FName table with find and DeleteEntry');
  const view = { objects: registry.objects, names: names?.names ?? [], rootSet: [...rootArray] };
  const walked = new WeakSet();
  // References the archive's 0x400 exclusion wrote back as null, with the
  // object whose Serialize held them.
  const excluded = [];
  let archive = null, holder = null;
  // Core's collector recurses on the native stack: each newly marked object is
  // serialized before the holder's next reference. Long reference chains
  // (NYC's navigation lists) exceed JavaScript's stack, so the same depth-first
  // order runs on an explicit stack: an object's Serialize references are
  // collected (a read-only pass), then visited in order, and a newly entered
  // object's frame is completed before its holder resumes.
  const frames = [];
  const enter = identity => {
    const items = [];
    serialize(identity, lvalue => { items.push({ lvalue }); }, text => { items.push({ name: text }); });
    frames.push({ identity, items, next: 0 });
  };
  const drain = () => {
    const saved = holder;
    try {
      while (frames.length) {
        const frame = frames[frames.length - 1];
        if (frame.next >= frame.items.length) { frames.pop(); continue; }
        const item = frame.items[frame.next++];
        holder = frame.identity;
        if ('name' in item) visitName(item.name);
        else visit(item.lvalue);
      }
    } finally { holder = saved; }
  };
  const visit = lvalue => {
    const value = lvalue.get();
    const record = value ? recordOf(value) : null;
    if (value && !modeled(record)) {
      // A persistent object outside the modeled registry: walk it once.
      if (typeof value === 'object' && !walked.has(value)) {
        walked.add(value);
        enter(value);
      }
      return;
    }
    const owner = holder;
    archive.serializeObject({ get: () => record, set: next => {
      if (!next && record) excluded.push({ holder: owner, target: record.identity });
      lvalue.set(next ? next.identity : null);
    } });
  };
  // Collector SerializeName (Core 0x1015ee00) clears the entry's 0x2 mark. A
  // text the host table never interned has no entry to mark.
  const visitName = text => {
    const index = names && typeof text === 'string' ? names.find(text) : -1;
    const entry = index >= 0 ? names.names[index] : null;
    if (entry) archive.serializeName({ get: () => entry, set: () => { throw new Error('The collector does not rewrite FNames'); } });
  };
  archive = createGarbageArchive(view, {
    serializeObject: object => enter(object.identity),
  });
  // SerializeRootSet(Ar, RF_Native, 0x40) Core 0x101580b0: the root array,
  // then each registry object with any keep flag and all of 0x40. A root the
  // registry does not model (the engine) is walked as a persistent object.
  for (let index = 0; index < view.rootSet.length; index++) {
    visit({ get: () => view.rootSet[index], set: value => { view.rootSet[index] = value; } });
    drain();
  }
  for (const record of registry.objects) {
    if (!record || !(record.flags & LOADMAP_GC.keepFlags) || !(record.flags & GC_FLAGS.archiveSerialize)) continue;
    archive.serializeObject({ value: record });
    drain();
  }
  const purgeable = registry.objects.filter(record => record && (record.flags & GC_FLAGS.unreachable));
  const result = purgeGarbage(view, {
    conditionalDestroy: required(conditionalDestroy, 'conditionalDestroy'),
    finalDelete: required(finalDelete, 'finalDelete'),
    // Core 0x10158400..0x10158451: FName::DeleteEntry in GNames order.
    deleteName: index => names.deleteEntry(index),
    setGarbageCollecting: required(setGarbageCollecting, 'setGarbageCollecting'),
  });
  // GObjAvailable right after the purge: each ~UObject appended its slot.
  const available = [...registry.freeIndices];
  return { ...result, eliminated, purged: purgeable, excluded, available, references: archive.serializedCount };
}
