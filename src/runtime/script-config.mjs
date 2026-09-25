/**
 * UObject::LoadConfig (Core 0x10150d60, thunk 0x101023dd) and
 * UObject::SaveConfig (0x10151540, thunk 0x101031d4) over the load graph's
 * native records, with GConfig (config-cache.mjs) and the property text
 * bodies (config-text.mjs). docs/script-config.md.
 *
 * Native offsets: Object +0x04 Index, +0x18 Outer, +0x20 Name, +0x24 Class;
 * Class +0x28 Super, +0x38 Children, +0x484 ClassFlags, +0x4a0
 * ClassConfigName; Field +0x2c Next; Property +0x34 ArrayDim,
 * +0x38 ElementSize, +0x3c PropertyFlags, +0x48 Offset; Bool +0x5c BitMask;
 * Byte +0x5c Enum -> UEnum +0x34 Names.
 */
import { importText, exportText, UnsupportedConfigTextError } from './config-text.mjs';

export const CLASS_CONFIG = 0x4;
export const CLASS_PER_OBJECT_CONFIG = 0x400;
export const CPF_CONFIG = 0x4000;
export const CPF_GLOBAL_CONFIG = 0x40000;
const PARM_KINDS = { BoolProperty: 'bool', IntProperty: 'int', FloatProperty: 'float', ByteProperty: 'byte',
  NameProperty: 'name', StrProperty: 'string' };

export class UnsupportedScriptConfigError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedScriptConfigError'; }
}
const unsupported = message => { throw new UnsupportedScriptConfigError(message); };

/** TFieldIterator<UProperty>(Class): Children, then each super's Children. */
function* configProperties(graph, cls) {
  for (let struct = cls; struct; struct = graph.superOf(struct))
    for (let field = graph.slotOf(struct, 0x38); field; field = graph.slotOf(field, 0x2c))
      if (graph.propertyKindOf(field)?.endsWith('Property')) yield field;
}

/** UField::GetOwnerClass: the first Class up the Outer chain. */
function ownerClass(graph, property) {
  for (let outer = graph.slotOf(property, 0x18); outer; outer = graph.slotOf(outer, 0x18))
    if (graph.isA(outer, graph.classStatic)) return outer;
  return unsupported('Config property has no owner class');
}

function kindOf(graph, property) {
  const kind = graph.propertyKindOf(property);
  if (kind === 'ArrayProperty' || kind === 'MapProperty') return kind;
  return PARM_KINDS[kind] ?? kind;
}

function enumNames(graph, property) {
  if (graph.propertyKindOf(property) !== 'ByteProperty') return null;
  const enumeration = graph.slotOf(property, 0x5c);
  if (!enumeration) return null;
  return graph.slotOf(enumeration, 0x34).data.map(name => graph.nameText(name));
}

/**
 * Section and file for one property of `self` (docs/script-config.md):
 * per-object config uses the object name and, with no filename, the Outer
 * name unless the Outer is the transient package; otherwise the section is
 * the owner class (globalconfig) or `sectionClass` path, and the file is
 * `self`'s class ClassConfigName.
 */
function configTarget(graph, self, property, sectionClass, filename) {
  const perObject = Boolean(graph.slotOf(self.cls, 0x484) & CLASS_PER_OBJECT_CONFIG) && self.index !== -1;
  if (perObject) unsupported('Per-object config (CLASS_PerObjectConfig) is not linked');
  const file = filename ?? graph.nameText(graph.slotOf(self.cls, 0x4a0));
  const owner = graph.slotOf(property, 0x3c) & CPF_GLOBAL_CONFIG ? ownerClass(graph, property) : sectionClass;
  return { section: graph.fullName(owner), file };
}

function elementKey(graph, property, index) {
  const name = graph.nameText(graph.slotOf(property, 0x20));
  return graph.slotOf(property, 0x34) === 1 ? name : `${name}[${index}]`;
}

/**
 * LoadConfig(Propagate, Class, Filename) into `self`: `{cls, index, read,
 * write}`, where read/write take (property, arrayIndex) and native values.
 */
