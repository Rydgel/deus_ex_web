/** ExportTravel (Engine.dll 0x10391740, UnGame.cpp): the text of the player and everything its `travel` properties reach.
 * docs/travel.md "ExportTravel: the travel text" is the evidence (the native body and measured texts).
 *
 * A worklist starts with the root (the player). For each object in worklist order:
 *   - an Actor is skipped unless its `bTravel` bit is set; an object that is not an Actor is exported;
 *   - `Class=<class path> Name=<object name> Ptr=<%08x>`, `{`;
 *   - for every property of the class chain (the most derived class first, then each superclass; declaration order inside a
 *     class) that has CPF_Travel (0x10000), for each array element: UProperty::ExportText(Index, Buffer, Object, ClassDefaults,
 *     0). ExportText returns nothing for an element that matches the class default (`UProperty::Matches`), so a default is not
 *     written (a fresh player writes no Health or Credits);
 *   - an object property is `Name=<pointer %08x> <object name>` (`None` for null), and its target joins the worklist;
 *   - any other property is `Name[i]=<ExportTextItem>`, a newline in the text replaced by `\`;
 *   - `}`.
 *
 * The property enumeration is the retail class metadata (the load graph's native Class/Property records), not a list. The
 * value formats are the ones whose Core bodies config-text.mjs holds (bool, int, float, byte and enum, name, string) and the
 * struct form `(Member=value,...)` whose members differ from the default's. Every other property kind is an explicit stop
 * ({@link UnsupportedTravelPropertyError}): it names the class, the property and the kind.
 *
 * Play's FlagBase is a host store (script-triggers.mjs createFlagBase) rather than a script object graph, so its flags are
 * exported as the `FlagBase` and `Flag*` objects the original holds: the same retail properties (hashTable, defaultFlagExpiration,
 * flagName, flagHash, flagBase, nextFlag, flagType, expiration, and the value) read from the store, so the generic path above
 * formats them. The hash table is the native's: 64 buckets by the FName CRC & 63, each chain ascending by the signed hash.
 *
 * Unverified assumption: `UStructProperty::ExportTextItem` writes every member that differs from the default's (Port() was not
 * read in Core.dll); measured only for `AugLocs[6]=(AugCount=3)`. A property is written with the spelling of its name in the
 * package's name table (the compiler keeps the first spelling of a name, so `flagName` is `FlagName`, as the measured texts show). */
import { exportText } from './config-text.mjs';
import { hashScriptName } from './script-names.mjs';

export const CPF_TRAVEL = 0x10000;
const lower = value => String(value ?? '').toLowerCase();

export class UnsupportedTravelPropertyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UnsupportedTravelPropertyError';
    Object.assign(this, details);
  }
}

const FLAG_CLASSES = ['FlagBool', 'FlagByte', 'FlagInt', 'FlagFloat', 'FlagName', 'FlagVector', 'FlagRotator'];
const FLAG_VALUE_PROPERTY = { FlagBool: 'bValue', FlagByte: 'byteValue', FlagInt: 'intValue', FlagFloat: 'floatValue', FlagName: 'nameValue',
  FlagVector: 'vectorValue', FlagRotator: 'rotatorValue' };

/** Whether `value` is Play's host FlagBase (script-triggers.mjs createFlagBase). */
export const isHostFlagBase = value => Boolean(value) && value.entries instanceof Map && typeof value.getBool === 'function' && typeof value.setBool === 'function';

/** The Extension classes the host FlagBase is exported as; loaded once (async) so the export itself is synchronous. */
export async function loadFlagClasses(runtime, assets) {
  const extension = await assets.get('Extension');
  const load = async name => runtime.loadClass(extension, extension.exportsByPath.get(lower(name)));
  const classes = { FlagBase: await load('FlagBase') };
  for (const name of FLAG_CLASSES) classes[name] = await load(name);
  return classes;
}

