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
 * registered native classes are the original's classes on DX.dx, 00_Training and 01_NYC_UNATCOIsland. This is bookkeeping: nothing in
 * Play reads it yet (name lookups and the LoadMap collection are later steps). A walk that fails is recorded in `failures`, not thrown.
 */
const PROPERTY_KINDS = ['Int', 'Float', 'Bool', 'Byte', 'Str', 'Name', 'Object', 'Class', 'Struct', 'Array', 'FixedArray', 'Map']
  .map(kind => `${kind}Property`);
export const METADATA_KINDS = Object.freeze(new Set(['Class', 'Function', 'State', 'Struct', 'Enum', 'Const', 'TextBuffer', 'Package',
  ...PROPERTY_KINDS]));

export function createOriginalLoadTracker(graph) {
  if (!graph?.loadEdges) throw new Error('The original-loaded tracker requires a load graph that records its load edges');
  const loaded = new Set(), pending = [], failures = [];
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
