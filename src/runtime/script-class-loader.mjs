/** Original class loading with the VM's canonical identity/value representation.
 * See docs/script-load-graph.md for original authority and remaining services.
 */
import {readClass} from '../unreal/classes.mjs';
import {createScriptLoadGraph} from './script-load-graph.mjs';

export class ScriptClassLoader {
  constructor({assets, objects, resources, captureEvents = false, meshLoadServices = null}) {
    this.assets = assets;
    this.objects = objects;
    this.resources = resources;
    this.graph = createScriptLoadGraph({captureEvents, meshLoadServices});
    this.identities = new WeakMap();
    this.nativeRecords = new WeakMap();
    this.linking = new Set();
    this.prepareQueue = Promise.resolve();
    this.bits = new DataView(new ArrayBuffer(4));
  }

  /** Fetch a dependency closure before any synchronous native load begins.
   * Serialize preparation requests so overlapping/cyclic closures cannot see
   * half-fetched tables. Native export creation remains lazy after fetching. */
  prepare(asset) {
    const pending = this.prepareQueue.then(async () => {
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
        // SerializeBin bool loading is not established by the seven-class
        // references. Refuse that branch instead of guessing its packed form.
        if (member) throw new Error(`Struct bool default is not verified: ${fullName(property)}`);
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
    const {slotOf, propertyKindOf} = this.graph;
    const property = field.loadRecord;
    const data = cls.loadRecord.defaults.data;
    for (const [index, value] of values) {
      const offset = slotOf(property, 0x48) + slotOf(property, 0x38) * index;
      if (propertyKindOf(property) === 'BoolProperty') {
        const mask = slotOf(property, 0x5c), word = data.get(offset) | 0;
        data.set(offset, ((word & ~mask) | (value ? mask : 0)) >>> 0);
      } else data.set(offset, this.value(property, value, {encode: true}));
    }
  }
}
