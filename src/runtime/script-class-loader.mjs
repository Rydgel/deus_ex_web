/** Original class loading with the VM's canonical identity/value representation.
 * See docs/script-load-graph.md for original authority and remaining services.
 */
import {readClass} from '../unreal/classes.mjs';
import {createScriptLoadGraph} from './script-load-graph.mjs';
import {loadConfigCache} from './config-cache.mjs';
import {createOriginalLoadTracker} from './original-loaded.mjs';

// UFunction::Bind (EndLoad's PostLoad, script-function-bind.mjs) writes each native function's pointer at +0x7c: GNatives[iNative] for a
// numbered native, else the package DLL's `int<Class>exec<Name>` export. Play has no DLL address space and dispatches natives itself
// (ScriptRuntime.invokeNative), and nothing reads that slot. A numbered native's slot holds HOST_NATIVE_TOKEN + iNative (nonzero, as
// the original's assertion requires, never dereferenced); a name-bound native's export is not looked up, so its slot stays null.
const HOST_NATIVE_TOKEN = 0x80000000;
const HOST_NATIVE_BINDING = Object.freeze({
  readNative: index => (HOST_NATIVE_TOKEN | index) >>> 0,
  getDllExport: () => null,
  readPointer: () => 0,
});

export class ScriptClassLoader {
  /** `carriedDefaults`: the class defaults a travel carried from the level left (Map class key -> Map field key -> [[index, value]]:
   * ScriptRuntime.classDefaultsForTravel); each is written into its class's Defaults as the class is serialized (applyCarriedDefaults). */
  constructor({assets, objects, resources, captureEvents = false, meshLoadServices = null,
    resourceServices = null, lifecycle = {}, carriedDefaults = null}) {
    this.assets = assets;
    this.objects = objects;
    this.resources = resources;
    this.carriedDefaults = carriedDefaults;
    this.graph = createScriptLoadGraph({captureEvents, meshLoadServices, resourceServices, lifecycle,
      nativeFunctions: HOST_NATIVE_BINDING, recordLoadEdges: true,
      classSerialized: carriedDefaults?.size ? record => this.applyCarriedDefaults(record) : null});
    // Which of the graph's objects the original holds loaded (original-loaded.mjs): what name lookups see, and the LoadMap collection's input.
    this.originalLoads = createOriginalLoadTracker(this.graph);
    this.identities = new WeakMap();
    this.nativeRecords = new WeakMap();
    this.linking = new Set();
    this.prepareQueue = Promise.resolve();
    this.bits = new DataView(new ArrayBuffer(4));
  }

  /** Fetch a dependency closure before any synchronous native load begins.
   * Serialize preparation requests so overlapping/cyclic closures cannot see
   * half-fetched tables. Native export creation remains lazy after fetching. */
  /** GConfig from the installed System/*.ini files, bound to the graph
   * before the first synchronous class load (UClass::Serialize reaches
   * LoadConfig). An install without .ini files yields an empty cache. */
  prepareConfig() {
    // Flush's writes go to the asset store's config store, where there is one: the player's kept files (docs/config-persistence.md).
    const store = this.assets?.configStore;
    return this.configReady ??= loadConfigCache(this.assets?.configFiles ?? [], { onWrite: store ? (name, text) => store.write(name, text) : null })
      .then(cache => { this.graph.setConfig(cache); return cache; });
  }

  prepare(asset) {
    const pending = this.prepareQueue.then(async () => {
      await this.prepareConfig();
      const visited = new Set();
      const queue = [asset];
      while (queue.length) {
        const current = queue.pop();
        const key = current.name.toLowerCase();
        if (visited.has(key)) continue;
        visited.add(key);
        this.graph.packageAssets.set(key, current);
        for (const name of current.pkg.dependencies) {
          if (!visited.has(name.toLowerCase())) queue.push(await this.assets.get(name));
        }
      }
    });
    this.prepareQueue = pending.catch(() => {});
    return pending;
  }

