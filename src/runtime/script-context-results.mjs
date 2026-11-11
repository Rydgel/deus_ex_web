import { readFunctionMetadata, readPropertyMetadata } from '../unreal/script-metadata.mjs';
import { zeroValue } from './script-values.mjs';
import { entryOf } from '../unreal/objects.mjs';
import { ScriptLinks, NO_WIDTH } from './script-links.mjs';

const PROPERTY_OPS = new Set([0x00, 0x01, 0x02, 0x29]);
const FUNCTION_OPS = new Set([0x1b, 0x1c, 0x38]);
const CONTEXT_OP = 0x19;
const CLASS_CONTEXT_OP = 0x12;
// execClassContext (0x12) and execContext (0x19) share the same decoded shape
// and the same null-context contract: 'Accessed None', skip the value bytes,
// zero valueSize of result. Result preparation must therefore recognize both.
const CONTEXT_OPS = new Set([CLASS_CONTEXT_OP, CONTEXT_OP]);
const STRUCT_MEMBER_OP = 0x36;
const BOOL_VARIABLE_OP = 0x2d;
const DYNAMIC_CAST_OP = 0x2e;
const PROPERTY_TYPES = Object.freeze({
  ByteProperty: 'byte', IntProperty: 'int', BoolProperty: 'bool',
  FloatProperty: 'float', NameProperty: 'name', StrProperty: 'string',
  ObjectProperty: 'object', ClassProperty: 'class', StructProperty: 'struct',
  ArrayProperty: 'array', MapProperty: 'map', FixedArrayProperty: 'fixedArray',
});
const SCALAR_TYPES = new Set(['byte', 'int', 'bool', 'float', 'name', 'object', 'class']);
const STRUCT_KEYS = new Set(['core.object.vector', 'core.object.rotator']);

