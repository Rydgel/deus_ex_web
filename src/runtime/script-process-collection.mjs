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
import { RESOURCE_KINDS } from './script-objects.mjs';

const RF_NATIVE = 0x04000000;
const CPF_NATIVE = 0x1000;
const RF_NEED_LOAD = 0x200;
const STRUCT_KINDS = new Set(['Class', 'State', 'Function', 'Struct']);
// UField's subclasses among the metadata kinds (UTextBuffer and UPackage are plain UObjects).
const FIELD_KINDS = new Set([...METADATA_KINDS].filter(kind => kind !== 'TextBuffer' && kind !== 'Package'));

export function createProcessCollection(process) {
  const loader = process.classLoader;
  if (!loader?.graph || !loader.originalLoads) throw new Error('The process collection requires the class loader and its tracker');
  const graph = loader.graph, tracker = loader.originalLoads;
  const { slotOf, nameText, fullName, classRecordOf, propertyKindOf, structFieldChain, recordAtAddress } = graph;
  // A record's class and name never change while it is loaded: each collection walks every tracked record, so both are read once.
  const kinds = new WeakMap(), nativeRoots = new WeakMap();
  const kindOf = record => {
    let kind = kinds.get(record);
    if (kind === undefined) kinds.set(record, kind = nameText(slotOf(classRecordOf(record), 0x20)));
    return kind;
  };
  const isNativeRoot = record => {
    let root = nativeRoots.get(record);
    if (root === undefined) nativeRoots.set(record, root = NATIVE_CLASS_KEYS.has(fullName(record).toLowerCase()));
    return root;
  };
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
      // a resource still deferred (RF_NeedLoad) has only its header's references until a load preloads it
      if (!(slotOf(record, 0x1c) & RF_NEED_LOAD) || METADATA_KINDS.has(kindOf(record))) fixedReferences.set(record, targets);
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
    if (RESOURCE_KINDS.has(kind)) { resourceReferences(record, kind, visit); return; }
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

  /** A resource's references after its header (docs/resource-gc-serializers.md): SerializeBin over its script properties, read only
   * once it is preloaded (RF_NeedLoad clear: a deferred resource holds its class's defaults, not its own), then the native bodies' object
   * references, a mesh's Textures array (+0xd8) and a font's page textures (+0x2c). */
  function resourceReferences(record, kind, visit) {
    const values = record.instanceValues;
    if (!(values instanceof Map)) return;
    if (!(slotOf(record, 0x1c) & RF_NEED_LOAD)) {
      for (const property of structFieldChain(classRecordOf(record))) {
        if ((slotOf(property, 0x3c) & CPF_NATIVE) || !holdsReferences(property)) continue;
        const dim = slotOf(property, 0x34) ?? 1, size = slotOf(property, 0x38) ?? 0, offset = slotOf(property, 0x48) ?? 0;
        for (let index = 0; index < dim; index++) visitValue(property, values.get(offset + size * index), visit);
      }
    }
    if (kind === 'LodMesh' || kind === 'Mesh') for (const reference of values.get(0xd8)?.references ?? []) visit(reference.object);
    if (kind === 'Font') for (const page of values.get(0x2c)?.data ?? []) visit(page?.texture ?? null);
  }

  /** The graph record behind a process identity, or null. */
  const recordOfIdentity = identity => identity?.loadRecord ?? loader.nativeRecords.get(identity) ?? null;

  /** The records the mark reaches from the native classes and `seeds` (records); `marked` extends an earlier mark. */
  function mark(seeds, marked = null) {
    const stack = [];
    const visit = value => { if (isRecord(value) && !marked.has(value)) { marked.add(value); stack.push(value); } };
    if (!marked) {
      marked = new Set();
      for (const record of graph.staticRecords.values()) visit(record);
      for (const record of tracker.held()) if (isNativeRoot(record)) visit(record);
    }
    for (const record of seeds) visit(record);
    while (stack.length) cachedReferences(stack.pop(), visit);
    return marked;
  }

  // The graph record behind a registry record, if the graph has created it.
  const graphRecordOf = resource => {
    const identity = resource.object;
    return recordOfIdentity(identity) ?? graph.linkers.get(resource.asset?.name.toLowerCase())?.exports[resource.index - 1]?.object ?? null;
  };

  /** The resource registry's records the mark reaches (script-resources.mjs; the objects of the packages Play reads outside the graph, a
   * level's resources among them): those of the marked graph records and of the level's seeds, every record that is neither a resource nor
   * a package (classes: their lifetime is the graph's), every record of the level's own objects, and what their references reach (Outer,
   * Class, a mesh's textures). A package is reached through its objects' Outer. */
  function reachRegistry(registry, marked, seedIdentities) {
    const reached = new Set(), stack = [];
    const visit = resource => { if (resource && typeof resource === 'object' && !reached.has(resource)) { reached.add(resource); stack.push(resource); } };
    for (const resource of registry.resources.values()) {
      const kind = resource.kind;
      if ((!RESOURCE_KINDS.has(kind) && kind !== 'Package') || !process.owns(resource.object) || seedIdentities.has(resource.object)) visit(resource);
      else { const record = graphRecordOf(resource); if (record && marked.has(record)) visit(resource); }
    }
    while (stack.length) registry.references(stack.pop(), reference => visit(reference.target));
    return reached;
  }

  /** The packages the process holds after the mark, by the original's linker rule (docs/class-graph-design.md "The collection over
   * resources"): an object's Linker is serialized with its header, and a linker serializes each import's SourceLinker, which VerifyImport
   * set for every import when the linker was made. So a package is held while one of its objects is marked, or a held package imports it;
   * the level's own linker is live, and so is the Entry level's (GEntry, loaded by UGameEngine::Init for the process's life: Entry.dx
   * imports Title_Music, which the original holds at every gc2 stop). The rest are unloaded (ULinkerLoad::Destroy). `level` is the level
   * package's asset, `entry` Entry's. */
  function heldPackages(level, entry, marked, reached, seedIdentities) {
    const held = new Set(), queue = [];
    const hold = name => { const key = typeof name === 'string' ? name.toLowerCase() : null; if (key && !held.has(key)) { held.add(key); queue.push(key); } };
    const linkers = new Set();
    for (const record of marked) linkers.add(slotOf(record, 0x10));
    for (const linker of linkers) hold(linker?.packageName);
    for (const name of ['Core', 'Engine', 'DeusEx']) hold(name);   // the static records' packages (graph.staticRecords)
    for (const resource of reached) hold(resource.asset?.name);
    for (const identity of seedIdentities) hold(identity?.asset?.name);
    const dependencies = asset => asset?.pkg?.dependencies ?? [];
    for (const name of dependencies(level)) hold(name);
    if (entry) hold(entry.name);
    while (queue.length) {
      const key = queue.pop();
      for (const name of dependencies(graph.packageAssets.get(key) ?? process.assets?.loaded?.(key))) hold(name);
    }
    return held;
  }

  /** The packages the process knows: the asset store's, the graph's linkers, the registry's and the identities'. */
  function knownPackages(registry) {
    const known = new Set([...graph.linkers.keys(), ...(process.assets?.ready?.keys() ?? [])]);
    for (const resource of registry?.resources.values() ?? []) if (resource.asset?.name) known.add(resource.asset.name.toLowerCase());
    for (const key of registry?.packages.keys() ?? []) known.add(key);
    for (const identity of process.packageObjects.values()) if (identity.asset?.name) known.add(identity.asset.name.toLowerCase());
    return known;
  }

  /** Run the collection with the level's seeds (process identities), the level package's asset and the Entry level's. Returns the counts,
   * the purged class keys, and the packages unloaded. */
  function collect(seedIdentities, level = null, entry = null) {
    const start = performance.now();
    tracker.flush();
    const seedSet = new Set(seedIdentities), registry = process.resources;
    const seeds = [];
    for (const identity of seedSet) { const record = recordOfIdentity(identity); if (record) seeds.push(record); }
    const marked = mark(seeds);
    // A registry record the mark reaches holds its graph record: a mesh's textures reach the graph through its payload as well.
    let reached = registry ? reachRegistry(registry, marked, seedSet) : new Set();
    for (let round = 0; registry && round < 8; round++) {
      const extra = [];
      for (const resource of reached) { const record = RESOURCE_KINDS.has(resource.kind) ? graphRecordOf(resource) : null; if (record && !marked.has(record)) extra.push(record); }
      if (!extra.length) break;
      mark(extra, marked);
      reached = reachRegistry(registry, marked, seedSet);
    }
    const markMs = performance.now() - start;
    const purged = new Set();
    for (const record of tracker.held()) {
      if (marked.has(record) || (record.objectFlags & RF_NATIVE)) continue;
      const kind = kindOf(record);
      // a top-level package goes with its linker (below), not with its objects
      if (kind === 'Package' ? !slotOf(record, 0x18) : !METADATA_KINDS.has(kind) && !RESOURCE_KINDS.has(kind)) continue;
      purged.add(record);
    }
    // A record Play made for its own readiness (host-only: no original request reached it, so the mark neither starts from it nor purges
    // it) keeps what its load resolved (the graph's load edges). A resource such a record references, with the resources and group packages
    // that one references in turn, is not purged: it leaves the original-loaded set (demoted) and stays loaded for Play's own records.
    // Purged, it would be read detached later: the full run's DeusEx.WeaponKarkianBite, created for readiness and linked later, holds the
    // LodMesh DeusExItems.InvisibleWeapon in its PlayerViewMesh default. A demoted resource is the same object to anything that can see it
    // (its identity and handle outlive a generation anyway). Classes are not demoted: a class keeps its Defaults and ClassUnique counter in
    // its generation, and gc2's OutdoorThings and ElectricityEmitter, which readiness-linked subclasses name as their super, come back as
    // new generations in the original; a purged class is linked again at once instead (relinkPurged).
    const demoted = new Set();
    if (graph.loadEdges && purged.size) {
      const stack = [];
      const keep = target => {
        if (!purged.has(target) || METADATA_KINDS.has(kindOf(target)) && !(kindOf(target) === 'Package' && slotOf(target, 0x18))) return;
        purged.delete(target); demoted.add(target); stack.push(target);
      };
      // A class's Defaults also hold what it inherited: InitClassDefaultObject copies the super's block, which the subclass's own load never
      // resolves (no load edge), so a readiness-only class's Defaults are read too.
      for (const [from, targets] of graph.loadEdges) {
        if (from.detached || tracker.has(from)) continue;
        for (const target of targets) keep(target);
        if (from.defaults?.data instanceof Map && kindOf(from) === 'Class') defaultsReferences(from, keep);
      }
      while (stack.length) for (const target of graph.loadEdges.get(stack.pop()) ?? []) keep(target);
    }
    tracker.forget(demoted);
    const classes = [], classIdentities = [];
    let resources = 0;
    for (const record of purged) {
      const identity = loader.identities.get(record), kind = kindOf(record);
      const metadata = METADATA_KINDS.has(kind) && kind !== 'Package';
      if (!metadata) resources++;
      if (identity && identity.loadRecord === record) {
        const cls = identity.linkedClass;
        if (cls && kind === 'Class') {
          classes.push(identity.key);
          classIdentities.push(identity);
          process.classes.delete(identity.key);
          process.linkedClasses.delete(cls);
          cls.purged = true;
          identity.linkedClass = null;
        }
        identity.loadRecord = null;
        loader.nativeRecords.delete(identity);
        // A resource's identity keeps its handle, as a class's readiness keeps its identity: a body prepared earlier may hold it as an
        // operand, and nothing reachable can tell the generations apart (docs/class-graph-design.md "Identities and generations").
        if (metadata) releaseHandle(identity);
      }
      loader.identities.delete(record);
      graph.detachExport(record);
    }
    graph.forgetDetached(purged);
    // a kept record's load edge to a purged one would let a later walk reach the detached record
    if (graph.loadEdges) for (const targets of graph.loadEdges.values()) for (const target of targets) if (purged.has(target)) targets.delete(target);
    tracker.forget(purged);
    // The registry forgets the resources the mark did not reach: the next request materializes a new generation.
    const forgotten = [];
    if (registry) for (const resource of registry.resources.values()) if (RESOURCE_KINDS.has(resource.kind) && !reached.has(resource)) forgotten.push(resource);
    registry?.forget(forgotten);
    // The packages nothing holds are unloaded, with every object left in them.
    let unloaded = [];
    if (level) {
      const held = heldPackages(level, entry, marked, reached, seedSet);
      unloaded = [...knownPackages(registry)].filter(key => !held.has(key) && key !== level.name?.toLowerCase()).sort();
      unloaded = process.unloadPackages(unloaded);
    }
    return { marked: marked.size, purged: purged.size, classes, classIdentities, resources, forgotten: forgotten.length, unloaded,
      demoted: demoted.size, markMs: Math.round(markMs), ms: Math.round(performance.now() - start) };
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