  /** Re-read the config properties of a linked class's VM defaults from its
   * native Defaults block after a LoadConfig reload (SaveConfig). */
  refreshConfigDefaults(cls) {
    const data = cls.loadRecord?.defaults?.data, {slotOf} = this.graph;
    if (!(data instanceof Map)) return;
    for (const field of cls.propertyLink ?? []) {
      const property = field.loadRecord;
      if (!property || !(slotOf(property, 0x3c) & 0x4000)) continue;
      const values = new Map();
      for (let index = 0; index < slotOf(property, 0x34); index += 1) {
        const offset = slotOf(property, 0x48) + slotOf(property, 0x38) * index;
        if (data.has(offset)) values.set(index, this.value(property, data.get(offset)));
      }
      if (values.size) cls.defaults.set(field.key, values);
    }
  }

  identity(record) {
    if (record == null) return null;
    if (this.identities.has(record)) return this.identities.get(record);
    const {slotOf, fullName} = this.graph;
    const linker = slotOf(record, 0x10);
    const index = slotOf(record, 0x14);
    let identity;
    if (linker?.asset && Number.isInteger(index) && index >= 0) {
      identity = this.objects.exportIdentity(linker.asset, index + 1);
    } else {
      const name = fullName(record);
      const resources = this.resources?.();
      if (!resources) throw new Error(`Native identity requires the canonical resource registry: ${name}`);
      if (this.graph.packageRoots.get(name.toLowerCase()) === record) {
        const asset = this.graph.packageAssets.get(name.toLowerCase());
        identity = resources.packageIdentity(asset);
      } else if (this.graph.staticRecords.get(name) === record) {
        identity = resources.nativeClass(name);
      } else throw new Error(`VM identity for unexported native object is unsupported: ${name}`);
    }
    if (identity.loadRecord && identity.loadRecord !== record)
      throw new Error(`Duplicate native backing record: ${identity.key}`);
    // Native-only resource class descriptors are immutable; the reverse map
    // binds their backing record without changing that public contract.
    if (Object.isExtensible(identity)) identity.loadRecord = record;
    this.identities.set(record, identity);
    this.nativeRecords.set(identity, record);
    return identity;
  }

  nativeIdentity(identity) {
    if (identity == null) return null;
    if (this.nativeRecords.has(identity)) return this.nativeRecords.get(identity);
    if (identity.loadRecord) return identity.loadRecord;
    if (!identity.asset || !this.graph.packageAssets.has(identity.asset.name.toLowerCase()))
      throw new Error('Class default reference requires an already prepared package');
    const record = this.graph.indexToObject(this.graph.buildLinker(identity.asset.name), identity.index);
    if (this.identity(record) !== identity) throw new Error('Noncanonical class default reference');
    return record;
  }

  async load(record) {
    await this.prepare(record.asset);
    const loaded = this.graph.loadExport(record.asset.name, record.index);
    if (this.identity(loaded) !== record) throw new Error('Class load changed canonical identity');
    if (this.graph.assertions.length) throw new Error('Native class loader reached an assertion boundary');
    const warning = this.graph.warnings.find(w => !['exists'].includes(w.kind));
    if (warning) throw new Error(`Native class loader warning: ${warning.kind}`);
    return loaded;
  }

