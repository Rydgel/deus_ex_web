/** Which objects the original holds loaded (docs/class-graph-design.md "Loaded in the original's sense", migration step 1).
 *
 * The original's EndLoad preloads every object a load creates, transitively (docs/script-end-load.md), so after a load request it
 * holds the closure of that request. Play's load graph creates and preloads lazily and also loads for its own readiness (the
 * prepare-every-body pass links classes the original never loads), so neither "created" nor "linked" is the original's set. This
 * tracker walks the graph's load edges (createScriptLoadGraph `recordLoadEdges`) from the original's requests only:
 * - the level load: each import of the level package (`reachLevel`);
 * - the class of every object the game instantiates (ScriptRuntime.linkInstance);
 * - a StaticLoadObject/DynamicLoadObject on the graph (ScriptRuntime.loadGraphDynamicObject).
 * A reached metadata record (a class and its functions, states, structs, properties, enums, consts) that Play has not preloaded yet is
 * preloaded inside BeginLoad/EndLoad, as the original's EndLoad would; its references become edges and are walked. Other kinds
 * (textures, sounds, meshes, fonts, music, conversations) are marked and not preloaded: their bulk data is not needed to know which
 * classes are loaded, so they stay as Play's own loads leave them (`setDeferPreload` keeps their flags).
 *
 * Measured against the original's registry dumps (scripts/validate-original-loaded.mjs, capture gc2): the reached classes plus the
 * registered native classes are the original's classes on DX.dx, 00_Training and 01_NYC_UNATCOIsland. Name lookups read it
 * (`findClass`, step 1c): a class Play links only for its own readiness is not found by name, as the original does not hold it. The
 * LoadMap collection is a later step. A walk that fails is recorded in `failures`, not thrown.
 */
const PROPERTY_KINDS = ['Int', 'Float', 'Bool', 'Byte', 'Str', 'Name', 'Object', 'Class', 'Struct', 'Array', 'FixedArray', 'Map']
  .map(kind => `${kind}Property`);
export const METADATA_KINDS = Object.freeze(new Set(['Class', 'Function', 'State', 'Struct', 'Enum', 'Const', 'TextBuffer', 'Package',
  ...PROPERTY_KINDS]));

/** The classes the DLLs register at startup that Play's load graph has no record for (it registers Core's, Engine's and DeusEx's
 * natives only): gc2's dump of DX.dx holds each with flags lacking the 0x70000 load-context bits (docs/class-lifetime.md). A level that
 * loads one's script export (Training loads ConSys.ConEventComment, ConItem and ConversationList) gives the tracker its record. */
const DLL_REGISTERED = Object.freeze(['ConSys.ConAudioList', 'ConSys.ConEventComment', 'ConSys.ConImport', 'ConSys.ConItem',
  'ConSys.ConversationList', 'ConSys.ConversationMissionList', 'Core.Exporter', 'Core.Factory', 'D3DDrv.D3DRenderDevice',
  'DeusExText.TextImport', 'Engine.DemoPlayPendingLevel', 'Extension.ExtString', 'Extension.GameEngineExt', 'Extension.InputExt',
  'Fire.IceTexture', 'Fire.WaveTexture', 'Galaxy.GalaxyAudioSubsystem', 'IpDrv.MasterServerCommandlet', 'IpDrv.TcpipConnection',
  'IpDrv.TcpNetDriver', 'IpDrv.UpdateServerCommandlet', 'Render.Render', 'Window.WindowManager', 'WinDrv.WindowsClient',
  'WinDrv.WindowsViewport']);
/** Top-level packages the process holds before any level request: Transient (UObject::StaticInit) and Entry (UGameEngine::Init), both in
 * gc2's DX.dx dump. */
const PROCESS_PACKAGES = Object.freeze(['transient', 'entry']);

/** A name lookup whose answer depends on what Play does not model (the original's GObjObjects order, a class the DLLs register without
 * a record here, a package Play cannot place): an explicit boundary, never a guessed miss. */
export class UnmodelledClassLookup extends Error {}

