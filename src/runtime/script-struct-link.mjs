/** GOTY Core.dll UStruct::Link; see docs/script-struct-link.md. */
import {linkScriptProperty} from './script-property-link.mjs';
import {NativeSlots, slotValue} from './native-slots.mjs';

export const SCRIPT_STRUCT_LINK = Object.freeze({
  thunk: 0x10101933, body: 0x10126060,
  propertyClass: 0x102a7af0, objectPropertyClass: 0x102a61f0,
  structPropertyClass: 0x102a3ef0, classClass: 0x101f1c18,
  linkGate: 0x101e5544,
});

export class UnsupportedScriptStructLinkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedScriptStructLinkError';
    this.code = 'UNSUPPORTED_SCRIPT_STRUCT_LINK';
  }
}
const fail = message => { throw new UnsupportedScriptStructLinkError(message); };
const pointer = value => value === 0 ? null : value;
const identity = value => pointer(value?.nativeAddress ?? value?.address ?? value);
const same = (a, b) => identity(a) === identity(b);
const integer = (value, label, max = 0x7fffffff) => {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new TypeError(`UStruct::Link requires ${label}, got ${String(value)}`);
  return value;
};
const required = (value, label) => typeof value === 'function' ? value : fail(`UStruct::Link requires ${label}`);

function slot(object, offset, services) {
  const fromHost = services.readSlot?.(object, offset);
  const value = fromHost === undefined ? slotValue(object, offset) : fromHost;
  if (value === undefined) fail(`UStruct::Link has no binding for +0x${offset.toString(16)}`);
  return value;
}

function write(object, offset, value, services, width = 4) {
  const slots = object?.nativeSlots instanceof NativeSlots ? object.nativeSlots : null;
  const present = slots !== null && slots.has(offset);
  if (present && slots.width(offset) !== width) throw new TypeError(`Wrong native slot width at +0x${offset.toString(16)}`);
  if (services.writeSlot) services.writeSlot(object, offset, value, width);
  if (present) slots.assign(offset, value);
  else if (slots) slots.set(offset, value, width);
  else if (!services.writeSlot) fail(`UStruct::Link has no writable +0x${offset.toString(16)} binding`);
}

function superOf(object, services) {
  if (services.getInheritanceSuper) {
    const value = services.getInheritanceSuper(object);
    if (value === undefined) fail('GetInheritanceSuper returned no pointer');
    return pointer(value);
  }
  // These three verified virtual implementations all return receiver +28.
  // In particular, UFunction's different override cannot use this fallback.
  const vtable = object?.nativeVtable ?? slot(object, 0, services);
  if (![0x10175698, 0x101757d8, 0x101758f4].includes(vtable))
    fail('UStruct::Link requires this native GetInheritanceSuper override');
  return pointer(slot(object, 0x28, services));
}

function isA(object, target, services) {
  if (services.isA) {
    const result = services.isA(object, target);
    if (result === true || result === 1) return true;
    if (result !== false && result !== 0) fail('IsA returned no native boolean');
    return false;
  }
  const classValue = object?.objectClass;
  let cls = pointer(classValue === undefined ? slot(object, 0x24, services) : classValue);
  const seen = new Set();
  while (cls !== null) {
    if (same(cls, target)) return true;
    if (seen.has(identity(cls))) throw new Error('Cyclic native Class ancestry');
    seen.add(identity(cls));
    cls = pointer(slot(cls, 0x28, services));
  }
  return false;
}

// The longest SuperField chain and Children chain a walk follows before it calls them cycles (the native loops forever there). Counting
// instead of visited sets: these walks run for every struct link, over every inherited field (the sets cost a share of each map load).
const MAX_SUPERS = 1024, MAX_CHILDREN = 1 << 20;

