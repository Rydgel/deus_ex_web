/** The tagged property list of an object, as UObject::SerializeTaggedProperties saves it (docs/travel.md "The .dxs"): for each property of the
 * class chain (the most derived class first, declaration order inside a class) that is not transient, for each array element whose value is not
 * Identical to the class default's: a tag, then the value as UProperty::SerializeItem writes it; a `None` name ends the list.
 *
 *   tag     name (compact name index), info byte = type | sizeCode << 4 | 0x80 (an array element other than 0; for a bool the value),
 *           the struct's name (a struct), the size when sizeCode says so (5: a byte, 6: a u16, 7: a u32), the element index (compact form below)
 *   types   1 byte, 2 int, 3 bool, 4 float, 5 object (a ClassProperty too), 6 name, 9 array, 10 struct, 13 string
 *   sizes   sizeCode 0..4 stand for 1, 2, 4, 12, 16 bytes
 *   index   one byte below 128, two bytes (0x80 | high, low) below 16384, else four bytes (0xC0 | ...)
 *   values  byte u8, int i32, float f32, name a compact name index, string an FString, object a compact export/import index, a struct its members
 *           in declaration order (skipping the CPF 0x1000 and the transient 0x2000 ones), an array its compact count then its elements
 *
 * This is the write side of objects.mjs readProperties and script-map-properties.mjs; the corpus of saved levels is its test (scripts/validate-
 * level-save.mjs decodes each tag, writes it again and compares the bytes). `context` supplies the package's tables:
 *   nameIndex(text) -> the name table index, objectRef(object) -> the compact index (0 for none), structName(field) -> the tag's struct name. */
import { ByteWriter } from './byte-writer.mjs';

const lower = value => String(value ?? '').toLowerCase();
export const CPF_TRANSIENT = 0x2000;
export const CPF_NATIVE = 0x1000;
const TAG_TYPES = { byte: 1, int: 2, bool: 3, float: 4, object: 5, class: 5, name: 6, array: 9, struct: 10, string: 13 };
const SIZE_CODES = new Map([[1, 0], [2, 1], [4, 2], [12, 3], [16, 4]]);

export class TaggedWriteError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'TaggedWriteError'; Object.assign(this, details); }
}

/** The compare UProperty::Identical makes between a value and the class default's (script-property-identical.mjs holds the retail bodies). */
export function identicalValues(field, a, b) {
  const metadata = field.metadata ?? field;
  switch (metadata.type) {
    case 'float': return Math.fround(a ?? 0) === Math.fround(b ?? 0);
    case 'byte': return ((a ?? 0) & 0xff) === ((b ?? 0) & 0xff);
    case 'int': return ((a ?? 0) | 0) === ((b ?? 0) | 0);
    case 'bool': return Boolean(a) === Boolean(b);
    case 'name': return lower(a ?? 'None') === lower(b ?? 'None');
    case 'string': return String(a ?? '') === String(b ?? '');
    case 'object': case 'class': {
      const key = value => value === null || value === undefined ? null : typeof value.key === 'string' ? value.key : value;
      return key(a) === key(b);
    }
    case 'array': {
      const inner = { metadata: metadata.innerMetadata };
      return (a ?? []).length === (b ?? []).length && (a ?? []).every((item, i) => identicalValues(inner, item, b[i]));
    }
    case 'struct': {
      if (metadata.structKey === 'core.object.vector' || metadata.structKey === 'core.object.rotator')
        return (a ?? [0, 0, 0]).every((item, i) => item === (b ?? [0, 0, 0])[i]);
      for (const member of metadata.structFields ?? []) {
        const dim = member.metadata.arrayDim ?? 1;
        const x = a?.[member.key], y = b?.[member.key];
        if (dim === 1) { if (!identicalValues(member, x, y)) return false; }
        else for (let i = 0; i < dim; i++) if (!identicalValues(member, x?.[i], y?.[i])) return false;
      }
      return true;
    }
    default: throw new TaggedWriteError(`Identical: unsupported property type ${metadata.type}`, { type: metadata.type });
  }
}

