/**
 * The objects the original's loader holds after a set of load requests
 * (docs/class-graph-design.md "Loaded in the original's sense", migration
 * step 1). Each request is replayed on a load graph of its own, inside the
 * recovered BeginLoad/EndLoad: EndLoad preloads every object a load created,
 * transitively (docs/script-end-load.md), so the graph then holds the closure
 * the original's loads build. Play's own graph is not touched: today it
 * creates and preloads objects lazily and never runs EndLoad, and its
 * readiness passes load more than the original does.
 *
 * Requests come from a Play session (`recordOriginalRequests`):
 * - the level load: every import of the map package, as the original's
 *   StaticLoadObject of MyLevel resolves the level's imports;
 * - the class of every object Play instantiates (a spawned actor, a window, a
 *   `new` object, an attached map or package object): the original holds that
 *   class because it holds an object of it;
 * - each DynamicLoadObject the session ran.
 * This is a measurement tool; nothing here changes how Play loads.
 */
import {createScriptLoadGraph} from '../src/runtime/script-load-graph.mjs';
import {loadConfigCache} from '../src/runtime/config-cache.mjs';
import { exportAt } from '../src/unreal/objects.mjs';

const lower = text => String(text).toLowerCase();

/** The requests a cold load makes, recorded on the runtime class's prototype before the session is built.
 * Returns `{requests(), stop()}`; `requests()` lists `{asset, index, key, why}` (classes of instantiated objects and DynamicLoadObject targets). */
export function recordOriginalRequests(ScriptRuntime) {
  const seen = new Map(), dynamic = [];
  const proto = ScriptRuntime.prototype;
  const linkInstance = proto.linkInstance, loadDynamic = proto.loadPreparedDynamicObject;
  proto.linkInstance = function (receiver, instance) {
    const record = instance?.cls?.record;
    if (record?.asset && Number.isInteger(record.index) && !seen.has(record.key))
      seen.set(record.key, {asset: record.asset, index: record.index, key: record.key, why: 'instantiated'});
    return linkInstance.call(this, receiver, instance);
  };
  proto.loadPreparedDynamicObject = function (request) {
    dynamic.push(String(request?.name));
    return loadDynamic.call(this, request);
  };
  return {
    requests: () => [...seen.values()],
    dynamicNames: () => [...dynamic],
    stop() { proto.linkInstance = linkInstance; proto.loadPreparedDynamicObject = loadDynamic; },
  };
}

/** Every import of `asset` (the level package) that resolves to an export of another package. */
export async function levelImportRequests(assets, asset) {
  const out = [];
  for (let i = 0; i < asset.pkg.imports.length; i++) {
    const entry = asset.pkg.imports.at(i);
    if (entry.className === 'Package') continue;
    let resolved;
    try { resolved = await assets.resolve(asset, -i - 1); } catch { resolved = null; }
    if (resolved?.asset && Number.isInteger(resolved.index)) out.push({asset: resolved.asset, index: resolved.index, key: resolved.key, why: `level import ${entry.className}`});
  }
  return out;
}

/** "Package.Object" -> a request, when the package exists. */
export async function pathRequest(assets, path, why) {
  const [packageName, ...rest] = String(path).split('.');
  const asset = await assets.get(packageName).catch(() => null);
  const index = asset?.exportsByPath.get(lower(rest.join('.')));
  return index ? {asset, index, key: `${asset.name}.${exportAt(asset.pkg, index).path}`, why} : null;
}

/** A load graph that only the original's requests reach (each inside BeginLoad/EndLoad), kept across `add` calls as a process
 * keeps its loaded objects. `add(requests)` returns the objects those requests constructed. `objects` maps every constructed object
 * as `{key, kind, record}` (key "package.path" lower-cased); `classes()` adds the classes the DLLs register (Play's static records). */