export function createOriginalLoadTracker(graph) {
  if (!graph?.loadEdges) throw new Error('The original-loaded tracker requires a load graph that records its load edges');
  const loaded = new Set(), pending = [], failures = [], levelPackages = new Set();
  let packageFiles = null, index = null, indexedSize = -1, packagesChanged = true;
  const kindOf = record => graph.nameText(graph.slotOf(graph.classRecordOf(record), 0x20));
  const isMetadata = record => METADATA_KINDS.has(kindOf(record));
  const isRecord = value => value !== null && typeof value === 'object' && value.nativeSlots instanceof Map;
  let walking = false;

  // A reached metadata record Play has not preloaded: the original's EndLoad would have. Other kinds the scope creates are deferred.
  function preloadScoped(record) {
    const restore = graph.suspendLoadQueue();
    let failed = false;
    graph.setDeferPreload(object => !isMetadata(object));
    try { graph.beginLoad(); graph.preload(record); graph.endLoad(); }
    catch (error) { failed = true; failures.push({object: graph.fullName(record), error: String(error?.message ?? error).split('\n')[0]}); }
    finally { graph.setDeferPreload(null); }
    restore({failed});
  }

  function walk(start) {
    const queue = [];
    const visit = record => { if (isRecord(record) && !loaded.has(record)) { loaded.add(record); queue.push(record); } };
    for (const record of start) visit(record);
    walking = true;
    try {
      for (let at = 0; at < queue.length; at++) {
        const record = queue[at];
        if ((graph.slotOf(record, 0x1c) & 0x200) && graph.slotOf(record, 0x10) && isMetadata(record)) preloadScoped(record);
        visit(graph.classRecordOf(record));
        for (const target of graph.loadEdges.get(record) ?? []) visit(target);
      }
    } finally { walking = false; }
  }

  const outermost = record => {
    let at = record;
    for (let steps = 0; steps < 64; steps++) {
      const outer = graph.slotOf(at, 0x18);
      if (!outer) return graph.nameText(graph.slotOf(at, 0x20)).toLowerCase();
      at = outer;
    }
    throw new Error(`The outer chain of ${graph.fullName(record)} does not end`);
  };
  // short class name -> [{key, record | null}] and the held top-level packages, rebuilt when the tracker has reached more objects or a
  // level load added its package
  function classIndex() {
    if (index && indexedSize === loaded.size && !packagesChanged) return index;
    const byName = new Map(), keys = new Set(), packages = new Set([...PROCESS_PACKAGES, ...levelPackages]);
    const add = (key, record) => {
      if (keys.has(key)) return;
      keys.add(key);
      const name = key.slice(key.indexOf('.') + 1);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({key, record});
    };
    for (const record of loaded) {
      packages.add(outermost(record));
      if (kindOf(record) === 'Class') add(graph.fullName(record).toLowerCase(), record);
    }
    for (const record of graph.staticRecords.values()) { packages.add(outermost(record)); add(graph.fullName(record).toLowerCase(), record); }
    for (const key of DLL_REGISTERED) { packages.add(key.split('.')[0].toLowerCase()); add(key.toLowerCase(), null); }
    indexedSize = loaded.size; packagesChanged = false;
    return index = {byName, packages};
  }
  function found(candidate, token) {
    if (candidate.record) return candidate.record;
    throw new UnmodelledClassLookup(`StaticFindObject(UClass, ANY_PACKAGE, ${token}) finds ${candidate.key}, a class the DLLs register that Play's load graph has no record for`);
  }

  const tracker = {
    failures,
    /** The records the original's requests reach. A request that arrives inside a load (or inside this walk) waits for the next one. */
    reach(records) {
      for (const record of records) if (isRecord(record) && !loaded.has(record)) pending.push(record);
      if (walking || graph.loadState.nest !== 0 || !pending.length) return;
      walk(pending.splice(0));
    },
    /** The level load: each import of the level package `asset` whose target package the graph already reads. A package Play has not
     * prepared on the graph is not prepared here (that would change which load route a later DynamicLoadObject takes). */
    reachLevel(assets, asset) {
      const records = [];
      let skipped = 0;
      levelPackages.add(asset.name.toLowerCase());
      packageFiles = assets.files ?? packageFiles;
      packagesChanged = true;
      for (let i = 0; i < asset.pkg.imports.length; i++) {
        if (asset.pkg.imports[i].className === 'Package') continue;
        let target = null;
        try { target = assets.resolveLoaded(asset, -i - 1); } catch { target = null; }
        if (!target?.asset || !graph.packageAssets.has(target.asset.name.toLowerCase())) { skipped++; continue; }
        records.push(graph.indexToObject(graph.buildLinker(target.asset.name), target.index));
      }
      tracker.reach(records);
      return {requests: records.length, skipped};
    },
    /** The requests that waited for a load or a walk to end: a collection calls this first, so a late request is marked. */
    flush() {
      if (!walking && graph.loadState.nest === 0 && pending.length) walk(pending.splice(0));
    },
    has: record => loaded.has(record),
    /** The records the tracker holds (the original-loaded set), for the collector's purge. */
    held: () => loaded.values(),
    /** The collector purged these records (script-process-collection.mjs): the original no longer holds them, and the next request
     * that reaches their exports reaches new records. */
    forget(records) {
      for (const record of records) loaded.delete(record);
      index = null;
    },
    /** The collection unloaded these packages (lower-case names) and their package roots: a level package among them is no longer held. */
    unloadPackages(names, roots) {
      for (const name of names) levelPackages.delete(name);
      for (const root of roots) loaded.delete(root);
      index = null; packagesChanged = true;
    },
    /** StaticFindObject(UClass, ANY_PACKAGE, token, 0) (Core 0x10151de0; script-object-lookup.mjs) over the classes the original holds:
     * the reached class records and the registered ones. Returns the class's record, or null for the original's miss. A class Play has
     * created only for its own readiness is not found.
     * - ResolveName (0x10154ad0) finds a dotted name's package as a top-level object; a package the process does not hold is a miss.
     * - The class is then probed in that package's hash bucket. A miss there, or an undotted name, falls to the ANY_PACKAGE walk over
     *   every object, which matches the name alone: `Engine.NanoKey` finds DeusEx.NanoKey.
     * - The walk returns the first match in GObjObjects order, which Play does not keep for graph records, so two candidates are an
     *   explicit boundary (none on the three measured maps), as are a class the DLLs register without a record here, a path below a
     *   package, and a package component Play cannot place.
     * An empty component is no FName, so its lookup misses. */
    findClass(token) {
      tracker.flush();   // a request that arrived inside a load is held by the time a lookup runs
      const parts = String(token).split('.');
      if (parts.some(part => part === '')) return null;
      if (parts.length > 2)
        throw new UnmodelledClassLookup(`StaticFindObject(UClass, ANY_PACKAGE, ${token}): ResolveName below a package is not modelled`);
      const {byName, packages} = classIndex();
      const candidates = byName.get(parts.at(-1).toLowerCase()) ?? [];
      if (parts.length === 2) {
        const pkg = parts[0].toLowerCase();
        if (!packages.has(pkg)) {
          // ResolveName misses unless the process holds the package; Play places a package by its records, its level and the
          // packages it registers. A name no package file carries is not held, unless a failed load's CreatePackage made it (the
          // graph then has a root of that name, and the answer is not modelled).
          if (!candidates.length || (packageFiles && !packageFiles.has(pkg) && !graph.packageRoots.has(pkg))) return null;
          throw new UnmodelledClassLookup(`StaticFindObject(UClass, ANY_PACKAGE, ${token}): whether the process holds package ${parts[0]} is not modelled`);
        }
        const exact = candidates.find(candidate => candidate.key === `${pkg}.${parts[1].toLowerCase()}`);
        if (exact) return found(exact, token);
      }
      if (candidates.length > 1)
        throw new UnmodelledClassLookup(`StaticFindObject(UClass, ANY_PACKAGE, ${token}) matches ${candidates.map(c => c.key).join(', ')}: the GObjObjects order between them is not modelled`);
      return candidates.length ? found(candidates[0], token) : null;
    },
    /** The reached classes and the classes the DLLs register (the graph's static records), as lower-case "package.class". */
    classes() {
      const out = new Set();
      for (const record of loaded) if (kindOf(record) === 'Class') out.add(graph.fullName(record).toLowerCase());
      for (const key of graph.staticRecords.keys()) out.add(key.toLowerCase());
      return out;
    },
    get size() { return loaded.size; },
  };
  return tracker;
}
