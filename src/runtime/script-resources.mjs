/**
 * Canonical package/resource identities for the Stage 3 loader boundary.
 *
 * This module deliberately stops at the evidence-backed boundary in
 * docs/script-resources.md. It links package exports to a stable outer and
 * class identity, decodes the recovered LodMesh data and Sound WAV payload,
 * and leaves other native payloads opaque.
 */
import {objectAt} from '../unreal/objects.mjs';
import {ScriptObjects} from './script-objects.mjs';
import {decodeLodMeshPayload} from './lodmesh-payload.mjs';
import {decodeSoundResource} from './script-sound-resource.mjs';

export class ScriptResourceError extends Error {
  constructor(message, code = 'resource-error') {
    super(message);
    this.name = 'ScriptResourceError';
    this.code = code;
  }
}

// These are addresses in the original Deus Ex GOTY Engine.dll image. They are
// metadata only; no host function is called by this registry.
const NATIVE_SPECS = Object.freeze({
  'engine.viewport': {
    packageName: 'Engine', name: 'Viewport', staticClass: 0x10581068,
    instanceSize: 0xf8, registrationBody: 0x10372370,
    superKey: 'engine.player', withinKey: 'engine.client',
    unsupportedReason: 'Only inherited Player script storage and local Console linkage are attached; platform viewport construction is unsupported',
  },
  'core.object': {
    packageName: 'Core', name: 'Object', staticClass: 0x1029e0d0,
    instanceSize: 0x28, registrationBody: 0x10150cc0,
  },
  'core.field': {
    packageName: 'Core', name: 'Field', staticClass: 0x101f2b18,
    instanceSize: 0x34, registrationBody: 0x10125e50,
    superKey: 'core.object', withinKey: 'core.object',
  },
  'core.struct': {
    packageName: 'Core', name: 'Struct', staticClass: 0x101f2618,
    instanceSize: 0x6c, registrationBody: 0x101273d0,
    superKey: 'core.field', withinKey: 'core.object',
  },
  'core.state': {
    packageName: 'Core', name: 'State', staticClass: 0x101f2118,
    instanceSize: 0x484, registrationBody: 0x10127760,
    superKey: 'core.struct', withinKey: 'core.object',
  },
  'core.package': {
    packageName: 'Core', name: 'Package', staticClass: 0x1029b8e0,
    instanceSize: 0x34, registrationBody: 0x1015a710,
    superKey: 'core.object', withinKey: 'core.object',
  },
  'core.class': {
    packageName: 'Core', name: 'Class', staticClass: 0x101f1c18,
    instanceSize: 0x4f4, registrationBody: 0x10128750,
    superKey: 'core.state', withinKey: 'core.package',
  },
  'engine.bitmap': {
    packageName: 'Engine', name: 'Bitmap', staticClass: 0x1058eb48,
    supportedResource: false,
    unsupportedReason: 'Bitmap static identity is recovered; constructor and payload ownership are not recovered here',
  },
  'engine.primitive': {
    packageName: 'Engine', name: 'Primitive', staticClass: 0x1058d368,
    instanceSize: 0x54, internalConstructor: 0x103023ce,
    registrationBody: 0x103d8200,
    serializer: {thunk: 0x10303c0b, body: 0x103d82d0},
    superKey: 'core.object', withinKey: 'core.object',
  },
  'engine.mesh': {
    packageName: 'Engine', name: 'Mesh', staticClass: 0x10589758,
    instanceSize: 0x12c, internalConstructor: 0x103020bd,
    defaultConstructor: {body: 0x103a6130}, registrationBody: 0x103a6770,
    serializer: {thunk: 0x10301717, body: 0x103a63b0},
    superKey: 'engine.primitive', withinKey: 'core.object',
    resourceKind: 'Mesh', payloadDecoder: 'mesh',
  },
  'engine.lodmesh': {
    packageName: 'Engine', name: 'LodMesh', staticClass: 0x105359d0,
    instanceSize: 0x1b0, internalConstructor: 0x10303855,
    defaultConstructor: {thunk: 0x10302f09, body: 0x1034a760},
    registrationBody: 0x10354f40,
    serializer: {thunk: 0x103024b9, body: 0x10354ab0},
    destructor: {thunk: 0x10303922, body: 0x1031c1f0},
    superKey: 'engine.mesh', withinKey: 'core.object',
    resourceKind: 'LodMesh', payloadDecoder: 'lodmesh',
  },
  'engine.sound': {
    packageName: 'Engine', name: 'Sound', staticClass: 0x10580868,
    instanceSize: 0x54, internalConstructor: 0x10303891,
    defaultConstructor: {thunk: 0x10303af3, body: 0x1034cdc0},
    registrationBody: 0x1036fc02,
    serializer: {thunk: 0x103029fa, body: 0x1036f900},
    destructor: {thunk: 0x10303a5d, body: 0x1031cb60},
    superKey: 'core.object', withinKey: 'core.object',
    resourceKind: 'Sound',
    unsupportedReason: 'Sound native lazy loading and audio ownership are not bound',
  },
  'engine.texture': {
    packageName: 'Engine', name: 'Texture', staticClass: 0x1058e648,
    instanceSize: 0xc0, internalConstructor: 0x1030249b,
    defaultConstructor: {body: 0x103edb10}, registrationBody: 0x103edba0,
    serializer: {thunk: 0x10301a32, body: 0x103ed470},
    superKey: 'engine.bitmap', withinKey: 'core.object',
    resourceKind: 'Texture',
    unsupportedReason: 'Texture bulk-data serializer and native ownership are not translated',
  },
});