  /** Convert a value, not its identity. Struct SerializeBin scalar words are
   * raw storage; the top-level defaults cells already coerce float words. */
  value(property, raw, {member = false, encode = false} = {}) {
    const {slotOf, propertyKindOf, nameText, intern, structFieldChain, fullName} = this.graph;
    switch (propertyKindOf(property)) {
      case 'BoolProperty':
        // SerializeBin's keyed member cells contain the serialized byte, not
        // the native packed DWORD. Core 10166575 tests that byte for nonzero;
        // encoding the VM's logical cell therefore emits canonical 0/1.
        if (member) return encode ? Number(Boolean(raw)) : raw !== 0;
        return Boolean((raw | 0) & slotOf(property, 0x5c));
      case 'IntProperty': return raw | 0;
      case 'ByteProperty': return Number(raw) & 255;
      case 'FloatProperty':
        if (!member) return Math.fround(raw);
        if (encode) { this.bits.setFloat32(0, raw, true); return this.bits.getUint32(0, true); }
        this.bits.setUint32(0, raw >>> 0, true); return this.bits.getFloat32(0, true);
      case 'NameProperty': return encode ? intern(raw) : nameText(raw);
      case 'ObjectProperty': case 'ClassProperty': return encode ? this.nativeIdentity(raw) : this.identity(raw);
      case 'StrProperty': return raw;
      case 'StructProperty': {
        const structure = slotOf(property, 0x5c);
        const fields = [...structFieldChain(structure)];
        const key = fullName(structure).toLowerCase();
        const vector = key === 'core.object.vector' || key === 'core.object.rotator';
        const result = !encode && vector ? [] : {};
        for (const [index, field] of fields.entries()) {
          const name = nameText(slotOf(field, 0x20));
          const canonical = this.identity(field);
          const inputKey = encode ? vector ? index : canonical.key : name;
          const outputKey = encode ? name : vector ? index : canonical.key;
          const dimension = slotOf(field, 0x34);
          if (dimension > 1) {
            if (!Array.isArray(raw[inputKey]) || raw[inputKey].length !== dimension)
              throw new Error(`Struct default ArrayDim storage is unresolved: ${canonical.key}`);
            result[outputKey] = raw[inputKey].map(v => this.value(field, v, {member: true, encode}));
          } else result[outputKey] = this.value(field, raw[inputKey], {member: true, encode});
        }
        return result;
      }
      default: throw new Error(`VM default storage is unsupported: ${fullName(property)}`);
    }
  }

  async linkClass(runtime, record) {
    this.linking.add(record.key);
    try { return await this.linkClassBody(runtime, record); }
    finally { this.linking.delete(record.key); }
  }
  async linkClassBody(runtime, record) {
    const loaded = await this.load(record);
    const {slotOf, superOf, nameText, propertyKindOf} = this.graph;
    const superIdentity = this.identity(superOf(loaded));
    const base = superIdentity ? await runtime.loadClass(superIdentity.asset, superIdentity.index) : null;
    // Preserve source metadata for bytecode/debug consumers. Runtime state and
    // default values below come from the serialized native records, not tags
    // decoded by readClass. This decoder is not a native loader substitute.
    const metadata = {...readClass(record.asset, record.index),
      classFlags: slotOf(loaded, 0x484), probeMask: slotOf(loaded, 0x6c),
      ignoreMask: slotOf(loaded, 0x74), stateFlags: slotOf(loaded, 0x7c),
      labelTableOffset: slotOf(loaded, 0x80), scriptSize: slotOf(loaded, 0x48)};
    const cls = {record, metadata, base, loadRecord: loaded, nameCounter: 0,
      fields: new Map(), methods: new Map(), states: new Map(), stateOrder: [],
      propertyOrder: [], defaults: new Map(), defaultsSource: 'original-linker-serialized'};
    for (let child = slotOf(loaded, 0x38); child; child = slotOf(child, 0x2c)) {
      const identity = this.identity(child);
      const kind = propertyKindOf(child), name = nameText(slotOf(child, 0x20)).toLowerCase();
      if (kind === 'Function') cls.methods.set(name, identity);
      else if (kind === 'State') {
        cls.states.set(name, identity);
        cls.stateOrder.push({record: identity, flags: slotOf(child, 0x7c)});
      } else if (kind?.endsWith('Property')) {
        await runtime.field(identity);
        // Logical VM bool cells deliberately do not receive a packed bitMask;
        // their native mask/offset remain on the backing loadRecord.
        Object.assign(identity.metadata, {arrayDim: slotOf(child, 0x34),
          elementSize: slotOf(child, 0x38), flags: slotOf(child, 0x3c)});
        cls.fields.set(name, identity);
        cls.propertyOrder.push(identity);
      }
    }
    cls.propertyLink = [...cls.propertyOrder, ...(base?.propertyLink ?? [])];
    cls.destructorLink = cls.propertyLink.filter(field => field.metadata.flags & 0x00400000);
    const data = loaded.defaults.data;
    for (const field of cls.propertyLink) {
      const property = field.loadRecord;
      if (!property) throw new Error(`Native default property is not loaded: ${field.key}`);
      const values = new Map();
      for (let index = 0; index < slotOf(property, 0x34); index += 1) {
        const offset = slotOf(property, 0x48) + slotOf(property, 0x38) * index;
        if (data.has(offset)) values.set(index, this.value(property, data.get(offset)));
      }
      if (values.size) cls.defaults.set(field.key, values);
    }
    // Class-valued defaults (class'WeaponAssaultGun' inside InitialInventory)
    // must carry linked ancestry before the VM can cast them. The original
    // linker loads referenced exports while serializing defaults; identity()
    // only mints the record, so link every Class record reachable here.
    const referenced = new Set();
    const collect = value => {
      if (value == null) return;
      if (value.kind === 'Class') { referenced.add(value); return; }
      if (Array.isArray(value)) { for (const member of value) collect(member); return; }
      if (typeof value === 'object' && !value.kind) for (const member of Object.values(value)) collect(member);
    };
    for (const values of cls.defaults.values()) for (const value of values.values()) collect(value);
    // A back-edge (A's defaults reference B, B's reference A) resolves the way
    // the original linker does: the export already on the load stack is
    // returned in progress instead of awaited into a circular dependency.
    for (const classRecord of referenced) {
      if (!this.linking.has(classRecord.key)) await runtime.loadClass(classRecord.asset, classRecord.index);
    }
    return cls;
  }