/** A context value whose original typed zero is not linked by this pass. */
export class UnsupportedScriptContextResultError extends Error {
  constructor(message, { key = null, type = null, offset = null, size = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptContextResultError';
    this.code = 'UNSUPPORTED_SCRIPT_CONTEXT_RESULT';
    this.key = key;
    this.type = type;
    this.offset = offset;
    this.size = size;
  }
}

const lower = value => String(value ?? '').toLowerCase();

function propertyType(metadata) {
  return metadata?.type ?? metadata?.valueType ?? PROPERTY_TYPES[metadata?.className] ?? null;
}

function fieldKey(record, metadata) {
  return String(record?.key ?? metadata?.path ?? metadata?.name ?? '<property>');
}

function fail(message, details = {}) {
  throw new UnsupportedScriptContextResultError(message, details);
}

/**
 * Keep only the fixed-width property types whose null result is established
 * by the original execContext memset. A context value is an expression
 * temporary, so BoolProperty uses its four-byte logical slot, not a storage
 * bit mask. Fixed arrays and all dynamic/string/map branches remain absent.
 */
function fixedPropertyShape(record, metadata) {
  const key = fieldKey(record, metadata);
  const type = propertyType(metadata);
  const arrayDim = Number(metadata?.arrayDim ?? metadata?.arrayDimension ?? 1);
  if (!Number.isInteger(arrayDim) || arrayDim !== 1) return null;
  if (type === 'struct') {
    const structKey = lower(metadata.structKey);
    if (!STRUCT_KEYS.has(structKey)) return null;
    return { key, type, structKey, width: 12 };
  }
  if (!SCALAR_TYPES.has(type)) return null;
  const width = type === 'byte' ? 1 : 4;
  return { key, type, width };
}

// `offset`: the property expression's expanded offset (null for a function result), not the node, which would keep a released
// body's nodes (docs/live-heap.md step 8).
function makePropertyDescriptor(record, metadata, node = null) {
  const shape = fixedPropertyShape(record, metadata);
  if (!shape) return null;
  return {
    source: 'property',
    key: shape.key,
    field: record,
    metadata,
    type: shape.type,
    structKey: shape.structKey ?? null,
    width: shape.width,
    offset: node?.offset ?? null,
    zero: zeroOfDescriptor,
  };
}

// The descriptor a body keeps: the same keys in the same order as `{...descriptor, contextOffset, encodedSize}`, written as one literal
// so that every key is in the object itself (the spread made the two last keys an out-of-line property array on each of the 11,600
// descriptors of the Island: docs/live-heap.md "Load records and functions").
function finishDescriptor(d, contextOffset, encodedSize) {
  if (d.source === 'property')
    return { source: d.source, key: d.key, field: d.field, metadata: d.metadata, type: d.type, structKey: d.structKey, width: d.width,
      offset: d.offset, zero: d.zero, contextOffset, encodedSize };
  if (d.source === 'function')
    return { source: d.source, key: d.key, field: d.field, metadata: d.metadata, type: d.type, structKey: d.structKey, width: d.width,
      offset: d.offset, zero: d.zero, function: d.function, returnField: d.returnField, contextOffset, encodedSize };
  return { ...d, contextOffset, encodedSize };
}

// The typed zero of a descriptor (shared by all of them, and by their copies: a closure per descriptor was two more objects each).
function zeroOfDescriptor() {
  return zeroValue({ key: this.key, metadata: this.metadata });
}
/** The `zero` every prepared descriptor carries (the tests build descriptors with it). */
export const descriptorZero = zeroOfDescriptor;

async function objectReference(runtime, script, index) {
  if (!Number.isInteger(index) || index === 0 || !runtime?.objects?.reference) return null;
  return runtime.objects.reference(script, index);
}

async function resolveObject(runtime, asset, index) {
  if (!Number.isInteger(index) || index === 0 || !runtime?.objects?.resolve) return null;
  return runtime.objects.resolve(asset, index);
}

/**
 * Use the runtime's normal property linker when available. It resolves a
 * StructProperty's complete identity without weakening the full-path rule.
 * Synthetic callers may supply metadata directly, which keeps this helper
 * independent of the class loader.
 */
async function linkedProperty(runtime, record) {
  if (!record) return null;
  let field = record;
  if (typeof runtime?.field === 'function') field = await runtime.field(record);
  let metadata = field?.metadata;
  if (!metadata && field?.asset && Number.isInteger(field.index)) {
    metadata = readPropertyMetadata(field.asset, field.index);
    field.metadata = metadata;
  }
  if (!metadata) return null;

  // ScriptRuntime.field normally fills this field. Keep the same resolution
  // available for small standalone linkers that expose only objects.resolve.
  if (propertyType(metadata) === 'struct' && !metadata.structKey && metadata.structRef &&
      runtime?.objects?.resolve) {
    const struct = await resolveObject(runtime, field.asset, metadata.structRef);
    if (struct?.key) metadata.structKey = lower(struct.key);
  }
  return { record: field, metadata };
}

async function propertyNode(runtime, script, node) {
  const record = await objectReference(runtime, script, node.fieldIndex);
  const linked = await linkedProperty(runtime, record);
  return linked ? makePropertyDescriptor(linked.record, linked.metadata, node) : null;
}

async function memberNode(runtime, script, node) {
  // StructMember carries the member UProperty reference in fieldIndex. The
  // struct operand is still executed by the VM; its static result is not
  // needed to establish this member's fixed result width.
  return propertyNode(runtime, script, node);
}

function methodFromClass(runtime, cls, name) {
  if (!cls) return null;
  if (typeof runtime?.lookupMember === 'function') {
    const result = runtime.lookupMember(cls, 'methods', name);
    if (result) return result;
  }
  const wanted = lower(name);
  for (let current = cls; current; current = current.base) {
    const methods = current.methods;
    if (methods?.get) {
      const result = methods.get(wanted);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Resolve an ObjectProperty receiver to its serialized class identity. This
 * deliberately never uses the current null receiver or a short class name.
 */
async function staticObjectClass(runtime, descriptor) {
  if (!descriptor || descriptor.type !== 'object') return null;
  // A DynamicCast receiver (`cast<Pawn>(x).FindInventoryType(...)`): the compiler resolved the call through the cast's class
  if (descriptor.source === 'cast') {
    const classRecord = descriptor.classRecord;
    if (!classRecord || classRecord.kind !== 'Class' || !entryOf(classRecord)?.serialSize) return null;
    if (typeof runtime?.loadClass !== 'function') return null;
    try { return { record: classRecord, loaded: await runtime.loadClass(classRecord.asset, classRecord.index) }; } catch { return null; }
  }
  const metadata = descriptor.metadata, record = descriptor.field;
  const classRef = metadata?.propertyClassRef;
  if (!Number.isInteger(classRef) || classRef === 0) return null;
  const classRecord = await resolveObject(runtime, record?.asset, classRef);
  if (!classRecord || classRecord.kind !== 'Class' || !entryOf(classRecord)?.serialSize) return null;
  if (typeof runtime?.loadClass !== 'function') return null;
  try {
    const loaded = await runtime.loadClass(classRecord.asset, classRecord.index);
    return { record: classRecord, loaded };
  } catch {
    // Native-only or otherwise unresolved class identities stay unsupported;
    // preparation must continue for the other Context expressions.
    return null;
  }
}

async function functionReturn(runtime, script, functionRecord) {
  if (!functionRecord?.asset || !Number.isInteger(functionRecord.index)) return null;
  let metadata;
  try {
    // This reads only the serialized UFunction header/children. It does not
    // compile, link, or execute the function body.
    metadata = readFunctionMetadata(functionRecord.asset, functionRecord.index, { includeChildren: true });
  } catch {
    return null;
  }
  const resultMetadata = metadata.children?.find(child => child.return);
  if (!resultMetadata) return null;
  let resultRecord = await resolveObject(runtime, functionRecord.asset, resultMetadata.index);
  if (!resultRecord) {
    resultRecord = {
      asset: functionRecord.asset,
      index: resultMetadata.index,
      entry: resultMetadata.entry,
      key: `${functionRecord.key ?? metadata.path}.${resultMetadata.name}`.toLowerCase(),
      kind: resultMetadata.className,
      name: resultMetadata.name,
    };
  }
  const linked = await linkedProperty(runtime, { ...resultRecord, metadata: resultMetadata });
  if (!linked) return null;
  const descriptor = makePropertyDescriptor(linked.record, linked.metadata);
  if (!descriptor) return null;
  return {
    ...descriptor,
    source: 'function',
    function: functionRecord,
    returnField: linked.record,
  };
}

async function functionNode(runtime, script, node, targetDescriptor) {
  let functionRecord;
  if (node.op === 0x1c) {
    functionRecord = await objectReference(runtime, script, node.functionIndex);
    if (functionRecord?.kind !== 'Function') return null;
  } else {
    const target = await staticObjectClass(runtime, targetDescriptor);
    if (!target) return null;
    functionRecord = methodFromClass(runtime, target.loaded, node.name);
    if (functionRecord?.kind !== 'Function') return null;
  }
  return functionReturn(runtime, script, functionRecord);
}

/**
 * A native token (`op: 'native'`) names only its GNatives index. The
 * compiler resolved it through the Context object's class, so the declaring
 * UFunction is the one in that class chain with the same iNative. Its
 * return property gives the typed zero; execContext still zeroes only the
 * encoded width.
 */
async function nativeNode(runtime, script, node, targetDescriptor) {
  const target = await staticObjectClass(runtime, targetDescriptor);
  if (!target) return null;
  for (let cls = target.loaded; cls; cls = cls.base) {
    for (const record of cls.methods?.values?.() ?? []) {
      if (record?.kind !== 'Function' || !record.asset || !Number.isInteger(record.index)) continue;
      if (functionNativeIndex(record.asset, record.index) === node.index) return functionReturn(runtime, script, record);
    }
  }
  return null;
}

/** A function export's iNative (null when not FUNC_Native, or unreadable), read once per package: the package bytes do not change, and reading
 * the header walks the whole bytecode (every map load asked again for every method of every Context class: about 6 s of a 747 load). */
const nativeIndexes = new WeakMap();
function functionNativeIndex(asset, index) {
  let cache = nativeIndexes.get(asset);
  if (!cache) nativeIndexes.set(asset, cache = new Map());
  if (cache.has(index)) return cache.get(index);
  let value = null;
  try { const metadata = readFunctionMetadata(asset, index); if (metadata.hasNativeIndex) value = metadata.nativeIndex; } catch {}
  cache.set(index, value);
  return value;
}

async function expressionNode(runtime, script, node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);
  try {
    if (PROPERTY_OPS.has(node.op)) return propertyNode(runtime, script, node);
    if (node.op === STRUCT_MEMBER_OP) return memberNode(runtime, script, node);
    if (node.op === DYNAMIC_CAST_OP) {
      const classRecord = await objectReference(runtime, script, node.fieldIndex);
      return classRecord ? { source: 'cast', type: 'object', classRecord } : null;
    }
    if (node.op === BOOL_VARIABLE_OP) {
      const descriptor = await expressionNode(runtime, script, node.value, seen);
      return descriptor?.type === 'bool' ? descriptor : null;
    }
    if (CONTEXT_OPS.has(node.op)) return contextNode(runtime, script, node, seen);
    return null;
  } finally {
    seen.delete(node);
  }
}

async function contextNode(runtime, script, node, seen) {
  const targetDescriptor = await expressionNode(runtime, script, node.context, seen);
  if (FUNCTION_OPS.has(node.value?.op)) {
    return functionNode(runtime, script, node.value, targetDescriptor);
  }
  if (node.value?.op === 'native' && Number.isInteger(node.value.index)) {
    return nativeNode(runtime, script, node.value, targetDescriptor);
  }
  return expressionNode(runtime, script, node.value, seen);
}

/**
 * Prepare a sparse map for null Context results. Unsupported expression
 * shapes are intentionally omitted; the VM reports one only if execution
 * reaches that Context. The map key is the expanded offset of the
 * `Context.value` expression, which names it in every decode of the body
 * (compileFunction releases and decodes trees again, docs/live-heap.md step 8).
 */
export async function prepareContextResults(runtime, script, decoded) {
  const result = new Map();
  if (!decoded?.expressions || typeof decoded.expressions.values !== 'function') return result;
  for (const node of decoded.expressions.values()) {
    if (!CONTEXT_OPS.has(node?.op) || !node.value) continue;
    try {
      const descriptor = await contextNode(runtime, script, node, new Set());
      if (!descriptor) continue;
      result.set(node.value.offset, finishDescriptor(descriptor, node.offset, node.valueSize));
    } catch {
      // A single unresolved cross-package/native/opaque result must not make
      // every other prepared script context unusable.
    }
  }
  return result;
}

// The type of a result is a small code in the script's links (the values fixedPropertyShape produces, then any other a descriptor
// brings, in the order they come).
const TYPE_NAMES = ['byte', 'int', 'bool', 'float', 'name', 'object', 'class', 'struct'];
const TYPE_CODES = new Map(TYPE_NAMES.map((name, code) => [name, code]));
function typeCode(type) {
  let code = TYPE_CODES.get(type);
  if (code === undefined) {
    if (typeof type !== 'string') throw new TypeError(`A Context result type must be a string: ${String(type)}`);
    TYPE_CODES.set(type, code = TYPE_NAMES.length);
    TYPE_NAMES.push(type);
  }
  return code;
}

const int32 = value => Number.isInteger(value) && (value | 0) === value;

// A function result's metadata is read from the package for each Context that calls the function (functionReturn: a fresh object of
// fifteen to eighteen fields, 3,374 for 349 functions on the Island). A result of a function whose metadata equals, field for field,
// the one an earlier result of that function kept takes that one: zeroValue reads the same fields from either, and the copies were the
// only holders of themselves. Keyed by the function's identity, so the table lives as long as the function.
const returnMetadata = new WeakMap();
function sameFields(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!Object.hasOwn(b, key) || !Object.is(a[key], b[key])) return false;
  return true;
}
function sharedMetadata(d) {
  const owner = d.function;
  if (d.source !== 'function' || owner === null || typeof owner !== 'object') return d.metadata;
  const first = returnMetadata.get(owner);
  if (first === undefined) { returnMetadata.set(owner, d.metadata); return d.metadata; }
  return first === d.metadata || sameFields(first, d.metadata) ? first : d.metadata;
}

/**
 * The prepared results (`prepareContextResults`' Map of value offset -> descriptor) as the entries ScriptLinks.prepared keeps: a script
 * holds a result as its value offset, context offset, width and type code in a block of words, with the key and the metadata that
 * zeroValue reads, in place of one descriptor object a result (11,700 on the Island; docs/firefox-60fps-plan.md "The per-script
 * offset tables"). What no later reader asks for goes with the descriptor: the linked field, the function and its return field, the
 * struct key, the property expression's offset and the context's encoded size (zeroContextResult reads the width, the key, the type, the
 * context offset and the metadata only). A descriptor with no width (a DynamicCast's: it names a class, which has no typed zero) keeps
 * none, so every width check against it fails as it did.
 */
export function compactContextResults(results) {
  const entries = [];
  for (const [offset, d] of results) {
    if (!int32(offset) || !int32(d.contextOffset)) throw new TypeError('A Context result needs integer offsets');
    const typed = d.source === 'property' || d.source === 'function';
    if (typed) {
      if (!int32(d.width) || typeof d.key !== 'string' || d.metadata === null || typeof d.metadata !== 'object' || d.zero !== zeroOfDescriptor)
        throw new TypeError(`A Context result of ${String(d.key)} has no fixed width or typed zero`);
    } else if (d.width !== undefined || d.key !== undefined || d.metadata !== undefined || d.zero !== undefined) {
      throw new TypeError('A Context result without a source must have no width, key, metadata or zero');
    }
    entries.push({ offset, contextOffset: d.contextOffset, width: typed ? d.width : NO_WIDTH, type: typeCode(d.type),
      key: typed ? d.key : undefined, metadata: typed ? sharedMetadata(d) : undefined });
  }
  return entries.sort((a, b) => a.offset - b.offset);
}

// zeroContextResult over a script's links: the same lookup, checks and messages, the descriptor's values read from their columns.
function zeroLinkedContextResult(links, node, encodedSize) {
  let rank = links.contextFind(node?.offset);
  if (rank < 0) rank = links.contextFind(node?.value?.offset);
  if (rank < 0) {
    fail(`Unsupported null Context result at offset ${node?.offset ?? '<unknown>'}`, {
      offset: node?.offset ?? null, size: encodedSize,
    });
  }
  const stored = links.contextInt(rank, 2), width = stored === NO_WIDTH ? undefined : stored, key = links.contextKey(rank);
  if (encodedSize !== width) {
    fail(`Null Context result width mismatch for ${key}: ` +
      `encoded ${encodedSize}, linked ${width}`, {
        key, type: TYPE_NAMES[links.contextInt(rank, 3)],
        offset: links.contextInt(rank, 1), size: encodedSize,
      });
  }
  // a descriptor with no width has no typed zero either: only an encoded size of `undefined` gets this far, and it called `zero()`
  if (width === undefined) throw new TypeError('descriptor.zero is not a function');
  return zeroValue({ key, metadata: links.contextMetadata(rank) });
}

/**
 * Produce the typed zero for a prepared Context value and enforce the exact
 * encoded width written by Core.dll's raw memset. `node` may be the Context's
 * value node (the public key) or the Context node itself for convenience.
 * `resultMap` is the script's links (ScriptObjects.contextResultsOf) or a Map of descriptors.
 */
export function zeroContextResult(resultMap, node, encodedSize) {
  if (resultMap instanceof ScriptLinks) return zeroLinkedContextResult(resultMap, node, encodedSize);
  if (!(resultMap instanceof Map)) throw new TypeError('Expected a prepared Context result Map');
  const descriptor = resultMap.get(resultMap.has(node?.offset) ? node.offset : node?.value?.offset);
  if (!descriptor) {
    fail(`Unsupported null Context result at offset ${node?.offset ?? '<unknown>'}`, {
      offset: node?.offset ?? null, size: encodedSize,
    });
  }
  if (encodedSize !== descriptor.width) {
    fail(`Null Context result width mismatch for ${descriptor.key}: ` +
      `encoded ${encodedSize}, linked ${descriptor.width}`, {
        key: descriptor.key, type: descriptor.type,
        offset: descriptor.contextOffset ?? node?.offset ?? null, size: encodedSize,
      });
  }
  return descriptor.zero();
}
