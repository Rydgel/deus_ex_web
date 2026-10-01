/**
 * Byte images for script-owned properties (docs/object-memory.md, stage 1d).
 *
 * An attached object keeps its properties at their linked offsets
 * (script-object-layout.mjs) in one little-endian byte image of the class's
 * PropertiesSize. Bytes, ints, floats and packed bools are stored there, so f32
 * rounding, byte truncation and shared bool dwords follow from the storage.
 * An object or class pointer's four bytes hold the identity's handle
 * (script-object-handles.mjs), and those bytes are its only storage (R1a-2):
 * a read resolves the handle, a write stores it. FName, FString and dynamic
 * arrays have no recovered byte form in the VM yet (docs/object-memory.md,
 * Unresolved). Each of those values sits in a per-object reference array
 * instead. A string's or array's bytes stay zero; a name's four bytes hold
 * the host id of its value (script-name-ids.mjs `nameCellWord`, 0 for None),
 * written with the reference, so the Rust core can compare names in memory
 * (docs/rust-core.md R3-c). The reference stays the value JavaScript reads.
 *
 * A cell reads and writes one property's logical VM value, the same value
 * script-values.mjs copies: a cell read equals `propertyCodec(field).read` of
 * the stored logical value, and a write takes a value that has already been
 * copied through that property's codec.
 */
import {linkedClassLayout, linkedFunctionLayout} from './script-object-layout.mjs';
import {noteBaseChange} from './base-epoch.mjs';
import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {nameCellWord} from './script-name-ids.mjs';

const BYTE = 1, INT = 2, BOOL = 3, FLOAT = 4, REF = 5, ARRAY = 6, VECTOR = 7, ROTATOR = 8, STRUCT = 9, FIXED = 10, POINTER = 11,
  NAME = 12;