export async function createOriginalLoadModel(assets) {
  const packageAssets = new Map();
  const prepare = async asset => {
    const queue = [asset];
    while (queue.length) {
      const current = queue.pop(), key = lower(current.name);
      if (packageAssets.has(key)) continue;
      packageAssets.set(key, current);
      for (const name of current.pkg.dependencies) if (!packageAssets.has(lower(name))) queue.push(await assets.get(name));
    }
  };
  let lazyLoad = 1;
  // EndLoad's PostLoad binds every loaded UFunction (UFunction::Bind): it writes the function's native pointer and creates no object.
  // This measurement counts objects only, so Bind's lookups answer with placeholder pointers (nonzero, never dereferenced).
  const PLACEHOLDER = 0x7f000000;
  const nativeFunctions = {
    readNative: index => PLACEHOLDER + index,
    getDllExport: () => PLACEHOLDER,
    readPointer: () => PLACEHOLDER,
  };
  // An object whose Serialize body Play has not recovered (a procedural texture, ...) stays created and unloaded: its own references
  // are not followed, so the closure is a lower bound there. The kinds are reported.
  const skipped = new Map();
  const skipUnrecovered = (object, kind) => { skipped.set(kind, (skipped.get(kind) ?? 0) + 1); return true; };
  // Every object a load constructs, in order (StaticConstructObject, a new one or an existing one reinitialized): no event log is kept.
  const constructed = [];
  const graph = createScriptLoadGraph({packageAssets, nativeFunctions, skipUnrecovered, onConstruct: record => constructed.push(record),
    resourceServices: {seconds: () => 0, getLazyLoad: () => lazyLoad, setLazyLoad: value => { lazyLoad = value; }, mipBias: () => 0},
    meshLoadServices: {getLazyLoad: () => 1},
    lifecycle: {logReceiver: {kind: 'GWarn'}, logEndLoad: () => {}, reallocLoaded: () => {}}});
  graph.setConfig(await loadConfigCache(assets.configFiles ?? []));
  const failures = [], objects = new Map();
  const debug = typeof process !== 'undefined' && process.env.CLOSURE_DEBUG;
  return {
    graph, objects, failures, skipped,
    async add(requests) {
      for (const request of requests) await prepare(request.asset);
      for (const request of requests) {
        if (debug) console.error('request', request.key, 'loaded before', graph.loadedObjects.length, 'nest', graph.loadState.nest);
        graph.beginLoad();
        try { graph.loadExport(request.asset.name, request.index); }
        catch (error) { failures.push({key: request.key, why: request.why, error: String(error?.message ?? error).split('\n')[0]}); if (debug) throw error; }
        try { graph.endLoad(); }
        catch (error) { failures.push({key: request.key, why: `${request.why} (EndLoad)`, error: String(error?.message ?? error).split('\n')[0]}); if (debug) throw error; }
      }
      const added = [];
      for (const record of constructed.splice(0)) {
        const key = lower(graph.fullName(record));
        const kind = graph.nameText(graph.slotOf(graph.classRecordOf(record), 0x20));
        if (!objects.has(key)) added.push(key);
        objects.set(key, {key, kind, record});
      }
      return added;
    },
    classes() {
      // The UClass objects the DLLs register at startup (Play's static records: Core, Engine, DeusEx) exist whatever was loaded.
      const out = new Set([...objects.values()].filter(object => object.kind === 'Class').map(object => object.key));
      for (const key of graph.staticRecords.keys()) out.add(lower(key));
      return out;
    },
  };
}

/** One model, one set of requests: the closure of a cold load. */
export async function originalLoadClosure(assets, requests) {
  const model = await createOriginalLoadModel(assets);
  await model.add(requests);
  return {objects: model.objects, classes: model.classes(), failures: model.failures, skipped: model.skipped, graph: model.graph};
}

/** The class rows of a dump-gobjects-win --flags dump, as "package.class" (lower case). */
export function dumpClasses(text) {
  const out = new Set();
  for (const line of text.split('\n')) {
    const match = /^slot\s+\d+ index\s+\d+ Class\.(\S+) ptr 0x\w+ flags 0x\w+ outer 0x\w+ (\S*)/.exec(line);
    if (match) out.add(lower(`${match[2]}.${match[1]}`));
  }
  return out;
}