/** Public copy of the measured class catalog, safe for callers to inspect. */
export const NATIVE_RESOURCE_CLASSES = Object.freeze(Object.fromEntries(
  Object.entries(NATIVE_SPECS).map(([key, spec]) => [key, Object.freeze({...spec})]),
));

function isAsset(value) {
  return value && typeof value === 'object' && value.pkg && typeof value.name === 'string';
}

function keyForAsset(asset) {
  return asset.name.toLowerCase();
}

function classPathKey(path) {
  return String(path ?? '').toLowerCase();
}

function sourceKey(asset, index) {
  return `${keyForAsset(asset)}:${index}`;
}

function importedPath(entry) {
  return String(entry?.path ?? entry?.name ?? '');
}

function immutableCopy(value) {
  return value && typeof value === 'object' ? Object.freeze({...value}) : value;
}

/**
 * The package/resource graph. `objects` may be the runtime's existing
 * ScriptObjects instance; if omitted this class creates one, preserving the
 * same canonical identities for bytecode and loaded exports.
 */
export class ScriptResourceRegistry {
  constructor({assets, objects = null, indexProvider = null, loader = null} = {}) {
    if (!assets || typeof assets.get !== 'function' || typeof assets.resolve !== 'function') {
      throw new TypeError('ScriptResourceRegistry requires an AssetStore-like assets object');
    }
    this.assets = assets;
    this.objects = objects ?? new ScriptObjects(assets);
    this.indexProvider = indexProvider;
    this.loader = loader;
    this.resources = new Map();
    this.pending = new Map();
    this.packages = new Map();
    this.imports = new Map();
    this.nativeClasses = new Map();
  }

  /** Resolve a package export or an import reference; zero is null. */
  async resolve(assetOrName, index) {
    const asset = await this.#asset(assetOrName);
    if (!index) return null;
    if (index < 0) return this.resolveReference(asset, index);
    return this.materialize(asset, index);
  }

  /** Materialize one positive package export into the canonical graph. */
  async materialize(assetOrName, index) {
    const asset = await this.#asset(assetOrName);
    if (!Number.isInteger(index) || index <= 0) {
      throw new ScriptResourceError(`Expected positive export index, got ${index}`, 'invalid-export-index');
    }
    return this.#materialize(asset, index, false);
  }

  async #materialize(asset, index, allowPending) {
    const object = await this.objects.resolve(asset, index);
    const key = object.key.toLowerCase();
    const existing = this.resources.get(key);
    if (existing) {
      const pending = this.pending.get(key);
      if (pending && !allowPending) return pending;
      // Recursive edges in a valid graph normally reach an already complete
      // record. Returning the published identity here also prevents a
      // malformed self-Outer from deadlocking its own pending promise.
      return existing;
    }