// One shape for every cell, so the reads and writes below see a single hidden
// class. `ref` and `refCount` index the reference array (a pointer cell uses
// none); `members` (struct) and `element`/`dim`/`stride` (fixed array) hold the
// parts of composite values.
class Cell {
  constructor(tag, offset, refCount, {mask = 0, members = null, element = null, dim = 0, stride = 0} = {}) {
    this.tag = tag; this.offset = offset; this.mask = mask; this.ref = 0; this.refCount = refCount;
    this.key = null; this.members = members; this.element = element; this.dim = dim; this.stride = stride;
    // Actor.Base: writes advance the rider-scan epoch (base-epoch.mjs).
    this.actorBase = false;
    // An object or class pointer (a POINTER cell): its bytes hold the
    // identity's handle (R1a), its only storage (R1a-2).
    this.handle = false;
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
    case 'object': case 'class': {
      const cell = new Cell(POINTER, offset, 0);
      cell.handle = true;
      return cell;
    }
    // A name keeps its value in the reference array and its id in its bytes.
    case 'name': return new Cell(NAME, offset, 1);
    case 'string': return new Cell(REF, offset, 1);
    default: return null;
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
  result = layoutCells(linkedClassLayout(cls, {graph, identity}));
  classCells.set(cls, result);
  for (const [key, cell] of result.cells) registerFieldCell(key, cell);
  return result;
}

// A property's cell is the same in every class that has it: the declaring
// class links its offset, subclasses append after it. The Rust interpreter
// (script-vm-lower.mjs) addresses an instance field by key through this
// registry; a key whose cells ever disagree is left to JavaScript.
const fieldCells = new Map();
let fieldCellVersion = 0;
// Called after each registry change (the Rust interpreter's event cache).
const fieldCellListeners = [];
export const onFieldImageCellVersion = listener => { fieldCellListeners.push(listener); };
function registerFieldCell(key, cell) {
  const known = fieldCells.get(key);
  if (known === undefined) {
    fieldCells.set(key, cell);
    fieldCellVersion++;
  } else if (known !== null && (known.tag !== cell.tag || known.offset !== cell.offset || known.mask !== cell.mask ||
    known.handle !== cell.handle)) {
    fieldCells.set(key, null);
    fieldCellVersion++;
  } else return;
  for (const listener of fieldCellListeners) listener();
}
/** The image cell every class with the property `key` uses, or null. */
export const fieldImageCell = key => fieldCells.get(key) ?? null;
/** Changes whenever the registry gains or loses a key. */
export const fieldImageCellVersion = () => fieldCellVersion;

// A vector's or rotator's members by name, at 4-byte steps (structCell
// checks the linked layout).
const COMPONENTS = {[VECTOR]: ['core.object.vector', 'float', ['X', 'Y', 'Z']],
  [ROTATOR]: ['core.object.rotator', 'int', ['Pitch', 'Yaw', 'Roll']]};
/** The scalar member `member` (a linked struct member field) of a struct
 * cell, as scalarCell describes it with the offset from the cell's image:
 * the member runtime.structValue reads. Null for any other member. */
export function structMemberCell(cell, member) {
  if (!cell || !member?.key) return null;
  const component = COMPONENTS[cell.tag];
  if (component) {
    const [structKey, kind, names] = component, index = names.indexOf(member.name);
    if (member.key.slice(0, member.key.lastIndexOf('.')) !== structKey || index < 0) return null;
    return {kind, offset: cell.offset + 4 * index, mask: 0};
  }
  if (cell.tag !== STRUCT) return null;
  const inner = scalarCell(cell.members.find(item => item.key === member.key));
  return inner && {...inner, offset: cell.offset + inner.offset};
}

/** A Core vector or rotator cell (three float32 or int32 words at 4-byte
 * steps, structCell checks the linked layout): its kind ('vector' or
 * 'rotator') and offset, for the Rust interpreter's lowering. Null for any
 * other cell. */
export function vectorCell(cell) {
  if (!cell || (cell.tag !== VECTOR && cell.tag !== ROTATOR)) return null;
  return {kind: cell.tag === VECTOR ? 'vector' : 'rotator', offset: cell.offset};
}

// A cell's storage kind (R3-c's field table), and whether two cells store a
// value the same way: tag, offset, mask, and the same element or members.
const CELL_KINDS = {[BYTE]: 'byte', [INT]: 'int', [BOOL]: 'bool', [FLOAT]: 'float', [REF]: 'string', [NAME]: 'name',
  [ARRAY]: 'array', [VECTOR]: 'vector', [ROTATOR]: 'rotator', [STRUCT]: 'struct', [FIXED]: 'fixed', [POINTER]: 'pointer'};
export const cellKind = cell => cell ? CELL_KINDS[cell.tag] ?? null : null;
export function sameCell(a, b) {
  if (a === b) return true;
  if (!a || !b || a.tag !== b.tag || a.offset !== b.offset || a.mask !== b.mask || a.dim !== b.dim ||
    a.stride !== b.stride || a.key !== b.key || a.handle !== b.handle) return false;
  if (a.tag === FIXED) return sameCell(a.element, b.element);
  if (a.tag !== STRUCT) return true;
  return a.members.length === b.members.length && a.members.every((member, index) => sameCell(member, b.members[index]));
}

const SCALAR_KINDS = {[BYTE]: 'byte', [INT]: 'int', [BOOL]: 'bool', [FLOAT]: 'float'};
/** A scalar cell's kind (byte, int, bool, float, or object for an object or
 * class pointer, whose bytes hold a handle), offset and bool mask; null for
 * any other cell. */
export function scalarCell(cell) {
  if (!cell) return null;
  const kind = cell.tag === POINTER ? 'object' : SCALAR_KINDS[cell.tag];
  return kind ? {kind, offset: cell.offset, mask: cell.mask >>> 0} : null;
}

/** The frame cells of a prepared function's parameters and locals
 * (script-frame-locals.mjs), or null while the function is not linked. */
export function functionImageCells(fields, record, {graph, identity, nativeRecord}) {
  const layout = linkedFunctionLayout(record, fields, {graph, identity, nativeRecord});
  return layout && layoutCells(layout);
}

function layoutCells(layout) {
  const cells = new Map();
  let refCount = 0;
  for (const entry of layout.properties) {
    const cell = cellFor(entry, entry.field.metadata, entry.offset);
    if (!cell) continue;
    cell.ref = refCount;
    refCount += cell.refCount;
    if (entry.key === 'engine.actor.base') cell.actorBase = true;
    cells.set(entry.key, cell);
  }
  return Object.freeze({size: layout.size, refCount, cells, fields: new Map(layout.properties.map(entry => [entry.key, entry.field]))});
}


/** The logical value of a cell in an image at byte offset `at`, reference
 * index `refAt` (a containing struct or array element). Scalars are handled
 * here, in a body small enough to inline into the property access path. */
export function readCell(cell, image, refs, at = 0, refAt = 0) {
  switch (cell.tag) {
    case BYTE: return image.getUint8(at + cell.offset);
    case INT: return image.getInt32(at + cell.offset, true);
    case BOOL: return (image.getUint32(at + cell.offset, true) & cell.mask) !== 0;
    case FLOAT: return image.getFloat32(at + cell.offset, true);
    case POINTER: return identityOfHandle(image.getUint32(at + cell.offset, true));
    case REF: case NAME: return refs[refAt + cell.ref];
    default: return readComposite(cell, image, refs, at + cell.offset, refAt);
  }
}

/** One element of a fixed-array cell: the value readCell's FIXED branch
 * builds at `index`, or undefined for a cell that is not a fixed array. */
export function readFixedElement(cell, image, refs, index, at = 0) {
  if (cell.tag !== FIXED) return undefined;
  const element = cell.element;
  return readCell(element, image, refs, at + cell.offset + index * cell.stride, cell.ref + index * element.refCount);
}
/** Store one element of a fixed-array cell at `index`: the store writeCell's
 * FIXED branch makes for that element, for a host member that is an
 * accessor over one slot (actor-link-fields.mjs Touching). */
export function writeFixedElement(cell, image, refs, index, value, at = 0) {
  if (cell.tag !== FIXED) throw new Error('writeFixedElement requires a fixed-array cell');
  const element = cell.element;
  writeCell(element, image, refs, value, at + cell.offset + index * cell.stride, cell.ref + index * element.refCount);
}
export const isFixedCell = cell => cell.tag === FIXED;

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
    case POINTER: {
      const offset = at + cell.offset, handle = pointerHandle(value);
      if (!cell.actorBase) { image.setUint32(offset, handle, true); return; }
      // An Actor.Base store: the rider lists of the old and the new base
      // change (base-epoch.mjs).
      const before = image.getUint32(offset, true);
      image.setUint32(offset, handle, true);
      if (before !== handle) noteBaseChange(identityOfHandle(before), value ?? null);
      return;
    }
    case REF: refs[refAt + cell.ref] = value; return;
    case NAME:
      refs[refAt + cell.ref] = value;
      image.setUint32(at + cell.offset, nameCellWord(value), true);
      return;
    default: writeComposite(cell, image, refs, value, at + cell.offset, refAt);
  }
}