/** The three native iterator bodies differ only in their ancestry target. */
function* properties(record, target, services) {
  let structure = record;
  for (let supers = 0; structure !== null; supers++) {
    if (supers === MAX_SUPERS) throw new Error('Cyclic native inheritance');
    let field = pointer(slot(structure, 0x38, services));
    for (let children = 0; field !== null; children++) {
      if (children === MAX_CHILDREN) throw new Error('Cyclic native Children chain');
      if (isA(field, target, services)) yield field;
      // Read after the caller resumes: property virtuals may update live data.
      field = pointer(slot(field, 0x2c, services));
    }
    structure = superOf(structure, services);
  }
}

function ownerClass(property, services) {
  if (services.getOwnerClass) {
    const value = services.getOwnerClass(property);
    if (value === undefined || pointer(value) === null) fail('GetOwnerClass returned no class');
    return value;
  }
  let current = property;
  const seen = new Set();
  while (current !== null) {
    if (seen.has(identity(current))) throw new Error('Cyclic UField Outer chain');
    seen.add(identity(current));
    const classValue = current?.objectClass;
    const cls = classValue === undefined ? slot(current, 0x24, services) : classValue;
    if (same(cls, SCRIPT_STRUCT_LINK.classClass)) return current;
    current = pointer(slot(current, 0x18, services));
  }
  fail('UField::GetOwnerClass reached null');
}

function baseArchive() {
  return {vtable: 0x101751f8, ar04: 0x44, ar08: 0x44c,
    ar0c: 0, ar10: 0, ar14: 0, ar18: 0,
    ar1c: 1, ar20: 1, ar24: 1, ar28: 0};
}

function readScriptBytes(owner, offset, count, services) {
  const bytes = required(services.readScriptBytes, 'expanded script-memory reader')(owner, offset, count);
  if (!(bytes instanceof Uint8Array) || bytes.length !== count)
    throw new TypeError('Script-memory reader must return the exact expanded byte span');
  return bytes;
}

function linkCondition(record, property, endCursors, services, operations, priors) {
  write(property, 0x58, property, services);
  const archive = baseArchive();
  const start = integer(slot(property, 0x44, services), 'RepOffset word', 0xffff);
  const cursor = {value: start, get() { return this.value; }, set(value) { this.value = value; }};
  const owner = ownerClass(property, services);
  required(services.serializeExpression, 'owner SerializeExpr (+0x7c)')(owner, cursor, archive);
  const end = integer(cursor.value, 'expression end cursor');
  if (end < start) throw new RangeError('Replication expression moved its cursor backwards');
  endCursors.set(identity(property), end);
  // `priors`: the properties the caller's walk of the same chain yielded before this one. Nothing between that walk and this one writes the
  // Class, SuperField, Children or Next words (+0x24, +0x28, +0x38, +0x2c), so the native body's second walk visits the same fields; walking
  // again for every replicated property cost seconds per map load (quadratic in a class's properties).
  for (const prior of priors ?? properties(record, SCRIPT_STRUCT_LINK.propertyClass, services)) {
    if (same(prior, property)) break;
    if ((integer(slot(prior, 0x3c, services), 'PropertyFlags', 0xffffffff) & 0x20) === 0) continue;
    const priorEnd = endCursors.get(identity(prior));
    if (priorEnd === undefined) fail('Original replication-condition memo assertion: missing prior expression');
    const priorStart = integer(slot(prior, 0x44, services), 'RepOffset word', 0xffff);
    if (end - start !== priorEnd - priorStart) continue;
    const priorOwner = ownerClass(prior, services);
    const currentOwner = ownerClass(property, services);
    const priorBytes = readScriptBytes(priorOwner, priorStart, end - start, services);
    const currentBytes = readScriptBytes(currentOwner, start, end - start, services);
    if (currentBytes.every((byte, i) => byte === priorBytes[i])) {
      write(prior, 0x58, slot(property, 0x58, services), services);
    }
  }
  operations.push({operation: 'link-replication-condition', property, start, end});
}

function preload(object, archive, services) {
  if (services.preload) services.preload(object, archive);
  else required(archive.preload, 'FArchive::Preload (+0x10)').call(archive, object);
}