/**
 * @param runtime       the ScriptRuntime
 * @param flagClasses   loadFlagClasses()'s result
 */
export function createTravelExporter({ runtime, flagClasses }) {
  const graph = runtime.classLoader.graph;
  const enumNamesOf = property => {
    if (graph.propertyKindOf(property) !== 'ByteProperty') return null;
    const enumeration = graph.slotOf(property, 0x5c);
    return enumeration ? graph.slotOf(enumeration, 0x34).data.map(name => graph.nameText(name)) : null;
  };
  const propertyName = property => graph.nameText(graph.slotOf(property, 0x20));
  /** The class chain's properties in export order: [{property, name, kind, dim, flags, owner}]. */
  const propertyCache = new Map();
  function propertiesOf(cls, travelOnly) {
    const key = `${cls.record.key}\u0000${travelOnly}`;
    let list = propertyCache.get(key);
    if (list) return list;
    list = [];
    for (let struct = cls.loadRecord; struct; struct = graph.superOf(struct))
      for (let field = graph.slotOf(struct, 0x38); field; field = graph.slotOf(field, 0x2c)) {
        const kind = graph.propertyKindOf(field);
        if (!kind?.endsWith('Property')) continue;
        const flags = graph.slotOf(field, 0x3c) >>> 0;
        if (travelOnly && !(flags & CPF_TRAVEL)) continue;
        list.push({ property: field, name: propertyName(field), kind, dim: graph.slotOf(field, 0x34), flags, owner: struct });
      }
    propertyCache.set(key, list);
    return list;
  }
  const classPath = cls => graph.fullName(cls.loadRecord);

  /** Matches(): whether an element equals the default's, per property kind. */
  function same(kind, a, b) {
    switch (kind) {
      case 'FloatProperty': return Number(a) === Number(b);
      case 'BoolProperty': return Boolean(a) === Boolean(b);
      case 'NameProperty': return lower(a ?? 'None') === lower(b ?? 'None');
      case 'StrProperty': return String(a ?? '') === String(b ?? '');
      case 'IntProperty': case 'ByteProperty': return (Number(a) | 0) === (Number(b) | 0);
      case 'ObjectProperty': return a === b || ((a ?? null) === null && (b ?? null) === null);
      default: return undefined;
    }
  }
  const unsupported = (node, entry, why) => new UnsupportedTravelPropertyError(
    `ExportTravel: ${classPath(node.cls)}.${entry.name} (${entry.kind.replace('Property', '')}) ${why}`, { class: classPath(node.cls), property: entry.name, kind: entry.kind });

  /** ExportTextItem of a struct (delimited members that differ), or null when it equals the default. */
  function exportStruct(node, entry, struct, value, defaultValue, structFields) {
    const parts = [];
    const members = [];
    for (let field = graph.slotOf(struct, 0x38); field; field = graph.slotOf(field, 0x2c))
      if (graph.propertyKindOf(field)?.endsWith('Property')) members.push(field);
    for (const member of members) {
      const kind = graph.propertyKindOf(member), name = propertyName(member), dim = graph.slotOf(member, 0x34);
      const runtimeMember = structFields.find(field => lower(field.name) === lower(name));
      if (!runtimeMember) throw unsupported(node, entry, `has a struct member ${name} the runtime does not link`);
      if (dim !== 1 || !['IntProperty', 'ByteProperty', 'FloatProperty', 'BoolProperty', 'NameProperty'].includes(kind))
        throw unsupported(node, entry, `has a struct member ${name} of kind ${kind.replace('Property', '')}[${dim}]`);
      const a = value[runtimeMember.key], b = defaultValue[runtimeMember.key];
      if (same(kind, a, b)) continue;
      parts.push(`${name}=${exportText({ IntProperty: 'int', ByteProperty: 'byte', FloatProperty: 'float', BoolProperty: 'bool', NameProperty: 'name' }[kind], a, { enumNames: enumNamesOf(member) })}`);
    }
    return parts.length ? `(${parts.join(',')})` : null;
  }

  /** Build the exporter's view of a runtime object. */
  function objectNode(object) {
    const instance = runtime.attachedInstance(object);
    if (!instance) throw new UnsupportedTravelPropertyError(`ExportTravel: a travel property reaches ${object?.name ?? object?.key ?? typeof object}, which is not a script object`);
    const cls = instance.cls;
    return { isNode: true, object, cls, className: classPath(cls), name: object.name, actor: isActorClass(cls),
      read: (name) => runtime.readNamed(object, name),
      field: name => runtime.namedField(object, name),
      defaults: (field) => runtime.defaultValue(cls, field) };
  }
  const isActorClass = cls => { for (let c = cls; c; c = c.base) if (c.record.key === 'engine.actor') return true; return false; };

  /** The host FlagBase as FlagBase / Flag* nodes (the store's chains), keyed by the store and by 'type:name'. */
  function flagNodes(store, counters) {
    const base = { isNode: true, object: store, cls: flagClasses.FlagBase, className: classPath(flagClasses.FlagBase), name: `FlagBase${counters.next('FlagBase')}`, actor: false };
    const buckets = Array.from({ length: 64 }, () => []);
    for (const [key, entry] of store.entries) buckets[hashScriptName(lower(entry.name)) & 63].push({ key, entry });
    const flagNodeOf = new Map();
    const hash = item => hashScriptName(lower(item.entry.name)) | 0;
    for (const chain of buckets) {
      chain.sort((a, b) => hash(a) - hash(b));   // a stable sort: a flag added later follows an equal hash (createFlagBase chainOf)
      for (const item of chain) {
        const cls = flagClasses[FLAG_CLASSES[item.entry.type]];
        if (!cls) throw new UnsupportedTravelPropertyError(`ExportTravel: flag ${item.entry.name} has the unsupported type ${item.entry.type}`);
        flagNodeOf.set(item.key, { isNode: true, object: item, cls, className: classPath(cls), name: `${FLAG_CLASSES[item.entry.type]}${counters.next(FLAG_CLASSES[item.entry.type])}`, actor: false, chain, item });
      }
    }
    const flagOf = item => item ? flagNodeOf.get(item.key) : null;
    base.read = (name, index) => {
      if (lower(name) === 'hashtable') return flagOf(buckets[index]?.[0]) ?? null;
      if (lower(name) === 'defaultflagexpiration') return store.defaultExpiration | 0;
      throw new UnsupportedTravelPropertyError(`ExportTravel: FlagBase.${name} is not modelled`);
    };
    base.indexed = name => lower(name) === 'hashtable';
    base.field = () => null;
    for (const node of flagNodeOf.values()) {
      const type = node.item.entry.type, valueName = lower(FLAG_VALUE_PROPERTY[FLAG_CLASSES[type]]);
      node.read = name => {
        const key = lower(name), entry = node.item.entry;
        if (key === valueName) return entry.value;
        switch (key) {
          case 'flagname': return entry.name;
          case 'flaghash': return hashScriptName(lower(entry.name)) | 0;
          case 'flagbase': return base;
          case 'nextflag': return flagOf(node.chain[node.chain.indexOf(node.item) + 1]);
          case 'flagtype': return type;
          case 'expiration': return entry.expiration | 0;
          default: throw new UnsupportedTravelPropertyError(`ExportTravel: ${node.className}.${name} is not modelled`);
        }
      };
      node.field = () => null;
    }
    return base;
  }

  /**
   * ExportTravel(root): `{records}` in worklist order, in travel-text.mjs's record shape (`formatTravelText` writes the text). The root is
   * the Viewport's actor.
   */
  function exportTravel(root) {
    const counters = { counts: new Map(), next(kind) { const n = this.counts.get(kind) ?? 0; this.counts.set(kind, n + 1); return n; } };
    const nodeOf = new Map(), worklist = [];
    let pointers = 0;
    const pointer = node => (node.ptr ??= (0x01000000 + 0x200 * ++pointers).toString(16).padStart(8, '0'));
    // A value reaches the worklist when a property points at it (ExportTravel appends a target not yet on it). The host FlagBase
    // and its flags are nodes of their own; a flag is queued when hashTable or nextFlag reaches it.
    const reach = value => {
      if (value === null || value === undefined) return null;
      let node = value.isNode ? value : nodeOf.get(value);
      if (!node) {
        if (isHostFlagBase(value)) node = flagNodes(value, counters);
        else node = objectNode(value);
        nodeOf.set(value, node);
      }
      if (!node.queued) { node.queued = true; worklist.push(node); }
      return node;
    };
    reach(root);
    const records = [];
    for (let at = 0; at < worklist.length; at++) {
      const node = worklist[at];
      if (node.actor && !node.read('bTravel')) continue;
      const lines = [];
      for (const entry of propertiesOf(node.cls, true)) {
        for (let index = 0; index < entry.dim; index++) {
          const line = exportElement(node, entry, index, reach, pointer);
          if (line !== null) lines.push(line);
        }
      }
      records.push({ class: node.className, name: node.name, ptr: pointer(node), lines });
    }
    return { records };
  }

  function exportElement(node, entry, index, reach, pointer) {
    const label = `${entry.name}${entry.dim > 1 ? `[${index}]` : ''}`;
    // The value and its class default for this element
    let value, defaultValue;
    if (node.indexed?.(entry.name)) { value = node.read(entry.name, index); defaultValue = null; }
    else {
      const whole = node.read(entry.name, index);
      value = entry.dim > 1 ? whole[index] : whole;
      const field = node.field(entry.name);
      if (field) { const d = node.defaults(field); defaultValue = entry.dim > 1 ? d?.[index] : d; }
      else defaultValue = { ObjectProperty: null, BoolProperty: false, StrProperty: '', NameProperty: 'None' }[entry.kind] ?? 0;
    }
    switch (entry.kind) {
      case 'ObjectProperty': {
        if ((value ?? null) === null) return null;
        if (value === defaultValue) return null;
        const target = reach(value);
        return `${label}=${pointer(target)} ${target.name}`;
      }
      case 'BoolProperty': case 'IntProperty': case 'ByteProperty': case 'FloatProperty': case 'NameProperty': case 'StrProperty': {
        if (same(entry.kind, value, defaultValue)) return null;
        const text = exportText({ BoolProperty: 'bool', IntProperty: 'int', ByteProperty: 'byte', FloatProperty: 'float', NameProperty: 'name', StrProperty: 'string' }[entry.kind],
          value, { enumNames: enumNamesOf(entry.property) });
        // ExportTravel replaces every newline of a value with `\` so the value stays on one line (measured on the real notes of Save0001: a datacube's
        // "code:    \n0012  \n..." is written `code:    \0012  \...`, docs/travel.md "Play, step 4"). A carriage return was not seen in any text: stop by name.
        if (/\r/.test(text)) throw unsupported(node, entry, 'holds a carriage return, whose encoding is not exercised');
        return `${label}=${text.replaceAll('\n', '\\')}`;
      }
      case 'StructProperty': {
        const struct = graph.slotOf(entry.property, 0x5c);
        const field = node.field(entry.name);
        if (!field?.metadata.structFields) throw unsupported(node, entry, 'is a struct the runtime does not link');
        const text = exportStruct(node, entry, struct, value, defaultValue ?? {}, field.metadata.structFields);
        return text === null ? null : `${label}=${text}`;
      }
      default:
        throw unsupported(node, entry, 'is not a property kind whose travel text was measured');
    }
  }

  return { exportTravel, propertiesOf, enumNamesOf, classPath, graph };
}
