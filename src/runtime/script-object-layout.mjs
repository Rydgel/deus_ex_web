/**
 * The linked property table of a loaded class (docs/object-memory.md, stage
 * 1c). Every value is read from the linker's own records after the recovered
 * UStruct::Link (docs/script-struct-link.md) and the property Link bodies
 * placed them:
 *
 *   UProperty +0x34 ArrayDim, +0x38 ElementSize, +0x3c PropertyFlags,
 *   +0x48 Offset, +0x5c BitMask (bool), Struct (struct) or Inner (array);
 *   UStruct +0x3c PropertiesSize.
 *
 * Nothing here derives an offset. The table is a view of the load graph that
 * the object image (script-object-image.mjs) and the layout validator
 * (scripts/validate-object-layout.mjs) share.
 */

const TYPES = Object.freeze({
  ByteProperty: 'byte', IntProperty: 'int', BoolProperty: 'bool', FloatProperty: 'float',
  NameProperty: 'name', StrProperty: 'string', ObjectProperty: 'object', ClassProperty: 'class',
  StructProperty: 'struct', ArrayProperty: 'array', MapProperty: 'map', FixedArrayProperty: 'fixedArray',
});

function propertyEntry(record, graph) {
  const {slotOf, propertyKindOf} = graph;
  const propertyKind = propertyKindOf(record);
  return {
    propertyKind, type: TYPES[propertyKind] ?? null,
    offset: slotOf(record, 0x48), elementSize: slotOf(record, 0x38), arrayDim: slotOf(record, 0x34),
    flags: slotOf(record, 0x3c) >>> 0,
    mask: propertyKind === 'BoolProperty' ? slotOf(record, 0x5c) >>> 0 : null,
  };
}

// A struct record belongs to one load graph; its layout is shared by every
// property of that struct.
const structLayouts = new WeakMap();

/** A linked UStruct's members, own then inherited (the iterator order of
 * UStruct::Link's chains), with offsets relative to the struct. */
export function linkedStructLayout(structure, {graph, identity}) {
  let layout = structLayouts.get(structure);
  if (layout) return layout;
  const members = [];
  for (const record of graph.structFieldChain(structure)) {
    const entry = propertyEntry(record, graph);
    const member = identity(record);
    members.push(Object.freeze({
      ...entry, record, key: member.key, name: graph.nameText(graph.slotOf(record, 0x20)),
      struct: entry.type === 'struct' ? linkedStructLayout(graph.slotOf(record, 0x5c), {graph, identity}) : null,
    }));
  }
  layout = Object.freeze({key: graph.fullName(structure).toLowerCase(), size: graph.slotOf(structure, 0x3c),
    members: Object.freeze(members), byKey: new Map(members.map(member => [member.key, member]))});
  structLayouts.set(structure, layout);
  return layout;
}

/** The class's PropertiesSize and one entry per linked property, own
 * properties first, then inherited (cls.propertyLink order). */
export function linkedClassLayout(cls, {graph, identity}) {
  const record = cls.loadRecord;
  if (!record) throw new Error(`Class has no linked load record: ${cls.record?.key ?? '<class>'}`);
  const properties = cls.propertyLink.map(field => {
    if (!field.loadRecord) throw new Error(`Linked property has no load record: ${field.key}`);
    const entry = propertyEntry(field.loadRecord, graph);
    return Object.freeze({
      ...entry, field, key: field.key, name: field.name,
      struct: entry.type === 'struct' ? linkedStructLayout(graph.slotOf(field.loadRecord, 0x5c), {graph, identity}) : null,
    });
  });
  return Object.freeze({key: cls.record.key, size: graph.slotOf(record, 0x3c),
    properties: Object.freeze(properties), byKey: new Map(properties.map(entry => [entry.key, entry]))});
}
