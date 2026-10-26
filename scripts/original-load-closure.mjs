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
    const entry = asset.pkg.imports[i];
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
  return index ? {asset, index, key: `${asset.name}.${asset.pkg.exports[index - 1].path}`, why} : null;
}

/** Replays `requests` on a fresh load graph, each inside BeginLoad/EndLoad. Returns the constructed objects as
 * `{key, kind, record}` (key "package.path" lower-cased), the classes among them, and the requests that failed. */
export async function originalLoadClosure(assets, requests) {
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
  for (const request of requests) await prepare(request.asset);
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
  const graph = createScriptLoadGraph({packageAssets, captureEvents: true, nativeFunctions, skipUnrecovered,
    resourceServices: {seconds: () => 0, getLazyLoad: () => lazyLoad, setLazyLoad: value => { lazyLoad = value; }, mipBias: () => 0},
    meshLoadServices: {getLazyLoad: () => 1},
    lifecycle: {logReceiver: {kind: 'GWarn'}, logEndLoad: () => {}, reallocLoaded: () => {}}});
  graph.setConfig(await loadConfigCache(assets.configFiles ?? []));
  const failures = [];
  const debug = typeof process !== 'undefined' && process.env.CLOSURE_DEBUG;
  for (const request of requests) {
    if (debug) console.error('request', request.key, 'loaded before', graph.loadedObjects.length, 'nest', graph.loadState.nest);
    graph.beginLoad();
    try { graph.loadExport(request.asset.name, request.index); }
    catch (error) { failures.push({key: request.key, why: request.why, error: String(error?.message ?? error).split('\n')[0]}); if (debug) throw error; }
    try { graph.endLoad(); }
    catch (error) { failures.push({key: request.key, why: `${request.why} (EndLoad)`, error: String(error?.message ?? error).split('\n')[0]}); if (debug) throw error; }
  }
  const objects = new Map();
  for (const event of graph.events) {
    if (event.op !== 'ConstructObject' && event.op !== 'ConstructExisting') continue;
    const record = event.object, key = lower(graph.fullName(record));
    const kind = graph.nameText(graph.slotOf(graph.classRecordOf(record), 0x20));
    objects.set(key, {key, kind, record});
  }
  // The UClass objects the DLLs register at startup (Play's static records: Core, Engine, DeusEx) exist whatever was loaded.
  const registered = new Set([...graph.staticRecords.keys()].map(lower));
  const classes = new Set([...objects.values()].filter(object => object.kind === 'Class').map(object => object.key));
  for (const key of registered) classes.add(key);
  return {objects, classes, registered, failures, skipped, graph};
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
