/**
 * Byte images for script-owned properties (docs/object-memory.md, stage 1d).
 *
 * An attached object keeps its properties at their linked offsets
 * (script-object-layout.mjs) in one little-endian byte image of the class's
 * PropertiesSize. Bytes, ints, floats and packed bools are stored there, so f32
 * rounding, byte truncation and shared bool dwords follow from the storage.
 * FName, FString, object and class pointers and dynamic arrays have no
 * recovered byte form in the VM yet (docs/object-memory.md, Unresolved). Each
 * of those values sits in a per-object reference array instead, and its bytes
 * in the image stay zero.
 *
 * A cell reads and writes one property's logical VM value, the same value
 * script-values.mjs copies: a cell read equals `propertyCodec(field).read` of
 * the stored logical value, and a write takes a value that has already been
 * copied through that property's codec.
 */
import {linkedClassLayout} from './script-object-layout.mjs';

const BYTE = 1, INT = 2, BOOL = 3, FLOAT = 4, REF = 5, ARRAY = 6, VECTOR = 7, ROTATOR = 8, STRUCT = 9, FIXED = 10;
const REF_TYPES = new Set(['name', 'string', 'object', 'class']);

// One shape for every cell, so the reads and writes below see a single hidden
// class. `ref` and `refCount` index the reference array; `members` (struct) and
// `element`/`dim`/`stride` (fixed array) hold the parts of composite values.
class Cell {
  constructor(tag, offset, refCount, {mask = 0, members = null, element = null, dim = 0, stride = 0} = {}) {
    this.tag = tag; this.offset = offset; this.mask = mask; this.ref = 0; this.refCount = refCount;
    this.key = null; this.members = members; this.element = element; this.dim = dim; this.stride = stride;
  }
}

/** The cell of one linked property, or null when the VM value has no image
 * representation here (its accesses keep the logical slot storage). `entry`
 * is a linked layout entry; `metadata` is the VM's property metadata. */
function cellFor(entry, metadata, offset) {
  if (!metadata || entry.type !== metadata.type || (entry.arrayDim ?? 1) !== (metadata.arrayDim ?? 1)) return null;
  if (entry.arrayDim > 1) {
    const element = elementCell(entry, metadata, 0);
    return element && new Cell(FIXED, offset, element.refCount * entry.arrayDim,
      {dim: entry.arrayDim, stride: entry.elementSize, element});
  }
  return elementCell(entry, metadata, offset);
}

function elementCell(entry, metadata, offset) {
  switch (entry.type) {
    case 'byte': return new Cell(BYTE, offset, 0);
    case 'int': return new Cell(INT, offset, 0);
    case 'float': return new Cell(FLOAT, offset, 0);
    // A VM bool that carries its own packed mask stores the raw word; only the
    // logical bool cells the class loader links are imaged.
    case 'bool': return metadata.bitMask == null && entry.mask ? new Cell(BOOL, offset, 0, {mask: entry.mask | 0}) : null;
    case 'array': {
      const inner = metadata.innerMetadata;
      return inner && (inner.type === 'int' && !(inner.flags & 0x400000) || inner.type === 'string')
        ? new Cell(ARRAY, offset, 1) : null;
    }
    case 'struct': return structCell(entry, metadata, offset);
    default: return REF_TYPES.has(entry.type) ? new Cell(REF, offset, 1) : null;
  }
}

function structCell(entry, metadata, offset) {
  const layout = entry.struct, key = String(metadata.structKey ?? '').toLowerCase();
  if (!layout || layout.key !== key) return null;
  if (key === 'core.object.vector' || key === 'core.object.rotator') {
    const type = key === 'core.object.vector' ? 'float' : 'int';
    const names = key === 'core.object.vector' ? ['x', 'y', 'z'] : ['pitch', 'yaw', 'roll'];
    const members = layout.members;
    if (members.length !== 3 || members.some((member, index) => member.type !== type ||
      member.offset !== index * 4 || member.arrayDim !== 1 || member.name.toLowerCase() !== names[index])) return null;
    return new Cell(key === 'core.object.vector' ? VECTOR : ROTATOR, offset, 0);
  }
  if (!Array.isArray(metadata.structFields)) return null;
  // The VM's struct value is keyed by linked member identity, in structFields
  // order; each member reads from its linked offset inside the struct.
  const members = [];
  let refCount = 0;
  for (const member of metadata.structFields) {
    const memberMetadata = member?.metadata ?? member;
    const linked = layout.byKey.get(member?.key);
    if (!linked) return null;
    const cell = cellFor(linked, memberMetadata, linked.offset);
    if (!cell) return null;
    cell.key = member.key;
    cell.ref = refCount;
    refCount += cell.refCount;
    members.push(cell);
  }
  return new Cell(STRUCT, offset, refCount, {members});
}

