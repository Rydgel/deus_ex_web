/** UObject::CollectGarbage(RF_Native) over the script process's classes at LoadMap (docs/class-graph-design.md, migration step 4a;
 * src/runtime/script-process.mjs). The level's own objects are collected by script-level-collection.mjs; this collects the original-
 * loaded metadata of the process graph: classes and their functions, states, structs, properties, enums, consts and text buffers.
 *
 * Mark, from:
 * - the native classes (native-class-roots.mjs): SerializeRootSet visits every object with the RF_Native keep flag;
 * - the level: the class of every object the level has instantiated, and the process objects its objects reference (an actor's
 *   class<...>, Mesh or Texture properties). The root array's GLevel reaches those objects in the original.
 * Each reached record is serialized as the collector does (the recovered GC branches: docs/script-class-serialization.md,
 * docs/core-gc-serializers.md, docs/script-property-serialization.md, docs/script-object-serialization.md):
 * - UObject: Class (+0x24), Outer (+0x18). Its Linker is the linkers' business (step 4b);
 * - UField: SuperField (+0x28), Next (+0x2c);
 * - UStruct: ScriptText (+0x34), Children (+0x38), then the object words of its expanded bytecode (UStruct::SerializeExpr);
 * - UClass: each dependency's class (+0x4bc), ClassWithin (+0x49c), then its Defaults through SerializeBin (every property but the
 *   native ones; transient ones too, the collector's +0x18 word being 0);
 * - UProperty kinds: Enum, PropertyClass, Inner or Struct (+0x5c), a map's Value (+0x60), a class property's MetaClass (+0x64);
 * - UFunction, UEnum, UConst, UTextBuffer and UPackage add no object reference.
 * A resource, a conversation object or a level export is marked through its header only: step 4a purges no such object.
 *
 * Purge: every metadata record the original-loaded tracker holds that the mark did not reach and that carries no RF_Native, but
 * packages: a group package (MoverSFX.Door) is its resources' Outer, and resources are step 4b's (they are not purged yet). Its
 * export is detached (the next load creates it again from its package), the tracker forgets it, and its class's generation ends:
 * the next load links a new class from the package, with the package's Defaults and a ClassUnique counter of 0. The identity
 * objects stay (script-objects.mjs): nothing reachable referenced the purged objects, so nothing can tell an identity's two
 * generations apart, and readiness hangs on them (docs/class-graph-design.md "Identities and generations").
 *
 * Readiness then links the purged classes again, host-only (relinkPurged): Play's synchronous VM runs only linked classes, and a body
 * prepared earlier, or the travel's import of the player's inventory, may name one. A class linked so is a new generation from its
 * package that the original does not hold (original-loaded.mjs), until a request of the original reaches it, which is when the original
 * loads it again. */
import { skipExpandedScriptExpression } from '../unreal/classes.mjs';
import { METADATA_KINDS } from './original-loaded.mjs';
import { NATIVE_CLASS_KEYS } from './native-class-roots.mjs';
import { releaseHandle, identityOfHandle } from './script-object-handles.mjs';
import { cleanupPlan } from './script-runtime.mjs';

const RF_NATIVE = 0x04000000;
const CPF_NATIVE = 0x1000;
const STRUCT_KINDS = new Set(['Class', 'State', 'Function', 'Struct']);
// UField's subclasses among the metadata kinds (UTextBuffer and UPackage are plain UObjects).
const FIELD_KINDS = new Set([...METADATA_KINDS].filter(kind => kind !== 'TextBuffer' && kind !== 'Package'));