/** Translate both native layout modes, then construct the five live chains. */
export function linkScriptStruct(record, {archive, secondArgument = 0, services = {}} = {}) {
  if (!record || !archive) throw new TypeError('UStruct::Link requires record and archive');
  if (!Number.isInteger(secondArgument)) throw new TypeError('Expected native integer layout argument');
  const operations = [];
  if (secondArgument !== 0) {
    write(record, 0x3c, 0, services);
    if (superOf(record, services) !== null) {
      preload(superOf(record, services), archive, services);
      const parent = superOf(record, services);
      const size = services.getPropertiesSize ? services.getPropertiesSize(parent)
        : slot(parent, 0x3c, services);
      write(record, 0x3c, (integer(size, 'super PropertiesSize') + 3) & ~3, services);
    }
  }
  let field = pointer(slot(record, 0x38, services));
  let previous = null;
  const seen = new Set();
  while (field !== null) {
    if (seen.has(identity(field))) throw new Error('Cyclic direct Children chain');
    seen.add(identity(field));
    if (secondArgument !== 0) preload(field, archive, services);
    if (!same(slot(field, 0x18, services), record)) break;
    if (isA(field, SCRIPT_STRUCT_LINK.propertyClass, services)) {
      const savedOffset = secondArgument === 0 ? integer(slot(field, 0x48, services), 'property Offset') : null;
      if (services.linkProperty) services.linkProperty(field, archive, previous);
      else linkScriptProperty(field, {archive, previousProperty: previous,
        services: services.scalarPropertyLink ?? services});
      if (secondArgument === 0) write(field, 0x48, savedOffset, services);
      else {
        const stride = integer(slot(field, 0x38, services), 'ElementSize');
        const dim = integer(slot(field, 0x34, services), 'ArrayDim');
        const offset = integer(slot(field, 0x48, services), 'property Offset');
        write(record, 0x3c, (Math.imul(stride, dim) + offset) | 0, services);
      }
      operations.push({operation: 'link-property', property: field, previous, preservedOffset: savedOffset});
      previous = field;
    }
    field = pointer(slot(field, 0x2c, services));
  }
  if (secondArgument !== 0) {
    const size = integer(slot(record, 0x3c, services), 'PropertiesSize');
    write(record, 0x3c, (size + 3) & ~3, services);
  }

  for (const [head, target] of [[0x58, SCRIPT_STRUCT_LINK.objectPropertyClass],
    [0x5c, SCRIPT_STRUCT_LINK.structPropertyClass]]) {
    let tail = [record, head];
    for (const property of properties(record, target, services)) {
      write(...tail, property, services);
      tail = [property, 0x60];
    }
    write(...tail, null, services);
    operations.push({operation: 'build-reference-chain', offset: head});
  }

  let allTail = [record, 0x60], configTail = [record, 0x64], destroyTail = [record, 0x68];
  const endCursors = new Map(), priors = [];
  for (const property of properties(record, SCRIPT_STRUCT_LINK.propertyClass, services)) {
    let flags = integer(slot(property, 0x3c, services), 'PropertyFlags', 0xffffffff);
    if (flags & 0x20) {
      const gate = required(services.readGlobal, 'live replication-link global')(SCRIPT_STRUCT_LINK.linkGate);
      integer(gate, 'global link gate', 0xffffffff);
      if (gate === 0) linkCondition(record, property, endCursors, services, operations, priors);
    }
    flags = integer(slot(property, 0x3c, services), 'PropertyFlags', 0xffffffff);
    if (flags & 0x400000) {
      write(...destroyTail, property, services);
      destroyTail = [property, 0x54];
    }
    flags = integer(slot(property, 0x3c, services), 'PropertyFlags', 0xffffffff);
    if (flags & 0x4000) {
      write(...configTail, property, services);
      configTail = [property, 0x50];
    }
    write(...allTail, property, services);
    allTail = [property, 0x4c];
    priors.push(property);
  }
  write(...allTail, null, services);
  write(...configTail, null, services);
  write(...destroyTail, null, services);
  operations.push({operation: 'build-property-chains'});
  return {record, operations};
}

export const linkUStruct = linkScriptStruct;