/** One element's payload (UProperty::SerializeItem) into `w`. */
export function writeItem(w, field, value, context) {
  const metadata = field.metadata ?? field;
  switch (metadata.type) {
    case 'byte': w.u8(value ?? 0); break;
    case 'int': w.i32(value ?? 0); break;
    case 'float': w.f32(value ?? 0); break;
    case 'bool': w.u8(value ? 1 : 0); break;
    case 'name': w.compact(context.nameIndex(value ?? 'None')); break;
    case 'string': w.string(value ?? ''); break;
    case 'object': case 'class': w.compact(context.objectRef(value ?? null)); break;
    case 'array': {
      const inner = { metadata: metadata.innerMetadata };
      if (!metadata.innerMetadata) throw new TaggedWriteError(`array property ${field.key} has no linked inner property`);
      w.compact((value ?? []).length);
      for (const item of value ?? []) writeItem(w, inner, item, context);
      break;
    }
    case 'struct': {
      if (metadata.structKey === 'core.object.vector') { for (let i = 0; i < 3; i++) w.f32(value?.[i] ?? 0); break; }
      if (metadata.structKey === 'core.object.rotator') { for (let i = 0; i < 3; i++) w.i32(value?.[i] ?? 0); break; }
      if (!metadata.structFields) throw new TaggedWriteError(`struct property ${field.key} has no linked members`);
      for (const member of metadata.structFields) {
        const flags = member.metadata.flags;
        if (flags & 0x1000 || flags & CPF_TRANSIENT) continue;
        const dim = member.metadata.arrayDim ?? 1;
        if (dim === 1) writeItem(w, member, value?.[member.key], context);
        else for (let i = 0; i < dim; i++) writeItem(w, member, value?.[member.key]?.[i], context);
      }
      break;
    }
    default: throw new TaggedWriteError(`SerializeItem: unsupported property type ${metadata.type} (${field.key})`, { type: metadata.type });
  }
}

/** One tag and its value. `index` is the array element (0 for a scalar). */
export function writeTaggedElement(w, field, index, value, context) {
  const metadata = field.metadata ?? field;
  const type = TAG_TYPES[metadata.type];
  if (!type) throw new TaggedWriteError(`tag: unsupported property type ${metadata.type} (${field.key})`, { type: metadata.type });
  w.compact(context.nameIndex(field.name));
  if (type === 3) {
    // a bool carries its value in the info byte and has no payload: its Size is 0, which no size code names, so the tag says 5 and a size
    // byte of 0 (measured: `d3 00` for a true bool, `53 00` for a false one)
    w.u8(3 | (5 << 4) | (value ? 0x80 : 0)); w.u8(0);
    return;
  }
  const payload = new ByteWriter();
  writeItem(payload, field, value, context);
  const size = payload.length;
  const code = SIZE_CODES.get(size) ?? (size <= 0xff ? 5 : size <= 0xffff ? 6 : 7);
  w.u8(type | (code << 4) | (index ? 0x80 : 0));
  if (type === 10) w.compact(context.nameIndex(context.structName(field)));
  if (code === 5) w.u8(size); else if (code === 6) w.u16(size); else if (code === 7) w.u32(size);
  if (index) {
    if (index < 0x80) w.u8(index);
    else if (index < 0x4000) { w.u8(0x80 | (index >> 8)); w.u8(index & 0xff); }
    else { w.u8(0xc0 | (index >>> 24)); w.u8((index >> 16) & 0xff); w.u8((index >> 8) & 0xff); w.u8(index & 0xff); }
  }
  w.raw(payload.bytes.subarray(0, size));
}

/**
 * The property list of one object. `fields` are the class chain's properties in tag order; `read(field)` the object's value of one (the whole
 * array for a fixed array), `defaults(field)` the class default's. A transient property is skipped.
 */
export function writeTaggedProperties(w, fields, read, defaults, context) {
  for (const field of fields) {
    const metadata = field.metadata;
    if (metadata.flags & (CPF_TRANSIENT | CPF_NATIVE)) continue;
    const dim = metadata.arrayDim ?? 1;
    const value = read(field), fallback = defaults(field);
    if (dim === 1) {
      if (!identicalValues(field, value, fallback)) writeTaggedElement(w, field, 0, value, context);
    } else {
      for (let i = 0; i < dim; i++) if (!identicalValues(field, value?.[i], fallback?.[i])) writeTaggedElement(w, field, i, value?.[i], context);
    }
  }
  w.compact(context.nameIndex('None'));
}