export function createProcessCollection(process) {
  const loader = process.classLoader;
  if (!loader?.graph || !loader.originalLoads) throw new Error('The process collection requires the class loader and its tracker');
  const graph = loader.graph, tracker = loader.originalLoads;
  const { slotOf, nameText, fullName, classRecordOf, propertyKindOf, structFieldChain, recordAtAddress } = graph;
  const kindOf = record => nameText(slotOf(classRecordOf(record), 0x20));
  const isRecord = value => value !== null && typeof value === 'object' && value.nativeSlots instanceof Map;

  // A property's value in a Defaults block or a struct: object and class values are records; a struct value is an object keyed by
  // member name (ScriptClassLoader.value), a fixed array an array.
  function visitValue(property, raw, visit) {
    if (raw === null || raw === undefined) return;
    const kind = propertyKindOf(property);
    if (kind === 'ObjectProperty' || kind === 'ClassProperty') { if (isRecord(raw)) visit(raw); return; }
    if (kind === 'StructProperty') {
      if (typeof raw !== 'object') return;
      for (const member of structFieldChain(slotOf(property, 0x5c))) {
        if (slotOf(member, 0x3c) & CPF_NATIVE) continue;
        const value = raw[nameText(slotOf(member, 0x20))];
        if (Array.isArray(value)) for (const item of value) visitValue(member, item, visit);
        else visitValue(member, value, visit);
      }
      return;
    }
    if (kind === 'ArrayProperty' && Array.isArray(raw)) for (const item of raw) visitValue(slotOf(property, 0x5c), item, visit);
  }

  // A record's references other than a class's Defaults never change while it is loaded (a reload makes a new record), so they are
  // read once; a class's Defaults are read at every collection (a SET or `Default.X =` writes them).
  const fixedReferences = new WeakMap();
  function cachedReferences(record, visit) {
    let targets = fixedReferences.get(record);
    if (!targets) {
      targets = [];
      references(record, target => { if (isRecord(target)) targets.push(target); }, false);
      fixedReferences.set(record, targets);
    }
    for (const target of targets) visit(target);
    if (record.defaults?.data instanceof Map && kindOf(record) === 'Class') defaultsReferences(record, visit);
  }
  // A class's properties that can hold a reference (object, class, struct with such a member, dynamic array), with their Defaults
  // offsets: SerializeBin visits every non-native property, but only these reach anything.
  const defaultsSites = new WeakMap();
  const holdsReferences = (property, depth = 0) => {
    const kind = propertyKindOf(property);
    if (kind === 'ObjectProperty' || kind === 'ClassProperty' || kind === 'ArrayProperty') return true;
    if (kind !== 'StructProperty' || depth > 16) return false;
    for (const member of structFieldChain(slotOf(property, 0x5c))) if (!(slotOf(member, 0x3c) & CPF_NATIVE) && holdsReferences(member, depth + 1)) return true;
    return false;
  };
  function defaultsReferences(record, visit) {
    let sites = defaultsSites.get(record);
    if (!sites) {
      sites = [];
      for (const property of structFieldChain(record)) {
        if ((slotOf(property, 0x3c) & CPF_NATIVE) || !holdsReferences(property)) continue;
        const dim = slotOf(property, 0x34) ?? 1, size = slotOf(property, 0x38) ?? 0, offset = slotOf(property, 0x48) ?? 0;
        for (let index = 0; index < dim; index++) sites.push(property, offset + size * index);
      }
      defaultsSites.set(record, sites);
    }
    const data = record.defaults.data;
    for (let at = 0; at < sites.length; at += 2) visitValue(sites[at], data.get(sites[at + 1]), visit);
  }

  /** The record's object references in the collector's order (`withDefaults` false leaves a class's Defaults out). */
  function references(record, visit, withDefaults = true) {
    visit(slotOf(record, 0x24));
    visit(slotOf(record, 0x18));
    const kind = kindOf(record);
    if (!METADATA_KINDS.has(kind)) return;
    if (FIELD_KINDS.has(kind)) { visit(slotOf(record, 0x28)); visit(slotOf(record, 0x2c)); }
    if (STRUCT_KINDS.has(kind)) {
      visit(slotOf(record, 0x34)); visit(slotOf(record, 0x38));
      const data = record.script?.data, size = slotOf(record, 0x48) ?? 0;
      if (data && size > 0) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const version = slotOf(record, 0x10)?.pkg?.version ?? 68;
        const onIndex = (isName, at) => { if (!isName) { const target = recordAtAddress(view.getUint32(at, true)); if (target) visit(target); } };
        for (let at = 0; at < size;) at = skipExpandedScriptExpression(data, at, { version, onIndex });
      }
    }
    if (kind === 'Class') {
      for (const entry of slotOf(record, 0x4bc)?.data ?? []) visit(entry.class ?? null);
      visit(slotOf(record, 0x49c));
      if (withDefaults && record.defaults?.data instanceof Map) defaultsReferences(record, visit);
    }
    if (kind.endsWith('Property')) {
      if (['ByteProperty', 'ObjectProperty', 'ClassProperty', 'FixedArrayProperty', 'ArrayProperty', 'MapProperty', 'StructProperty'].includes(kind))
        visit(slotOf(record, 0x5c));
      if (kind === 'MapProperty') visit(slotOf(record, 0x60));
      if (kind === 'ClassProperty') visit(slotOf(record, 0x64));
    }
  }

  /** The graph record behind a process identity, or null. */
  const recordOfIdentity = identity => identity?.loadRecord ?? loader.nativeRecords.get(identity) ?? null;

  /** The records the mark reaches from the native classes and `seeds` (records). */
  function mark(seeds) {
    const marked = new Set(), stack = [];
    const visit = value => { if (isRecord(value) && !marked.has(value)) { marked.add(value); stack.push(value); } };
    for (const record of graph.staticRecords.values()) visit(record);
    for (const record of tracker.held()) if (NATIVE_CLASS_KEYS.has(fullName(record).toLowerCase())) visit(record);
    for (const record of seeds) visit(record);
    while (stack.length) cachedReferences(stack.pop(), visit);
    return marked;
  }

  /** Run the collection with the level's seeds (process identities). Returns {marked, purged} counts and the purged class keys. */
  function collect(seedIdentities) {
    const start = performance.now();
    tracker.flush();
    const seeds = [];
    for (const identity of seedIdentities) { const record = recordOfIdentity(identity); if (record) seeds.push(record); }
    const marked = mark(seeds), markMs = performance.now() - start;
    const purged = new Set();
    for (const record of tracker.held()) {
      const kind = kindOf(record);
      if (marked.has(record) || (record.objectFlags & RF_NATIVE) || !METADATA_KINDS.has(kind) || kind === 'Package') continue;
      purged.add(record);
    }
    const classes = [], classIdentities = [];
    for (const record of purged) {
      const identity = loader.identities.get(record);
      if (identity && identity.loadRecord === record) {
        const cls = identity.linkedClass;
        if (cls && kindOf(record) === 'Class') {
          classes.push(identity.key);
          classIdentities.push(identity);
          process.classes.delete(identity.key);
          process.linkedClasses.delete(cls);
          cls.purged = true;
          identity.linkedClass = null;
        }
        identity.loadRecord = null;
        loader.nativeRecords.delete(identity);
        releaseHandle(identity);
      }
      loader.identities.delete(record);
      graph.detachExport(record);
    }
    graph.forgetDetached(purged);
    // a kept record's load edge to a purged one would let a later walk reach the detached record
    if (graph.loadEdges) for (const targets of graph.loadEdges.values()) for (const target of targets) if (purged.has(target)) targets.delete(target);
    tracker.forget(purged);
    return { marked: marked.size, purged: purged.size, classes, classIdentities, markMs: Math.round(markMs), ms: Math.round(performance.now() - start) };
  }

  return { references, mark, collect, recordOfIdentity };
}