    const entry = object.entry;
    const record = {
      key,
      kind: entry.className,
      className: entry.className,
      name: entry.name,
      path: entry.path,
      fullPath: `${object.asset.name}.${entry.path}`,
      asset: object.asset,
      index: object.index,
      entry,
      object,
      outer: null,
      nativeClass: null,
      nativeRegistration: entry.className === 'Class'
        ? this.#nativeClass(`${object.asset.name}.${entry.path}`, false)
        : null,
      globalIndex: this.#globalIndex(entry.className, entry.name),
      materialization: 'package-export',
      payloadStatus: 'not-a-native-resource',
      payloadComplete: false,
      payload: null,
      unsupported: [],
    };
    // Publish before traversing edges so a malformed/cyclic package cannot
    // create duplicate identities. Valid UE1 packages have acyclic Outers.
    this.resources.set(key, record);
    const pending = (async () => {
      try {
        record.nativeClass = await this.#classReference(object.asset, entry.classIndex, true);
        record.outer = await this.#outerReference(object.asset, entry.outer, true);
        await this.#decodePayload(record);
        return record;
      } catch (error) {
        this.resources.delete(key);
        if (error instanceof ScriptResourceError) throw error;
        throw new ScriptResourceError(`Unable to materialize ${record.fullPath}: ${error.message}`, 'materialize-failed');
      }
    })();
    this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }

  /**
   * Resolve an imported object. Native class imports return their canonical
   * DLL descriptor; package exports return the same record as direct loads.
   */
  async resolveReference(assetOrName, index) {
    const asset = await this.#asset(assetOrName);
    return this.#resolveReference(asset, index, false);
  }

  async #resolveReference(asset, index, allowPending) {
    if (!Number.isInteger(index) || index >= 0) {
      return index === 0 ? null : this.#materialize(asset, index, allowPending);
    }
    const cacheKey = sourceKey(asset, index);
    if (this.imports.has(cacheKey)) return this.imports.get(cacheKey);
    const entry = objectAt(asset.pkg, index);
    if (entry.className === 'Class') {
      const scriptClass = await this.#scriptClass(importedPath(entry), allowPending);
      if (scriptClass) {
        this.imports.set(cacheKey, scriptClass);
        return scriptClass;
      }
    }
    const known = this.#nativeClass(importedPath(entry), false);
    if (known) {
      this.imports.set(cacheKey, known);
      return known;
    }
    const target = await this.#followImport(entry, allowPending);
    if (target) {
      this.imports.set(cacheKey, target);
      return target;
    }
    const unresolved = this.#unresolvedImport(asset, index, entry);
    this.imports.set(cacheKey, unresolved);
    return unresolved;
  }

  /** Package identity used as the implicit outer for root exports. */
  async package(assetOrName) {
    const asset = await this.#asset(assetOrName);
    return this.packageIdentity(asset);
  }

  /** Synchronous identity boundary for an already fetched linker root. */
  packageIdentity(asset) {
    if (!isAsset(asset)) throw new TypeError('Package identity requires a loaded asset');
    const key = keyForAsset(asset);
    if (this.packages.has(key)) return this.packages.get(key);
    const record = {
      key: `package:${key}`,
      kind: 'Package',
      className: 'Package',
      name: asset.name,
      path: asset.name,
      fullPath: asset.name,
      asset,
      index: 0,
      entry: null,
      object: null,
      outer: null,
      nativeClass: this.#nativeClass('Core.Package', true),
      globalIndex: null,
      materialization: 'package-identity',
      payloadStatus: 'no-payload',
      payload: null,
      unsupported: [],
    };
    this.packages.set(key, record);
    return record;
  }

  /**
   * Return only evidence-backed UObject edges. `visit` is optional; when
   * supplied it receives each `{slot,target,mutable,evidence}` object.
   */
  references(record, visit = null) {
    if (!record || typeof record !== 'object') throw new TypeError('Expected a resource record');
    const references = [];
    if (record.outer) references.push({
      slot: 'outer', target: record.outer, mutable: false,
      evidence: 'serialized export Outer reference',
    });
    if (record.nativeClass) references.push({
      slot: 'class', target: record.nativeClass, mutable: false,
      evidence: 'serialized export ClassIndex or native class registration',
    });
    for (const reference of record.payloadReferences ?? []) references.push(reference);
    if (typeof visit === 'function') for (const reference of references) visit(reference);
    return references;
  }

  /** Collector-friendly alias with an explicit result for unsupported data. */
  collectReferences(record, visit) {
    const references = this.references(record, visit);
    return {references, nameReferences:record.payload?.nameReferences??[], unsupported: [...(record?.unsupported ?? [])]};
  }

  /** Return a canonical native class descriptor, including its class chain. */
  nativeClass(path) {
    return this.#nativeClass(path, true);
  }

  async #asset(assetOrName) {
    if (typeof assetOrName === 'string') return this.assets.get(assetOrName);
    if (!isAsset(assetOrName)) throw new TypeError('Expected a loaded package asset or package name');
    return assetOrName;
  }

  #nativeClass(path, createUnknown) {
    const key = classPathKey(path);
    if (!key) return null;
    const canonical = key.includes('.') ? key : `engine.${key}`;
    const known = NATIVE_SPECS[canonical];
    if (!known && !createUnknown) return null;
    if (this.nativeClasses.has(canonical)) return this.nativeClasses.get(canonical);
    const spec = known ?? {
      packageName: String(path).split('.')[0] ?? 'Unknown',
      name: String(path).split('.').at(-1) ?? String(path),
      unsupportedReason: 'Native class registration is not recovered in this registry',
      supportedResource: false,
    };
    const descriptor = {
      key: `native:${canonical}`,
      kind: 'NativeClass',
      className: spec.name,
      packageName: spec.packageName,
      name: spec.name,
      path: `${spec.packageName}.${spec.name}`,
      native: true,
      supportedResource: spec.resourceKind !== undefined,
      resourceKind: spec.resourceKind ?? null,
      staticClass: spec.staticClass ?? null,
      instanceSize: spec.instanceSize ?? null,
      internalConstructor: spec.internalConstructor ?? null,
      defaultConstructor: immutableCopy(spec.defaultConstructor),
      registrationBody: spec.registrationBody ?? null,
      serializer: immutableCopy(spec.serializer),
      destructor: immutableCopy(spec.destructor),
      superClass: spec.superKey ? this.#nativeClass(spec.superKey, true) : null,
      withinClass: spec.withinKey ? this.#nativeClass(spec.withinKey, true) : null,
      unsupported: spec.unsupportedReason ? [spec.unsupportedReason] : [],
    };
    this.nativeClasses.set(canonical, Object.freeze(descriptor));
    return this.nativeClasses.get(canonical);
  }

  async #classReference(asset, classIndex, allowPending) {
    if (!classIndex) return await this.#scriptClass('Core.Class', allowPending)
      ?? this.#nativeClass('Core.Class', true);
    const entry = objectAt(asset.pkg, classIndex);
    if (classIndex < 0) {
      const scriptClass = await this.#scriptClass(importedPath(entry), allowPending);
      if (scriptClass) return scriptClass;
      const known = this.#nativeClass(importedPath(entry), false);
      if (known) return known;
      const target = await this.#followImport(entry, allowPending);
      if (target) return target;
      return this.#nativeClass(importedPath(entry), true);
    }
    const object = await this.objects.resolve(asset, classIndex);
    const existing = this.resources.get(object.key.toLowerCase());
    if (existing) return existing;
    return this.#materialize(object.asset, object.index, allowPending);
  }

  async #outerReference(asset, outerIndex, allowPending) {
    if (!outerIndex) return this.package(asset);
    if (outerIndex > 0) return this.#materialize(asset, outerIndex, allowPending);
    return this.#resolveReference(asset, outerIndex, allowPending);
  }

  async #followImport(entry, allowPending) {
    const path = importedPath(entry);
    const parts = path.split('.').filter(Boolean);
    if (!parts.length) return null;
    const packageName = parts.shift();
    let target;
    try {
      target = await this.assets.get(packageName);
    } catch (error) {
      if (!String(error.message).startsWith('Missing package:')) throw error;
      return null;
    }
    if (entry.className === 'Package' && parts.length === 0) return this.package(target);
    const targetPath = parts.join('.').toLowerCase();
    const targetIndex = target.exportsByPath.get(targetPath);
    if (!targetIndex) return null;
    return this.#materialize(target, targetIndex, allowPending);
  }

  /**
   * Native classes that also have a serialized script class must share the
   * ScriptObjects identity used by ScriptRuntime.loadClass. This lookup is
   * intentionally limited to a real Class export; it does not manufacture a
   * script class for an Engine native-only type such as LodMesh.
   */
  async #scriptClass(path, allowPending) {
    const parts = String(path).split('.').filter(Boolean);
    if (parts.length < 2) return null;
    const packageName = parts.shift();
    let target;
    try {
      target = await this.assets.get(packageName);
    } catch (error) {
      if (!String(error.message).startsWith('Missing package:')) throw error;
      return null;
    }
    const index = target.exportsByPath.get(parts.join('.').toLowerCase());
    if (!index) return null;
    const entry = target.pkg.exports[index - 1];
    if (entry?.className !== 'Class') return null;
    const record = await this.#materialize(target, index, allowPending);
    const native = this.#nativeClass(path, false);
    if (native) record.nativeRegistration ??= native;
    return record;
  }

  #unresolvedImport(asset, index, entry) {
    return Object.freeze({
      key: `unresolved:${sourceKey(asset, index)}`,
      kind: entry.className,
      className: entry.className,
      name: entry.name,
      path: importedPath(entry),
      asset: null,
      index: null,
      entry,
      object: null,
      outer: null,
      nativeClass: null,
      globalIndex: null,
      materialization: 'unresolved-import',
      payloadStatus: 'unsupported',
      payload: null,
      unsupported: [`Import target ${importedPath(entry)} is absent from the loaded package set`],
    });
  }

  async #decodePayload(record) {
    // A class represented by both a script export and a native registration
    // keeps the script record as its identity; the registration metadata still
    // selects the evidence-backed payload path for objects of that class.
    const native = record.nativeClass?.nativeRegistration ?? record.nativeClass;
    if (!native?.supportedResource) {
      record.materialization = 'package-object';
      record.payloadStatus = 'not-a-native-resource';
      return;
    }
    record.materialization = 'native-resource';
    if (native.resourceKind === 'LodMesh' || native.resourceKind === 'Mesh') {
      if (!this.loader && native.resourceKind === 'Mesh')
        throw new ScriptResourceError(`Classic Mesh payloads load only through the native load graph: ${record.fullPath}`);
      if (this.loader) {
        const loaded = await this.loader.load(record.object);
        const {slotOf} = this.loader.graph;
        if (this.loader.identity(slotOf(loaded, 0x24)) !== (record.nativeClass.object ?? record.nativeClass) ||
            this.loader.identity(slotOf(loaded, 0x18)) !== (record.outer.object ?? record.outer))
          throw new ScriptResourceError(`Native mesh Class/Outer identity mismatch: ${record.fullPath}`);
        if (!loaded.meshPayload)
          throw new ScriptResourceError(`Native mesh serializer has no payload: ${record.fullPath}`);
        record.loadRecord = loaded;
        record.payload = loaded.meshPayload;
        record.payloadSource = 'original-linker-serialized';
      } else {
        record.payload = decodeLodMeshPayload(record.asset.pkg, record.asset.bytes, record.index);
        record.payloadSource = 'detached-inspection';
      }
      record.payloadStatus = record.payload.payloadStatus;
      record.unsupported.push(...record.payload.unsupported);
      record.payloadReferences = [];
      for (const {slot, index, object} of record.payload.objectReferences) {
        if (!index) continue;
        let target;
        if (this.loader) {
          const canonical = this.loader.identity(object);
          target = await this.#materialize(canonical.asset, canonical.index, true);
          if (target.object !== canonical)
            throw new ScriptResourceError(`Native mesh Texture identity mismatch: ${record.fullPath}`);
        } else target = await this.#resolveReference(record.asset, index, true);
        record.payloadReferences.push({slot, target, mutable: false,
          evidence: 'original UMesh::Serialize +0xd8 UObject array (0x103a9f90)'});
      }
      return;
    }
    if(native.resourceKind==='Sound'){
      record.payload=decodeSoundResource({pkg:record.asset.pkg,bytes:record.asset.bytes,entry:record.entry});
      record.payloadStatus=record.payload.payloadStatus;
      record.payloadComplete=record.payload.payloadComplete;
      record.unsupported.push(...record.payload.unsupported);
      return;
    }
    record.payloadStatus = 'opaque';
    record.unsupported.push(native.unsupported[0] ?? `${native.resourceKind} payload is opaque`);
  }

  #globalIndex(className, name) {
    const provider = this.indexProvider;
    const indexFor = typeof provider === 'function' ? provider : provider?.indexFor;
    if (typeof indexFor !== 'function') return null;
    try {
      const value = indexFor.call(provider, className, name);
      return Number.isInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }
}