// The handle a pointer cell stores for a logical value (copyPointer's result):
// 0 for None. Anything else that is not an object has no pointer form.
function pointerHandle(value) {
  if (value == null) return 0;
  if (typeof value !== 'object') throw new TypeError(`An object or class property cannot hold a ${typeof value} value (${String(value)})`);
  return handleOf(value);
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

/** Every name inside the cells, struct members and fixed array elements
 * included: its byte offset relative to the image and its reference-array
 * index, in cell order (for validators of the name bytes, R3-c). */
export function nameSlots(cells) {
  const slots = [];
  const visit = (cell, at, refAt) => {
    switch (cell.tag) {
      case NAME: slots.push({offset: at + cell.offset, ref: refAt + cell.ref}); return;
      case STRUCT: for (const member of cell.members) visit(member, at + cell.offset, refAt + cell.ref); return;
      case FIXED:
        for (let index = 0; index < cell.dim; index++)
          visit(cell.element, at + cell.offset + index * cell.stride, refAt + cell.ref + index * cell.element.refCount);
        return;
    }
  };
  for (const cell of cells.values()) visit(cell, 0, 0);
  return slots;
}

/** Every object or class pointer inside the cells, struct members and fixed
 * array elements included: their byte offsets relative to the image, in
 * cell order (for handle validators). */
export function handleSlots(cells) {
  const slots = [];
  const visit = (cell, at) => {
    switch (cell.tag) {
      case POINTER: slots.push(at + cell.offset); return;
      case STRUCT: for (const member of cell.members) visit(member, at + cell.offset); return;
      case FIXED:
        for (let index = 0; index < cell.dim; index++) visit(cell.element, at + cell.offset + index * cell.stride);
        return;
    }
  };
  for (const cell of cells.values()) visit(cell, 0);
  return slots;
}