/** The process identities a level's live objects reach: the class of every object the runtime has attached (its `attachedClasses`)
 * and the objects of the process its live objects' properties reference (the level's actors and the objects its registry holds). An
 * object's object and class properties are read from its image where the class has a pointer-site plan (the one CleanupDestroyed's
 * reference pass reads: every object and class property, in structs and fixed arrays too), else through the reflected walk. */
// Per pointer-site plan: the sites SerializeBin visits. It skips a property flagged 0x1000 at any depth (script-reference-serialization.mjs
// shouldSkipProperty); CleanupDestroyed's plan lists them.
const visitedSites = new WeakMap();
const visitedOf = plan => {
  let visited = visitedSites.get(plan);
  if (!visited) visitedSites.set(plan, visited = plan.sites.map(site => !site.path.some(step => step.field.metadata?.flags & CPF_NATIVE)));
  return visited;
};

export function levelSeeds(runtime, level) {
  const seeds = new Set(), owns = value => value && runtime.process.owns(value);
  for (const cls of runtime.attachedClasses ?? []) seeds.add(cls.record);
  const archive = { objectReference: reference => { const value = reference.get(); if (owns(value)) seeds.add(value); },
    nameReference: () => {} };
  const objects = new Set([...(level?.actors ?? []), ...(runtime.actorLifecycle?.construction?.registry?.objects ?? []).map(record => record?.identity)]);
  for (const identity of objects) {
    const instance = identity && runtime.attachedInstance?.(identity);
    if (!instance) continue;
    const plan = instance.nativeObject?.serializeReferences ? null : cleanupPlan(instance);
    const bound = instance.bindings.size ? instance.bindings : null;
    // a site in a bound field nested below the top level has no image word: the reflected walk reads it
    if (!plan || (bound && plan.sites.some(site => site.path.length > 1 && bound.has(site.top)))) { runtime.serializeReferences(identity, archive); continue; }
    const view = instance.arena.view, base = instance.base, visited = visitedOf(plan);
    for (let index = 0; index < plan.offsets.length; index++) {
      if (!visited[index]) continue;
      let value;
      const site = plan.sites[index];
      if (bound && bound.has(site.top)) {
        const read = runtime.readField(identity, site.path[0].field);
        value = Array.isArray(read) ? read[site.path[0].index] : read;
      } else {
        const handle = view.getUint32(base + plan.offsets[index], true);
        value = handle === 0 ? null : identityOfHandle(handle);
      }
      if (owns(value)) seeds.add(value);
    }
  }
  return seeds;
}

/** Link the classes a collection purged again, host-only (see the module's note): each is a new generation from its package. */
export async function relinkPurged(runtime, result) {
  for (const identity of result?.classIdentities ?? []) await runtime.loadClass(identity.asset, identity.index);
}
