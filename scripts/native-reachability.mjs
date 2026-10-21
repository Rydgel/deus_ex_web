/** Which natives the shipped scripts can call, and from where (docs/native-census.md "Reachability").
 *
 * Every shipped script package (System/*.u) is read; every function and state body is decoded (src/unreal/bytecode.mjs); each
 * native declaration (a Function with FUNC_Native, 0x400) is collected with its index (0 for a native the declaration binds by
 * name); and each call site that can reach a declaration is recorded, by one of:
 *   token     a native token (an index declared `native(N)`), the form the compiler emits for every numbered native
 *   final     EX_FinalFunction: the call's function object is the declaration itself (exact)
 *   virtual   EX_VirtualFunction / EX_GlobalFunction: a call by name, resolved to a native of that name whose class is the
 *             caller's class, one of its ancestors or one of its descendants (a call through `Context.Name()` has no static
 *             receiver class: any native of that name, reported as `context`)
 * A caller is a function or state of the shipped packages, so a call in code no map ever runs still counts (an over-
 * approximation of "can run"); the report keeps the caller classes so a reader can judge. */
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata, readStateMetadata, readPropertyMetadata} from '../src/unreal/script-metadata.mjs';
import {decodeScript} from '../src/unreal/bytecode.mjs';
import {gameDirectory} from './game-directory.mjs';

// Function flags (UnScript.h): FUNC_Final 0x1, FUNC_Iterator 0x4, FUNC_Latent 0x8, FUNC_PreOperator 0x10, FUNC_Native 0x400, FUNC_Operator 0x1000, FUNC_Static 0x2000.
const FUNC_NATIVE = 0x400, FUNC_LATENT = 0x8, FUNC_ITERATOR = 0x4, FUNC_OPERATOR = 0x1010, FUNC_STATIC = 0x2000;

export async function openSystemPackages(root = gameDirectory()) {
  const files = [];
  for (const name of await readdir(path.join(root, 'System'))) files.push({path: name, read: () => readFile(path.join(root, 'System', name))});
  return new AssetStore(files);
}

/** Script packages in System/ (the .u files), by name. */
export async function scriptPackageNames(root = gameDirectory()) {
  return (await readdir(path.join(root, 'System'))).filter(name => name.endsWith('.u')).map(name => name.slice(0, -2)).sort();
}

const lower = text => String(text).toLowerCase();

export async function scanNativeCalls(assets, packageNames) {
  const declarations = [], classes = new Map(), callers = [], typeCache = new Map();
  const decodeErrors = [], packages = [];
  for (const name of packageNames) {
    let asset;
    try { asset = await assets.get(name); } catch (error) { decodeErrors.push({package: name, error: error.message}); continue; }
    const stats = {name: asset.name, classes: 0, functions: 0, states: 0, natives: 0, decoded: 0};
    packages.push(stats);
    for (const [i, entry] of asset.pkg.exports.entries()) {
      if (entry.className === 'Class') {
        stats.classes++;
        let superKey = null;
        if (entry.superIndex) {
          try { superKey = lower((await assets.resolve(asset, entry.superIndex)).key); } catch { superKey = null; }
        }
        classes.set(lower(`${asset.name}.${entry.path}`), {package: asset.name, name: entry.path, superKey});
        continue;
      }
      if (!['Function', 'State'].includes(entry.className)) continue;
      stats[entry.className === 'Function' ? 'functions' : 'states']++;
      const key = `${asset.name}.${entry.path}`, parts = entry.path.split('.');
      let script;
      try { script = (entry.className === 'Function' ? readFunctionMetadata : readStateMetadata)(asset, i + 1, {includeChildren: false}); }
      catch (error) { decodeErrors.push({function: key, error: error.message}); continue; }
      if (entry.className === 'Function' && script.functionFlags & FUNC_NATIVE) {
        stats.natives++;
        declarations.push({key, package: asset.name, class: parts[0], function: parts.at(-1), path: entry.path, index: script.nativeIndex || 0,
          flags: script.functionFlags, latent: Boolean(script.functionFlags & FUNC_LATENT), operator: Boolean(script.functionFlags & FUNC_OPERATOR), iterator: Boolean(script.functionFlags & FUNC_ITERATOR),
          static: Boolean(script.functionFlags & FUNC_STATIC)});
        continue;
      }
      let decoded;
      try { decoded = decodeScript(script); stats.decoded++; }
      catch (error) { decodeErrors.push({function: key, error: error.message}); continue; }
      // A context call's receiver is the context node's first operand.
      const contextOf = new Map();
      for (const node of decoded.expressions.values()) if (node.op === 0x19 || node.op === 0x12) contextOf.set(node.value, node.context);
      const callerClassKey = lower(`${asset.name}.${parts[0]}`);
      const sites = [];
      for (const node of decoded.expressions.values()) {
        if (node.op === 'native') sites.push({via: 'token', index: node.index});
        else if (node.op === 0x1c) {
          try { sites.push({via: 'final', target: lower((await assets.resolve(asset, node.functionIndex)).key)}); }
          catch { /* a function object the packages do not hold */ }
        } else if (node.op === 0x1b || node.op === 0x38) {
          const context = contextOf.get(node);
          // The static class of the receiver: self for a plain call, the property's or the cast's class for a context call
          // (null when the context is a call result or an expression this reading does not type).
          sites.push({via: context ? 'context' : 'virtual', name: lower(node.name),
            receiver: context ? await receiverClass(assets, asset, context, callerClassKey, typeCache) : callerClassKey});
        }
      }
      if (sites.length) callers.push({key, package: asset.name, class: parts[0], classKey: callerClassKey, kind: entry.className, sites});
    }
  }
  return {declarations, classes, callers, decodeErrors, packages};
}

