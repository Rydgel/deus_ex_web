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
import {registerAllocationSiteWarmer} from './allocation-site-warmup.mjs';

const BYTE = 1, INT = 2, BOOL = 3, FLOAT = 4, REF = 5, ARRAY = 6, VECTOR = 7, ROTATOR = 8, STRUCT = 9, FIXED = 10, POINTER = 11,
  NAME = 12;

// One shape for every cell, so the reads and writes below see a single hidden
// class. `ref` and `refCount` index the reference array (a pointer cell uses
// none); `members` (struct) and `element`/`dim`/`stride` (fixed array) hold the
// parts of composite values.
class Cell {
  constructor(tag, offset, refCount, {mask = 0, members = null, element = null, dim = 0, stride = 0} = {}) {
    // A bool's mask can have bit 30 or 31 set (-2147483648 for the top bit), which is a heap number. A field that has stored
    // one holds a heap number for every cell, boxed in each (docs/live-heap.md, "Step 5's results"). Storing null first
    // makes the field tagged: a small mask stays a Smi, and only the masks that are not Smis are boxed.
    this.tag = tag; this.offset = offset; this.mask = null; this.mask = mask; this.ref = 0; this.refCount = refCount;
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

// A class that declares no property of its own (the class loader's propertyOrder is empty) lists its base's properties, the same
// field objects in the same order (cls.propertyLink is `[...propertyOrder, ...base.propertyLink]`), at the same offsets in the
// same PropertiesSize: its layout, cells and field table are its base's. 145 of the 289 classes the Island attaches are such
// classes (decoration and pawn subclasses that differ in their defaults and their script only); they share the nearest ancestor
// that declares a property, which is the layout's owner (docs/firefox-60fps-plan.md, "The script runtime's instance state").
const layoutOwners = new WeakMap();
/** The class whose layout `cls` has: the nearest ancestor (or `cls` itself) with the same linked property list and
 * PropertiesSize. `graph` reads the sizes. */
export function layoutOwner(cls, graph) {
  let owner = layoutOwners.get(cls);
  if (owner !== undefined) return owner;
  owner = cls;
  const base = cls.base, link = cls.propertyLink, baseLink = base?.propertyLink;
  // (a class that declares no property holds its base's list itself: class-link-lists.mjs)
  if (base?.loadRecord && cls.loadRecord && cls.propertyOrder?.length === 0 && link && baseLink &&
    (link === baseLink || link.length === baseLink.length && link.every((field, index) => field === baseLink[index])) &&
    graph.slotOf(cls.loadRecord, 0x3c) === graph.slotOf(base.loadRecord, 0x3c))
    owner = layoutOwner(base, graph);
  layoutOwners.set(cls, owner);
  return owner;
}

/** The image cells of a class linked by the native class loader. */
export function objectImageCells(cls, {graph, identity}) {
  let result = classCells.get(cls);
  if (result) return result;
  const owner = layoutOwner(cls, graph);
  if (owner !== cls) result = objectImageCells(owner, {graph, identity});
  else {
    result = layoutCells(linkedClassLayout(cls, {graph, identity}), fieldIndexOf(graph));
    for (const [key, cell] of result.cells) registerFieldCell(key, cell);
  }
  classCells.set(cls, result);
  return result;
}

// A property's cell is the same in every class that has it: the declaring
// class links its offset, subclasses append after it. The Rust interpreter
// (script-vm-lower.mjs) addresses an instance field by key through this
// registry; a key whose cells ever disagree is left to JavaScript.
const fieldCells = new Map();
let fieldCellVersion = 0;
// Called when a key's cell is withdrawn (the cells of two classes disagree):
// code lowered with that cell is no longer valid (the Rust interpreter's
// event and call caches). A key gaining its cell invalidates nothing.
const fieldCellListeners = [];
export const onFieldImageCellWithdrawn = listener => { fieldCellListeners.push(listener); };
function registerFieldCell(key, cell) {
  const known = fieldCells.get(key);
  if (known === undefined) {
    fieldCells.set(key, cell);
    fieldCellVersion++;
  } else if (known !== null && (known.tag !== cell.tag || known.offset !== cell.offset || known.mask !== cell.mask ||
    known.handle !== cell.handle)) {
    fieldCells.set(key, null);
    fieldCellVersion++;
    for (const listener of fieldCellListeners) listener();
  }
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

const MEMBER_KINDS = {[BYTE]: 'byte', [INT]: 'int', [BOOL]: 'bool', [FLOAT]: 'float', [POINTER]: 'object'};
/** A struct cell whose every member is a byte, int, bool, float or object pointer: its offset and its members {key, kind, offset
 * (within the struct), mask}, for the Rust interpreter's copies of a struct out argument (interp.rs P_STRUCT). Null for any other cell. */
export function scalarStructMembers(cell) {
  if (!cell || cell.tag !== STRUCT || !cell.members.length) return null;
  const members = [];
  for (const member of cell.members) {
    const kind = MEMBER_KINDS[member.tag];
    if (!kind) return null;
    members.push({key: member.key, kind, offset: member.offset, mask: member.mask >>> 0});
  }
  return {offset: cell.offset, members};
}

/** A struct cell flattened to its scalar leaves: every byte, int, bool, float and object-pointer member, and the three components of
 * a vector (float) or rotator (int) member, with nested structs and fixed arrays walked in order. {offset, members}, the members
 * {key, kind, offset (within the struct), mask, path} as scalarStructMembers describes them (a leaf's key is that of the member it
 * lies in); `path` is the steps from the struct's value to the leaf (a member key, an array index or a component index), for a
 * check against the codec copy. Null when any part is a name, string, dynamic array or other cell with no byte form, or the struct
 * has no leaf. */
export function flatStructMembers(cell) {
  if (!cell || cell.tag !== STRUCT || !cell.members.length) return null;
  const members = [];
  const walk = (part, base, path, key) => {
    key = part.key ?? key;
    const kind = MEMBER_KINDS[part.tag];
    if (kind) {
      members.push({key, kind, offset: base + part.offset, mask: part.mask >>> 0, path});
      return true;
    }
    switch (part.tag) {
      case VECTOR: case ROTATOR:
        for (let i = 0; i < 3; i++)
          members.push({key, kind: part.tag === VECTOR ? 'float' : 'int', offset: base + part.offset + 4 * i, mask: 0, path: [...path, i]});
        return true;
      case STRUCT:
        return part.members.length > 0 && part.members.every(member => walk(member, base + part.offset, [...path, member.key], member.key));
      case FIXED:
        if (!(part.dim > 0)) return false;
        for (let i = 0; i < part.dim; i++) if (!walk(part.element, base + part.offset + i * part.stride, [...path, i], key)) return false;
        return true;
      default: return false;
    }
  };
  for (const member of cell.members) if (!walk(member, 0, [member.key], member.key)) return null;
  return {offset: cell.offset, members};
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

// A cell that holds no reference and no parts (a scalar, a pointer, a vector or a rotator) is the same in every class that has
// its property: the declaring class links the offset and subclasses append after it. The classes share it, as one object per
// property instead of one per class and property (docs/live-heap.md, "Step 5's results"): 77,000 cells on the Island. Its `ref`
// is never read (only REF, NAME, ARRAY and the composites index the reference array). A struct's members, which take a key and a
// reference position of their own, and Actor.Base's cell, which takes the rider flag, stay each class's own.
const LEAF_TAGS = new Set([BYTE, INT, BOOL, FLOAT, POINTER, VECTOR, ROTATOR]);
const sharedCells = new Map();
function sharedCell(key, cell) {
  const id = `${key}|${cell.tag}|${cell.offset}|${cell.mask}|${cell.handle ? 1 : 0}`;
  const kept = sharedCells.get(id);
  if (kept !== undefined) return kept;
  sharedCells.set(id, cell);
  return cell;
}

// The other cells (a string, a name, a dynamic array, a struct or a fixed array: `ref` is their position in the reference array) are the
// same in every class that has the same properties before theirs in link order, which a subclass that adds none and the classes of one
// chain below its last addition have. Equal cells (the same tag, offset, mask, reference position, parts, key and flags) are one object:
// the Island's 11,300 of them (a Map entry and a cell object of twelve slots each per class) are a few thousand. Nothing writes a cell
// once layoutCells has made it.
const canonicalCells = new Map();
const cellSignature = cell => `${cell.tag}|${cell.offset}|${cell.mask}|${cell.ref}|${cell.refCount}|${cell.key}|${cell.dim}|${cell.stride}|` +
  `${cell.actorBase ? 1 : 0}|${cell.handle ? 1 : 0}|${cell.element ? `[${cellSignature(cell.element)}]` : ''}|` +
  `${cell.members ? `{${cell.members.map(cellSignature).join(',')}}` : ''}`;
function canonicalCell(cell) {
  const id = cellSignature(cell), kept = canonicalCells.get(id);
  if (kept !== undefined) return kept;
  canonicalCells.set(id, cell);
  return cell;
}

// The linked fields of a class graph by property key: the `fields` of every class layout of the graph. A property's key (the declaring
// class and its name) names one field, so the layouts of the classes that inherit it share the entry instead of a Map each.
const fieldIndexes = new WeakMap();
function fieldIndexOf(graph) {
  let index = fieldIndexes.get(graph);
  if (!index) fieldIndexes.set(graph, index = new Map());
  return index;
}

/** `layout`'s cells by property key and their reference count. `index` (class layouts): the graph's shared field index, which
 * becomes the layout's `fields` unless a key of it names another field there than the layout's (then the layout has its own). */
function layoutCells(layout, index = null) {
  const cells = new Map();
  let refCount = 0;
  for (const entry of layout.properties) {
    let cell = cellFor(entry, entry.field.metadata, entry.offset);
    if (!cell) continue;
    if (LEAF_TAGS.has(cell.tag) && entry.key !== 'engine.actor.base') cell = sharedCell(entry.key, cell);
    else {
      cell.ref = refCount;
      if (entry.key === 'engine.actor.base') cell.actorBase = true;
      if (index) cell = canonicalCell(cell);
    }
    refCount += cell.refCount;
    cells.set(entry.key, cell);
  }
  let fields = index;
  if (index) for (const entry of layout.properties) {
    const known = index.get(entry.key);
    if (known === undefined) index.set(entry.key, entry.field);
    else if (known !== entry.field) { fields = null; break; }
  }
  return Object.freeze({size: layout.size, refCount, cells,
    fields: fields ?? new Map(layout.properties.map(entry => [entry.key, entry.field]))});
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
export const isPointerCell = cell => cell.tag === POINTER;
/** A vector or rotator cell (a three-word value copyScalar copies component by component). */
export const isVector3Cell = cell => cell.tag === VECTOR || cell.tag === ROTATOR;
/** writeCell(cell, image, refs, copyValue(value), at) for a vector or rotator cell and a three-element array, without making the copy
 * (the components copyScalar makes are fround or `| 0` of Number(item ?? 0), and the store rounds or wraps the same way): true when
 * written, false for any other cell or value, which the caller copies and writes. */
export function writeVector3(cell, image, value, at = 0) {
  const tag = cell.tag;
  if ((tag !== VECTOR && tag !== ROTATOR) || !Array.isArray(value) || value.length !== 3) return false;
  const offset = at + cell.offset;
  if (tag === VECTOR) {
    image.setFloat32(offset, Number(value[0] ?? 0), true); image.setFloat32(offset + 4, Number(value[1] ?? 0), true);
    image.setFloat32(offset + 8, Number(value[2] ?? 0), true);
  } else {
    image.setInt32(offset, Number(value[0] ?? 0) | 0, true); image.setInt32(offset + 4, Number(value[1] ?? 0) | 0, true);
    image.setInt32(offset + 8, Number(value[2] ?? 0) | 0, true);
  }
  return true;
}
/** One member of a struct cell, as readCell(cell) would put it in the struct's value under `key`, without building the value:
 * undefined for a cell that is not a struct or has no such member. */
export function readStructMember(cell, key, image, refs, at = 0, refAt = 0) {
  if (cell.tag !== STRUCT) return undefined;
  for (const member of cell.members) if (member.key === key) return readCell(member, image, refs, at + cell.offset, refAt + cell.ref);
  return undefined;
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

/** The image offset of the pointer that `path` names from a property's
 * cell `cell`: per level the property (`field.key`, a struct member below
 * the top) and its fixed-array index. Null when the path leaves the cells
 * or does not end at a pointer. */
export function pointerOffset(cell, path) {
  let at = 0;
  for (let level = 0; level < path.length; level++) {
    const {field, index} = path[level];
    if (level > 0) {
      if (cell?.tag !== STRUCT) return null;
      at += cell.offset;
      cell = cell.members.find(member => member.key === field.key);
      if (!cell) return null;
    }
    if (cell.tag === FIXED) {
      if (!(index >= 0 && index < cell.dim)) return null;
      at += cell.offset + index * cell.stride;
      cell = cell.element;
    } else if (index !== 0) return null;
  }
  return cell?.tag === POINTER ? at + cell.offset : null;
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

let sink = null;
// readComposite's literals and `Array(n)` build the vectors, rotators, structs and fixed arrays every property read returns. A map
// load keeps what it reads, so without this V8 decides those sites "tenure" there and allocates every later read in old space
// (allocation-site-warmup.mjs). The fabricated cells read a scratch image and the values are dropped. The samples are fractions
// and integers as the images' are, so the sites' elements kinds are the production ones.
registerAllocationSiteWarmer(count => {
  const image = new DataView(new ArrayBuffer(96)), refs = [[1, 2, 3], 'text'];
  for (let word = 0; word < 24; word++) image.setFloat32(word * 4, word + 0.5, true);
  const vector = new Cell(VECTOR, 0, 0), rotator = new Cell(ROTATOR, 12, 0), array = new Cell(ARRAY, 0, 1);
  const struct = (offset, ...members) => {
    members.forEach((member, index) => { member.key = `warm.${index}`; member.ref = 0; });
    return new Cell(STRUCT, offset, 0, {members});
  };
  const mixed = struct(24, new Cell(FLOAT, 0, 0), new Cell(VECTOR, 4, 0), new Cell(INT, 16, 0), new Cell(BOOL, 20, 0, {mask: 1}));
  const nested = struct(48, new Cell(ROTATOR, 0, 0), new Cell(FLOAT, 12, 0));
  const fixedVectors = new Cell(FIXED, 0, 0, {dim: 4, stride: 12, element: vector});
  const fixedFloats = new Cell(FIXED, 0, 0, {dim: 4, stride: 4, element: new Cell(FLOAT, 0, 0)});
  for (let i = 0; i < count; i++) {
    sink = readCell(vector, image, refs); sink = readCell(rotator, image, refs); sink = readCell(array, image, refs);
    sink = readCell(mixed, image, refs); sink = readCell(nested, image, refs);
    sink = readCell(fixedVectors, image, refs); sink = readCell(fixedFloats, image, refs);
  }
  sink = null;
});