  /** Class-default writes must update the native prefix copied by a class
   * loaded later. Existing instances retain the VM's existing snapshots. */
  writeDefault(cls, field, values) {
    this.writeDefaultCells(cls.loadRecord.defaults.data, field.loadRecord, values);
  }

  /** The original process keeps a class and its Defaults for its whole life, so a default written in one level (a console SET:
   * UObject::GlobalSetProperty's ImportText into Class->Defaults, 0x101524b1..0x101524ca; a script's `Default.X = ...`) is the
   * default the next level's exports and spawns are built from. Play builds a runtime per level and serializes each class again;
   * the values the travel carried (docs/travel.md "Class defaults across a travel") are written here, into the Defaults block the
   * class's UClass::Serialize just built, before a subclass copies it (InitClassDefaultObject) or an object is constructed from it. */
  applyCarriedDefaults(record) {
    const {slotOf, superOf, nameText, propertyKindOf, fullName} = this.graph;
    const fields = this.carriedDefaults.get(fullName(record).toLowerCase());
    if (!fields) return;
    for (const [fieldKey, values] of fields) {
      const dot = fieldKey.lastIndexOf('.'), owner = fieldKey.slice(0, dot), name = fieldKey.slice(dot + 1);
      let property = null;
      for (let c = record; c && !property; c = superOf(c)) {
        if (fullName(c).toLowerCase() !== owner) continue;
        for (let child = slotOf(c, 0x38); child && !property; child = slotOf(child, 0x2c))
          if (propertyKindOf(child)?.endsWith('Property') && nameText(slotOf(child, 0x20)).toLowerCase() === name) property = child;
      }
      if (!property) throw new Error(`Carried class default ${fieldKey} is not a property of ${fullName(record)}`);
      this.writeDefaultCells(record.defaults.data, property, values);
    }
  }

  writeDefaultCells(data, property, values) {
    const {slotOf, propertyKindOf} = this.graph;
    for (const [index, value] of values) {
      const offset = slotOf(property, 0x48) + slotOf(property, 0x38) * index;
      if (propertyKindOf(property) === 'BoolProperty') {
        const mask = slotOf(property, 0x5c), word = data.get(offset) | 0;
        data.set(offset, ((word & ~mask) | (value ? mask : 0)) >>> 0);
      } else data.set(offset, this.value(property, value, {encode: true}));
    }
  }
}