/** The class key of a context call's receiver expression, or null. */
async function receiverClass(assets, asset, node, callerClassKey, cache) {
  try {
    if (node.op === 0x17) return callerClassKey;
    if (node.op === 0x2e) return lower((await assets.resolve(asset, node.fieldIndex)).key);
    if (node.op !== 0x00 && node.op !== 0x01 && node.op !== 0x02 && node.op !== 0x29) return null;
    const field = await assets.resolve(asset, node.fieldIndex);
    const id = `${field.asset.name}#${field.index}`;
    if (!cache.has(id)) {
      let key = null;
      if (field.entry.className === 'ObjectProperty') {
        const metadata = readPropertyMetadata(field.asset, field.index);
        if (metadata.propertyClassRef) key = lower((await assets.resolve(field.asset, metadata.propertyClassRef)).key);
      }
      cache.set(id, key);
    }
    return cache.get(id);
  } catch { return null; }
}

/** The classes a class derives from, nearest first. */
export function ancestors(classes, classKey) {
  const out = [];
  for (let key = classes.get(classKey)?.superKey, guard = 0; key && guard < 64; key = classes.get(key)?.superKey, guard++) out.push(key);
  return out;
}

/** Callers by declaration: Map(declaration key -> {sites, via, callers: Map(callerKey -> {class, package, via:Set, count})}). */
export function resolveCalls(scan) {
  const {declarations, classes, callers} = scan;
  const byIndex = new Map(), byKey = new Map(), byName = new Map();
  for (const decl of declarations) {
    byKey.set(lower(decl.key), decl);
    if (decl.index) { if (!byIndex.has(decl.index)) byIndex.set(decl.index, []); byIndex.get(decl.index).push(decl); }
    const name = lower(decl.function);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(decl);
  }
  const ancestry = new Map();
  const related = (callerClass, declClass) => {
    if (callerClass === declClass) return true;
    if (!ancestry.has(callerClass)) ancestry.set(callerClass, new Set(ancestors(classes, callerClass)));
    if (!ancestry.has(declClass)) ancestry.set(declClass, new Set(ancestors(classes, declClass)));
    return ancestry.get(callerClass).has(declClass) || ancestry.get(declClass).has(callerClass);
  };
  const result = new Map(declarations.map(decl => [decl.key, {declaration: decl, sites: 0, via: {}, callers: new Map()}]));
  const note = (decl, caller, via) => {
    const entry = result.get(decl.key);
    entry.sites++;
    entry.via[via] = (entry.via[via] ?? 0) + 1;
    let record = entry.callers.get(caller.key);
    if (!record) entry.callers.set(caller.key, record = {key: caller.key, class: caller.class, package: caller.package, via: new Set(), count: 0});
    record.via.add(via); record.count++;
  };
  for (const caller of callers) {
    for (const site of caller.sites) {
      if (site.via === 'token') {
        // One index can be declared by two functions (2054); either may be the callee, the report names both.
        for (const decl of byIndex.get(site.index) ?? []) note(decl, caller, 'token');
      } else if (site.via === 'final') {
        const decl = byKey.get(site.target);
        if (decl) note(decl, caller, 'final');
      } else {
        // The compiler emits a native token for every numbered native, in a context call too; a call by name that matches
        // a numbered native's name is another function of that name (PersonaInfoWindow.SetText wraps TextWindow.SetText).
        const named = (byName.get(site.name) ?? []).filter(decl => !decl.index);
        if (!named.length) continue;
        if (!site.receiver) { for (const decl of named) note(decl, caller, 'context'); continue; }
        // A typed receiver reaches the nearest declaration up its ancestry (the override a virtual call runs) and any
        // declaration of a descendant (an override a subclass instance would run).
        const chain = [site.receiver, ...ancestors(classes, site.receiver)];
        const classOf = decl => lower(`${decl.package}.${decl.class}`);
        const nearest = chain.find(key => named.some(decl => classOf(decl) === key));
        for (const decl of named) {
          const own = classOf(decl);
          if (own === nearest || (own !== site.receiver && ancestors(classes, own).includes(site.receiver))) note(decl, caller, site.via);
        }
      }
    }
  }
  return result;
}
