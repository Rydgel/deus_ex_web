import { readFunctionMetadata, readPropertyMetadata } from '../unreal/script-metadata.mjs';
import { zeroValue } from './script-values.mjs';

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
    node,
    zero: () => zeroValue({ key: shape.key, metadata }),
  };
}

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
  const metadata = descriptor.metadata, record = descriptor.field;
  const classRef = metadata?.propertyClassRef;
  if (!Number.isInteger(classRef) || classRef === 0) return null;
  const classRecord = await resolveObject(runtime, record?.asset, classRef);
  if (!classRecord || classRecord.kind !== 'Class' || !classRecord.entry?.serialSize) return null;
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
      let metadata;
      try { metadata = readFunctionMetadata(record.asset, record.index); } catch { continue; }
      if (metadata.hasNativeIndex && metadata.nativeIndex === node.index) return functionReturn(runtime, script, record);
    }
  }
  return null;
}

async function expressionNode(runtime, script, node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);
  try {
    if (PROPERTY_OPS.has(node.op)) return propertyNode(runtime, script, node);
    if (node.op === STRUCT_MEMBER_OP) return memberNode(runtime, script, node);
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
 * reaches that Context. The map key is the exact decoded `Context.value`
 * object identity used by compileFunction.
 */
export async function prepareContextResults(runtime, script, decoded) {
  const result = new Map();
  if (!decoded?.expressions || typeof decoded.expressions.values !== 'function') return result;
  for (const node of decoded.expressions.values()) {
    if (!CONTEXT_OPS.has(node?.op) || !node.value) continue;
    try {
      const descriptor = await contextNode(runtime, script, node, new Set());
      if (!descriptor) continue;
      result.set(node.value, { ...descriptor, context: node, encodedSize: node.valueSize });
    } catch {
      // A single unresolved cross-package/native/opaque result must not make
      // every other prepared script context unusable.
    }
  }
  return result;
}

/**
 * Produce the typed zero for a prepared Context value and enforce the exact
 * encoded width written by Core.dll's raw memset. `node` may be the Context's
 * value node (the public key) or the Context node itself for convenience.
 */
export function zeroContextResult(resultMap, node, encodedSize) {
  if (!(resultMap instanceof Map)) throw new TypeError('Expected a prepared Context result Map');
  const valueNode = resultMap.has(node) ? node : node?.value;
  const descriptor = resultMap.get(valueNode);
  if (!descriptor) {
    fail(`Unsupported null Context result at offset ${node?.offset ?? '<unknown>'}`, {
      offset: node?.offset ?? null, size: encodedSize,
    });
  }
  if (encodedSize !== descriptor.width) {
    fail(`Null Context result width mismatch for ${descriptor.key}: ` +
      `encoded ${encodedSize}, linked ${descriptor.width}`, {
        key: descriptor.key, type: descriptor.type,
        offset: descriptor.context?.offset ?? node?.offset ?? null, size: encodedSize,
      });
  }
  return descriptor.zero();
}