// Cells per linked class: one per property with an image representation,
// keyed by field key, and the class's reference-array length.
const classCells = new WeakMap();

/** The image cells of a class linked by the native class loader. */
export function objectImageCells(cls, {graph, identity}) {
  let result = classCells.get(cls);
  if (result) return result;
  const layout = linkedClassLayout(cls, {graph, identity});
  const cells = new Map();
  let refCount = 0;
  for (const entry of layout.properties) {
    const cell = cellFor(entry, entry.field.metadata, entry.offset);
    if (!cell) continue;
    cell.ref = refCount;
    refCount += cell.refCount;
    cells.set(entry.key, cell);
  }
  result = Object.freeze({size: layout.size, refCount, cells, fields: new Map(layout.properties.map(entry => [entry.key, entry.field]))});
  classCells.set(cls, result);
  return result;
}

/** A zeroed image of `size` bytes. */
export const createImage = size => new DataView(new ArrayBuffer(size));
/** A copy of an image's bytes (InitProperties' default copy). */
export const copyImage = image => new DataView(image.buffer.slice(0));

/** The logical value of a cell in an image at byte offset `at`, reference
 * index `refAt` (a containing struct or array element). Scalars are handled
 * here, in a body small enough to inline into the property access path. */
export function readCell(cell, image, refs, at = 0, refAt = 0) {
  switch (cell.tag) {
    case BYTE: return image.getUint8(at + cell.offset);
    case INT: return image.getInt32(at + cell.offset, true);
    case BOOL: return (image.getUint32(at + cell.offset, true) & cell.mask) !== 0;
    case FLOAT: return image.getFloat32(at + cell.offset, true);
    case REF: return refs[refAt + cell.ref];
    default: return readComposite(cell, image, refs, at + cell.offset, refAt);
  }
}

function readComposite(cell, image, refs, offset, refAt) {
  switch (cell.tag) {
    case ARRAY: return refs[refAt + cell.ref].slice();
    case VECTOR: return [image.getFloat32(offset, true), image.getFloat32(offset + 4, true), image.getFloat32(offset + 8, true)];
    case ROTATOR: return [image.getInt32(offset, true), image.getInt32(offset + 4, true), image.getInt32(offset + 8, true)];
    case STRUCT: {
      const value = {}, base = refAt + cell.ref;
      for (const member of cell.members) value[member.key] = readCell(member, image, refs, offset, base);
      return value;
    }
    case FIXED: {
      const value = new Array(cell.dim), element = cell.element;
      for (let index = 0; index < cell.dim; index++)
        value[index] = readCell(element, image, refs, offset + index * cell.stride, refAt + cell.ref + index * element.refCount);
      return value;
    }
    default: throw new Error(`Unknown object image cell ${cell.tag}`);
  }
}

/** Store a logical value already copied through the property's codec. */
export function writeCell(cell, image, refs, value, at = 0, refAt = 0) {
  switch (cell.tag) {
    case BYTE: image.setUint8(at + cell.offset, value); return;
    case INT: image.setInt32(at + cell.offset, value, true); return;
    case BOOL: {
      const offset = at + cell.offset, word = image.getUint32(offset, true);
      image.setUint32(offset, value ? word | cell.mask : word & ~cell.mask, true);
      return;
    }
    case FLOAT: image.setFloat32(at + cell.offset, value, true); return;
    case REF: refs[refAt + cell.ref] = value; return;
    default: writeComposite(cell, image, refs, value, at + cell.offset, refAt);
  }
}

function writeComposite(cell, image, refs, value, offset, refAt) {
  switch (cell.tag) {
    case ARRAY: refs[refAt + cell.ref] = value; return;
    case VECTOR:
      image.setFloat32(offset, value[0], true); image.setFloat32(offset + 4, value[1], true);
      image.setFloat32(offset + 8, value[2], true);
      return;
    case ROTATOR:
      image.setInt32(offset, value[0], true); image.setInt32(offset + 4, value[1], true);
      image.setInt32(offset + 8, value[2], true);
      return;
    case STRUCT: {
      const base = refAt + cell.ref;
      for (const member of cell.members) writeCell(member, image, refs, value[member.key], offset, base);
      return;
    }
    case FIXED: {
      const element = cell.element;
      for (let index = 0; index < cell.dim; index++)
        writeCell(element, image, refs, value[index], offset + index * cell.stride, refAt + cell.ref + index * element.refCount);
      return;
    }
    default: throw new Error(`Unknown object image cell ${cell.tag}`);
  }
}