export function loadConfig(graph, config, self, { propagate = 0, cls = null, filename = null } = {}) {
  cls ??= self.cls;
  if (!(graph.slotOf(cls, 0x484) & CLASS_CONFIG)) return;
  const superClass = graph.superOf(cls);
  if (propagate && superClass) loadConfig(graph, config, self, { propagate, cls: superClass, filename });
  for (const property of configProperties(graph, cls)) {
    if (!(graph.slotOf(property, 0x3c) & CPF_CONFIG)) continue;
    const { section, file } = configTarget(graph, self, property, cls, filename);
    const kind = kindOf(graph, property);
    if (kind === 'ArrayProperty' || kind === 'MapProperty') {
      // GetSectionPrivate(Section, 0, 1): an existing section empties and
      // refills the dynamic array (map) from every value under the key.
      if (config.getSectionPrivate(section, false, true, file))
        unsupported(`Config ${kind} loading is not linked: ${graph.fullName(property)}`);
      continue;
    }
    for (let index = 0; index < graph.slotOf(property, 0x34); index++) {
      const text = config.getString(section, elementKey(graph, property, index), file, 0x400);
      if (text === null) continue;
      let imported;
      try { imported = importText(kind, text, { enumNames: enumNames(graph, property) }); }
      catch (error) {
        if (error instanceof UnsupportedConfigTextError) unsupported(`${error.message}: ${graph.fullName(property)}`);
        throw error;
      }
      if (imported && imported.value !== undefined) self.write(property, index, kind, imported.value);
    }
  }
}

/** The topmost ancestor still carrying CLASS_Config (SaveConfig's reload
 * root, 0x1015193f-0x1015195b). */
export function configRoot(graph, cls) {
  let root = cls;
  for (let base = graph.superOf(root); base && graph.slotOf(base, 0x484) & CLASS_CONFIG; base = graph.superOf(base)) root = base;
  return root;
}

/**
 * SaveConfig(Flags, Filename) of `self`: `{cls, index, read}` with VM-side
 * values. Every matching property of the class is exported through
 * ExportText into GConfig->SetString, then GConfig->Flush(0). The caller
 * then reloads (LoadConfig(1)) the defaults of every loaded class under
 * configRoot, as the original's GObjObjects walk does.
 */
export function saveConfig(graph, config, self, { flags = CPF_CONFIG, filename = null } = {}) {
  for (const property of configProperties(graph, self.cls)) {
    if ((graph.slotOf(property, 0x3c) & flags) !== flags) continue;
    const { section, file } = configTarget(graph, self, property, self.cls, filename);
    const kind = kindOf(graph, property);
    if (kind === 'ArrayProperty' || kind === 'MapProperty')
      unsupported(`Config ${kind} saving is not linked: ${graph.fullName(property)}`);
    for (let index = 0; index < graph.slotOf(property, 0x34); index++) {
      let text;
      try { text = exportText(kind, self.read(property, index, kind), { enumNames: enumNames(graph, property) }); }
      catch (error) {
        if (error instanceof UnsupportedConfigTextError) unsupported(`${error.message}: ${graph.fullName(property)}`);
        throw error;
      }
      config.setString(section, elementKey(graph, property, index), text, file);
    }
  }
  config.flush(false, null);
}

/** Native-data access for a class default object (the class's Defaults
 * block): offsets are relative to the object, bool bits share a word. */
export function defaultsObject(graph, cls, data) {
  const offset = (property, index) => graph.slotOf(property, 0x48) + graph.slotOf(property, 0x38) * index;
  return {
    cls, index: -1,
    write(property, index, kind, value) {
      const at = offset(property, index);
      switch (kind) {
        case 'bool': {
          const mask = graph.slotOf(property, 0x5c) >>> 0, word = (data.get(at) ?? 0) >>> 0;
          data.set(at, (value ? word | mask : word & ~mask) >>> 0);
          return;
        }
        case 'int': data.set(at, value | 0); return;
        case 'byte': data.set(at, value & 255); return;
        case 'float': data.set(at, Math.fround(value)); return;
        case 'name': data.set(at, graph.intern(value)); return;
        case 'string': data.set(at, String(value)); return;
        default: unsupported(`Config default storage is not linked for ${kind}`);
      }
    },
  };
}
